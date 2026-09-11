/**
 * Ciclo de vida e operações do Codex App Server.
 *
 * Concentra: descoberta do executável, handshake, autenticação, catálogo de
 * modelos, skills e roteamento de notificações/requisições do servidor.
 *
 * Se o Codex estiver ausente, o aplicativo continua aberto: o diagnóstico é
 * reportado e os caminhos diretos de outros provedores seguem disponíveis.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CodexAccountState,
  CodexAuthMethod,
  CodexLoginProgress,
  CodexModelProviderInfo,
  CodexRuntimeInfo,
  ErrorDetail,
  ModelCatalogPage,
  ModelDescriptor,
  RateLimitWindow,
  SkillDescriptor,
} from '../../shared/domain';
import { appError, toErrorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import { CodexAppServerClient, type ClientState } from './CodexAppServerClient';
import { discoverCodexExecutable, readCodexVersion, type ResolvedExecutable } from './discovery';
import { CODEX_METHODS } from './methods';
import { arr, asRecord, bool, deepPick, int, pick, str } from './parse';
import { ChildProcessTransport } from './transport';
import { loginParams, matchVariant, parseExpectedVariants, preferredVariant } from './loginParams';
import {
  buildCodexProviderArgs,
  buildCodexProviderEnv,
  looksLikeConfigOverrideRejection,
  type CodexModelProviderConfig,
} from './modelProvider';

export interface CodexRuntimeOptions {
  appName: string;
  appTitle: string;
  appVersion: string;
  generatedTypesDir: string;
  configuredPath(): string | undefined;
  /** Torna o caminho configurado exclusivo (usado por overrides de ambiente e testes). */
  configuredPathOnly?(): boolean;
  /**
   * Provedor de modelos que o processo do Codex deve usar, já com a credencial
   * resolvida. Lido a cada início: mudar a configuração vale no próximo start.
   */
  modelProvider(): CodexModelProviderConfig;
  onNotification(method: string, params: unknown, generation: number): void | Promise<void>;
  onServerRequest(method: string, params: unknown, generation: number): Promise<unknown>;
  onRuntimeChanged(info: CodexRuntimeInfo): void;
  onAccountChanged(account: CodexAccountState): void;
  onLoginProgress(progress: CodexLoginProgress): void;
  onReconnected(generation: number): void | Promise<void>;
}

export class CodexRuntime {
  private client: CodexAppServerClient | null = null;
  private executable: ResolvedExecutable | null = null;
  private version: string | undefined;
  private state: ClientState = 'stopped';
  private diagnostic: ErrorDetail | null = null;
  private protocolVersion: string | undefined;
  private account: CodexAccountState = {
    authenticated: false,
    message: 'A autenticação do Codex ainda não foi verificada.',
  };
  private activeLogins = new Map<string, CodexLoginProgress>();
  /** Versões antigas do Codex não aceitam `-c chave=valor`; ver `start()`. */
  private overridesRejected = false;
  /** Saída de erro do processo, usada só para diagnosticar a partida. */
  private lastStderr = '';

  constructor(private readonly options: CodexRuntimeOptions) {}

  /* -------------------- Tipos gerados -------------------- */

  private generatedTypes(): { version: string | undefined; provisional: boolean } {
    const versionFile = join(this.options.generatedTypesDir, 'VERSION');
    if (!existsSync(versionFile)) {
      return { version: undefined, provisional: true };
    }
    try {
      const content = readFileSync(versionFile, 'utf8').trim();
      const provisional = /provis(ó|o)rio|provisional/i.test(content) || content === '';
      const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(content);
      return { version: match?.[1], provisional };
    } catch {
      return { version: undefined, provisional: true };
    }
  }

  /* -------------------- Informações -------------------- */

  info(): CodexRuntimeInfo {
    const generated = this.generatedTypes();
    return {
      found: this.executable !== null,
      executablePath: this.executable?.filePath,
      discoveredVia: this.executable?.discoveredVia,
      version: this.version,
      initialized: this.state === 'ready',
      protocolVersionReported: this.protocolVersion,
      generatedTypesVersion: generated.version,
      generatedTypesAreProvisional: generated.provisional,
      diagnostic: this.diagnostic ?? undefined,
      restartCount: this.client?.restarts ?? 0,
      modelProvider: this.modelProviderInfo(),
    };
  }

