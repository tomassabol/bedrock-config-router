#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { RouterStack } from '../lib/router-stack';

const app = new App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';

new RouterStack(app, `BedrockConfigRouter-${stage}`, {
  stage,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-central-1' },
});
