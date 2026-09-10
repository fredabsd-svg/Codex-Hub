/**
 * Formatação para exibição, sempre em pt-BR.
 *
 * Regras de honestidade aplicadas aqui:
 *  - dado ausente vira "Não informado", nunca 0, "grátis" ou "ilimitado";
 *  - preço sempre com unidade explícita;
 *  - estimativa é rotulada como estimativa.
 */

import type { ModelPricing, TokenUsage } from '@shared/domain';

export const NOT_INFORMED = 'Não informado';

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short' });
const relativeUnits: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];
const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return NOT_INFORMED;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_INFORMED;
  return dateTime.format(date);
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return timeOnly.format(date);
}

export function formatRelative(iso: string | undefined): string {
  if (!iso) return NOT_INFORMED;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_INFORMED;
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return 'agora';
  for (const [unit, ms] of relativeUnits) {
    if (abs >= ms) return relative.format(Math.round(diff / ms), unit);
  }
  return relative.format(Math.round(diff / 1000), 'second');
}

export function formatNumber(value: number | undefined, fallback = NOT_INFORMED): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat('pt-BR').format(value);
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return NOT_INFORMED;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return NOT_INFORMED;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return formatNumber(value);
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return NOT_INFORMED;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds.toString().padStart(2, '0')} s`;
}

/**
 * Preço por milhão de tokens, com unidade explícita.
 * O catálogo informa preço POR TOKEN; multiplicamos por 1e6 apenas para
 * exibição e dizemos isso no rótulo.
 */
export function formatPricePerMillion(perToken: number | undefined, currency: string): string | null {
  if (perToken === undefined || !Number.isFinite(perToken)) return null;
  const perMillion = perToken * 1_000_000;
  const digits = perMillion < 1 ? 4 : perMillion < 100 ? 2 : 2;
  return `${currency} ${perMillion.toFixed(digits)} / 1M tokens`;
}

export function describePricing(pricing: ModelPricing): { label: string; detail: string[] } {
  if (pricing.unknown) {
    return {
      label: NOT_INFORMED,
      detail: ['O provedor não informou preço para este modelo. Ausência de preço não significa gratuito.'],
    };
  }
  const detail: string[] = [];
  const prompt = formatPricePerMillion(pricing.promptPerToken, pricing.currency);
  const completion = formatPricePerMillion(pricing.completionPerToken, pricing.currency);
  if (prompt) detail.push(`Entrada: ${prompt}`);
  if (completion) detail.push(`Saída: ${completion}`);
  if (pricing.imagePerImage !== undefined) {
    detail.push(`Imagem: ${pricing.currency} ${pricing.imagePerImage.toFixed(6)} por imagem`);
  }
  if (pricing.requestPerRequest !== undefined && pricing.requestPerRequest > 0) {
    detail.push(`Por requisição: ${pricing.currency} ${pricing.requestPerRequest.toFixed(6)}`);
  }
  if (pricing.internalReasoningPerToken !== undefined) {
    const reasoning = formatPricePerMillion(pricing.internalReasoningPerToken, pricing.currency);
    if (reasoning) detail.push(`Raciocínio interno: ${reasoning}`);
  }
  const zero =
    (pricing.promptPerToken ?? 1) === 0 && (pricing.completionPerToken ?? 1) === 0 && detail.length > 0;
  return {
    label: zero ? 'Sem custo informado (0)' : (prompt ?? completion ?? NOT_INFORMED),
    detail: detail.length > 0 ? detail : ['O provedor informou preço, mas sem valores utilizáveis.'],
  };
}

export function describeUsage(usage: TokenUsage | undefined): string[] {
  if (!usage) return ['Sem dados de uso informados pelo provedor.'];
  const lines: string[] = [];
  if (usage.promptTokens !== undefined) lines.push(`Entrada: ${formatNumber(usage.promptTokens)} tokens`);
  if (usage.completionTokens !== undefined) lines.push(`Saída: ${formatNumber(usage.completionTokens)} tokens`);
  if (usage.reasoningTokens !== undefined) lines.push(`Raciocínio: ${formatNumber(usage.reasoningTokens)} tokens`);
  if (usage.totalTokens !== undefined) lines.push(`Total: ${formatNumber(usage.totalTokens)} tokens`);
  if (usage.reportedCost !== undefined) {
    lines.push(`Custo informado pelo provedor: ${usage.currency ?? 'USD'} ${usage.reportedCost.toFixed(6)}`);
  } else if (usage.estimatedCost !== undefined) {
    lines.push(
      `Custo ESTIMADO localmente: ${usage.currency ?? 'USD'} ${usage.estimatedCost.toFixed(6)}${
        usage.estimateBasis ? ` — ${usage.estimateBasis}` : ''
      }`,
    );
  } else {
    lines.push('O provedor não informou custo para este turno.');
  }
  return lines.length > 0 ? lines : ['Sem dados de uso informados pelo provedor.'];
}

export function formatContextWindow(tokens: number | undefined): string {
  if (tokens === undefined) return NOT_INFORMED;
  return `${formatTokens(tokens)} tokens`;
}

export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(value.length - half)}`;
}

export function pluralize(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
