/**
 * Acesso defensivo aos payloads do Codex App Server.
 *
 * Os nomes de campo variam entre versões do protocolo. Em vez de assumir uma
 * forma única, cada leitor tenta os aliases plausíveis e devolve `undefined`
 * quando nada corresponde — nunca um valor inventado.
 *
 * Com o Codex instalado, rode `npm run codex:types` e prefira os tipos gerados.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function pick(value: unknown, ...keys: string[]): unknown {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record && record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** Busca uma chave em profundidade limitada (payloads aninhados). */
export function deepPick(value: unknown, keys: string[], maxDepth = 3): unknown {
  const direct = pick(value, ...keys);
  if (direct !== undefined) return direct;
  if (maxDepth <= 0) return undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const child of Object.values(record)) {
    const found = deepPick(child, keys, maxDepth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function int(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function threadIdOf(params: unknown): string | undefined {
  return str(deepPick(params, ['threadId', 'thread_id', 'conversationId', 'conversation_id', 'sessionId']));
}

export function turnIdOf(params: unknown): string | undefined {
  return str(deepPick(params, ['turnId', 'turn_id']));
}

export function itemIdOf(params: unknown): string | undefined {
  return str(deepPick(params, ['itemId', 'item_id', 'id']));
}

export function deltaOf(params: unknown): string | undefined {
  const value = deepPick(params, ['delta', 'text', 'chunk', 'content']);
  if (typeof value === 'string') return value;
  return undefined;
}
