import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import Ajv from 'ajv';
import type { ComplianceConfig, CostPolicy, RoutingConfig } from '../src/router/types';

export const CONFIG_DIR = path.join(__dirname, '..', 'config');
export const PROFILE_NAMES = ['routing', 'cost-policy', 'compliance', 'flags'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export const readConfig = <T>(name: string): T =>
  JSON.parse(readFileSync(path.join(CONFIG_DIR, `${name}.json`), 'utf8')) as T;

/**
 * Validates every config file against its JSON Schema (the same schemas AppConfig
 * enforces) plus cross-profile rules a schema can't express.
 * Returns a list of errors; empty means valid.
 */
export function validateAll(): string[] {
  const errors: string[] = [];
  const ajv = new Ajv({ allErrors: true });

  for (const name of ['routing', 'cost-policy', 'compliance'] as const) {
    const schema = JSON.parse(readFileSync(path.join(CONFIG_DIR, 'schemas', `${name}.schema.json`), 'utf8'));
    const validate = ajv.compile(schema);
    if (!validate(readConfig(name))) {
      for (const e of validate.errors ?? []) errors.push(`${name}${e.instancePath}: ${e.message}`);
    }
  }

  const flags = readConfig<{ version: string; flags: Record<string, unknown>; values: Record<string, unknown> }>(
    'flags',
  );
  if (flags.version !== '1') errors.push('flags: version must be "1"');
  for (const key of Object.keys(flags.values ?? {})) {
    if (!flags.flags?.[key]) errors.push(`flags: value "${key}" has no flag definition`);
  }
  if (errors.length) return errors;

  const routing = readConfig<RoutingConfig>('routing');
  const cost = readConfig<CostPolicy>('cost-policy');
  const compliance = readConfig<ComplianceConfig>('compliance');
  const allowed = (m: string) => compliance.allowedModelPrefixes.some((p) => m.startsWith(p));

  if (!routing.routes[routing.defaultRoute]) errors.push(`routing: defaultRoute "${routing.defaultRoute}" not found`);
  for (const [routeName, route] of Object.entries(routing.routes)) {
    const names = route.variants.map((v) => v.name);
    if (new Set(names).size !== names.length) errors.push(`routing.${routeName}: duplicate variant names`);
    for (const v of route.variants) {
      if (!v.models.some(allowed)) {
        errors.push(`routing.${routeName}.${v.name}: no model allowed by compliance.allowedModelPrefixes`);
      }
      for (const m of v.models) {
        if (!cost.pricesPer1kTokensUsd[m]) errors.push(`cost-policy: missing price for ${m}`);
      }
    }
  }
  if (!allowed(cost.downgrade.model)) errors.push('cost-policy.downgrade.model is not allowed by compliance');
  for (const r of cost.downgrade.exemptRoutes ?? []) {
    if (!routing.routes[r]) errors.push(`cost-policy.downgrade.exemptRoutes: unknown route "${r}"`);
  }
  return [...new Set(errors)];
}

if (require.main === module) {
  const errors = validateAll();
  if (errors.length) {
    console.error(`Config invalid:\n  - ${errors.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('Config valid ✓');
}
