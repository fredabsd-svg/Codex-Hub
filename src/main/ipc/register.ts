/**
 * Registro EXPLÍCITO dos handlers de IPC.
 *
 * Não existe encaminhamento genérico: cada canal tem um handler dedicado, com
 * schema de validação e conversão para DTOs seguros.
 */

import { app, clipboard, dialog, shell, type BrowserWindow, type WebContents } from 'electron';
import { basename, join } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { exportFileName, renderConversationExport, type ConversationExportFormat } from '../../shared/conversationExport';
import type {
  ApprovalRequest,
  CodexAccountState,
  ModelCatalogPage,
  ProviderConnection,
  SkillDescriptor,
  UsageSnapshot,
} from '../../shared/domain';
import type {
  AddManualModelInput,
  BootstrapPayload,
  CapabilityProbeInput,
  CatalogListInput,
  ConnectProviderInput,
  CreateConversationInput,
  FileTreeNode,
  ForkConversationInput,
  PrepareAttachmentsInput,
  PrepareClipboardImageInput,
  RegisterCompatibleInput,
  ResolveApprovalInput,
  SendTurnInput,
} from '../../shared/ipc';
import { appError, toErrorDetail } from '../../shared/errors';
import { cap } from '../../shared/capabilities';
import type { AppContext } from '../context';
import { CODEX_PROVIDER_ID } from '../providers/registry';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { isProbablyBinary } from '../tools/diff';
import { logger } from '../services/logger';
import { registerHandler, type SenderPolicy } from './guard';

export interface RegisterIpcOptions {
  context: AppContext;
  getMainWindow(): BrowserWindow | null;
  appName: string;
  appVersion: string;
}