  /**
   * Estado do provedor pedido ao processo do Codex.
   *
   * `accepted` diz apenas que o processo iniciou e concluiu o handshake com
   * essa configuração — nunca que o provedor foi validado de ponta a ponta.
   */
  private modelProviderInfo(): CodexModelProviderInfo {
    const config = this.options.modelProvider();
    if (config.mode === 'default') {
      return { mode: 'default', wireApi: config.wireApi, state: 'default' };
    }
    if (this.overridesRejected) {
      return {
        mode: config.mode,
        wireApi: config.wireApi,
        state: 'overridesRejected',
        note:
          'Esta versão do Codex recusou a configuração enviada pela linha de comando. ' +
          'O processo está usando o provedor padrão. Configure o provedor no config.toml do Codex.',
      };
    }
    if (!config.apiKey) {
      return {
        mode: config.mode,
        wireApi: config.wireApi,
        state: 'missingCredential',
        note:
          'Não há credencial do OpenRouter conectada, então o Codex está usando o provedor padrão dele. ' +
          'Conecte o OpenRouter em Configurações › Provedores.',
      };
    }
    return {
      mode: config.mode,
      wireApi: config.wireApi,
      state: this.state === 'ready' ? 'accepted' : 'requested',
      note:
        this.state === 'ready'
          ? 'O processo do Codex iniciou com esta configuração. Isso não é uma validação do provedor: confirme com um turno real.'
          : 'Configuração enviada ao processo do Codex; ainda não houve handshake concluído com ela.',
    };
  }

  accountState(): CodexAccountState {
    return this.account;
  }

  get isReady(): boolean {
    return this.client?.isReady === true;
  }

  get generation(): number {
    return this.client?.currentGeneration ?? 0;
  }

  /* -------------------- Descoberta -------------------- */

  async locate(explicitPath?: string): Promise<CodexRuntimeInfo> {
    const configured = explicitPath?.trim() || this.options.configuredPath();
    const found = discoverCodexExecutable({
      configuredPath: configured,
      configuredPathOnly: explicitPath === undefined && this.options.configuredPathOnly?.(),
    });
    if (!found) {
      this.executable = null;
      this.version = undefined;
      this.diagnostic = toErrorDetail(
        appError('codexMissing', {
          message: configured
            ? `O caminho informado não contém um executável do Codex: ${configured}`
            : 'O executável do Codex não foi encontrado no PATH nem nos locais de instalação conhecidos.',
          action:
            'Instale o Codex CLI ou informe o caminho completo em Configurações › Codex. O OpenRouter direto continua disponível.',
        }),
      );
      const info = this.info();
      this.options.onRuntimeChanged(info);
      return info;
    }
    this.executable = found;
    this.version = await readCodexVersion(found);
    this.diagnostic = null;
    if (found.kind === 'windowsShellScript' && /\.ps1$/i.test(found.filePath)) {
      this.diagnostic = toErrorDetail(
        appError('codexIncompatible', {
          message: 'Só foi encontrado um script PowerShell do Codex, que este aplicativo não executa.',
          action: 'Instale o binário nativo (codex.exe) ou aponte para o launcher .cmd em Configurações › Codex.',
        }),
      );
    }
    logger.info('codex', 'Executável localizado', {
      path: found.filePath,
      kind: found.kind,
      via: found.discoveredVia,
      version: this.version,
    });
    const info = this.info();
    this.options.onRuntimeChanged(info);
    return info;
  }

  /* -------------------- Ciclo de vida -------------------- */

