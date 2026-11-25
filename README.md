# bedrock-config-router

A minimal example of runtime configuration for a GenAI Lambda. The Bedrock model, system prompt and inference settings live in **AWS AppConfig**, not in code or environment variables. The **AppConfig Lambda extension** caches them in the function, so switching from Nova 2 Lite to Nova Micro is a config deployment, not a code deployment.

```
client ──SigV4──► API Gateway (REST, response streaming, IAM auth)
                       │
                       ▼
                Lambda (Node 22) ──► Bedrock ConverseStream (Amazon Nova)
                  └─ AppConfig extension: localhost:2772, refreshes every 15s
                       ▲
config/model.json ──► AppConfig (validated by config/model.schema.json)
```

| File | What it is |
|---|---|
| [lib/router-stack.ts](lib/router-stack.ts) | CDK: AppConfig app/env/profile, Lambda + extension layer, streaming API |
| [src/router/index.ts](src/router/index.ts) | Handler: read config from the extension, stream the Bedrock reply |
| [config/model.json](config/model.json) | The runtime config: `enabled`, `modelId`, `systemPrompt`, `maxTokens`, `temperature` |
| [scripts/chat.sh](scripts/chat.sh) | Calls the API with `curl --aws-sigv4` |
| [scripts/deploy-config.sh](scripts/deploy-config.sh) | Pushes `config/model.json` to AppConfig without touching the Lambda |

## Run it

Requires [Bun](https://bun.sh), the AWS CLI, `jq`, and AWS credentials for eu-central-1.

```bash
bun install
AWS_PROFILE=tomassabol bun run deploy
AWS_PROFILE=tomassabol bun run chat "Explain AWS AppConfig in two sentences"
```

## Change the model without deploying code

Edit `config/model.json`, for example `"modelId": "eu.amazon.nova-micro-v1:0"`, then run:

```bash
AWS_PROFILE=tomassabol bun run config:deploy
```

Running functions pick up the new config within about 15–30 seconds. The `x-model` and `x-config-version` response headers show which config served each request. Set `"enabled": false` to make the API return 503, which works as a kill switch.

AppConfig rejects any version that doesn't match [config/model.schema.json](config/model.schema.json), so a typo never reaches the function.

## Logs and metrics

Powertools writes structured JSON logs that include `modelId` and `configVersion`. Metrics go to the `BedrockConfigRouter` namespace: `InputTokens` and `OutputTokens` per `Model`, plus `Errors`.

## Notes

- **Propagation is polling, not push.** Lambda environments are frozen between requests, so changes arrive at the next poll. 15 seconds is the shortest interval AppConfig allows.
- **The rollout is immediate.** Each deployment uses a strategy with no gradual rollout. For production, use a linear or canary strategy and attach CloudWatch alarms to the environment so a bad config rolls back automatically.
