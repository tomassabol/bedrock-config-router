import type { Logger } from '@aws-lambda-powertools/logger';
import bundledCompliance from '../../config/compliance.json';
import bundledCostPolicy from '../../config/cost-policy.json';
import bundledFlags from '../../config/flags.json';
import bundledRouting from '../../config/routing.json';
import type { ComplianceConfig, CostPolicy, Flags, RoutingConfig, RuntimeConfig } from './types';

/** AppConfig configuration profile names. Must match the CDK stack. */
export const PROFILES = {
  routing: 'routing',
  costPolicy: 'cost-policy',
  compliance: 'compliance',
  flags: 'flags',
} as const;

const port = process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT ?? '2772';
const application = process.env.APPCONFIG_APPLICATION;
const environment = process.env.APPCONFIG_ENVIRONMENT;

interface Fetched<T> {
  value: T;
  version: string;
  bundled: boolean;
}

/**
 * Reads one profile from the AppConfig Lambda extension. The extension keeps the
 * config cached in the execution environment and refreshes it in the background,
 * so this is a localhost call, not a network round trip to AppConfig.
 * Falls back to the config bundled with the code if the extension can't serve it.
 */
async function fetchProfile<T>(profile: string, bundled: T, logger: Logger): Promise<Fetched<T>> {
  if (!application || !environment) {
    return { value: bundled, version: 'bundled', bundled: true };
  }
  const url = `http://localhost:${port}/applications/${application}/environments/${environment}/configurations/${profile}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return {
      value: (await res.json()) as T,
      version: res.headers.get('Configuration-Version') ?? 'unknown',
      bundled: false,
    };
  } catch (error) {
    logger.warn('AppConfig extension unavailable, using bundled config', { profile, error });
    return { value: bundled, version: 'bundled', bundled: true };
  }
}

export async function loadRuntimeConfig(logger: Logger): Promise<RuntimeConfig> {
  const [routing, costPolicy, compliance, flags] = await Promise.all([
    fetchProfile<RoutingConfig>(PROFILES.routing, bundledRouting as RoutingConfig, logger),
    fetchProfile<CostPolicy>(PROFILES.costPolicy, bundledCostPolicy as CostPolicy, logger),
    fetchProfile<ComplianceConfig>(PROFILES.compliance, bundledCompliance as ComplianceConfig, logger),
    // Bundled flags are in the authoring format; the extension returns only the values.
    fetchProfile<Flags>(PROFILES.flags, bundledFlags.values as Flags, logger),
  ]);

  return {
    routing: routing.value,
    costPolicy: costPolicy.value,
    compliance: compliance.value,
    flags: flags.value,
    versions: {
      routing: routing.version,
      costPolicy: costPolicy.version,
      compliance: compliance.version,
      flags: flags.version,
    },
    usedBundledFallback: [routing, costPolicy, compliance, flags].some((p) => p.bundled),
  };
}
