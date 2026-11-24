export interface InferenceParams {
  maxTokens: number;
  temperature?: number;
  topP?: number;
}

export interface Variant {
  name: string;
  weight: number;
  models: string[];
}

export interface RouteConfig {
  description?: string;
  systemPrompt?: string;
  inference: InferenceParams;
  variants: Variant[];
}

export interface RoutingConfig {
  defaultRoute: string;
  routes: Record<string, RouteConfig>;
}

export interface CostPolicy {
  maxInputChars: number;
  maxOutputTokensCap: number;
  downgrade: {
    enabled: boolean;
    inputCharsThreshold: number;
    model: string;
    exemptRoutes?: string[];
  };
  pricesPer1kTokensUsd: Record<string, { input: number; output: number }>;
}

export interface ComplianceConfig {
  allowedModelPrefixes: string[];
  guardrail: {
    enabled: boolean;
    version: string;
    streamProcessingMode?: 'sync' | 'async';
  };
  logPrompts: boolean;
}

/** Feature flag values as returned by the AppConfig extension. */
export type Flags = Record<string, { enabled: boolean }>;

export interface RuntimeConfig {
  routing: RoutingConfig;
  costPolicy: CostPolicy;
  compliance: ComplianceConfig;
  flags: Flags;
  /** Version per profile, e.g. { routing: "3", flags: "bundled" }. */
  versions: Record<string, string>;
  /** True when at least one profile came from the bundled defaults. */
  usedBundledFallback: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  route?: string;
  prompt?: string;
  messages?: ChatMessage[];
  userId?: string;
  maxTokens?: number;
}

export interface ExecutionPlan {
  route: string;
  variant: string;
  models: string[];
  messages: ChatMessage[];
  systemPrompt?: string;
  inference: InferenceParams;
  guardrail?: { id: string; version: string; streamProcessingMode: 'sync' | 'async' };
  downgraded: boolean;
  inputChars: number;
}
