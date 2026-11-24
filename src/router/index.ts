import { BedrockRuntimeClient, type ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { Logger } from '@aws-lambda-powertools/logger';
import { Metrics, MetricUnit } from '@aws-lambda-powertools/metrics';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { openStreamWithFallback } from './bedrock';
import { loadRuntimeConfig } from './config';
import { estimateCostUsd, PolicyError, resolvePlan } from './policy';
import type { ChatRequest } from './types';

const SERVICE = 'bedrock-config-router';
const NAMESPACE = process.env.POWERTOOLS_METRICS_NAMESPACE ?? 'BedrockConfigRouter';

const logger = new Logger({ serviceName: SERVICE });
const metrics = new Metrics({ namespace: NAMESPACE, serviceName: SERVICE });
const bedrock = new BedrockRuntimeClient({ maxAttempts: 2 });

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function writeJson(stream: awslambda.ResponseStream, statusCode: number, body: unknown) {
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode,
    headers: { 'content-type': 'application/json' },
  });
  // write() then end(): end(data) right after from() can drop the prelude, which API Gateway reports as a 502.
  out.write(JSON.stringify(body));
  out.end();
}

function parseBody(event: APIGatewayProxyEvent): ChatRequest {
  if (!event.body) throw new PolicyError(400, 'Missing request body');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw) as ChatRequest;
  } catch {
    throw new PolicyError(400, 'Body must be valid JSON');
  }
}

export const handler = awslambda.streamifyResponse<APIGatewayProxyEvent>(async (event, responseStream, context) => {
  logger.addContext(context);
  const started = Date.now();
  metrics.addMetric('Requests', MetricUnit.Count, 1);

  try {
    const cfg = await loadRuntimeConfig(logger);
    if (cfg.usedBundledFallback) metrics.addMetric('ConfigBundledFallback', MetricUnit.Count, 1);

    const req = parseBody(event);
    const subjectId = req.userId ?? event.requestContext?.identity?.userArn ?? context.awsRequestId;
    const plan = resolvePlan(req, cfg, subjectId, process.env.GUARDRAIL_ID);

    logger.appendKeys({ route: plan.route, variant: plan.variant, configVersions: cfg.versions });
    logger.info('Resolved plan', {
      models: plan.models,
      downgraded: plan.downgraded,
      guardrail: plan.guardrail ? `${plan.guardrail.id}:${plan.guardrail.version}` : 'off',
      inputChars: plan.inputChars,
      ...(cfg.compliance.logPrompts ? { messages: plan.messages } : {}),
    });

    const opened = await openStreamWithFallback(bedrock, plan, logger);
    const ttfbMs = Date.now() - started;

    // Headers are committed only now, after a model accepted the request.
    const out = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-route': plan.route,
        'x-variant': plan.variant,
        'x-model': opened.model,
      },
    });
    out.write(
      sse('meta', {
        route: plan.route,
        variant: plan.variant,
        model: opened.model,
        fallbacks: opened.fallbacks,
        downgraded: plan.downgraded,
        configVersions: cfg.versions,
      }),
    );

    let usage: { inputTokens?: number; outputTokens?: number } = {};
    let stopReason: string | undefined;
    const handle = (ev: ConverseStreamOutput) => {
      const text = ev.contentBlockDelta?.delta?.text;
      if (text) out.write(sse('delta', { text }));
      if (ev.messageStop) stopReason = ev.messageStop.stopReason;
      if (ev.metadata?.usage) usage = ev.metadata.usage;
    };

    let streamFailed = false;
    try {
      if (!opened.first.done) handle(opened.first.value);
      for (let r = await opened.rest.next(); !r.done; r = await opened.rest.next()) handle(r.value);
    } catch (error) {
      // Tokens already went out, so we can't switch model or status code: report in-band.
      streamFailed = true;
      logger.error('Stream failed mid-response', { error });
      out.write(sse('error', { message: 'Upstream model stream failed' }));
    }

    const costUsd = estimateCostUsd(cfg, opened.model, usage);
    out.write(sse('done', { stopReason, usage, estimatedCostUsd: Number(costUsd.toFixed(8)) }));
    out.end();

    if (streamFailed) metrics.addMetric('RequestFailed', MetricUnit.Count, 1);

    // Per-model metrics in their own EMF blob so they get Route/Variant/Model dimensions.
    const perModel = new Metrics({
      namespace: NAMESPACE,
      serviceName: SERVICE,
      defaultDimensions: { Route: plan.route, Variant: plan.variant, Model: opened.model },
    });
    perModel.addMetric('ModelRequests', MetricUnit.Count, 1);
    perModel.addMetric('InputTokens', MetricUnit.Count, usage.inputTokens ?? 0);
    perModel.addMetric('OutputTokens', MetricUnit.Count, usage.outputTokens ?? 0);
    perModel.addMetric('EstimatedCostUsd', MetricUnit.NoUnit, costUsd);
    perModel.addMetric('TimeToFirstTokenMs', MetricUnit.Milliseconds, ttfbMs);
    perModel.addMetric('LatencyMs', MetricUnit.Milliseconds, Date.now() - started);
    perModel.addMetric('Fallbacks', MetricUnit.Count, opened.fallbacks);
    perModel.addMetric('Downgraded', MetricUnit.Count, plan.downgraded ? 1 : 0);
    perModel.addMetric('GuardrailIntervened', MetricUnit.Count, stopReason === 'guardrail_intervened' ? 1 : 0);
    perModel.publishStoredMetrics();

    logger.info('Completed', { model: opened.model, stopReason, usage, costUsd, latencyMs: Date.now() - started });
  } catch (error) {
    if (error instanceof PolicyError) {
      metrics.addMetric('Rejected', MetricUnit.Count, 1);
      logger.info('Request rejected by policy', { statusCode: error.statusCode, reason: error.message });
      writeJson(responseStream, error.statusCode, { error: error.message });
    } else {
      metrics.addMetric('RequestFailed', MetricUnit.Count, 1);
      logger.error('All models failed', { error });
      writeJson(responseStream, 502, { error: 'All candidate models failed' });
    }
  } finally {
    metrics.publishStoredMetrics();
    logger.resetKeys();
  }
});
