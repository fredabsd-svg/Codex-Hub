/**
 * Nomes de métodos e notificações do Codex App Server que este aplicativo usa.
 *
 * ATENÇÃO — procedência dos nomes:
 * Estes identificadores seguem a documentação pública do App Server
 * (https://learn.chatgpt.com/docs/app-server) e são os que o aplicativo tenta
 * usar. Eles NÃO são prova de que a versão instalada os implementa.
 *
 * O `CodexAppServerClient`:
 *  - trata `-32601 method not found` como "recurso ausente nesta versão" e
 *    reporta isso na interface como indisponível, com motivo concreto;
 *  - trata notificações desconhecidas como eventos ignorados (registrados em
 *    modo desenvolvedor), nunca como erro fatal;
 *  - NÃO inventa eventos para preencher a interface.
 *
 * Rode `npm run codex:types` com o Codex instalado para gerar os tipos reais em
 * `src/generated/codex`. Ver src/generated/codex/README.md.
 */

export const CODEX_METHODS = {
  initialize: 'initialize',

  accountRead: 'account/read',
  accountLoginStart: 'account/login/start',
  accountLoginCancel: 'account/login/cancel',
  accountLogout: 'account/logout',
  accountRateLimitsRead: 'account/rateLimits/read',

  modelList: 'model/list',
  skillsList: 'skills/list',

  threadStart: 'thread/start',
  threadList: 'thread/list',
  threadRead: 'thread/read',
  threadResume: 'thread/resume',
  threadFork: 'thread/fork',
  threadArchive: 'thread/archive',
  threadUnarchive: 'thread/unarchive',

  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
} as const;

export const CODEX_NOTIFICATIONS = {
  initialized: 'initialized',
} as const;

/**
 * Notificações que o servidor envia e que o roteador de eventos entende.
 * Qualquer outra é ignorada com registro em modo desenvolvedor.
 */
export const CODEX_EVENTS = {
  threadStarted: 'thread/started',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnFailed: 'turn/failed',
  itemStarted: 'item/started',
  itemUpdated: 'item/updated',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  turnDiffUpdated: 'turn/diff/updated',
  accountUpdated: 'account/updated',
  accountLoginCompleted: 'account/login/completed',
  accountLoginFailed: 'account/login/failed',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  error: 'error',
} as const;

/**
 * Requisições INICIADAS PELO SERVIDOR que o aplicativo responde.
 * Aprovações chegam por aqui — precisam de resposta correlacionada ao `id`.
 */
export const CODEX_SERVER_REQUESTS = {
  execCommandApproval: 'execCommandApproval',
  applyPatchApproval: 'applyPatchApproval',
} as const;

/** Aliases aceitos para a mesma intenção, conforme a versão do servidor. */
export const APPROVAL_REQUEST_ALIASES = [
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/approvalRequested',
  'item/fileChange/approvalRequested',
  'turn/approvalRequested',
  'approval/request',
] as const;

export function isApprovalRequestMethod(method: string): boolean {
  return (APPROVAL_REQUEST_ALIASES as readonly string[]).includes(method);
}
