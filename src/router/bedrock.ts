import {
  type BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamOutput,
} from '@aws-sdk/client-bedrock-runtime';
import type { Logger } from '@aws-lambda-powertools/logger';
import type { ExecutionPlan } from './types';

export interface OpenedStream {
  model: string;
  /** Number of models that failed before this one. */
  fallbacks: number;
  /** First event, already read so that early errors can trigger a fallback. */
  first: IteratorResult<ConverseStreamOutput>;
  rest: AsyncIterator<ConverseStreamOutput>;
}

/**
 * Opens a ConverseStream against each model in the plan in order, until one
 * returns its first event. Errors before the first event (throttling, access,
 * unsupported parameters) move to the next model; once tokens flow, we're committed.
 */
export async function openStreamWithFallback(
  client: BedrockRuntimeClient,
  plan: ExecutionPlan,
  logger: Logger,
): Promise<OpenedStream> {
  let lastError: unknown;
  for (const [index, model] of plan.models.entries()) {
    try {
      const res = await client.send(
        new ConverseStreamCommand({
          modelId: model,
          messages: plan.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
          system: plan.systemPrompt ? [{ text: plan.systemPrompt }] : undefined,
          inferenceConfig: plan.inference,
          guardrailConfig: plan.guardrail
            ? {
                guardrailIdentifier: plan.guardrail.id,
                guardrailVersion: plan.guardrail.version,
                streamProcessingMode: plan.guardrail.streamProcessingMode,
              }
            : undefined,
        }),
      );
      if (!res.stream) throw new Error('Bedrock returned no stream');
      const rest = res.stream[Symbol.asyncIterator]();
      const first = await rest.next();
      return { model, fallbacks: index, first, rest };
    } catch (error) {
      lastError = error;
      logger.warn('Model failed before streaming, trying next', {
        model,
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
        remaining: plan.models.length - index - 1,
      });
    }
  }
  throw lastError;
}
