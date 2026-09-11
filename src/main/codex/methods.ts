/**
 * Nomes de métodos e notificações do Codex App Server que este aplicativo usa.
 *
 * ATENÇÃO — procedência dos nomes:
 * Estes identificadores seguem a documentação pública do App Server
 * (https://learn.chatgpt.com/docs/app-server) e são os que o aplicativo tenta
 * usar. Eles NÃO são prova de que a versão instalada os implementa.
 *
 * VERIFICAÇÃO PARCIAL (Codex 0.154.0, Windows, via `codex app-server
 * generate-ts`): todos os métodos em `CODEX_METHODS` constam do `ClientRequest`
 * daquela versão. Entre as notificações, três nomes que este aplicativo usava
 * NÃO existem lá — estão marcados um a um e listados em
 * `CODEX_EVENTS_NOT_IN_0_154_0`. As requisições iniciadas pelo servidor
 * continuam NÃO verificadas: dependem do arquivo `ServerRequest.ts` gerado.
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
  threadStatusChanged: 'thread/status/changed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  /**
   * NÃO existe no 0.154.0 — ver CODEX_EVENTS_NOT_IN_0_154_0. Mantido porque
   * ignorar um nome que o servidor nunca envia não custa nada, e removê-lo
   * quebraria versões que porventura o enviem.
   */
  turnFailed: 'turn/failed',
  turnPlanUpdated: 'turn/plan/updated',
  itemStarted: 'item/started',
  /** Também ausente no 0.154.0; ver a constante acima. */
  itemUpdated: 'item/updated',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  commandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  fileChangeOutputDelta: 'item/fileChange/outputDelta',
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  turnDiffUpdated: 'turn/diff/updated',
  accountUpdated: 'account/updated',
  accountLoginCompleted: 'account/login/completed',
  /** Ausente no 0.154.0: a falha chega dentro de `account/login/completed`. */
  accountLoginFailed: 'account/login/failed',
  accountRateLimitsUpdated: 'account/rateLimits/updated',
  modelRerouted: 'model/rerouted',
  warning: 'warning',
  configWarning: 'configWarning',
  deprecationNotice: 'deprecationNotice',
  error: 'error',
} as const;

/**
 * Nomes que este aplicativo já usou e que **não constam** do `ServerNotification`
 * do Codex 0.154.0 (verificado com `codex app-server generate-ts`). Ficam
 * tolerados no roteador, nunca anunciados como suportados.
 */
export const CODEX_EVENTS_NOT_IN_0_154_0 = [
  CODEX_EVENTS.turnFailed,
  CODEX_EVENTS.itemUpdated,
  CODEX_EVENTS.accountLoginFailed,
] as const;

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
