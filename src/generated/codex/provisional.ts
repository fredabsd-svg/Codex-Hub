/**
 * TIPOS PROVISÓRIOS — NÃO são os tipos gerados pelo Codex.
 *
 * Existem apenas para documentar a FORMA ESPERADA das mensagens enquanto
 * `npm run codex:types` não foi executado. Nenhum módulo de produção depende
 * deles para funcionar: `src/main/codex/parse.ts` lê os payloads de forma
 * defensiva.
 *
 * Ao gerar os tipos reais, prefira-os e remova este arquivo.
 */

export interface ProvisionalClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface ProvisionalInitializeParams {
  clientInfo: ProvisionalClientInfo;
}

export interface ProvisionalInitializeResult {
  /** Pode não existir em todas as versões. */
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
}

export interface ProvisionalThreadStartParams {
  cwd?: string;
  model?: string;
  approvalPolicy?: string;
  sandbox?: string;
  reasoningEffort?: string;
  personality?: string;
}

export interface ProvisionalThreadStartResult {
  threadId?: string;
}

export type ProvisionalTurnInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'localImage'; path: string };

export interface ProvisionalTurnStartParams {
  threadId: string;
  input: ProvisionalTurnInputItem[];
  model?: string;
  reasoningEffort?: string;
}

export interface ProvisionalApprovalRequestParams {
  threadId?: string;
  turnId?: string;
  command?: string | string[];
  argv?: string[];
  cwd?: string;
  reason?: string;
  changes?: Record<string, { unifiedDiff?: string }> | Array<{ path?: string }>;
}

export interface ProvisionalApprovalResponse {
  decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
  approved?: boolean;
}
