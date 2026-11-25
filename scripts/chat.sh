#!/usr/bin/env zsh
# Streams a reply from the /chat endpoint, signing the request with curl's built-in SigV4.
#   ./scripts/chat.sh "Explain AWS AppConfig in two sentences"
set -euo pipefail

STACK="${STACK:-BedrockConfigRouter-dev}"
REGION="${AWS_REGION:-eu-central-1}"
PROMPT="${1:?usage: chat.sh \"<prompt>\"}"

URL=$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ChatUrl'].OutputValue" --output text)

# Turn the current profile (SSO, assumed role, keys...) into plain credentials for curl.
eval "$(aws configure export-credentials --format env)"
token_header=()
[[ -n "${AWS_SESSION_TOKEN:-}" ]] && token_header=(-H "x-amz-security-token: $AWS_SESSION_TOKEN")

curl -sN -D /dev/stderr "$URL" \
  --aws-sigv4 "aws:amz:${REGION}:execute-api" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  "${token_header[@]}" \
  -H 'content-type: application/json' \
  --data "$(jq -n --arg p "$PROMPT" '{prompt: $p}')"
echo
