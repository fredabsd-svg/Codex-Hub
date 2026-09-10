/**
 * Composição da aplicação no processo principal.
 *
 * Nada aqui é global implícito: tudo é montado explicitamente e injetado.
 * O renderer nunca recebe nenhuma destas instâncias — apenas DTOs por IPC.
 */

import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import type { AppSettings, CodexAccountState, CodexLoginProgress, CodexRuntimeInfo } from './../shared/domain';
import { openDatabase, type Database } from './persistence/database';
import { CredentialStore, type SecretEncryptor } from './services/CredentialStore';
import { EventBus } from './services/EventBus';
import { GitService } from './services/GitService';
import { logger } from './services/logger';
import { AttachmentService } from './services/AttachmentService';
import { ConversationService } from './services/ConversationService';
import { DiagnosticsService } from './services/DiagnosticsService';
import { SettingsService } from './services/SettingsService';
import { WorkspaceService } from './services/WorkspaceService';
import { ModelCatalog } from './providers/ModelCatalog';
import { ProviderRegistry, CODEX_PROVIDER_ID } from './providers/registry';
import { ApprovalBroker } from './tools/ApprovalBroker';
import { CodexRuntime } from './codex/CodexRuntime';
import { CodexEngine } from './engines/CodexEngine';
import { DirectEngine } from './engines/DirectEngine';
import type { ExecutionEngine } from './engines/types';
import type { EngineId, SkillDescriptor } from './../shared/domain';

const APP_NAME = 'Codex Hub';

export interface BootNotice {
  level: 'info' | 'warn' | 'error';
  message: string;
  action?: string;
}

export interface AppContext {
  db: Database;
  bus: EventBus;
  credentials: CredentialStore;
  providers: ProviderRegistry;
  catalog: ModelCatalog;
  approvals: ApprovalBroker;
  git: GitService;
  workspaces: WorkspaceService;
  attachments: AttachmentService;
  settings: SettingsService;
  conversations: ConversationService;
  diagnostics: DiagnosticsService;
  codexRuntime: CodexRuntime;
  codexEngine: CodexEngine;
  directEngine: DirectEngine;
  engineFor(engineId: EngineId): ExecutionEngine;
  notices: BootNotice[];
  appVersion: string;
  dispose(): Promise<void>;
}

const electronEncryptor: SecretEncryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptString(plain),
  decryptString: (cipher) => safeStorage.decryptString(cipher),
};

