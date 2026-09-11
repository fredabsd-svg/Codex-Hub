/**
 * Protocolo do Codex App Server.
 *
 * A documentação atual descreve JSON-RPC bidirecional com o campo `jsonrpc`
 * OMITIDO no fio. Portanto:
 *
 *   requisição  → { id, method, params? }
 *   resposta    → { id, result } | { id, error: { code, message, data? } }
 *   notificação → { method, params? }   (sem id)
 *
 * O servidor também INICIA requisições (aprovações, por exemplo). Elas precisam
 * de resposta correlacionada ao `id` original — não são notificações.
 *
 * Este módulo só classifica e serializa. Nenhum nome de método é inventado
 * aqui: os métodos usados ficam em `methods.ts` e o handshake em `client.ts`.
 */

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export type IncomingMessage =
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId; error: JsonRpcFailure['error'] }
  | { kind: 'serverRequest'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'invalid'; reason: string; raw: string };

export function classify(rawLine: string): IncomingMessage | null {
  const trimmed = rawLine.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid', reason: 'Linha não é JSON válido', raw: trimmed.slice(0, 400) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', reason: 'Mensagem não é um objeto JSON', raw: trimmed.slice(0, 400) };
  }
  const message = parsed as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
  const id = message.id as JsonRpcId | undefined;
  const method = typeof message.method === 'string' ? message.method : undefined;

  if (hasId && id !== undefined && method === undefined) {
    if (Object.prototype.hasOwnProperty.call(message, 'error')) {
      const error = message.error;
      if (error && typeof error === 'object') {
        const e = error as Record<string, unknown>;
        return {
          kind: 'error',
          id,
          error: {
            code: typeof e.code === 'number' ? e.code : -1,
            message: typeof e.message === 'string' ? e.message : 'Erro sem mensagem',
            data: e.data,
          },
        };
      }
      return { kind: 'invalid', reason: 'Campo `error` malformado', raw: trimmed.slice(0, 400) };
    }
    return { kind: 'response', id, result: message.result };
  }

  if (hasId && id !== undefined && method !== undefined) {
    return { kind: 'serverRequest', id, method, params: message.params };
  }

  if (method !== undefined) {
    return { kind: 'notification', method, params: message.params };
  }

  return { kind: 'invalid', reason: 'Mensagem sem `id` e sem `method`', raw: trimmed.slice(0, 400) };
}

/**
 * `params` SEMPRE vai na linha, mesmo vazio.
 *
 * Verificado contra o Codex 0.154.0: omitir o campo faz o servidor responder
 * `Invalid request: missing field \`params\`` — por exemplo em `account/read`,
 * que não recebe argumento nenhum. O desserializador do servidor exige o campo
 * presente, não apenas o conteúdo.
 */
export function encodeRequest(id: JsonRpcId, method: string, params?: unknown): string {
  const payload: JsonRpcRequest = { id, method, params: params ?? {} };
  return `${JSON.stringify(payload)}\n`;
}

export function encodeNotification(method: string, params?: unknown): string {
  const payload: JsonRpcNotification = { method, params: params ?? {} };
  return `${JSON.stringify(payload)}\n`;
}

export function encodeResponse(id: JsonRpcId, result: unknown): string {
  return `${JSON.stringify({ id, result } satisfies JsonRpcSuccess)}\n`;
}

export function encodeErrorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): string {
  const payload: JsonRpcFailure = { id, error: data === undefined ? { code, message } : { code, message, data } };
  return `${JSON.stringify(payload)}\n`;
}

/** Códigos JSON-RPC padrão usados nas respostas que o aplicativo devolve. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Faixa reservada para a aplicação. */
  requestCancelled: -32800,
  requestRejected: -32001,
} as const;
