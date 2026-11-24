import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const root = path.join(__dirname, '..');
const configDir = path.join(root, 'config');
const SERVICE = 'bedrock-config-router';
const METRICS_NAMESPACE = 'BedrockConfigRouter';

/** Profile names are part of the contract with src/router/config.ts and scripts/deploy-config.ts. */
const PROFILES = ['routing', 'cost-policy', 'compliance', 'flags'] as const;

export interface RouterStackProps extends StackProps {
  stage: string;
}

export class RouterStack extends Stack {
  constructor(scope: Construct, id: string, props: RouterStackProps) {
    super(scope, id, props);
    const { stage } = props;
    const appName = `${SERVICE}-${stage}`;
    const envName = stage;

    // ── Compliance: Bedrock Guardrail. Which version is enforced is chosen at runtime via AppConfig.
    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: appName,
      description: 'Content and PII filters for the config router',
      blockedInputMessaging: 'This request was blocked by the content policy.',
      blockedOutputsMessaging: 'The response was blocked by the content policy.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: 'EMAIL', action: 'ANONYMIZE' },
          { type: 'PHONE', action: 'ANONYMIZE' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
        ],
      },
    });
    new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion1', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: 'Initial version',
    });

    // ── Router Lambda with the AppConfig extension layer.
    const logGroup = new logs.LogGroup(this, 'RouterLogs', {
      logGroupName: `/aws/lambda/${appName}-router`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const prefetch = PROFILES.map(
      (p) => `/applications/${appName}/environments/${envName}/configurations/${p}`,
    ).join(',');

    const router = new nodejs.NodejsFunction(this, 'Router', {
      functionName: `${appName}-router`,
      entry: path.join(root, 'src/router/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'AppConfigExtension',
          appconfig.Application.getLambdaLayerVersionArn(this.region, appconfig.Platform.ARM_64),
        ),
      ],
      environment: {
        POWERTOOLS_LOG_LEVEL: 'INFO',
        POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE,
        APPCONFIG_APPLICATION: appName,
        APPCONFIG_ENVIRONMENT: envName,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS: '30',
        AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: prefetch,
      },
      bundling: { minify: true, sourceMap: true, target: 'node22' },
    });

    router.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModelWithResponseStream', 'bedrock:InvokeModel'],
        resources: [
          // Cross-region inference profiles (eu./global.) and the foundation models they route to.
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*.amazon.nova-*`,
          'arn:aws:bedrock:*::foundation-model/amazon.nova-*',
          'arn:aws:bedrock:::foundation-model/amazon.nova-*',
        ],
      }),
    );
    router.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn] }),
    );

    // ── AppConfig: application, rollback alarms, environment, deployment strategies, profiles.
    const app = new appconfig.Application(this, 'AppConfigApp', { applicationName: appName });

    // Scoped to the application (not the environment) to avoid a dependency cycle
    // Lambda → role policy → environment → alarm → Lambda.
    router.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'],
        resources: [`arn:aws:appconfig:${this.region}:${this.account}:application/${app.applicationId}/*`],
      }),
    );

    const failedRequestsAlarm = new cloudwatch.Alarm(this, 'RequestFailedAlarm', {
      alarmName: `${appName}-request-failed`,
      alarmDescription: 'Router failed requests; rolls back in-flight AppConfig deployments',
      metric: new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName: 'RequestFailed',
        dimensionsMap: { service: SERVICE },
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const lambdaErrorsAlarm = new cloudwatch.Alarm(this, 'LambdaErrorsAlarm', {
      alarmName: `${appName}-lambda-errors`,
      metric: router.metricErrors({ period: Duration.minutes(1), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const environment = app.addEnvironment('Env', {
      environmentName: envName,
      monitors: [
        appconfig.Monitor.fromCloudWatchAlarm(failedRequestsAlarm),
        appconfig.Monitor.fromCloudWatchAlarm(lambdaErrorsAlarm),
      ],
    });

    // Used by `cdk deploy` for the initial/bootstrap config versions.
    const immediate = new appconfig.DeploymentStrategy(this, 'Immediate', {
      deploymentStrategyName: `${appName}-immediate`,
      rolloutStrategy: appconfig.RolloutStrategy.linear({
        growthFactor: 100,
        deploymentDuration: Duration.minutes(0),
        finalBakeTime: Duration.minutes(0),
      }),
    });
    // Used by scripts/deploy-config.ts for day-to-day changes: 20% of execution
    // environments per step over 5 minutes, then a 5-minute bake watched by the alarms.
    new appconfig.DeploymentStrategy(this, 'Canary', {
      deploymentStrategyName: `${appName}-canary`,
      rolloutStrategy: appconfig.RolloutStrategy.linear({
        growthFactor: 20,
        deploymentDuration: Duration.minutes(5),
        finalBakeTime: Duration.minutes(5),
      }),
    });

    for (const name of ['routing', 'cost-policy', 'compliance'] as const) {
      new appconfig.HostedConfiguration(this, `Profile-${name}`, {
        application: app,
        name,
        content: appconfig.ConfigurationContent.fromFile(path.join(configDir, `${name}.json`), 'application/json'),
        validators: [
          appconfig.JsonSchemaValidator.fromFile(path.join(configDir, 'schemas', `${name}.schema.json`)),
        ],
        deploymentStrategy: immediate,
        deployTo: [environment],
      });
    }
    new appconfig.HostedConfiguration(this, 'Profile-flags', {
      application: app,
      name: 'flags',
      type: appconfig.ConfigurationType.FEATURE_FLAGS,
      content: appconfig.ConfigurationContent.fromFile(path.join(configDir, 'flags.json'), 'application/json'),
      deploymentStrategy: immediate,
      deployTo: [environment],
    });

    // ── REST API with response streaming and IAM (SigV4) auth.
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: appName,
      cloudWatchRole: false,
      deployOptions: {
        stageName: stage,
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
      },
    });
    api.root.addResource('chat').addMethod(
      'POST',
      new apigw.LambdaIntegration(router, {
        proxy: true,
        responseTransferMode: apigw.ResponseTransferMode.STREAM,
        timeout: Duration.minutes(5),
      }),
      { authorizationType: apigw.AuthorizationType.IAM },
    );

    new CfnOutput(this, 'ChatUrl', { value: api.urlForPath('/chat') });
    new CfnOutput(this, 'AppConfigApplication', { value: appName });
    new CfnOutput(this, 'AppConfigEnvironment', { value: envName });
    new CfnOutput(this, 'GuardrailId', { value: guardrail.attrGuardrailId });
  }
}