export function createAppContext(options: { userDataDir?: string; logsDir?: string } = {}): AppContext {
  const userDataDir = options.userDataDir ?? app.getPath('userData');
  const logsDir = options.logsDir ?? app.getPath('logs');
  const appVersion = app.getVersion();

  const notices: BootNotice[] = [];

  const db = openDatabase(userDataDir);
  const settingsFromDisk = db.prefs.getSettings();

  logger.configure({
    dir: logsDir,
    level: (process.env.CODEX_HUB_LOG_LEVEL as AppSettings['diagnosticsLogLevel']) ?? settingsFromDisk.diagnosticsLogLevel,
    toStdout: process.env.CODEX_HUB_LOG_STDOUT !== 'false' && !app.isPackaged,
    enabled: settingsFromDisk.diagnosticsEnabled,
  });
  logger.info('boot', 'Iniciando Codex Hub', { version: appVersion, userDataDir });

  const bus = new EventBus();
  const credentials = new CredentialStore(userDataDir, electronEncryptor);
  if (!credentials.protectionAvailable) {
    notices.push({
      level: 'warn',
      message:
        'O armazenamento protegido do sistema não está disponível. Chaves de API funcionam nesta sessão, mas não são gravadas em disco.',
      action: 'No Windows, verifique se o perfil do usuário permite DPAPI. Nada é salvo em texto puro.',
    });
  }

  const providers = new ProviderRegistry(credentials, db.compatibleProviders, APP_NAME);
  const catalog = new ModelCatalog(db.catalog, db.prefs, (providerId) => providers.get(providerId));
  const git = new GitService();
  const workspaces = new WorkspaceService(db.workspaces, git);

  const settings = new SettingsService(db.prefs, bus, (next, previous) => {
    if (next.codexExecutablePath !== previous.codexExecutablePath) {
      void codexRuntime.locate(next.codexExecutablePath).catch(() => undefined);
    }
  });

  const attachments = new AttachmentService(workspaces, () => {
    const current = settings.get();
    return { maxCount: current.attachmentMaxCount, maxBytes: current.attachmentMaxBytes };
  });

  const approvals = new ApprovalBroker({
    onRequested: (request) => conversations.publishApproval(request),
    onResolved: (request, decision) => conversations.publishApprovalResolved(request, decision),
  });

  const codexRuntime: CodexRuntime = new CodexRuntime({
    appName: 'codex-hub',
    appTitle: APP_NAME,
    appVersion,
    generatedTypesDir: resolveGeneratedTypesDir(),
    configuredPath: () => settings.get().codexExecutablePath || process.env.CODEX_HUB_CODEX_PATH || undefined,
    onNotification: (method, params) => {
      codexEngine.handleNotification(method, params);
    },
    onServerRequest: (method, params, generation) => codexEngine.handleServerRequest(method, params, generation),
    onRuntimeChanged: (info: CodexRuntimeInfo) => {
      bus.emitApp({ type: 'codex/runtime', runtime: info, at: new Date().toISOString() });
    },
    onAccountChanged: (account: CodexAccountState) => {
      bus.emitApp({ type: 'codex/account', account, at: new Date().toISOString() });
    },
    onLoginProgress: (progress: CodexLoginProgress) => {
      bus.emitApp({ type: 'codex/login', progress, at: new Date().toISOString() });
    },
    onReconnected: (generation) => {
      // Reconciliação: nada mutável é reexecutado.
      approvals.invalidateGeneration(generation - 1);
      codexEngine.invalidateBindings('o processo foi reiniciado');
      conversations.invalidateEngineBindings();
      bus.emitApp({
        type: 'diagnostics/notice',
        level: 'warn',
        message:
          'A conexão com o Codex foi reiniciada. As conversas continuam salvas; reenvie a última mensagem se ela não tiver concluído. Nenhum comando foi reexecutado automaticamente.',
        at: new Date().toISOString(),
      });
    },
  });

  const codexEngine = new CodexEngine({
    runtime: codexRuntime,
    approvals,
    developerMode: () => settings.get().developerMode,
    isPathAuthorized: (conversationId, path) => {
      const row = db.conversations.read(conversationId);
      if (!row?.workspacePath) return false;
      return workspaces.guardFor(row.workspacePath).contains(path);
    },
  });

  const directEngine = new DirectEngine({
    providers,
    catalog,
    approvals,
    git,
    limits: () => {
      const current = settings.get();
      return {
        maxSteps: current.toolMaxSteps,
        maxDurationMs: current.toolMaxDurationMs,
        maxResultBytes: current.toolMaxResultBytes,
      };
    },
    customInstructions: () => settings.get().customInstructions,
  });

  const engineFor = (engineId: EngineId): ExecutionEngine => (engineId === 'codex' ? codexEngine : directEngine);

  const skillsFor = async (engineId: EngineId, workspacePath?: string): Promise<SkillDescriptor[]> => {
    try {
      return await engineFor(engineId).listSkills(workspacePath);
    } catch {
      return [];
    }
  };

  const conversations: ConversationService = new ConversationService({
    db,
    bus,
    attachments,
    workspaces,
    engineFor,
    skillsFor,
    onCatalogUse: (providerId, modelId) => catalog.noteUsed(providerId, modelId),
  });

  const diagnostics = new DiagnosticsService({
    appName: APP_NAME,
    appVersion,
    isPackaged: app.isPackaged,
    versions: {
      electron: process.versions.electron ?? 'desconhecido',
      chrome: process.versions.chrome ?? 'desconhecido',
      node: process.versions.node,
    },
    db,
    codex: codexRuntime,
    providers,
    credentials,
    settings,
    exportDir: userDataDir,
    extraNotes: () => {
      const info = codexRuntime.info();
      return [
        info.generatedTypesAreProvisional
          ? 'Tipos do Codex PROVISÓRIOS: rode "npm run codex:types" com o Codex instalado para gerar os tipos reais. O protocolo não é considerado validado por causa desses tipos.'
          : `Tipos do Codex gerados a partir da versão ${info.generatedTypesVersion ?? 'desconhecida'}.`,
        `Execução de comandos arbitrários no motor direto: INDISPONÍVEL (sem isolamento verificado).`,
      ];
    },
  });

  // Codex participa do catálogo por um caminho próprio (App Server, não HTTP).
  void catalog;

  return {
    db,
    bus,
    credentials,
    providers,
    catalog,
    approvals,
    git,
    workspaces,
    attachments,
    settings,
    conversations,
    diagnostics,
    codexRuntime,
    codexEngine,
    directEngine,
    engineFor,
    notices,
    appVersion,
    async dispose() {
      logger.info('boot', 'Encerrando Codex Hub');
      await codexRuntime.stop().catch(() => undefined);
      db.store.compact();
    },
  };
}

export { CODEX_PROVIDER_ID };

function resolveGeneratedTypesDir(): string {
  // Em desenvolvimento os tipos ficam no repositório; empacotado, dentro do app.
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar', 'src', 'generated', 'codex')
    : join(app.getAppPath(), 'src', 'generated', 'codex');
}