export function registerIpc(options: RegisterIpcOptions): void {
  const { context: ctx } = options;

  const policy: SenderPolicy = {
    isAuthorized(contents: WebContents): boolean {
      const main = options.getMainWindow();
      if (!main || main.isDestroyed()) return false;
      return contents.id === main.webContents.id;
    },
  };

  const on = <C extends Parameters<typeof registerHandler>[0]>(
    channel: C,
    handler: (input: never) => unknown,
  ): void => {
    registerHandler(channel, policy, (input) => handler(input as never));
  };

  /* ------------------------------------------------------------------ *
   * Bootstrap e configurações
   * ------------------------------------------------------------------ */

  on('app:getBootstrap', async (): Promise<BootstrapPayload> => {
    const settings = ctx.settings.get();
    // A janela pode ter sido criada depois do registro dos handlers.
    applyUiScale(settings.fontScale);
    // Localiza o Codex sem bloquear a interface por falta dele.
    const codex = await ctx.codexRuntime.locate().catch((err) => {
      logger.debug('ipc', 'Localização do Codex falhou', toErrorDetail(err));
      return ctx.codexRuntime.info();
    });
    return {
      appName: options.appName,
      appVersion: options.appVersion,
      platform: process.platform,
      isPackaged: app.isPackaged,
      settings,
      providers: ctx.providers.descriptors(),
      connections: ctx.providers.allConnections(),
      codex,
      workspaces: await ctx.workspaces.list(),
      conversations: ctx.conversations.list(true),
      modelFavorites: ctx.catalog.favorites(),
      recentModels: ctx.catalog.recents(),
      onboardingCompleted: ctx.settings.isOnboardingCompleted(),
      notices: ctx.notices,
    };
  });

  on('settings:get', () => ctx.settings.get());
  on('settings:update', (patch: Parameters<typeof ctx.settings.update>[0]) => {
    const previous = ctx.settings.get();
    const next = ctx.settings.update(patch);
    if (next.fontScale !== previous.fontScale) applyUiScale(next.fontScale);
    return next;
  });

  /**
   * "Tamanho da interface" é o zoom da janela: escala textos, ícones e
   * espaçamentos de forma consistente, o que uma variável de fonte não faz
   * com tamanhos em px.
   */
  const applyUiScale = (scale: number): void => {
    const window = options.getMainWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.setZoomFactor(Math.min(1.5, Math.max(0.85, scale)));
  };
  applyUiScale(ctx.settings.get().fontScale);

  /* ------------------------------------------------------------------ *
   * Provedores
   * ------------------------------------------------------------------ */

  on('providers:list', () => ctx.providers.descriptors());
  on('providers:connections', () => ctx.providers.allConnections());

  on('providers:connect', async (input: ConnectProviderInput): Promise<ProviderConnection> => {
    const descriptor = ctx.providers.descriptor(input.providerId);
    if (!descriptor) {
      throw appError('validation', { message: `Provedor desconhecido: ${input.providerId}.` });
    }
    if (descriptor.kind === 'codex') {
      throw appError('validation', {
        message: 'A autenticação do Codex é feita pelo próprio Codex.',
        action: 'Use Configurações › Codex › Autenticação.',
      });
    }
    let warning: string | undefined;
    if (input.apiKey) {
      const stored = ctx.credentials.set(input.providerId, input.apiKey, input.persist);
      warning = stored.warning;
      ctx.providers.invalidate(input.providerId);
    } else if (!ctx.credentials.has(input.providerId)) {
      throw appError('validation', {
        message: 'Informe a chave de API do provedor.',
        action: 'Cole a chave no campo indicado.',
      });
    }
    const provider = ctx.providers.require(input.providerId);
    const connection = await provider.testConnection();
    const merged = ctx.providers.setConnection(
      warning ? { ...connection, message: `${connection.message ?? ''} ${warning}`.trim() } : connection,
    );
    ctx.bus.emitApp({ type: 'provider/connection', connection: merged, at: new Date().toISOString() });
    if (merged.state === 'connected') {
      ctx.settings.completeOnboarding();
      // Aquece o catálogo em segundo plano.
      void ctx.catalog.refresh(input.providerId).then(() => {
        ctx.bus.emitApp({ type: 'catalog/invalidated', providerId: input.providerId, at: new Date().toISOString() });
      });
    }
    return merged;
  });

  on('providers:disconnect', (input: { providerId: string }): ProviderConnection => {
    ctx.credentials.remove(input.providerId);
    ctx.providers.invalidate(input.providerId);
    const connection = ctx.providers.setConnection({
      providerId: input.providerId,
      state: 'disconnected',
      message: 'Credencial removida desta sessão e do armazenamento protegido.',
    });
    ctx.bus.emitApp({ type: 'provider/connection', connection, at: new Date().toISOString() });
    return connection;
  });

  on('providers:test', async (input: { providerId: string }): Promise<ProviderConnection> => {
    if (input.providerId === CODEX_PROVIDER_ID) {
      const info = await ctx.codexRuntime.start();
      const account = ctx.codexRuntime.accountState();
      return ctx.providers.setConnection({
        providerId: CODEX_PROVIDER_ID,
        state: info.initialized ? (account.authenticated ? 'connected' : 'unauthorized') : 'unavailable',
        accountLabel: account.accountLabel,
        planLabel: account.planLabel,
        message: info.initialized
          ? (account.message ?? 'Codex conectado.')
          : (info.diagnostic?.message ?? 'Codex indisponível.'),
        actionHint: info.diagnostic?.action,
        lastCheckedAt: new Date().toISOString(),
      });
    }
    const provider = ctx.providers.require(input.providerId);
    const connection = ctx.providers.setConnection(await provider.testConnection());
    ctx.bus.emitApp({ type: 'provider/connection', connection, at: new Date().toISOString() });
    return connection;
  });

  on('providers:registerCompatible', async (input: RegisterCompatibleInput) => {
    const descriptor = ctx.providers.registerCompatible({
      label: input.label,
      baseUrl: input.baseUrl,
      headers: input.headers,
    });
    // Credencial pertence a ESTE provedor; nunca reaproveitada de outro.
    if (input.apiKey) {
      ctx.credentials.set(descriptor.id, input.apiKey, input.persist);
      ctx.providers.invalidate(descriptor.id);
    }
    const provider = ctx.providers.require(descriptor.id);
    const connection = ctx.providers.setConnection(await provider.testConnection());
    ctx.bus.emitApp({ type: 'provider/connection', connection, at: new Date().toISOString() });
    if (connection.state === 'connected') {
      void ctx.catalog.refresh(descriptor.id);
      ctx.settings.completeOnboarding();
    }
    return descriptor;
  });

  on('providers:removeCompatible', (input: { providerId: string }) => ({
    removed: ctx.providers.removeCompatible(input.providerId),
  }));

  on('providers:usage', async (input: { providerId: string }): Promise<UsageSnapshot> => {
    if (input.providerId === CODEX_PROVIDER_ID) {
      const account = await ctx.codexRuntime.refreshRateLimits().catch(() => ctx.codexRuntime.accountState());
      return {
        providerId: CODEX_PROVIDER_ID,
        rateLimits: account.rateLimits,
        fetchedAt: new Date().toISOString(),
        unavailable: account.rateLimits
          ? undefined
          : ['O Codex não informou limites de uso para esta conta nesta versão.'],
      };
    }
    const provider = ctx.providers.require(input.providerId);
    const usage = await provider.readUsage();
    ctx.bus.emitApp({ type: 'usage/updated', usage, at: new Date().toISOString() });
    return usage;
  });

  /* ------------------------------------------------------------------ *
   * Catálogo
   * ------------------------------------------------------------------ */

  const listCatalog = async (input: CatalogListInput): Promise<ModelCatalogPage> => {
    if (input.providerId === CODEX_PROVIDER_ID) {
      const cached = ctx.catalog.cached(CODEX_PROVIDER_ID);
      if (!input.forceRefresh && cached && cached.models.length > 0) return cached;
      if (!ctx.codexRuntime.isReady) {
        return {
          providerId: CODEX_PROVIDER_ID,
          models: cached?.models ?? [],
          fetchedAt: cached?.fetchedAt ?? new Date().toISOString(),
          fromCache: true,
          warning:
            'O Codex App Server não está conectado, então o catálogo não pode ser descoberto agora. Conecte em Configurações › Codex.',
        };
      }
      const page = await ctx.codexRuntime.listModels();
      if (page.models.length > 0) {
        ctx.db.catalog.write({
          id: CODEX_PROVIDER_ID,
          models: page.models,
          fetchedAt: page.fetchedAt,
          warning: page.warning,
        });
      }
      return page;
    }
    return ctx.catalog.list(input.providerId, { forceRefresh: input.forceRefresh });
  };

  on('catalog:list', (input: CatalogListInput) => listCatalog(input));
  on('catalog:refresh', (input: { providerId: string }) => listCatalog({ providerId: input.providerId, forceRefresh: true }));
  on('catalog:addManualModel', (input: AddManualModelInput) =>
    ctx.catalog.addManualModel(input.providerId, input.modelId, input.displayName),
  );
  on('catalog:setFavorite', (input: { providerId: string; modelId: string; favorite: boolean }) =>
    ctx.catalog.setFavorite(input.providerId, input.modelId, input.favorite),
  );

  on('catalog:probeCapability', async (input: CapabilityProbeInput): Promise<ModelCatalogPage> => {
    if (input.capability !== 'toolCalling') {
      throw appError('validation', {
        message: 'Apenas a verificação de chamada de ferramentas está implementada.',
        action: 'Use o catálogo para ver as capacidades declaradas das demais.',
      });
    }
    const provider = ctx.providers.get(input.providerId);
    if (!(provider instanceof OpenRouterProvider)) {
      throw appError('validation', {
        message: 'A verificação de ferramentas só está implementada para o OpenRouter.',
        action: 'Para outros provedores, a capacidade é descoberta no primeiro uso real.',
      });
    }
    try {
      const probe = await provider.probeToolCalling(input.modelId);
      ctx.catalog.recordObservation(
        input.providerId,
        input.modelId,
        'toolCalling',
        cap(probe.supported ? 'supported' : 'unsupported', 'tested', probe.reason),
      );
    } catch (err) {
      const detail = toErrorDetail(err);
      // Indisponibilidade temporária NÃO vira incompatibilidade permanente.
      ctx.catalog.applyErrorObservation(input.providerId, input.modelId, detail.code, detail.message);
      throw err;
    }
    ctx.bus.emitApp({ type: 'catalog/invalidated', providerId: input.providerId, at: new Date().toISOString() });
    return listCatalog({ providerId: input.providerId });
  });

  /* ------------------------------------------------------------------ *
   * Codex
   * ------------------------------------------------------------------ */

  on('codex:runtime', () => ctx.codexRuntime.info());
  on('codex:locate', (input: { executablePath?: string }) => ctx.codexRuntime.locate(input.executablePath));
  on('codex:start', () => ctx.codexRuntime.start());
  on('codex:stop', () => ctx.codexRuntime.stop());
  on('codex:account', (): Promise<CodexAccountState> => ctx.codexRuntime.refreshAccount());
  on('codex:rateLimits', (): Promise<CodexAccountState> => ctx.codexRuntime.refreshRateLimits());
  on('codex:logout', () => ctx.codexRuntime.logout());

  on('codex:loginStart', async (input: { method: 'chatgpt' | 'deviceCode' | 'apiKey'; apiKey?: string }) => {
    const started = await ctx.codexRuntime.startLogin(input.method, input.apiKey);
    return started;
  });

  on('codex:loginCancel', async (input: { loginId: string }) => ({
    cancelled: await ctx.codexRuntime.cancelLogin(input.loginId),
  }));

  on('codex:skills', async (input: { workspacePath?: string }): Promise<SkillDescriptor[]> =>
    ctx.codexEngine.listSkills(input.workspacePath),
  );

  /* ------------------------------------------------------------------ *
   * Conversas
   * ------------------------------------------------------------------ */

  on('conversations:list', (input: { includeArchived?: boolean }) =>
    ctx.conversations.list(input.includeArchived ?? false),
  );
  on('conversations:create', (input: CreateConversationInput) => ctx.conversations.create(input));
  on('conversations:read', (input: { conversationId: string }) => ctx.conversations.read(input.conversationId));
  on('conversations:items', (input: { conversationId: string; limit?: number; beforeSeq?: number }) =>
    ctx.conversations.items(input.conversationId, { limit: input.limit, beforeSeq: input.beforeSeq }),
  );
  on('conversations:rename', (input: { conversationId: string; title: string }) =>
    ctx.conversations.rename(input.conversationId, input.title),
  );
  on('conversations:archive', (input: { conversationId: string }) => ctx.conversations.archive(input.conversationId, true));
  on('conversations:unarchive', (input: { conversationId: string }) =>
    ctx.conversations.archive(input.conversationId, false),
  );
  on('conversations:delete', async (input: { conversationId: string }) => ({
    deleted: await ctx.conversations.delete(input.conversationId),
  }));
  on('conversations:fork', (input: ForkConversationInput) => ctx.conversations.fork(input));
  on('conversations:setFavorite', (input: { conversationId: string; favorite: boolean }) =>
    ctx.conversations.setFavorite(input.conversationId, input.favorite),
  );
  on('conversations:search', (input: { query: string; limit?: number }) =>
    ctx.conversations.search(input.query, input.limit),
  );
  on('conversations:export', async (input: { conversationId: string; format: ConversationExportFormat }) => {
    const conversation = ctx.conversations.read(input.conversationId);
    if (!conversation) throw appError('validation', { message: 'A conversa não foi encontrada.' });
    const items = ctx.conversations.items(input.conversationId);
    const content = renderConversationExport(input.format, {
      conversation,
      items,
      app: { name: options.appName, version: options.appVersion },
    });
    const window = options.getMainWindow();
    const suggested = exportFileName(conversation, input.format);
    const result = await dialog.showSaveDialog(window ?? undefined!, {
      title: 'Exportar conversa',
      defaultPath: join(app.getPath('documents'), suggested),
      buttonLabel: 'Exportar',
      filters:
        input.format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { path: null };
    await writeFile(result.filePath, content, 'utf8');
    logger.info('ipc', 'Conversa exportada', { format: input.format });
    return { path: result.filePath };
  });
  on('conversations:saveDraft', (input: { conversationId: string; text: string; attachmentIds: string[] }) => {
    ctx.conversations.saveDraft(input.conversationId, input.text, input.attachmentIds);
    return { saved: true };
  });
  on('conversations:readDraft', (input: { conversationId: string }) => ctx.conversations.readDraft(input.conversationId));
  on('conversations:setParameters', (input: { conversationId: string; parameters: Record<string, unknown> }) =>
    ctx.conversations.setParameters(input.conversationId, input.parameters as never),
  );
  on('conversations:setMode', (input: { conversationId: string; mode: 'chat' | 'plan' | 'execute' }) =>
    ctx.conversations.setMode(input.conversationId, input.mode),
  );
  on('conversations:setWorkspace', async (input: { conversationId: string; workspacePath: string | null }) => {
    const updated = await ctx.conversations.setWorkspace(input.conversationId, input.workspacePath);
    ctx.bus.emitApp({ type: 'workspaces/updated', at: new Date().toISOString() });
    return updated;
  });

  /* ------------------------------------------------------------------ *
   * Turnos
   * ------------------------------------------------------------------ */

  on('turn:send', (input: SendTurnInput) => ctx.conversations.send(input));
  on('turn:steer', async (input: { conversationId: string; text: string }) => ({
    accepted: await ctx.conversations.steer(input.conversationId, input.text),
  }));
  on('turn:interrupt', async (input: { conversationId: string }) => ({
    requested: await ctx.conversations.interrupt(input.conversationId),
  }));
  on('turn:policy', (input: { conversationId: string }) => ctx.conversations.policyFor(input.conversationId));

  /* ------------------------------------------------------------------ *
   * Aprovações
   * ------------------------------------------------------------------ */

  on('approvals:pending', (): ApprovalRequest[] => ctx.approvals.pending());
  on('approvals:resolve', (input: ResolveApprovalInput) => ({
    resolved: ctx.approvals.resolve(input.approvalId, input.decision),
  }));

  /* ------------------------------------------------------------------ *
   * Workspaces
   * ------------------------------------------------------------------ */

  on('workspaces:list', () => ctx.workspaces.list());

  on('workspaces:choose', async () => {
    const window = options.getMainWindow();
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: 'Selecionar workspace',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Usar esta pasta',
    });
    const chosen = result.filePaths[0];
    if (result.canceled || !chosen) return null;
    const workspace = await ctx.workspaces.register(chosen);
    ctx.bus.emitApp({ type: 'workspaces/updated', at: new Date().toISOString() });
    return workspace;
  });

  on('workspaces:register', async (input: { path: string }) => {
    const workspace = await ctx.workspaces.register(input.path);
    ctx.bus.emitApp({ type: 'workspaces/updated', at: new Date().toISOString() });
    return workspace;
  });

  on('workspaces:remove', (input: { id: string }) => {
    const removed = ctx.workspaces.remove(input.id);
    if (removed) ctx.bus.emitApp({ type: 'workspaces/updated', at: new Date().toISOString() });
    return { removed };
  });

  on('workspaces:setFavorite', (input: { id: string; favorite: boolean }) =>
    ctx.workspaces.setFavorite(input.id, input.favorite),
  );
  on('workspaces:git', (input: { path: string }) => ctx.workspaces.gitSummary(input.path));
  on('workspaces:gitChanges', (input: { path: string }) => ctx.workspaces.gitChanges(input.path));
  on('workspaces:fileTree', (input: { path: string; maxEntries?: number }): Promise<FileTreeNode> =>
    ctx.workspaces.fileTree(input.path, input.maxEntries),
  );

  on('workspaces:readFile', async (input: { workspacePath: string; filePath: string; maxBytes?: number }) => {
    const guard = ctx.workspaces.guardFor(input.workspacePath);
    const resolved = guard.resolve(input.filePath);
    const info = await stat(resolved.realPath).catch(() => null);
    if (!info?.isFile()) {
      throw appError('validation', { message: `"${input.filePath}" não é um arquivo legível no workspace.` });
    }
    const maxBytes = input.maxBytes ?? 1024 * 1024;
    const buffer = await readFile(resolved.realPath);
    if (isProbablyBinary(buffer)) {
      return { content: '', truncated: false, binary: true, sizeBytes: info.size };
    }
    const limited = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    return {
      content: limited.toString('utf8'),
      truncated: buffer.byteLength > maxBytes,
      binary: false,
      sizeBytes: info.size,
    };
  });

  /* ------------------------------------------------------------------ *
   * Anexos
   * ------------------------------------------------------------------ */

  const workspaceOf = (conversationId: string): { path?: string; engineId: 'codex' | 'direct' } => {
    const row = ctx.db.conversations.read(conversationId);
    if (!row) throw appError('validation', { message: 'Conversa não encontrada.' });
    return { path: row.workspacePath, engineId: row.engineId };
  };

  on('attachments:choose', async (input: { conversationId: string }) => {
    const window = options.getMainWindow();
    const { path, engineId } = workspaceOf(input.conversationId);
    const result = await dialog.showOpenDialog(window ?? undefined!, {
      title: 'Anexar arquivos',
      properties: ['openFile', 'multiSelections'],
      buttonLabel: 'Anexar',
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return ctx.attachments.prepare({
      conversationId: input.conversationId,
      workspacePath: path,
      paths: result.filePaths,
      engineId,
    });
  });

  const prepare = (input: PrepareAttachmentsInput) => {
    const { path, engineId } = workspaceOf(input.conversationId);
    return ctx.attachments.prepare({
      conversationId: input.conversationId,
      workspacePath: path,
      paths: input.paths,
      engineId,
    });
  };

  on('attachments:prepare', (input: PrepareAttachmentsInput) => prepare(input));
  on('attachments:prepareFromPaths', (input: PrepareAttachmentsInput) => prepare(input));

  on('attachments:prepareFromClipboardImage', (input: PrepareClipboardImageInput) => {
    const { path, engineId } = workspaceOf(input.conversationId);
    return ctx.attachments.prepareClipboardImage({
      conversationId: input.conversationId,
      workspacePath: path,
      base64: input.base64,
      suggestedName: input.suggestedName,
      engineId,
    });
  });

  on('attachments:discard', async (input: { conversationId: string; attachmentId: string }) => ({
    discarded: await ctx.attachments.discard(input.conversationId, input.attachmentId),
  }));

  /* ------------------------------------------------------------------ *
   * Diagnóstico e sistema
   * ------------------------------------------------------------------ */

  on('diagnostics:report', () => ctx.diagnostics.report());
  on('diagnostics:export', async () => {
    const path = await ctx.diagnostics.export();
    return { path };
  });
  on('diagnostics:openLogFolder', async () => {
    const dir = logger.directory;
    if (!dir) return { opened: false };
    await shell.openPath(dir);
    return { opened: true };
  });

  on('shell:openExternal', async (input: { url: string }) => {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      throw appError('validation', { message: 'A URL informada não é válida.' });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') {
      throw appError('forbidden', {
        message: `Abertura bloqueada para o protocolo "${parsed.protocol.replace(':', '')}".`,
        action: 'Somente http, https e mailto são abertos no navegador do sistema.',
      });
    }
    await shell.openExternal(parsed.toString());
    return { opened: true };
  });

  on('shell:showItemInFolder', (input: { path: string }) => {
    // Só caminhos dentro de algum workspace registrado.
    const authorized = ctx.workspaces.listRaw().some((row) => ctx.workspaces.guardFor(row.path).contains(input.path));
    if (!authorized) {
      throw appError('workspaceDenied', {
        message: 'Só é possível revelar arquivos que estão dentro de um workspace registrado.',
      });
    }
    shell.showItemInFolder(input.path);
    return { shown: true };
  });

  on('clipboard:writeText', (input: { text: string }) => {
    clipboard.writeText(input.text);
    return { written: true };
  });

  logger.info('ipc', 'Handlers de IPC registrados');
}

export function attachmentDisplayName(path: string): string {
  return basename(path);
}
