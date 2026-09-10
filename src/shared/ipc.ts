/**
 * Contratos de IPC.
 *
 * Regras:
 *  - Lista de canais EXPLÍCITA. Nada é encaminhado genericamente.
 *  - Todo payload de entrada é validado por schema em runtime no processo principal.
 *  - Segredos entram (chave de API) mas nunca saem.
 */

import type {
  AppSettings,
  ApprovalDecision,
  ApprovalRequest,
  CodexAccountState,
  CodexAuthMethod,
  CodexRuntimeInfo,
  ConversationId,
  ConversationItem,
  ConversationSummary,
  DiagnosticsReport,
  EffectivePolicy,
  EngineId,
  GitFileChange,
  GitSummary,
  ModelCatalogPage,
  OperationMode,
  ProviderConnection,
  ProviderDescriptor,
  ProviderId,
  SettingsPatch,
  SkillDescriptor,
  TurnParameters,
  UsageSnapshot,
  WorkspaceSummary,
  AttachmentRef,
} from './domain';
import type { AppEvent, DomainEvent } from './events';
import type { ConversationExportFormat } from './conversationExport';

export const IPC_INVOKE_CHANNELS = [
  'app:getBootstrap',
  'settings:get',
  'settings:update',

  'providers:list',
  'providers:connections',
  'providers:connect',
  'providers:disconnect',
  'providers:test',
  'providers:registerCompatible',
  'providers:removeCompatible',
  'providers:usage',

  'catalog:list',
  'catalog:refresh',
  'catalog:addManualModel',
  'catalog:setFavorite',
  'catalog:probeCapability',

  'codex:runtime',
  'codex:locate',
  'codex:start',
  'codex:stop',
  'codex:account',
  'codex:loginStart',
  'codex:loginCancel',
  'codex:logout',
  'codex:rateLimits',
  'codex:skills',

  'conversations:list',
  'conversations:create',
  'conversations:read',
  'conversations:items',
  'conversations:rename',
  'conversations:archive',
  'conversations:unarchive',
  'conversations:delete',
  'conversations:fork',
  'conversations:setFavorite',
  'conversations:search',
  'conversations:export',
  'conversations:saveDraft',
  'conversations:readDraft',
  'conversations:setParameters',
  'conversations:setMode',
  'conversations:setWorkspace',

  'turn:send',
  'turn:steer',
  'turn:interrupt',
  'turn:policy',

  'approvals:pending',
  'approvals:resolve',

  'workspaces:list',
  'workspaces:choose',
  'workspaces:register',
  'workspaces:remove',
  'workspaces:setFavorite',
  'workspaces:git',
  'workspaces:gitChanges',
  'workspaces:fileTree',
  'workspaces:readFile',

  'attachments:choose',
  'attachments:prepare',
  'attachments:prepareFromPaths',
  'attachments:prepareFromClipboardImage',
  'attachments:discard',

  'diagnostics:report',
  'diagnostics:export',
  'diagnostics:openLogFolder',

  'shell:openExternal',
  'shell:showItemInFolder',
  'clipboard:writeText',
] as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number];

export const IPC_EVENT_CHANNELS = ['event:domain', 'event:app'] as const;
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

export interface BootstrapPayload {
  appName: string;
  appVersion: string;
  platform: string;
  isPackaged: boolean;
  settings: AppSettings;
  providers: ProviderDescriptor[];
  connections: ProviderConnection[];
  codex: CodexRuntimeInfo;
  workspaces: WorkspaceSummary[];
  conversations: ConversationSummary[];
  /** Favoritos do catálogo (`providerId::modelId`), persistidos entre sessões. */
  modelFavorites: string[];
  /** Modelos usados recentemente (`providerId::modelId`), do mais recente ao mais antigo. */
  recentModels: string[];
  onboardingCompleted: boolean;
  /** Avisos de inicialização em pt-BR (ex.: safeStorage indisponível). */
  notices: Array<{ level: 'info' | 'warn' | 'error'; message: string; action?: string }>;
}

export interface ConnectProviderInput {
  providerId: ProviderId;
  /** Segredo transitório. Entra por IPC, nunca volta. */
  apiKey?: string;
  /** Quando false, a credencial não é persistida (só a sessão atual). */
  persist: boolean;
}

export interface RegisterCompatibleInput {
  label: string;
  baseUrl: string;
  apiKey?: string;
  persist: boolean;
  /** Cabeçalhos extras permitidos (nomes validados). */
  headers?: Record<string, string>;
}

export interface CatalogListInput {
  providerId: ProviderId;
  cursor?: string;
  forceRefresh?: boolean;
}

