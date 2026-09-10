/**
 * Estado global do aplicativo: bootstrap, configurações, provedores, Codex,
 * workspaces e uso.
 *
 * Nada de segredo é guardado aqui. Uma credencial vai do campo do formulário
 * direto para o IPC; o que volta é estado + máscara.
 */

import { create } from 'zustand';
import type {
  AppSettings,
  CodexAccountState,
  CodexLoginProgress,
  CodexRuntimeInfo,
  ProviderConnection,
  ProviderDescriptor,
  SkillDescriptor,
  SettingsPatch,
  UsageSnapshot,
  WorkspaceSummary,
} from '@shared/domain';
import type { BootstrapPayload } from '@shared/ipc';
import { errorOf, invoke } from '../lib/api';
import { useCatalogStore } from './catalogStore';
import { useUiStore } from './uiStore';

interface AppState {
  ready: boolean;
  bootError: string | null;
  appName: string;
  appVersion: string;
  platform: string;
  settings: AppSettings;
  providers: ProviderDescriptor[];
  connections: Record<string, ProviderConnection>;
  codex: CodexRuntimeInfo | null;
  codexAccount: CodexAccountState | null;
  codexLogin: CodexLoginProgress | null;
  workspaces: WorkspaceSummary[];
  usage: Record<string, UsageSnapshot>;
  skills: SkillDescriptor[];
  onboardingCompleted: boolean;
  notices: BootstrapPayload['notices'];

  bootstrap(): Promise<void>;
  applySettings(patch: SettingsPatch): Promise<void>;
  refreshConnections(): Promise<void>;
  setConnection(connection: ProviderConnection): void;
  setCodexRuntime(runtime: CodexRuntimeInfo): void;
  setCodexAccount(account: CodexAccountState): void;
  setCodexLogin(progress: CodexLoginProgress | null): void;
  refreshWorkspaces(): Promise<void>;
  refreshUsage(providerId: string): Promise<void>;
  refreshSkills(engineId: 'codex' | 'direct', workspacePath?: string): Promise<void>;
  setSkillEnabled(skillId: string, enabled: boolean): void;
  connectProvider(providerId: string, apiKey: string | undefined, persist: boolean): Promise<ProviderConnection>;
  disconnectProvider(providerId: string): Promise<void>;
  registerCompatible(input: {
    label: string;
    baseUrl: string;
    apiKey?: string;
    persist: boolean;
  }): Promise<ProviderDescriptor | null>;
  dismissNotice(index: number): void;
}

