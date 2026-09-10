/**
 * Tipos de domínio compartilhados entre processo principal, preload e renderer.
 * Nada aqui depende de Electron, React ou de formatos brutos de fornecedores.
 */

/* ------------------------------------------------------------------ *
 * Identificadores
 * ------------------------------------------------------------------ */

export type AccountId = string;
export type ProviderId = string;
export type EngineId = 'codex' | 'direct';
export type ConversationId = string;
export type TurnId = string;
export type ItemId = string;
export type WorkspaceId = string;
export type ApprovalId = string;

/* ------------------------------------------------------------------ *
 * Capacidades (tri-estado + procedência)
 * ------------------------------------------------------------------ */

export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

/** De onde vem a afirmação de capacidade. `declared` ≠ `tested`. */
export type CapabilitySource = 'declared' | 'tested' | 'inferred';

export interface Capability {
  state: CapabilityState;
  source: CapabilitySource;
  /** Explicação curta, em pt-BR, do porquê deste estado. */
  reason?: string;
  /** ISO date da última observação. */
  observedAt?: string;
}

export type CapabilityKey =
  | 'chat'
  | 'streaming'
  | 'imageInput'
  | 'fileInput'
  | 'toolCalling'
  | 'taskExecution'
  | 'reasoningEffort'
  | 'reasoningSummary'
  | 'temperature'
  | 'personality';

export type CapabilityMap = Partial<Record<CapabilityKey, Capability>>;

export const UNKNOWN_CAPABILITY: Capability = { state: 'unknown', source: 'inferred' };

/* ------------------------------------------------------------------ *
 * Provedores e contas
 * ------------------------------------------------------------------ */

export type ProviderKind = 'openrouter' | 'compatible' | 'codex';

export type AuthKind = 'apiKey' | 'chatgptOAuth' | 'deviceCode' | 'none';

export interface ProviderDescriptor {
  id: ProviderId;
  kind: ProviderKind;
  /** Nome exibido na interface. */
  label: string;
  /** Descrição curta em pt-BR. */
  description: string;
  /** Motores que podem usar este provedor. */
  engines: EngineId[];
  authKinds: AuthKind[];
  /** URL base efetiva (endpoints compatíveis) — nunca contém credenciais. */
  baseUrl?: string;
  /** true quando o provedor foi cadastrado pela pessoa (endpoint compatível). */
  userDefined: boolean;
  docsUrl?: string;
}

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'unavailable'
  | 'error';

export interface ProviderConnection {
  providerId: ProviderId;
  state: ConnectionState;
  /** Identificador opaco da credencial guardada (nunca o segredo). */
  credentialId?: string;
  /** Representação mascarada, ex.: `sk-or-v1-…4f2a`. */
  maskedCredential?: string;
  /** Rótulo da conta quando o provedor informa (ex.: e-mail, plano). */
  accountLabel?: string;
  planLabel?: string;
  lastCheckedAt?: string;
  /** Mensagem em pt-BR pronta para exibição, com ação sugerida. */
  message?: string;
  actionHint?: string;
}

/* ------------------------------------------------------------------ *
 * Catálogo de modelos
 * ------------------------------------------------------------------ */

export interface ModelPricing {
  /** Valores por 1 token, exatamente como informados pelo provedor. */
  promptPerToken?: number;
  completionPerToken?: number;
  imagePerImage?: number;
  requestPerRequest?: number;
  webSearchPerRequest?: number;
  internalReasoningPerToken?: number;
  currency: string;
  /** Quando o provedor não informa preço. Ausência ≠ gratuito. */
  unknown: boolean;
}

export interface ModelDescriptor {
  /** ID exato usado nas requisições. */
  id: string;
  providerId: ProviderId;
  /** Nome de apresentação; cai para o ID quando ausente. */
  displayName: string;
  /** Autor/fornecedor de inferência declarado pelo catálogo, quando houver. */
  vendor?: string;
  description?: string;
  inputModalities: string[];
  outputModalities: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
  supportedParameters: string[];
  pricing: ModelPricing;
  capabilities: CapabilityMap;
  /** Campos específicos do Codex, quando informados pelo `model/list`. */
  codex?: CodexModelExtras;
  /** true quando o ID foi digitado manualmente e não veio de descoberta. */
  unverified: boolean;
  createdAt?: string;
}

