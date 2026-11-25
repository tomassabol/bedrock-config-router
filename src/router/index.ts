import { BedrockRuntimeClient, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEvent } from 'aws-lambda';

interface ModelConfig {
  enabled: boolean;
  modelId: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature?: number;
}

const logger = new Logger();
const metrics = new Metrics();
const bedrock = new BedrockRuntimeClient();

// The AppConfig extension serves the cached config on localhost and refreshes it in the background.
const CONFIG_URL = `http://localhost:2772/applications/${process.env.APPCONFIG_APPLICATION}/environments/${process.env.APPCONFIG_ENVIRONMENT}/configurations/model`;

async function getConfig() {
  const res = await fetch(CONFIG_URL);
  if (!res.ok) throw new Error(`AppConfig extension returned ${res.status}`);
  return { config: (await res.json()) as ModelConfig, version: res.headers.get('Configuration-Version') ?? '?' };
}

function parsePrompt(body: string | null): string | undefined {
  try {
    const prompt = JSON.parse(body ?? '{}').prompt;
    return typeof prompt === 'string' && prompt.trim() ? prompt : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(stream: awslambda.ResponseStream, statusCode: number, body: unknown) {
  const out = awslambda.HttpResponseStream.from(stream, { statusCode, headers: { 'content-type': 'application/json' } });
  // write() then end(): end(data) right after from() can drop the prelude, which API Gateway reports as a 502.
  out.write(JSON.stringify(body));
  out.end();
}

export const handler = awslambda.streamifyResponse<APIGatewayProxyEvent>(async (event, responseStream, context) => {
  logger.addContext(context);
  let out: awslambda.ResponseStream | undefined;
  try {
    const { config, version } = await getConfig();
    logger.appendKeys({ modelId: config.modelId, configVersion: version });

    if (!config.enabled) return sendJson(responseStream, 503, { error: 'Service disabled by config' });

    const prompt = parsePrompt(event.body);
    if (!prompt) return sendJson(responseStream, 400, { error: 'Missing "prompt"' });

    const { stream } = await bedrock.send(
      new ConverseStreamCommand({
        modelId: config.modelId,
        system: config.systemPrompt ? [{ text: config.systemPrompt }] : undefined,
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: config.maxTokens, temperature: config.temperature },
      }),
    );

    out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-model': config.modelId, 'x-config-version': version },
    });
    for await (const chunk of stream ?? []) {
      const text = chunk.contentBlockDelta?.delta?.text;
      if (text) out.write(text);
      if (chunk.metadata?.usage) {
        metrics.addDimension('Model', config.modelId);
        metrics.addMetric('InputTokens', MetricUnit.Count, chunk.metadata.usage.inputTokens ?? 0);
        metrics.addMetric('OutputTokens', MetricUnit.Count, chunk.metadata.usage.outputTokens ?? 0);
        logger.info('Completed', { usage: chunk.metadata.usage });
      }
    }
    out.end();
  } catch (error) {
    logger.error('Request failed', { error });
    metrics.addMetric('Errors', MetricUnit.Count, 1);
    // Once streaming has started the status code is already sent, so just close the stream.
    if (out) out.end();
    else sendJson(responseStream, 500, { error: 'Request failed' });
  } finally {
    metrics.publishStoredMetrics();
    logger.resetKeys();
  }
});