export interface AddManualModelInput {
  providerId: ProviderId;
  modelId: string;
  displayName?: string;
}

export interface CreateConversationInput {
  engineId: EngineId;
  providerId: ProviderId;
  modelId: string;
  workspacePath?: string;
  mode: OperationMode;
  title?: string;
}

export interface SendTurnInput {
  conversationId: ConversationId;
  text: string;
  attachmentIds?: string[];
  parameters?: Partial<TurnParameters>;
  /** Quando true, envia como orientação ao turno em andamento. */
  asSteer?: boolean;
}

export interface ForkConversationInput {
  conversationId: ConversationId;
  /** Ramifica a partir deste item (inclusive, salvo `exclusive`). */
  fromItemId?: string;
  /** Quando true, a ramificação termina ANTES de `fromItemId` (editar e reenviar). */
  exclusive?: boolean;
  title?: string;
}

export interface ResolveApprovalInput {
  approvalId: string;
  decision: ApprovalDecision;
  note?: string;
}

export interface PrepareAttachmentsInput {
  conversationId: ConversationId;
  /** Caminhos vindos de um diálogo nativo ou de `webUtils.getPathForFile`. */
  paths: string[];
}

export interface PrepareClipboardImageInput {
  conversationId: ConversationId;
  /** PNG em base64 obtido do evento de paste no renderer. */
  base64: string;
  suggestedName?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
  children?: FileTreeNode[];
  truncated?: boolean;
}

export interface SearchConversationsResult {
  conversations: ConversationSummary[];
  matches: Array<{ conversationId: ConversationId; itemId: string; snippet: string }>;
}

export type { ConversationExportFormat };

export interface CapabilityProbeInput {
  providerId: ProviderId;
  modelId: string;
  capability: 'toolCalling' | 'imageInput' | 'streaming';
}

/* ------------------------------------------------------------------ *
 * Mapa canal → (entrada, saída)
 * ------------------------------------------------------------------ */

export interface IpcContract {
  'app:getBootstrap': { input: void; output: BootstrapPayload };

  'settings:get': { input: void; output: AppSettings };
  'settings:update': { input: SettingsPatch; output: AppSettings };

  'providers:list': { input: void; output: ProviderDescriptor[] };
  'providers:connections': { input: void; output: ProviderConnection[] };
  'providers:connect': { input: ConnectProviderInput; output: ProviderConnection };
  'providers:disconnect': { input: { providerId: ProviderId }; output: ProviderConnection };
  'providers:test': { input: { providerId: ProviderId }; output: ProviderConnection };
  'providers:registerCompatible': { input: RegisterCompatibleInput; output: ProviderDescriptor };
  'providers:removeCompatible': { input: { providerId: ProviderId }; output: { removed: boolean } };
  'providers:usage': { input: { providerId: ProviderId }; output: UsageSnapshot };

  'catalog:list': { input: CatalogListInput; output: ModelCatalogPage };
  'catalog:refresh': { input: { providerId: ProviderId }; output: ModelCatalogPage };
  'catalog:addManualModel': { input: AddManualModelInput; output: ModelCatalogPage };
  'catalog:setFavorite': { input: { providerId: ProviderId; modelId: string; favorite: boolean }; output: string[] };
  'catalog:probeCapability': { input: CapabilityProbeInput; output: ModelCatalogPage };

  'codex:runtime': { input: void; output: CodexRuntimeInfo };
  'codex:locate': { input: { executablePath?: string }; output: CodexRuntimeInfo };
  'codex:start': { input: void; output: CodexRuntimeInfo };
  'codex:stop': { input: void; output: CodexRuntimeInfo };
  'codex:account': { input: void; output: CodexAccountState };
  'codex:loginStart': { input: { method: CodexAuthMethod; apiKey?: string }; output: { loginId: string } };
  'codex:loginCancel': { input: { loginId: string }; output: { cancelled: boolean } };
  'codex:logout': { input: void; output: CodexAccountState };
  'codex:rateLimits': { input: void; output: CodexAccountState };
  'codex:skills': { input: { workspacePath?: string }; output: SkillDescriptor[] };