export interface CodexModelExtras {
  isDefault?: boolean;
  reasoningEffortLevels?: string[];
  defaultReasoningEffort?: string;
  personalities?: string[];
  defaultPersonality?: string;
  upgradeAvailable?: boolean;
  upgradeNotice?: string;
}

export interface ModelCatalogPage {
  providerId: ProviderId;
  models: ModelDescriptor[];
  /** ISO date da coleta. */
  fetchedAt: string;
  /** true quando os dados vieram do cache local. */
  fromCache: boolean;
  /** Cursor devolvido pelo provedor, quando houver paginação. */
  nextCursor?: string;
  /** Aviso em pt-BR (ex.: catálogo parcial). */
  warning?: string;
}

/* ------------------------------------------------------------------ *
 * Parâmetros de turno
 * ------------------------------------------------------------------ */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface TurnParameters {
  modelId: string;
  providerId: ProviderId;
  engineId: EngineId;
  /** Só é enviado quando o modelo declara suporte. */
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  personality?: string;
  /** Preferências de roteamento (apenas OpenRouter). */
  routing?: RoutingPreferences;
  /** Skills selecionadas para o turno. */
  skillIds?: string[];
}

export interface RoutingPreferences {
  /** Fornecedores de inferência permitidos, em ordem de preferência. */
  order?: string[];
  only?: string[];
  ignore?: string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny';
  sort?: 'price' | 'throughput' | 'latency';
  /** Modelos de fallback autorizados explicitamente pela pessoa. */
  modelFallbacks?: string[];
  maxPricePromptPerToken?: number;
  maxPriceCompletionPerToken?: number;
}

/* ------------------------------------------------------------------ *
 * Modos de operação (aplicados no backend, não só no prompt)
 * ------------------------------------------------------------------ */

export type OperationMode = 'chat' | 'plan' | 'execute';

export type ApprovalPolicy = 'always' | 'onRequest' | 'onFailure' | 'never';

export type SandboxPolicy = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';

export type NetworkPolicy = 'blocked' | 'workspaceAllowed' | 'allowed';

export interface EffectivePolicy {
  mode: OperationMode;
  approvals: ApprovalPolicy;
  sandbox: SandboxPolicy;
  /** Rede das FERRAMENTAS do agente — distinta da rede da API de inferência. */
  toolNetwork: NetworkPolicy;
  /** Rede necessária para falar com a API de inferência. */
  inferenceNetwork: NetworkPolicy;
  /**
   * true somente quando o runtime confirmou a política.
   * Enquanto false, a interface mostra "solicitada", nunca "aplicada".
   */
  confirmedByRuntime: boolean;
  /** Motivo em pt-BR quando a política pedida não pôde ser aplicada. */
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  /** Caminho absoluto normalizado e resolvido (realpath). */
  path: string;
  lastUsedAt?: string;
  favorite: boolean;
  git?: GitSummary;
}

export interface GitSummary {
  available: boolean;
  isRepository: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  changedFiles?: number;
  dirty?: boolean;
  /** Motivo em pt-BR quando indisponível (git ausente, pasta sem repo…). */
  unavailableReason?: string;
}

export interface GitFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
  oldPath?: string;
  binary: boolean;
  additions?: number;
  deletions?: number;
}

/* ------------------------------------------------------------------ *
 * Conversas e itens
 * ------------------------------------------------------------------ */