  async start(): Promise<CodexRuntimeInfo> {
    if (this.client?.isReady) return this.info();
    if (!this.executable) await this.locate();
    const executable = this.executable;
    if (!executable) return this.info();
    if (this.diagnostic?.code === 'codexIncompatible' && /PowerShell/.test(this.diagnostic.message)) {
      return this.info();
    }

    // Provedor de modelos pedido ao processo. No modo padrão nada muda: a
    // lista de argumentos e o ambiente extra ficam vazios.
    const provider = this.options.modelProvider();
    const useOverrides = !this.overridesRejected;
    const providerArgs = useOverrides ? buildCodexProviderArgs(provider) : [];
    const providerEnv = useOverrides ? buildCodexProviderEnv(provider) : {};
    if (providerArgs.length > 0) {
      logger.info('codex', 'Iniciando o App Server com provedor de modelos configurado', {
        mode: provider.mode,
        wireApi: provider.wireApi,
        // A chave nunca é registrada: apenas se existe.
        hasCredential: Object.keys(providerEnv).length > 0,
      });
    }
    this.lastStderr = '';

    const client = new CodexAppServerClient({
      createTransport: () =>
        new ChildProcessTransport({
          executable,
          args: ['app-server', ...providerArgs],
          env: providerEnv,
        }),
      clientInfo: {
        name: this.options.appName,
        title: this.options.appTitle,
        version: this.options.appVersion,
      },
      callbacks: {
        onNotification: (method, params, generation) => this.routeNotification(method, params, generation),
        onServerRequest: (method, params, generation) => this.options.onServerRequest(method, params, generation),
        onStateChange: (state, detail) => {
          this.state = state;
          if (detail) this.diagnostic = detail;
          if (state === 'ready') {
            this.diagnostic = null;
            this.protocolVersion = readProtocolVersion(client.handshakeResult);
          }
          this.options.onRuntimeChanged(this.info());
        },
        onStderr: (text) => {
          const trimmed = text.trim();
          if (trimmed === '') return;
          // Guardado apenas para diagnosticar a partida; passa pela redação do
          // logger como qualquer outra saída do processo.
          if (this.lastStderr.length < 4000) this.lastStderr += `${trimmed}\n`;
          logger.debug('codex:stderr', trimmed.slice(0, 2000));
        },
        onReconnected: async (generation) => {
          await this.refreshAccount().catch(() => undefined);
          await this.options.onReconnected(generation);
        },
      },
    });
    this.client = client;

    try {
      await client.start();
      await this.refreshAccount().catch((err) => {
        logger.debug('codex', 'Não foi possível ler a conta após o handshake', toErrorDetail(err));
      });
    } catch (err) {
      this.diagnostic = toErrorDetail(err, 'codexIncompatible');
      logger.warn('codex', 'Falha ao iniciar o App Server', this.diagnostic);

      // Uma versão do Codex que não aceite `-c chave=valor` derruba o processo
      // antes do handshake. Nesse caso — e SOMENTE nesse — tentamos uma vez
      // sem as sobrescritas: nenhuma operação mutável foi executada ainda.
      if (providerArgs.length > 0 && looksLikeConfigOverrideRejection(this.lastStderr)) {
        logger.warn('codex', 'A versão instalada recusou as sobrescritas de configuração; nova tentativa sem elas');
        this.overridesRejected = true;
        await this.client?.stop().catch(() => undefined);
        this.client = null;
        return this.start();
      }
    }
    const info = this.info();
    this.options.onRuntimeChanged(info);
    return info;
  }

