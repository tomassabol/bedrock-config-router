import * as path from 'node:path';
import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

const root = path.join(__dirname, '..');

export class RouterStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { stage: string }) {
    super(scope, id, props);
    const appName = `bedrock-config-router-${props.stage}`;

    // AppConfig: one application, one environment, one validated JSON profile.
    const app = new appconfig.Application(this, 'AppConfigApp', { applicationName: appName });
    const env = app.addEnvironment('Env', { environmentName: props.stage });
    const strategy = new appconfig.DeploymentStrategy(this, 'Immediate', {
      deploymentStrategyName: `${appName}-immediate`,
      rolloutStrategy: appconfig.RolloutStrategy.linear({
        growthFactor: 100,
        deploymentDuration: Duration.minutes(0),
        finalBakeTime: Duration.minutes(0),
      }),
    });
    const profile = new appconfig.HostedConfiguration(this, 'ModelConfig', {
      application: app,
      name: 'model',
      content: appconfig.ConfigurationContent.fromFile(path.join(root, 'config/model.json'), 'application/json'),
      validators: [appconfig.JsonSchemaValidator.fromFile(path.join(root, 'config/model.schema.json'))],
      deploymentStrategy: strategy,
      deployTo: [env],
    });

    // Lambda with the AppConfig extension layer.
    const fn = new nodejs.NodejsFunction(this, 'Router', {
      functionName: `${appName}-router`,
      entry: path.join(root, 'src/router/index.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(5),
      logGroup: new logs.LogGroup(this, 'RouterLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(
          this,
          'AppConfigExtension',
          appconfig.Application.getLambdaLayerVersionArn(this.region, appconfig.Platform.ARM_64),
        ),
      ],
      environment: {
        APPCONFIG_APPLICATION: appName,
        APPCONFIG_ENVIRONMENT: props.stage,
        AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS: '15', // lowest interval AppConfig allows
        POWERTOOLS_SERVICE_NAME: appName,
        POWERTOOLS_METRICS_NAMESPACE: 'BedrockConfigRouter',
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['appconfig:StartConfigurationSession', 'appconfig:GetLatestConfiguration'],
        resources: [`arn:aws:appconfig:${this.region}:${this.account}:application/${app.applicationId}/*`],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*.amazon.nova-*`,
          'arn:aws:bedrock:*::foundation-model/amazon.nova-*',
          'arn:aws:bedrock:::foundation-model/amazon.nova-*',
        ],
      }),
    );

    // REST API with response streaming and IAM (SigV4) auth.
    const api = new apigw.RestApi(this, 'Api', {
      restApiName: appName,
      cloudWatchRole: false,
      deployOptions: { stageName: props.stage, throttlingRateLimit: 10, throttlingBurstLimit: 20 },
    });
    api.root.addResource('chat').addMethod(
      'POST',
      new apigw.LambdaIntegration(fn, {
        responseTransferMode: apigw.ResponseTransferMode.STREAM,
        timeout: Duration.minutes(5),
      }),
      { authorizationType: apigw.AuthorizationType.IAM },
    );

    // Read by scripts/*.sh.
    new CfnOutput(this, 'ChatUrl', { value: api.urlForPath('/chat') });
    new CfnOutput(this, 'AppConfigAppId', { value: app.applicationId });
    new CfnOutput(this, 'AppConfigEnvId', { value: env.environmentId });
    new CfnOutput(this, 'AppConfigProfileId', { value: profile.configurationProfileId });
    new CfnOutput(this, 'AppConfigStrategyId', { value: strategy.deploymentStrategyId });
  }
}
