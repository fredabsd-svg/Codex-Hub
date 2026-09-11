/**
 * Ponte falsa (`window.codexHub`) para os testes de interface.
 *
 * Reproduz o contrato do preload: `invoke` resolve com os dados ou rejeita com
 * um `Error` que carrega `detail`. Nenhum acesso real a IPC, disco ou rede.
 */

import { vi } from 'vitest';
import type {
  AppSettings,
  ConversationItem,
  ConversationSummary,
  ErrorDetail,
  ModelCatalogPage,
  ProviderConnection,
  ProviderDescriptor,
} from '../../src/shared/domain';
import { DEFAULT_SETTINGS } from '../../src/shared/domain';
import type { AppEvent, DomainEvent } from '../../src/shared/events';
import type { BootstrapPayload } from '../../src/shared/ipc';

export interface FakeBridgeOptions {
  settings?: Partial<AppSettings>;
  providers?: ProviderDescriptor[];
  connections?: ProviderConnection[];
  conversations?: ConversationSummary[];
  items?: Record<string, ConversationItem[]>;
  catalog?: ModelCatalogPage;
  onboardingCompleted?: boolean;
  notices?: BootstrapPayload['notices'];
  codexFound?: boolean;
  /** Sobrescreve respostas por canal. */
  overrides?: Record<string, (payload: unknown) => unknown>;
  /** Faz o canal falhar com este detalhe. */
  failures?: Record<string, ErrorDetail>;
}

export interface FakeBridge {
  calls: Array<{ channel: string; payload: unknown }>;
  emitDomain(event: DomainEvent): void;
  emitApp(event: AppEvent): void;
  callsTo(channel: string): unknown[];
  restore(): void;
}

export const OPENROUTER_DESCRIPTOR: ProviderDescriptor = {
  id: 'openrouter',
  kind: 'openrouter',
  label: 'OpenRouter',
  description: 'Catálogo amplo com uma única chave.',
  engines: ['direct', 'codex'],
  authKinds: ['apiKey'],
  baseUrl: 'https://openrouter.ai/api/v1',
  userDefined: false,
};

export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: 'codex',
  kind: 'codex',
  label: 'Codex (conta ChatGPT ou chave OpenAI)',
  description: 'Usa o Codex App Server instalado na máquina.',
  engines: ['codex'],
  authKinds: ['chatgptOAuth', 'deviceCode', 'apiKey'],
  userDefined: false,
};

export function conversationFixture(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  const at = new Date().toISOString();
  return {
    id: 'c1',
    title: 'Ajustar o build',
    titleIsLocal: true,
    engineId: 'direct',
    providerId: 'openrouter',
    modelId: 'vendor/modelo',
    mode: 'chat',
    archived: false,
    favorite: false,
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    messageCount: 0,
    parameters: { modelId: 'vendor/modelo', providerId: 'openrouter', engineId: 'direct' },
    ...overrides,
  };
}

export function itemFixture(overrides: Partial<ConversationItem> = {}): ConversationItem {
  const at = new Date().toISOString();
  return {
    id: 'i1',
    conversationId: 'c1',
    role: 'assistant',
    kind: 'agentMessage',
    status: 'completed',
    createdAt: at,
    updatedAt: at,
    text: 'Resposta.',
    ...overrides,
  };
}

export const CATALOG_FIXTURE: ModelCatalogPage = {
  providerId: 'openrouter',
  fetchedAt: new Date().toISOString(),
  fromCache: false,
  models: [
    {
      id: 'vendor/modelo',
      providerId: 'openrouter',
      displayName: 'Vendor Modelo',
      vendor: 'vendor',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      supportedParameters: ['tools', 'temperature'],
      pricing: { currency: 'USD', unknown: false, promptPerToken: 0.000003, completionPerToken: 0.000015 },
      capabilities: {
        chat: { state: 'supported', source: 'declared' },
        toolCalling: { state: 'supported', source: 'declared' },
        imageInput: { state: 'supported', source: 'declared' },
      },
      unverified: false,
    },
    {
      id: 'vendor/sem-preco',
      providerId: 'openrouter',
      displayName: 'Vendor Sem Preço',
      vendor: 'vendor',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: [],
      pricing: { currency: 'USD', unknown: true },
      capabilities: { toolCalling: { state: 'unknown', source: 'inferred' } },
      unverified: false,
    },
  ],
};