  async stop(): Promise<CodexRuntimeInfo> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.state = 'stopped';
    // Parar e conectar de novo é a forma de reavaliar a configuração: a
    // recusa anterior das sobrescritas não vale para a próxima partida.
    this.overridesRejected = false;
    const info = this.info();
    this.options.onRuntimeChanged(info);
    return info;
  }

  private requireClient(): CodexAppServerClient {
    const client = this.client;
    if (!client || !client.isReady) {
      throw appError('codexMissing', {
        message: 'O Codex App Server não está conectado.',
        action: 'Abra Configurações › Codex e use "Conectar". O OpenRouter direto continua disponível.',
      });
    }
    return client;
  }

  async request<T>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.requireClient().request<T>(method, params, options);
  }

  respondToServerRequest(id: number | string, result: unknown, generation: number): void {
    this.client?.respond(id, result, generation);
  }

  /* -------------------- Notificações -------------------- */

  private async routeNotification(method: string, params: unknown, generation: number): Promise<void> {
    if (method.startsWith('account/')) {
      this.handleAccountNotification(method, params);
    }
    await this.options.onNotification(method, params, generation);
  }

  private handleAccountNotification(method: string, params: unknown): void {
    if (method.endsWith('/rateLimits/updated') || method.endsWith('rateLimitsUpdated')) {
      this.account = { ...this.account, rateLimits: readRateLimits(params) };
      this.options.onAccountChanged(this.account);
      return;
    }
    if (method.includes('login')) {
      const progress = readLoginProgress(params, this.activeLogins);
      if (progress) {
        this.activeLogins.set(progress.loginId, progress);
        this.options.onLoginProgress(progress);
        if (progress.state === 'completed') {
          void this.refreshAccount().catch(() => undefined);
        }
      }
      return;
    }
    if (method.endsWith('/updated')) {
      this.account = readAccount(params) ?? this.account;
      this.options.onAccountChanged(this.account);
    }
  }

  /* -------------------- Conta -------------------- */

  async refreshAccount(): Promise<CodexAccountState> {
    try {
      const result = await this.request<unknown>(CODEX_METHODS.accountRead, undefined, { timeoutMs: 20_000 });
      this.account = readAccount(result) ?? {
        authenticated: false,
        message: 'O Codex não informou dados de conta.',
      };
    } catch (err) {
      const detail = toErrorDetail(err);
      this.account = {
        authenticated: false,
        message: detail.message,
      };
      if (detail.code === 'codexIncompatible') {
        this.account.message = 'A versão instalada do Codex não expõe leitura de conta pelo App Server.';
      }
    }
    this.options.onAccountChanged(this.account);
    return this.account;
  }

  async refreshRateLimits(): Promise<CodexAccountState> {
    try {
      const result = await this.request<unknown>(CODEX_METHODS.accountRateLimitsRead, undefined, { timeoutMs: 20_000 });
      this.account = { ...this.account, rateLimits: readRateLimits(result) };
    } catch (err) {
      const detail = toErrorDetail(err);
      this.account = { ...this.account, message: detail.message };
    }
    this.options.onAccountChanged(this.account);
    return this.account;
  }

  async startLogin(method: CodexAuthMethod, apiKey?: string): Promise<{ loginId: string }> {
    // Uma chave OpenRouter NUNCA é enviada ao fluxo de chave OpenAI do Codex:
    // este método só recebe o que a pessoa digitou no campo do Codex.
    const result = await this.requestLogin(method, apiKey);
    const loginId =
      str(deepPick(result, ['loginId', 'login_id', 'id'])) ?? `login-${Date.now().toString(36)}`;
    const progress: CodexLoginProgress = {
      loginId,
      method,
      state: method === 'deviceCode' ? 'pendingDeviceCode' : method === 'chatgpt' ? 'pendingBrowser' : 'starting',
      userCode: str(deepPick(result, ['userCode', 'user_code', 'code'])),
      verificationUri: str(deepPick(result, ['verificationUri', 'verification_uri', 'url', 'authUrl'])),
      verificationUriComplete: str(deepPick(result, ['verificationUriComplete', 'verification_uri_complete'])),
      expiresAt: str(deepPick(result, ['expiresAt', 'expires_at'])),
    };
    this.activeLogins.set(loginId, progress);
    this.options.onLoginProgress(progress);
    return { loginId };
  }

  /**
   * Envia `account/login/start` com o discriminador `type`.
   *
   * Se a versão instalada não conhecer a variante enviada, ela responde
   * listando as que aceita; usamos ESSA lista para tentar uma única vez mais.
   * Uma requisição recusada não inicia login, então não há efeito repetido.
   */
  private async requestLogin(method: CodexAuthMethod, apiKey?: string): Promise<unknown> {
    const variant = preferredVariant(method);
    try {
      return await this.request<unknown>(
        CODEX_METHODS.accountLoginStart,
        loginParams(method, variant, apiKey),
        { timeoutMs: 60_000 },
      );
    } catch (err) {
      const detail = toErrorDetail(err);
      const options = parseExpectedVariants(`${detail.message} ${detail.technical ?? ''}`);
      const alternative = options.length > 0 ? matchVariant(method, options) : null;
      if (!alternative || alternative === variant) throw err;
      logger.info('codex', 'Repetindo o início de login com a variante aceita pelo servidor', {
        method,
        tentada: variant,
        aceita: alternative,
      });
      return this.request<unknown>(
        CODEX_METHODS.accountLoginStart,
        loginParams(method, alternative, apiKey),
        { timeoutMs: 60_000 },
      );
    }
  }

  async cancelLogin(loginId: string): Promise<boolean> {
    try {
      await this.request(CODEX_METHODS.accountLoginCancel, { loginId }, { timeoutMs: 15_000 });
      const progress = this.activeLogins.get(loginId);
      if (progress) {
        const next: CodexLoginProgress = { ...progress, state: 'cancelled' };
        this.activeLogins.set(loginId, next);
        this.options.onLoginProgress(next);
      }
      return true;
    } catch (err) {
      logger.warn('codex', 'Falha ao cancelar login', toErrorDetail(err));
      return false;
    }
  }

  async logout(): Promise<CodexAccountState> {
    await this.request(CODEX_METHODS.accountLogout, undefined, { timeoutMs: 20_000 });
    this.account = { authenticated: false, message: 'Sessão do Codex encerrada.' };
    this.options.onAccountChanged(this.account);
    return this.account;
  }

  /* -------------------- Catálogo -------------------- */

  async listModels(): Promise<ModelCatalogPage> {
    const fetchedAt = new Date().toISOString();
    try {
      const result = await this.request<unknown>(CODEX_METHODS.modelList, undefined, { timeoutMs: 30_000 });
      const list = arr(deepPick(result, ['models', 'data', 'items']));
      const models: ModelDescriptor[] = [];
      for (const entry of list) {
        const model = readCodexModel(entry);
        if (model) models.push(model);
      }
      return {
        providerId: 'codex',
        models,
        fetchedAt,
        fromCache: false,
        warning:
          models.length === 0
            ? 'O Codex não devolveu modelos em `model/list`. Verifique a autenticação em Configurações › Codex.'
            : undefined,
      };
    } catch (err) {
      const detail = toErrorDetail(err);
      return {
        providerId: 'codex',
        models: [],
        fetchedAt,
        fromCache: false,
        warning: `${detail.message} ${detail.action ?? ''}`.trim(),
      };
    }
  }

  async listSkills(workspacePath?: string): Promise<SkillDescriptor[]> {
    try {
      const result = await this.request<unknown>(
        CODEX_METHODS.skillsList,
        workspacePath ? { cwd: workspacePath } : undefined,
        { timeoutMs: 20_000 },
      );
      const list = arr(deepPick(result, ['skills', 'data', 'items']));
      const skills: SkillDescriptor[] = [];
      for (const [index, entry] of list.entries()) {
        const record = asRecord(entry);
        if (!record) continue;
        const name = str(pick(record, 'name', 'title', 'id'));
        if (!name) continue;
        skills.push({
          id: str(pick(record, 'id', 'slug')) ?? `${name}-${index}`,
          name,
          description: str(pick(record, 'description', 'summary')),
          origin: str(pick(record, 'origin', 'source', 'scope')),
          scope: str(pick(record, 'scope', 'path')),
          workspacePath,
          engineId: 'codex',
          availability: bool(pick(record, 'available', 'enabled')) === false ? 'unsupported' : 'supported',
          availabilityReason: str(pick(record, 'unavailableReason', 'reason')),
          // A versão atual não expõe um mecanismo de habilitar/desabilitar
          // pelo App Server: a preferência é LOCAL e isso é declarado.
          toggleIsLocalOnly: true,
          enabledLocally: true,
        });
      }
      return skills;
    } catch (err) {
      const detail = toErrorDetail(err);
      logger.debug('codex', 'skills/list indisponível', detail);
      return [];
    }
  }
}