const FALLBACK_SETTINGS: AppSettings = {
  theme: 'dark',
  fontScale: 1,
  density: 'comfortable',
  reduceMotion: 'system',
  sendWithEnter: false,
  showReasoningSummaries: true,
  chatWidth: 'comfortable',
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
  toolMaxDurationMs: 300_000,
  toolMaxResultBytes: 262_144,
  layout: {
    sidebarWidth: 288,
    sidebarCollapsed: false,
    rightPanelWidth: 420,
    rightPanelCollapsed: true,
    rightPanelTab: 'diff',
  },
};

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  bootError: null,
  appName: 'Codex Hub',
  appVersion: '0.0.0',
  platform: 'unknown',
  settings: FALLBACK_SETTINGS,
  providers: [],
  connections: {},
  codex: null,
  codexAccount: null,
  codexLogin: null,
  workspaces: [],
  usage: {},
  skills: [],
  onboardingCompleted: false,
  notices: [],

  async bootstrap() {
    try {
      const payload = await invoke('app:getBootstrap');
      set({
        ready: true,
        bootError: null,
        appName: payload.appName,
        appVersion: payload.appVersion,
        platform: payload.platform,
        settings: payload.settings,
        providers: payload.providers,
        connections: Object.fromEntries(payload.connections.map((c) => [c.providerId, c])),
        codex: payload.codex,
        workspaces: payload.workspaces,
        onboardingCompleted: payload.onboardingCompleted,
        notices: payload.notices,
      });
      useUiStore.getState().setLayout(payload.settings.layout);
      useCatalogStore.getState().hydrate(payload.modelFavorites ?? [], payload.recentModels ?? []);
      applyThemeToDocument(payload.settings);
    } catch (err) {
      const detail = errorOf(err);
      set({ ready: false, bootError: `${detail.message} ${detail.action ?? ''}`.trim() });
    }
  },

  async applySettings(patch) {
    const previous = get().settings;
    // Aplicação otimista para a interface não "piscar".
    const optimistic = { ...previous, ...patch, layout: { ...previous.layout, ...(patch.layout ?? {}) } };
    set({ settings: optimistic });
    applyThemeToDocument(optimistic);
    try {
      const next = await invoke('settings:update', patch);
      set({ settings: next });
      applyThemeToDocument(next);
    } catch (err) {
      set({ settings: previous });
      applyThemeToDocument(previous);
      useUiStore.getState().pushError(errorOf(err), 'Não foi possível salvar a configuração');
    }
  },

  async refreshConnections() {
    try {
      const connections = await invoke('providers:connections');
      set({ connections: Object.fromEntries(connections.map((c) => [c.providerId, c])) });
    } catch (err) {
      useUiStore.getState().pushError(errorOf(err), 'Não foi possível ler o estado dos provedores');
    }
  },

  setConnection(connection) {
    set((state) => ({ connections: { ...state.connections, [connection.providerId]: connection } }));
  },

  setCodexRuntime(runtime) {
    set({ codex: runtime });
  },

  setCodexAccount(account) {
    set({ codexAccount: account });
  },

  setCodexLogin(progress) {
    set({ codexLogin: progress });
  },

  async refreshWorkspaces() {
    try {
      set({ workspaces: await invoke('workspaces:list') });
    } catch (err) {
      useUiStore.getState().pushError(errorOf(err), 'Não foi possível listar os workspaces');
    }
  },

  async refreshUsage(providerId) {
    try {
      const usage = await invoke('providers:usage', { providerId });
      set((state) => ({ usage: { ...state.usage, [providerId]: usage } }));
    } catch (err) {
      const detail = errorOf(err);
      // Uso indisponível não é erro bloqueante: registramos sem alarmar.
      set((state) => ({
        usage: {
          ...state.usage,
          [providerId]: {
            providerId,
            fetchedAt: new Date().toISOString(),
            unavailable: [detail.message],
          },
        },
      }));
    }
  },

  async refreshSkills(engineId, workspacePath) {
    if (engineId !== 'codex') {
      set({ skills: [] });
      return;
    }
    try {
      const skills = await invoke('codex:skills', { workspacePath });
      // A preferência local prevalece; sem preferência, vale o que o motor
      // informou (o Codex entrega as skills habilitadas por padrão).
      const previous = new Map(get().skills.map((s) => [s.id, s.enabledLocally]));
      set({ skills: skills.map((s) => ({ ...s, enabledLocally: previous.get(s.id) ?? s.enabledLocally })) });
    } catch {
      set({ skills: [] });
    }
  },

  setSkillEnabled(skillId, enabled) {
    set((state) => ({
      skills: state.skills.map((skill) => (skill.id === skillId ? { ...skill, enabledLocally: enabled } : skill)),
    }));
  },

  async connectProvider(providerId, apiKey, persist) {
    const connection = await invoke('providers:connect', { providerId, apiKey, persist });
    get().setConnection(connection);
    if (connection.state === 'connected') set({ onboardingCompleted: true });
    return connection;
  },

  async disconnectProvider(providerId) {
    const connection = await invoke('providers:disconnect', { providerId });
    get().setConnection(connection);
  },

  async registerCompatible(input) {
    try {
      const descriptor = await invoke('providers:registerCompatible', {
        label: input.label,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        persist: input.persist,
      });
      set((state) => ({ providers: [...state.providers.filter((p) => p.id !== descriptor.id), descriptor] }));
      await get().refreshConnections();
      return descriptor;
    } catch (err) {
      useUiStore.getState().pushError(errorOf(err), 'Não foi possível cadastrar o endpoint');
      return null;
    }
  },

  dismissNotice(index) {
    set((state) => ({ notices: state.notices.filter((_, i) => i !== index) }));
  },
}));

/** Tema efetivo (resolve "do sistema" pela preferência do SO). */
export function resolveTheme(settings: Pick<AppSettings, 'theme'>): 'dark' | 'light' {
  if (settings.theme !== 'system') return settings.theme;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Aplica tema, densidade, largura de leitura e redução de movimento no DOM.
 * O tamanho da interface é aplicado pelo processo principal (zoom da janela).
 */
export function applyThemeToDocument(settings: AppSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveTheme(settings));
  root.setAttribute('data-density', settings.density);
  root.setAttribute('data-chat-width', settings.chatWidth ?? 'comfortable');
  if (settings.reduceMotion === 'always') root.setAttribute('data-motion', 'reduced');
  else root.removeAttribute('data-motion');
}

export function connectionOf(providerId: string | undefined): ProviderConnection | undefined {
  if (!providerId) return undefined;
  return useAppStore.getState().connections[providerId];
}
