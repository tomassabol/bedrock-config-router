# bedrock-config-router

A config-driven gateway for Amazon Bedrock (Nova models). Routing, A/B tests, cost rules, guardrails and kill switches live in **AWS AppConfig**, and the Lambda reads them through the **AppConfig Lambda extension**. You change behaviour by deploying config, not code. Each change is validated, rolled out gradually and rolled back automatically if alarms fire.

```
 client ──SigV4──► API Gateway (REST, response streaming, IAM auth)
                        │
                        ▼
                 Router Lambda (Node 22, arm64, Powertools logger + metrics)
                  ├─ AppConfig extension ── localhost:2772 cache, polls every 30s
                  ├─ policy: kill switch → route → limits → A/B variant → cost downgrade → compliance
                  └─ Bedrock ConverseStream, falls back to the next model if one fails before the first token
                        │
                        ▼
               Nova 2 Lite · Nova Pro · Nova Lite · Nova Micro   (eu.* inference profiles)
                 + Bedrock Guardrail (version chosen in config)

 config/*.json ──validate──► AppConfig hosted version ──canary deployment──► extension
                                       ▲                                       │
                                       └──── auto-rollback ◄── CloudWatch alarms (RequestFailed, Lambda Errors)
```

## Config profiles

| Profile | File | What it controls |
|---|---|---|
| `routing` | [config/routing.json](config/routing.json) | Routes (`chat`, `summarize`, `reasoning`) → weighted variants → ordered model fallback list, system prompt, inference params |
| `cost-policy` | [config/cost-policy.json](config/cost-policy.json) | Input size limit, output token cap, downgrade to Nova Micro above a prompt-size threshold, prices used for the `EstimatedCostUsd` metric |
| `compliance` | [config/compliance.json](config/compliance.json) | Allowed model prefixes (e.g. only `eu.` for data residency), guardrail on/off and version, whether prompts are logged |
| `flags` | [config/flags.json](config/flags.json) | AppConfig feature flags: `maintenance-mode`, `ab-testing`, `model-fallback` |

AppConfig enforces the JSON Schemas in [config/schemas](config/schemas) on every new version. `npm run config:validate` also runs cross-profile checks, such as "every routed model is allowed by compliance and has a price".

The Lambda bundles the same files as a fallback, so it can still serve requests if the extension can't reach AppConfig on a cold start.

## Usage

Requires Node 22+ and AWS credentials for eu-central-1 (the npm scripts use `AWS_PROFILE`).

```bash
npm install
npm test
AWS_PROFILE=tomassabol npm run deploy
```

Chat (SigV4-signed, streamed as server-sent events):

```bash
AWS_PROFILE=tomassabol npm run chat -- "Explain AppConfig in two sentences" --user alice
AWS_PROFILE=tomassabol npm run chat -- "Summarize: ..." --route summarize
```

Change runtime behaviour without a code deploy: edit a file in `config/`, then run

```bash
AWS_PROFILE=tomassabol npm run config:deploy -- routing                       # canary: 20%/min, 5 min bake
AWS_PROFILE=tomassabol npm run config:deploy -- flags --strategy immediate    # kill switch
```

### Request

`POST /chat`

```json
{ "prompt": "hi", "route": "chat", "userId": "alice", "maxTokens": 512 }
```

You can send `messages: [{ "role": "user", "content": "..." }]` instead of `prompt`. `userId` makes the A/B assignment sticky; if it's omitted, the caller's IAM ARN is used.

### Response (`text/event-stream`)

```
event: meta   {"route":"chat","variant":"control","model":"eu.amazon.nova-2-lite-v1:0","fallbacks":0,"configVersions":{...}}
event: delta  {"text":"..."}
event: done   {"stopReason":"end_turn","usage":{...},"estimatedCostUsd":0.0000412}
```

Errors found before the stream starts return a normal status code with a JSON body: 400, 403 (no compliant model), 413, 503 (maintenance) or 502 (every model failed).

## Observability

The Powertools Logger writes structured JSON logs. Each request's log lines include route, variant and the config versions in effect. Prompts are logged only when `compliance.logPrompts` is `true`.

Powertools Metrics are published to the `BedrockConfigRouter` namespace:

- **Service level:** `Requests`, `Rejected`, `RequestFailed`, `ConfigBundledFallback`
- **Per `Route`/`Variant`/`Model`:** `ModelRequests`, `InputTokens`, `OutputTokens`, `EstimatedCostUsd`, `TimeToFirstTokenMs`, `LatencyMs`, `Fallbacks`, `Downgraded`, `GuardrailIntervened`

## Notes

- **Propagation isn't instant.** The extension polls every 30s (`AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS`), so after a deployment completes, warm environments pick up the change within about 30–60s. Lower the interval for faster propagation at the cost of more AppConfig calls.
- **Gradual deployments roll out by execution environment, not by request.**
- **The guardrail version is chosen in `compliance.json`.** CDK creates version `1`. Publish a new version and switch to it through config when you're ready.
- **Prices in `cost-policy.json` are approximate.** Check the current Bedrock pricing for your region.