/* ------------------------------------------------------------------ *
 * Leitores
 * ------------------------------------------------------------------ */

function readProtocolVersion(handshake: unknown): string | undefined {
  return (
    str(deepPick(handshake, ['protocolVersion', 'protocol_version'])) ??
    str(deepPick(handshake, ['version'])) ??
    undefined
  );
}

export function readAccount(raw: unknown): CodexAccountState | null {
  const record = asRecord(raw) ?? asRecord(deepPick(raw, ['account']));
  if (!record) return null;
  const authenticated =
    bool(pick(record, 'authenticated', 'isAuthenticated', 'loggedIn')) ??
    (str(pick(record, 'email', 'accountId', 'accountLabel')) !== undefined);
  const methodRaw = str(pick(record, 'method', 'authMethod', 'auth_method', 'type'));
  const method =
    methodRaw === undefined
      ? undefined
      : /chatgpt|oauth/i.test(methodRaw)
        ? 'chatgpt'
        : /device/i.test(methodRaw)
          ? 'deviceCode'
          : 'apiKey';
  return {
    authenticated,
    method,
    accountLabel: str(pick(record, 'email', 'accountLabel', 'label', 'accountId')),
    planLabel: str(pick(record, 'plan', 'planName', 'planType', 'subscription')),
    rateLimits: readRateLimits(record),
    message: authenticated ? undefined : 'Nenhuma conta autenticada no Codex.',
  };
}