export type ConversationStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'running'
  | 'awaitingApproval'
  | 'interrupting'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface ConversationSummary {
  id: ConversationId;
  title: string;
  /** true quando o título é local (não veio do motor). */
  titleIsLocal: boolean;
  engineId: EngineId;
  providerId: ProviderId;
  modelId: string;
  workspaceId?: WorkspaceId;
  workspacePath?: string;
  mode: OperationMode;
  archived: boolean;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  /** ID nativo da thread no motor (ex.: Codex thread id). */
  nativeThreadId?: string;
  /** Conversa da qual esta foi ramificada. */
  forkedFromId?: ConversationId;
  forkedFromItemId?: ItemId;
  status: ConversationStatus;
  lastMessagePreview?: string;
  messageCount: number;
  /** Parâmetros efetivos da conversa. Não contém nada sensível. */
  parameters: TurnParameters;
}

export type ItemRole = 'user' | 'assistant' | 'system' | 'tool';

export type ItemKind =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoningSummary'
  | 'plan'
  | 'commandExecution'
  | 'toolCall'
  | 'fileChange'
  | 'error'
  | 'notice';

export type ItemStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface AttachmentRef {
  id: string;
  kind: 'image' | 'document' | 'code' | 'unknown';
  fileName: string;
  /** Caminho absoluto dentro do workspace autorizado. */
  absolutePath?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Como o anexo foi entregue ao motor. */
  delivery?: AttachmentDelivery;
  /** Mensagem em pt-BR quando a preparação falhou. */
  error?: string;
}

export type AttachmentDelivery =
  | { type: 'codexImage'; path: string }
  | { type: 'codexLocalPath'; path: string }
  | { type: 'inlineImage'; mimeType: string; bytes: number }
  | { type: 'extractedText'; characters: number; pages?: number; sheets?: string[] }
  | { type: 'toolReadable'; path: string }
  | { type: 'failed'; reason: string };

export interface PlanStep {
  id: string;
  text: string;
  status: 'pending' | 'inProgress' | 'completed' | 'skipped';
}

export interface CommandExecutionData {
  command: string;
  /** Argumentos separados — nunca uma linha de shell concatenada. */
  argv?: string[];
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  /** Saída retida na interface (limitada). */
  output: string;
  outputTruncated: boolean;
  totalOutputBytes: number;
}

export interface ToolCallData {
  toolName: string;
  callId: string;
  /** Argumentos validados. Nunca argumentos parciais de streaming. */
  arguments?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  approvalId?: ApprovalId;
}

export interface FileChangeData {
  files: FileDiff[];
}

export interface FileDiff {
  path: string;
  changeKind: 'add' | 'modify' | 'delete' | 'rename';
  oldPath?: string;
  binary: boolean;
  additions: number;
  deletions: number;
  /** Diff unificado; ausente para binários. */
  unifiedDiff?: string;
}

export interface ConversationItem {
  id: ItemId;
  conversationId: ConversationId;
  turnId?: TurnId;
  role: ItemRole;
  kind: ItemKind;
  status: ItemStatus;
  createdAt: string;
  updatedAt: string;
  /** Texto acumulado (mensagens, resumos de raciocínio). */
  text?: string;
  attachments?: AttachmentRef[];
  plan?: PlanStep[];
  command?: CommandExecutionData;
  tool?: ToolCallData;
  fileChange?: FileChangeData;
  /** Modelo/motor efetivos deste item. */
  modelId?: string;
  providerId?: ProviderId;
  engineId?: EngineId;
  /** Fornecedor de inferência efetivamente usado, quando o provedor informa. */
  effectiveUpstream?: string;
  usage?: TokenUsage;
  errorDetail?: ErrorDetail;
  /** ID nativo do item no motor, quando existe. */
  nativeId?: string;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Custo informado pelo provedor. */
  reportedCost?: number;
  /** Estimativa local — sempre identificada como tal. */
  estimatedCost?: number;
  estimateBasis?: string;
  currency?: string;
}

