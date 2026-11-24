import { describe, expect, it } from 'vitest';
import compliance from '../config/compliance.json';
import costPolicy from '../config/cost-policy.json';
import flags from '../config/flags.json';
import routing from '../config/routing.json';
import { validateAll } from '../scripts/validate';
import { estimateCostUsd, PolicyError, pickVariant, resolvePlan } from '../src/router/policy';
import type { RuntimeConfig } from '../src/router/types';

const baseConfig = (): RuntimeConfig =>
  structuredClone({
    routing,
    costPolicy,
    compliance,
    flags: flags.values,
    versions: {},
    usedBundledFallback: false,
  }) as RuntimeConfig;

const statusOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyError) return e.statusCode;
    throw e;
  }
  return 200;
};

describe('config files', () => {
  it('pass schema and cross-profile validation', () => {
    expect(validateAll()).toEqual([]);
  });
});

describe('resolvePlan', () => {
  it('uses the default route and its first-choice model', () => {
    const plan = resolvePlan({ prompt: 'hi' }, baseConfig(), 'user-control', 'gr-1');
    expect(plan.route).toBe('chat');
    expect(plan.models.length).toBeGreaterThan(1);
    expect(plan.guardrail).toEqual({ id: 'gr-1', version: '1', streamProcessingMode: 'async' });
  });

  it('rejects everything when maintenance-mode is on', () => {
    const cfg = baseConfig();
    cfg.flags['maintenance-mode'] = { enabled: true };
    expect(statusOf(() => resolvePlan({ prompt: 'hi' }, cfg, 'u'))).toBe(503);
  });

  it('rejects unknown routes and empty input', () => {
    expect(statusOf(() => resolvePlan({ prompt: 'hi', route: 'nope' }, baseConfig(), 'u'))).toBe(400);
    expect(statusOf(() => resolvePlan({}, baseConfig(), 'u'))).toBe(400);
  });

  it('rejects input over maxInputChars', () => {
    const cfg = baseConfig();
    cfg.costPolicy.maxInputChars = 10;
    expect(statusOf(() => resolvePlan({ prompt: 'x'.repeat(100) }, cfg, 'u'))).toBe(413);
  });

  it('is sticky per user and splits traffic roughly by weight', () => {
    const cfg = baseConfig();
    const a = resolvePlan({ prompt: 'hi' }, cfg, 'alice').variant;
    expect(resolvePlan({ prompt: 'hi' }, cfg, 'alice').variant).toBe(a);

    const counts: Record<string, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const v = pickVariant(cfg.routing.routes.chat.variants, `chat:user-${i}`).name;
      counts[v] = (counts[v] ?? 0) + 1;
    }
    expect(counts['treatment-pro'] / 10_000).toBeGreaterThan(0.07);
    expect(counts['treatment-pro'] / 10_000).toBeLessThan(0.13);
  });

  it('always uses the first variant when ab-testing is off', () => {
    const cfg = baseConfig();
    cfg.flags['ab-testing'] = { enabled: false };
    for (let i = 0; i < 200; i++) expect(resolvePlan({ prompt: 'hi' }, cfg, `u${i}`).variant).toBe('control');
  });

  it('downgrades large inputs to the cheap model, except exempt routes', () => {
    const cfg = baseConfig();
    cfg.flags['ab-testing'] = { enabled: false };
    const big = 'x'.repeat(cfg.costPolicy.downgrade.inputCharsThreshold + 1);
    const plan = resolvePlan({ prompt: big }, cfg, 'u');
    expect(plan.downgraded).toBe(true);
    expect(plan.models[0]).toBe(cfg.costPolicy.downgrade.model);

    const exempt = resolvePlan({ prompt: big, route: 'reasoning' }, cfg, 'u');
    expect(exempt.downgraded).toBe(false);
    expect(exempt.models[0]).toBe('eu.amazon.nova-pro-v1:0');
  });

  it('drops models outside allowed prefixes and 403s when none remain', () => {
    const cfg = baseConfig();
    cfg.routing.routes.chat.variants = [{ name: 'control', weight: 100, models: ['global.amazon.nova-2-lite-v1:0'] }];
    expect(statusOf(() => resolvePlan({ prompt: 'hi' }, cfg, 'u'))).toBe(403);

    cfg.compliance.allowedModelPrefixes = ['eu.', 'global.'];
    expect(resolvePlan({ prompt: 'hi' }, cfg, 'u').models).toEqual(['global.amazon.nova-2-lite-v1:0']);
  });

  it('keeps only one model when model-fallback is off', () => {
    const cfg = baseConfig();
    cfg.flags['model-fallback'] = { enabled: false };
    expect(resolvePlan({ prompt: 'hi' }, cfg, 'u').models).toHaveLength(1);
  });

  it('caps maxTokens and omits the guardrail when disabled', () => {
    const cfg = baseConfig();
    cfg.compliance.guardrail.enabled = false;
    const plan = resolvePlan({ prompt: 'hi', maxTokens: 99_999 }, cfg, 'u', 'gr-1');
    expect(plan.inference.maxTokens).toBe(cfg.costPolicy.maxOutputTokensCap);
    expect(plan.guardrail).toBeUndefined();
  });
});

describe('estimateCostUsd', () => {
  it('prices by model', () => {
    const cost = estimateCostUsd(baseConfig(), 'eu.amazon.nova-micro-v1:0', { inputTokens: 1000, outputTokens: 1000 });
    expect(cost).toBeCloseTo(0.000175, 9);
  });
});