export function readRateLimits(raw: unknown): RateLimitWindow[] | undefined {
  const container = deepPick(raw, ['rateLimits', 'rate_limits', 'limits']);
  const windows: RateLimitWindow[] = [];
  const record = asRecord(container);
  if (record && !Array.isArray(container)) {
    for (const [key, value] of Object.entries(record)) {
      const item = asRecord(value);
      if (!item) continue;
      windows.push(toRateWindow(key, item));
    }
  }
  for (const entry of arr(container)) {
    const item = asRecord(entry);
    if (!item) continue;
    windows.push(toRateWindow(str(pick(item, 'label', 'name', 'window')) ?? 'Limite', item));
  }
  return windows.length > 0 ? windows : undefined;
}

function toRateWindow(label: string, item: Record<string, unknown>): RateLimitWindow {
  const minutes = int(pick(item, 'windowMinutes', 'window_minutes', 'windowSizeMinutes'));
  return {
    label: humanizeWindowLabel(label, minutes),
    usedPercent: int(pick(item, 'usedPercent', 'used_percent', 'percentUsed')),
    remaining: int(pick(item, 'remaining', 'remainingRequests')),
    limit: int(pick(item, 'limit', 'total')),
    resetsAt: str(pick(item, 'resetsAt', 'resets_at', 'resetAt')),
    windowMinutes: minutes,
  };
}

function humanizeWindowLabel(label: string, minutes: number | undefined): string {
  if (minutes !== undefined) {
    if (minutes >= 1440) return `Janela de ${Math.round(minutes / 1440)} dia(s)`;
    if (minutes >= 60) return `Janela de ${Math.round(minutes / 60)} hora(s)`;
    return `Janela de ${minutes} minuto(s)`;
  }
  if (/primary/i.test(label)) return 'Limite principal';
  if (/secondary/i.test(label)) return 'Limite secundário';
  return label;
}

function readLoginProgress(
  raw: unknown,
  known: Map<string, CodexLoginProgress>,
): CodexLoginProgress | null {
  const loginId = str(deepPick(raw, ['loginId', 'login_id', 'id']));
  const previous = loginId ? known.get(loginId) : [...known.values()][0];
  const id = loginId ?? previous?.loginId;
  if (!id) return null;
  const stateRaw = str(deepPick(raw, ['state', 'status', 'phase']));
  const success = bool(deepPick(raw, ['success', 'completed']));
  let state: CodexLoginProgress['state'] = previous?.state ?? 'starting';
  if (success === true) state = 'completed';
  else if (success === false) state = 'error';
  if (stateRaw) {
    if (/complete|success/i.test(stateRaw)) state = 'completed';
    else if (/cancel/i.test(stateRaw)) state = 'cancelled';
    else if (/expire/i.test(stateRaw)) state = 'expired';
    else if (/error|fail/i.test(stateRaw)) state = 'error';
    else if (/device/i.test(stateRaw)) state = 'pendingDeviceCode';
    else if (/browser|pending/i.test(stateRaw)) state = 'pendingBrowser';
  }
  return {
    loginId: id,
    method: previous?.method ?? 'chatgpt',
    state,
    userCode: str(deepPick(raw, ['userCode', 'user_code', 'code'])) ?? previous?.userCode,
    verificationUri:
      str(deepPick(raw, ['verificationUri', 'verification_uri', 'url'])) ?? previous?.verificationUri,
    verificationUriComplete:
      str(deepPick(raw, ['verificationUriComplete', 'verification_uri_complete'])) ??
      previous?.verificationUriComplete,
    expiresAt: str(deepPick(raw, ['expiresAt', 'expires_at'])) ?? previous?.expiresAt,
    message: str(deepPick(raw, ['message', 'error', 'reason'])),
  };
}