export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const domainListeners = new Set<(event: DomainEvent) => void>();
  const appListeners = new Set<(event: AppEvent) => void>();

  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...(options.settings ?? {}) };
  const providers = options.providers ?? [OPENROUTER_DESCRIPTOR, CODEX_DESCRIPTOR];
  const connections =
    options.connections ??
    ([
      { providerId: 'openrouter', state: 'connected', message: 'Credencial validada.', maskedCredential: 'sk-or-v1-…4f2a' },
      { providerId: 'codex', state: 'disconnected', message: 'Codex não conectado.' },
    ] as ProviderConnection[]);
  const conversations = options.conversations ?? [];
  const items = options.items ?? {};
  const catalog = options.catalog ?? CATALOG_FIXTURE;

  const bootstrap: BootstrapPayload = {
    appName: 'Codex Hub',
    appVersion: '0.1.0',
    platform: 'linux',
    isPackaged: false,
    settings,
    providers,
    connections,
    codex: {
      found: options.codexFound ?? false,
      initialized: false,
      generatedTypesAreProvisional: true,
      restartCount: 0,
      modelProvider: { mode: 'default', wireApi: 'chat', state: 'default' },
      diagnostic: options.codexFound
        ? undefined
        : {
            code: 'codexMissing',
            message: 'O executável do Codex não foi encontrado.',
            action: 'Informe o caminho em Configurações › Codex.',
            retryable: false,
          },
    },
    workspaces: [],
    conversations,
    modelFavorites: [],
    recentModels: [],
    onboardingCompleted: options.onboardingCompleted ?? true,
    notices: options.notices ?? [],
  };

  const defaults: Record<string, (payload: unknown) => unknown> = {
    'app:getBootstrap': () => bootstrap,
    'settings:get': () => settings,
    'settings:update': (payload) => Object.assign(settings, payload as Partial<AppSettings>),
    'providers:list': () => providers,
    'providers:connections': () => connections,
    'providers:connect': () => ({ providerId: 'openrouter', state: 'connected', message: 'Credencial validada.' }),
    'providers:usage': () => ({ providerId: 'openrouter', fetchedAt: new Date().toISOString() }),
    'catalog:list': () => catalog,
    'catalog:refresh': () => catalog,
    'catalog:setFavorite': () => [],
    'codex:runtime': () => bootstrap.codex,
    'codex:skills': () => [],
    'conversations:list': () => conversations,
    'conversations:create': () => conversationFixture({ id: 'nova', title: 'Nova conversa' }),
    'conversations:items': (payload) => items[(payload as { conversationId: string }).conversationId] ?? [],
    'conversations:readDraft': () => ({ text: '', attachments: [] }),
    'conversations:saveDraft': () => ({ saved: true }),
    'conversations:setMode': (payload) => conversationFixture(payload as Partial<ConversationSummary>),
    'conversations:setParameters': () => conversationFixture(),
    'turn:policy': () => ({
      mode: 'chat',
      approvals: 'onRequest',
      sandbox: 'readOnly',
      toolNetwork: 'blocked',
      inferenceNetwork: 'allowed',
      confirmedByRuntime: true,
    }),
    'turn:send': () => ({ turnId: 't1', accepted: true }),
    'turn:interrupt': () => ({ requested: true }),
    'approvals:pending': () => [],
    'approvals:resolve': () => ({ resolved: true }),
    'workspaces:list': () => [],
    'workspaces:git': () => ({ available: false, isRepository: false, unavailableReason: 'git ausente' }),
    'clipboard:writeText': () => ({ written: true }),
    'shell:openExternal': () => ({ opened: true }),
  };

  const api = {
    invoke: vi.fn(async (channel: string, payload?: unknown) => {
      calls.push({ channel, payload });
      const failure = options.failures?.[channel];
      if (failure) {
        const error = new Error(failure.message) as Error & { detail: ErrorDetail };
        error.detail = failure;
        throw error;
      }
      const handler = options.overrides?.[channel] ?? defaults[channel];
      if (!handler) return undefined;
      return handler(payload);
    }),
    onDomainEvent: (listener: (event: DomainEvent) => void) => {
      domainListeners.add(listener);
      return () => domainListeners.delete(listener);
    },
    onAppEvent: (listener: (event: AppEvent) => void) => {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
    getPathForFile: (file: File) => `/tmp/arrastado/${file.name}`,
  };

  (window as unknown as { codexHub: unknown }).codexHub = api;

  return {
    calls,
    emitDomain: (event) => {
      for (const listener of domainListeners) listener(event);
    },
    emitApp: (event) => {
      for (const listener of appListeners) listener(event);
    },
    callsTo: (channel) => calls.filter((call) => call.channel === channel).map((call) => call.payload),
    restore: () => {
      delete (window as unknown as { codexHub?: unknown }).codexHub;
    },
  };
}
