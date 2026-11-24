import type { ChatMessage, ChatRequest, ExecutionPlan, RuntimeConfig, Variant } from './types';

export class PolicyError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const flagOn = (cfg: RuntimeConfig, name: string, fallback: boolean) => cfg.flags[name]?.enabled ?? fallback;

/** FNV-1a 32-bit hash. Deterministic, so a user always lands in the same A/B variant. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function pickVariant(variants: Variant[], subjectKey: string): Variant {
  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  if (total <= 0) return variants[0];
  let bucket = hash32(subjectKey) % total;
  for (const v of variants) {
    if (bucket < v.weight) return v;
    bucket -= v.weight;
  }
  return variants[variants.length - 1];
}

function normalizeMessages(req: ChatRequest): ChatMessage[] {
  if (Array.isArray(req.messages) && req.messages.length > 0) {
    for (const m of req.messages) {
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content) {
        throw new PolicyError(400, 'Each message needs role "user" | "assistant" and non-empty string content');
      }
    }
    if (req.messages[req.messages.length - 1].role !== 'user') {
      throw new PolicyError(400, 'The last message must have role "user"');
    }
    return req.messages;
  }
  if (typeof req.prompt === 'string' && req.prompt.trim()) {
    return [{ role: 'user', content: req.prompt }];
  }
  throw new PolicyError(400, 'Provide "prompt" or a non-empty "messages" array');
}

/**
 * Turns a request plus the current runtime config into an execution plan.
 * Order: kill switch → route → input limits → A/B variant → cost downgrade → compliance filter.
 * Pure function, so every rule is unit-testable without AWS.
 */
export function resolvePlan(
  req: ChatRequest,
  cfg: RuntimeConfig,
  subjectId: string,
  guardrailId?: string,
): ExecutionPlan {
  if (flagOn(cfg, 'maintenance-mode', false)) {
    throw new PolicyError(503, 'Service is in maintenance mode');
  }

  const routeName = req.route ?? cfg.routing.defaultRoute;
  const route = cfg.routing.routes[routeName];
  if (!route) throw new PolicyError(400, `Unknown route "${routeName}"`);

  const messages = normalizeMessages(req);
  const inputChars = messages.reduce((n, m) => n + m.content.length, 0) + (route.systemPrompt?.length ?? 0);
  if (inputChars > cfg.costPolicy.maxInputChars) {
    throw new PolicyError(413, `Input too large (${inputChars} > ${cfg.costPolicy.maxInputChars} chars)`);
  }

  const variant = flagOn(cfg, 'ab-testing', true)
    ? pickVariant(route.variants, `${routeName}:${subjectId}`)
    : route.variants[0];

  let models = [...variant.models];
  const { downgrade } = cfg.costPolicy;
  const downgraded =
    downgrade.enabled &&
    inputChars > downgrade.inputCharsThreshold &&
    !(downgrade.exemptRoutes ?? []).includes(routeName);
  if (downgraded) {
    models = [downgrade.model, ...models.filter((m) => m !== downgrade.model)];
  }

  models = models.filter((m) => cfg.compliance.allowedModelPrefixes.some((p) => m.startsWith(p)));
  if (models.length === 0) {
    throw new PolicyError(403, `No model for route "${routeName}" is allowed by the compliance policy`);
  }
  if (!flagOn(cfg, 'model-fallback', true)) models = models.slice(0, 1);

  const maxTokens = Math.min(req.maxTokens ?? route.inference.maxTokens, cfg.costPolicy.maxOutputTokensCap);
  const { guardrail } = cfg.compliance;

  return {
    route: routeName,
    variant: variant.name,
    models,
    messages,
    systemPrompt: route.systemPrompt,
    inference: { ...route.inference, maxTokens },
    guardrail:
      guardrail.enabled && guardrailId
        ? { id: guardrailId, version: guardrail.version, streamProcessingMode: guardrail.streamProcessingMode ?? 'async' }
        : undefined,
    downgraded,
    inputChars,
  };
}

export function estimateCostUsd(
  cfg: RuntimeConfig,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number },
): number {
  const price = cfg.costPolicy.pricesPer1kTokensUsd[model];
  if (!price) return 0;
  return ((usage.inputTokens ?? 0) / 1000) * price.input + ((usage.outputTokens ?? 0) / 1000) * price.output;
}
