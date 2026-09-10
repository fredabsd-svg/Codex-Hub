import type { ModelDescriptor, TokenUsage } from '../../shared/domain';

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Converte o bloco `usage` do provedor. Campos ausentes ficam ausentes:
 * um dado indisponível NUNCA se transforma em zero.
 */
export function usageFromRaw(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const total = num(u.total_tokens);
  const cost = num(u.cost);
  const details = u.completion_tokens_details;
  const reasoning =
    details && typeof details === 'object' ? num((details as Record<string, unknown>).reasoning_tokens) : undefined;
  if (prompt === undefined && completion === undefined && total === undefined && cost === undefined) return undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    reasoningTokens: reasoning,
    totalTokens: total,
    reportedCost: cost,
    currency: cost !== undefined ? 'USD' : undefined,
  };
}

/**
 * Estimativa local de custo — SEMPRE identificada como estimativa, com a base
 * de cálculo explícita. Só é calculada quando há preço informado no catálogo.
 */
export function estimateCost(usage: TokenUsage | undefined, model: ModelDescriptor | undefined): TokenUsage | undefined {
  if (!usage) return usage;
  if (usage.reportedCost !== undefined) return usage;
  if (!model || model.pricing.unknown) return usage;
  const promptPrice = model.pricing.promptPerToken;
  const completionPrice = model.pricing.completionPerToken;
  if (promptPrice === undefined && completionPrice === undefined) return usage;
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  const amount = promptTokens * (promptPrice ?? 0) + completionTokens * (completionPrice ?? 0);
  if (!Number.isFinite(amount)) return usage;
  return {
    ...usage,
    estimatedCost: amount,
    currency: usage.currency ?? model.pricing.currency,
    estimateBasis: `Estimativa local: ${promptTokens} tokens de entrada × ${promptPrice ?? 0} + ${completionTokens} tokens de saída × ${completionPrice ?? 0} (${model.pricing.currency} por token, preço declarado no catálogo).`,
  };
}

/**
 * Estimativa de tokens quando não há contagem oficial.
 * Heurística explícita: ~4 caracteres por token. Nunca apresentada como
 * contagem real.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