  'conversations:list': { input: { includeArchived?: boolean }; output: ConversationSummary[] };
  'conversations:create': { input: CreateConversationInput; output: ConversationSummary };
  'conversations:read': { input: { conversationId: ConversationId }; output: ConversationSummary | null };
  'conversations:items': {
    input: { conversationId: ConversationId; limit?: number; beforeSeq?: number };
    output: ConversationItem[];
  };
  'conversations:rename': { input: { conversationId: ConversationId; title: string }; output: ConversationSummary };
  'conversations:archive': { input: { conversationId: ConversationId }; output: ConversationSummary };
  'conversations:unarchive': { input: { conversationId: ConversationId }; output: ConversationSummary };
  'conversations:delete': { input: { conversationId: ConversationId }; output: { deleted: boolean } };
  'conversations:fork': { input: ForkConversationInput; output: ConversationSummary };
  'conversations:setFavorite': {
    input: { conversationId: ConversationId; favorite: boolean };
    output: ConversationSummary;
  };
  'conversations:search': { input: { query: string; limit?: number }; output: SearchConversationsResult };
  'conversations:export': {
    input: { conversationId: ConversationId; format: ConversationExportFormat };
    /** `path` é null quando a pessoa cancelou o diálogo de salvar. */
    output: { path: string | null };
  };
  'conversations:saveDraft': {
    input: { conversationId: ConversationId; text: string; attachmentIds: string[] };
    output: { saved: boolean };
  };
  'conversations:readDraft': {
    input: { conversationId: ConversationId };
    output: { text: string; attachments: AttachmentRef[] };
  };
  'conversations:setParameters': {
    input: { conversationId: ConversationId; parameters: Partial<TurnParameters> };
    output: ConversationSummary;
  };
  'conversations:setMode': {
    input: { conversationId: ConversationId; mode: OperationMode };
    output: ConversationSummary;
  };
  'conversations:setWorkspace': {
    input: { conversationId: ConversationId; workspacePath: string | null };
    output: ConversationSummary;
  };

  'turn:send': { input: SendTurnInput; output: { turnId: string; accepted: true } };
  'turn:steer': { input: { conversationId: ConversationId; text: string }; output: { accepted: boolean } };
  'turn:interrupt': { input: { conversationId: ConversationId }; output: { requested: boolean } };
  'turn:policy': { input: { conversationId: ConversationId }; output: EffectivePolicy };

  'approvals:pending': { input: void; output: ApprovalRequest[] };
  'approvals:resolve': { input: ResolveApprovalInput; output: { resolved: boolean } };

  'workspaces:list': { input: void; output: WorkspaceSummary[] };
  'workspaces:choose': { input: void; output: WorkspaceSummary | null };
  'workspaces:register': { input: { path: string }; output: WorkspaceSummary };
  'workspaces:remove': { input: { id: string }; output: { removed: boolean } };
  'workspaces:setFavorite': { input: { id: string; favorite: boolean }; output: WorkspaceSummary };
  'workspaces:git': { input: { path: string }; output: GitSummary };
  'workspaces:gitChanges': { input: { path: string }; output: GitFileChange[] };
  'workspaces:fileTree': { input: { path: string; maxEntries?: number }; output: FileTreeNode };
  'workspaces:readFile': {
    input: { workspacePath: string; filePath: string; maxBytes?: number };
    output: { content: string; truncated: boolean; binary: boolean; sizeBytes: number };
  };

  'attachments:choose': { input: { conversationId: ConversationId }; output: AttachmentRef[] };
  'attachments:prepare': { input: PrepareAttachmentsInput; output: AttachmentRef[] };
  'attachments:prepareFromPaths': { input: PrepareAttachmentsInput; output: AttachmentRef[] };
  'attachments:prepareFromClipboardImage': { input: PrepareClipboardImageInput; output: AttachmentRef[] };
  'attachments:discard': { input: { conversationId: ConversationId; attachmentId: string }; output: { discarded: boolean } };

  'diagnostics:report': { input: void; output: DiagnosticsReport };
  'diagnostics:export': { input: void; output: { path: string | null } };
  'diagnostics:openLogFolder': { input: void; output: { opened: boolean } };

  'shell:openExternal': { input: { url: string }; output: { opened: boolean } };
  'shell:showItemInFolder': { input: { path: string }; output: { shown: boolean } };
  'clipboard:writeText': { input: { text: string }; output: { written: boolean } };
}

export type IpcInput<C extends IpcInvokeChannel> = IpcContract[C]['input'];
export type IpcOutput<C extends IpcInvokeChannel> = IpcContract[C]['output'];

/** API exposta pelo preload via contextBridge. */
export interface CodexHubApi {
  invoke<C extends IpcInvokeChannel>(
    channel: C,
    ...args: IpcInput<C> extends void ? [] : [IpcInput<C>]
  ): Promise<IpcOutput<C>>;
  onDomainEvent(listener: (event: DomainEvent) => void): () => void;
  onAppEvent(listener: (event: AppEvent) => void): () => void;
}
