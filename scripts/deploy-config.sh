#!/usr/bin/env zsh
# Pushes config/model.json to AppConfig as a new version and deploys it.
# No Lambda deploy: running functions pick it up within ~15-30 seconds.
set -euo pipefail

STACK="${STACK:-BedrockConfigRouter-dev}"
REGION="${AWS_REGION:-eu-central-1}"
output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
APP=$(output AppConfigAppId)
ENV=$(output AppConfigEnvId)
PROFILE=$(output AppConfigProfileId)
STRATEGY=$(output AppConfigStrategyId)

# AppConfig validates the content against config/model.schema.json here.
VERSION=$(aws appconfig create-hosted-configuration-version --region "$REGION" \
  --application-id "$APP" --configuration-profile-id "$PROFILE" \
  --content-type application/json --content fileb://config/model.json \
  --query VersionNumber --output text /dev/null)
echo "Created config version $VERSION"

aws appconfig start-deployment --region "$REGION" \
  --application-id "$APP" --environment-id "$ENV" --configuration-profile-id "$PROFILE" \
  --configuration-version "$VERSION" --deployment-strategy-id "$STRATEGY" \
  --query '{deployment: DeploymentNumber, state: State}' --output text
