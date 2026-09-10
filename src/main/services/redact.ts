/**
 * Redação de segredos.
 *
 * Aplicada a TODO texto que vai para log, diagnóstico, `stderr` do Codex e
 * payloads de erro. É uma rede de segurança — o caminho correto continua
 * sendo nunca colocar segredos em texto de log.
 */

const PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // Chaves OpenRouter / OpenAI / Anthropic / genéricas com prefixo.
  { re: /\bsk-or-v1-[A-Za-z0-9_-]{8,}/g, replace: 'sk-or-v1-[REDIGIDO]' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: 'sk-ant-[REDIGIDO]' },
  { re: /\bsk-proj-[A-Za-z0-9_-]{8,}/g, replace: 'sk-proj-[REDIGIDO]' },
  { re: /\bsk-[A-Za-z0-9]{16,}/g, replace: 'sk-[REDIGIDO]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: 'gh*_[REDIGIDO]' },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: 'AIza[REDIGIDO]' },
  // JWT.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, replace: 'eyJ[REDIGIDO]' },
  // Cabeçalhos e campos nomeados.
  { re: /(authorization\s*[:=]\s*)(bearer\s+)?\S+/gi, replace: '$1$2[REDIGIDO]' },
  { re: /(x-api-key\s*[:=]\s*)\S+/gi, replace: '$1[REDIGIDO]' },
  { re: /("?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret)"?\s*[:=]\s*")([^"]{2,})(")/gi, replace: '$1[REDIGIDO]$3' },
  { re: /((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret)\s*[:=]\s*)([^\s,;"'}]{4,})/gi, replace: '$1[REDIGIDO]' },
  // Segredos em query string.
  { re: /([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, replace: '$1[REDIGIDO]' },
];

/** Segredos registrados em runtime (valor exato) para redação garantida. */
const knownSecrets = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
  if (typeof secret === 'string' && secret.trim().length >= 8) knownSecrets.add(secret.trim());
}

export function forgetSecret(secret: string | undefined | null): void {
  if (typeof secret === 'string') knownSecrets.delete(secret.trim());
}

export function clearRegisteredSecrets(): void {
  knownSecrets.clear();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactText(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDIGIDO]');
  }
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

const SENSITIVE_KEY = /^(api[_-]?key|apikey|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|cookie|set-cookie|x-api-key)$/i;

/** Redige recursivamente estruturas antes de serializar. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[PROFUNDIDADE_MÁXIMA]';
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDIGIDO]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return '[NÃO_SERIALIZÁVEL]';
}

/** Representação mascarada estável para exibir uma credencial na interface. */
export function maskCredential(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) return '•'.repeat(Math.max(trimmed.length, 4));
  const prefixMatch = /^(sk-or-v1-|sk-ant-|sk-proj-|sk-)/.exec(trimmed);
  const prefix = prefixMatch?.[1] ?? trimmed.slice(0, 4);
  return `${prefix}…${trimmed.slice(-4)}`;
}