export function readCodexModel(raw: unknown): ModelDescriptor | null {
  const record = asRecord(raw);
  if (!record) return null;
  const id = str(pick(record, 'id', 'model', 'slug', 'name'));
  if (!id) return null;
  const efforts = arr(deepPick(record, ['reasoningEffortLevels', 'reasoning_effort_levels', 'reasoningEfforts']))
    .filter((v): v is string => typeof v === 'string');
  const personalities = arr(deepPick(record, ['personalities', 'personalityOptions']))
    .filter((v): v is string => typeof v === 'string');
  return {
    id,
    providerId: 'codex',
    displayName: str(pick(record, 'displayName', 'display_name', 'name', 'label')) ?? id,
    description: str(pick(record, 'description', 'summary')),
    vendor: str(pick(record, 'vendor', 'provider')),
    inputModalities: arr(deepPick(record, ['inputModalities', 'input_modalities'])).filter(
      (v): v is string => typeof v === 'string',
    ),
    outputModalities: arr(deepPick(record, ['outputModalities', 'output_modalities'])).filter(
      (v): v is string => typeof v === 'string',
    ),
    contextWindow: int(deepPick(record, ['contextWindow', 'context_window', 'contextLength'])),
    maxOutputTokens: int(deepPick(record, ['maxOutputTokens', 'max_output_tokens'])),
    supportedParameters: arr(deepPick(record, ['supportedParameters', 'supported_parameters'])).filter(
      (v): v is string => typeof v === 'string',
    ),
    pricing: { currency: 'USD', unknown: true },
    capabilities: {
      chat: { state: 'supported', source: 'declared', reason: 'Modelo listado por model/list no Codex.' },
      streaming: { state: 'supported', source: 'declared', reason: 'O App Server envia deltas de mensagem.' },
      toolCalling: {
        state: 'supported',
        source: 'declared',
        reason: 'Ferramentas são executadas pelo runtime oficial do Codex.',
      },
      taskExecution: {
        state: 'supported',
        source: 'declared',
        reason: 'Comandos são executados pelo runtime oficial com sandbox e aprovações.',
      },
      reasoningEffort:
        efforts.length > 0
          ? { state: 'supported', source: 'declared', reason: `Níveis: ${efforts.join(', ')}.` }
          : { state: 'unknown', source: 'inferred' },
      personality:
        personalities.length > 0
          ? { state: 'supported', source: 'declared', reason: `Opções: ${personalities.join(', ')}.` }
          : { state: 'unknown', source: 'inferred' },
    },
    codex: {
      isDefault: bool(deepPick(record, ['isDefault', 'is_default', 'default'])),
      reasoningEffortLevels: efforts.length > 0 ? efforts : undefined,
      defaultReasoningEffort: str(deepPick(record, ['defaultReasoningEffort', 'default_reasoning_effort'])),
      personalities: personalities.length > 0 ? personalities : undefined,
      defaultPersonality: str(deepPick(record, ['defaultPersonality', 'default_personality'])),
      upgradeAvailable: bool(deepPick(record, ['upgradeAvailable', 'upgrade_available'])),
      upgradeNotice: str(deepPick(record, ['upgradeNotice', 'upgrade_notice', 'upgradeMessage'])),
    },
    unverified: false,
  };
}
