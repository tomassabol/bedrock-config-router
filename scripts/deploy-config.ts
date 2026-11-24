/**
 * Ships one config profile to AppConfig without touching the Lambda:
 *   npm run config:deploy -- routing                  # canary rollout (default)
 *   npm run config:deploy -- flags --strategy immediate
 *   npm run config:deploy -- routing --stage prod
 * Validates locally, creates a new hosted version, starts a deployment and
 * follows it until it completes or the CloudWatch alarms roll it back.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
  GetDeploymentCommand,
  ListApplicationsCommand,
  ListConfigurationProfilesCommand,
  ListDeploymentStrategiesCommand,
  ListEnvironmentsCommand,
  StartDeploymentCommand,
} from '@aws-sdk/client-appconfig';
import { CONFIG_DIR, PROFILE_NAMES, type ProfileName, validateAll } from './validate';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stage: { type: 'string', default: 'dev' },
    strategy: { type: 'string', default: 'canary' },
    description: { type: 'string' },
  },
});

const profile = positionals[0] as ProfileName;
if (!PROFILE_NAMES.includes(profile)) {
  console.error(`Usage: npm run config:deploy -- <${PROFILE_NAMES.join('|')}> [--stage dev] [--strategy canary|immediate]`);
  process.exit(1);
}

const appName = `bedrock-config-router-${values.stage}`;
const client = new AppConfigClient({ region: 'eu-central-1' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function find<T extends { Name?: string; Id?: string }>(items: T[] | undefined, name: string, kind: string): string {
  const id = items?.find((i) => i.Name === name)?.Id;
  if (!id) throw new Error(`${kind} "${name}" not found. Did you run cdk deploy for stage "${values.stage}"?`);
  return id;
}

async function main() {
  const errors = validateAll();
  if (errors.length) throw new Error(`Config invalid:\n  - ${errors.join('\n  - ')}`);

  const appId = find((await client.send(new ListApplicationsCommand({}))).Items, appName, 'Application');
  const envId = find(
    (await client.send(new ListEnvironmentsCommand({ ApplicationId: appId }))).Items,
    values.stage!,
    'Environment',
  );
  const profileId = find(
    (await client.send(new ListConfigurationProfilesCommand({ ApplicationId: appId }))).Items,
    profile,
    'Configuration profile',
  );
  const strategyId = find(
    (await client.send(new ListDeploymentStrategiesCommand({}))).Items,
    `${appName}-${values.strategy}`,
    'Deployment strategy',
  );

  const version = await client.send(
    new CreateHostedConfigurationVersionCommand({
      ApplicationId: appId,
      ConfigurationProfileId: profileId,
      ContentType: 'application/json',
      Content: readFileSync(path.join(CONFIG_DIR, `${profile}.json`)),
      Description: values.description,
    }),
  );
  console.log(`Created ${profile} version ${version.VersionNumber}`);

  const deployment = await client.send(
    new StartDeploymentCommand({
      ApplicationId: appId,
      EnvironmentId: envId,
      ConfigurationProfileId: profileId,
      ConfigurationVersion: String(version.VersionNumber),
      DeploymentStrategyId: strategyId,
      Description: values.description,
    }),
  );
  console.log(`Started deployment #${deployment.DeploymentNumber} (${values.strategy})`);

  for (;;) {
    const d = await client.send(
      new GetDeploymentCommand({
        ApplicationId: appId,
        EnvironmentId: envId,
        DeploymentNumber: deployment.DeploymentNumber,
      }),
    );
    console.log(`  ${d.State} ${d.PercentageComplete ?? 0}%`);
    if (d.State === 'COMPLETE') return;
    if (d.State === 'ROLLED_BACK' || d.State === 'REVERTED') {
      throw new Error(`Deployment ${d.State}. Check the ${appName}-* CloudWatch alarms.`);
    }
    await sleep(15_000);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