export interface ErrorDetail {
  code: ErrorCode;
  /** Mensagem pt-BR pronta para exibição. */
  message: string;
  /** Ação concreta sugerida. */
  action?: string;
  /** Detalhe técnico já redigido (sem segredos). */
  technical?: string;
  retryable: boolean;
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'insufficientCredit'
  | 'rateLimited'
  | 'contextExceeded'
  | 'unsupportedParameter'
  | 'modelUnavailable'
  | 'providerUnavailable'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'protocol'
  | 'codexMissing'
  | 'codexIncompatible'
  | 'workspaceDenied'
  | 'approvalDenied'
  | 'toolLimit'
  | 'validation'
  | 'persistence'
  | 'internal';

/* ------------------------------------------------------------------ *
 * Aprovações
 * ------------------------------------------------------------------ */

export type ApprovalKind =
  | 'commandExecution'
  | 'fileWrite'
  | 'filePatch'
  | 'networkAccess'
  | 'additionalPermission'
  | 'toolCall';

export type ApprovalDecision = 'allowOnce' | 'allowForSession' | 'deny' | 'cancel';

export interface ApprovalRequest {
  id: ApprovalId;
  conversationId: ConversationId;
  turnId?: TurnId;
  engineId: EngineId;
  kind: ApprovalKind;
  createdAt: string;
  /** Título curto em pt-BR. */
  title: string;
  /** Justificativa vinda do motor, quando existe. */
  reason?: string;
  command?: { argv: string[]; cwd?: string; display: string };
  files?: string[];
  diffs?: FileDiff[];
  networkTargets?: string[];
  /** Somente decisões realmente aceitas por esta solicitação. */
  allowedDecisions: ApprovalDecision[];
  /** Heurística local — nunca apresentada como garantia. */
  risk?: RiskEstimate;
  /** Escopo concreto que "permitir na sessão" concede. */
  sessionScopeDescription?: string;
  expiresAt?: string;
}

export interface RiskEstimate {
  level: 'low' | 'medium' | 'high';
  /** Sempre 'heuristic' nesta versão. */
  method: 'heuristic';
  /** Regras que dispararam, em pt-BR. */
  signals: string[];
}

/* ------------------------------------------------------------------ *
 * Skills
 * ------------------------------------------------------------------ */

export interface SkillDescriptor {
  id: string;
  name: string;
  description?: string;
  /** Origem declarada pelo motor (ex.: projeto, usuário, embutida). */
  origin?: string;
  /** Caminho ou escopo, quando informado. */
  scope?: string;
  workspacePath?: string;
  engineId: EngineId;
  /** `available` só quando o motor confirma que pode invocá-la. */
  availability: CapabilityState;
  availabilityReason?: string;
  /**
   * true quando habilitar/desabilitar é apenas preferência local da interface
   * (não altera a configuração do Codex).
   */
  toggleIsLocalOnly: boolean;
  enabledLocally: boolean;
}

/* ------------------------------------------------------------------ *
 * Uso / limites
 * ------------------------------------------------------------------ */

export interface UsageSnapshot {
  providerId: ProviderId;
  /** Somente dados oficialmente retornados à credencial. */
  balance?: { amount: number; currency: string; label: string };
  spend?: { amount: number; currency: string; windowLabel: string };
  rateLimits?: RateLimitWindow[];
  fetchedAt: string;
  /** Explica o que não pôde ser obtido. Ausência ≠ zero ou ilimitado. */
  unavailable?: string[];
}

export interface RateLimitWindow {
  label: string;
  usedPercent?: number;
  remaining?: number;
  limit?: number;
  resetsAt?: string;
  windowMinutes?: number;
}

/* ------------------------------------------------------------------ *
 * Autenticação Codex
 * ------------------------------------------------------------------ */

export type CodexAuthMethod = 'chatgpt' | 'deviceCode' | 'apiKey';

export interface CodexAccountState {
  authenticated: boolean;
  method?: CodexAuthMethod;
  accountLabel?: string;
  planLabel?: string;
  rateLimits?: RateLimitWindow[];
  /** Mensagem pt-BR quando não autenticado ou com problema. */
  message?: string;
}

export interface CodexLoginProgress {
  loginId: string;
  method: CodexAuthMethod;
  state: 'starting' | 'pendingBrowser' | 'pendingDeviceCode' | 'completed' | 'cancelled' | 'expired' | 'error';
  /** Fluxo device code. */
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: string;
  message?: string;
}

export interface CodexRuntimeInfo {
  found: boolean;
  /** Caminho resolvido do executável. */
  executablePath?: string;
  /** Como foi encontrado. */
  discoveredVia?: 'setting' | 'path' | 'wellKnown';
  version?: string;
  /** `true` quando o handshake `initialize`/`initialized` concluiu. */
  initialized: boolean;
  protocolVersionReported?: string;
  /** Tipos gerados: versão registrada em src/generated/codex/VERSION. */
  generatedTypesVersion?: string;
  generatedTypesAreProvisional: boolean;
  diagnostic?: ErrorDetail;
  restartCount: number;
}

/* ------------------------------------------------------------------ *
 * Configurações
 * ------------------------------------------------------------------ */

export type ThemePreference = 'dark' | 'light' | 'system';
export type DensityPreference = 'compact' | 'comfortable';
export type StartupBehavior = 'newConversation' | 'lastConversation' | 'home';

export interface AppSettings {
  theme: ThemePreference;
  fontScale: number;
  density: DensityPreference;
  reduceMotion: 'system' | 'always' | 'never';
  defaultProviderId?: ProviderId;
  defaultModelId?: string;
  defaultEngineId: EngineId;
  defaultReasoningEffort?: ReasoningEffort;
  defaultPersonality?: string;
  defaultWorkspacePath?: string;
  defaultMode: OperationMode;
  approvalPolicy: ApprovalPolicy;
  sandboxPolicy: SandboxPolicy;
  toolNetworkPolicy: NetworkPolicy;
  startupBehavior: StartupBehavior;
  codexExecutablePath?: string;
  diagnosticsEnabled: boolean;
  diagnosticsLogLevel: 'error' | 'warn' | 'info' | 'debug';
  developerMode: boolean;
  demoMode: boolean;
  attachmentMaxCount: number;
  attachmentMaxBytes: number;
  toolMaxSteps: number;
  toolMaxDurationMs: number;
  toolMaxResultBytes: number;
  layout: LayoutPreferences;
}

/**
 * Alteração parcial de configurações. `layout` também é parcial: a interface
 * grava um campo de layout por vez (largura de painel, aba ativa…).
 */
export type SettingsPatch = Partial<Omit<AppSettings, 'layout'>> & { layout?: Partial<LayoutPreferences> };

export interface LayoutPreferences {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  rightPanelWidth: number;
  rightPanelCollapsed: boolean;
  rightPanelTab: 'files' | 'diff' | 'output' | 'context';
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  fontScale: 1,
  density: 'comfortable',
  reduceMotion: 'system',
  defaultEngineId: 'direct',
  defaultMode: 'chat',
  approvalPolicy: 'onRequest',
  sandboxPolicy: 'workspaceWrite',
  toolNetworkPolicy: 'blocked',
  startupBehavior: 'newConversation',
  diagnosticsEnabled: true,
  diagnosticsLogLevel: 'info',
  developerMode: false,
  demoMode: false,
  attachmentMaxCount: 20,
  attachmentMaxBytes: 25 * 1024 * 1024,
  toolMaxSteps: 24,
  toolMaxDurationMs: 5 * 60 * 1000,
  toolMaxResultBytes: 256 * 1024,
  layout: {
    sidebarWidth: 288,
    sidebarCollapsed: false,
    rightPanelWidth: 420,
    rightPanelCollapsed: true,
    rightPanelTab: 'diff',
  },
};

/* ------------------------------------------------------------------ *
 * Diagnóstico
 * ------------------------------------------------------------------ */

export interface DiagnosticsReport {
  generatedAt: string;
  app: { name: string; version: string };
  runtime: {
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
    osRelease: string;
  };
  codex: CodexRuntimeInfo;
  providers: Array<{
    providerId: ProviderId;
    kind: ProviderKind;
    state: ConnectionState;
    hasCredential: boolean;
    baseUrl?: string;
  }>;
  persistence: { schemaVersion: number; conversations: number; items: number; location: string };
  recentErrors: Array<{ at: string; scope: string; code: string; message: string }>;
  settings: Omit<AppSettings, 'layout'>;
  notes: string[];
}
