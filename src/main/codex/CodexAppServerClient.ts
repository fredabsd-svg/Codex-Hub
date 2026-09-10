/**
 * Cliente do Codex App Server.
 *
 * Garantias implementadas:
 *  - handshake obrigatório: `initialize` → resposta → `initialized`. Nenhuma
 *    outra operação é liberada antes disso, e o handshake é refeito em CADA
 *    nova conexão.
 *  - correlação por `id` com timeout individual e limpeza de promessas pendentes.
 *  - respostas de conexões antigas são REJEITADAS (contador de geração).
 *  - requisições iniciadas pelo servidor são classificadas separadamente e
 *    respondidas no `id` original.
 *  - ordem de eventos preservada: notificações são despachadas em série,
 *    mesmo quando o handler é assíncrono; a leitura é pausada quando a fila
 *    cresce (controle de fluxo).
 *  - reinício com atraso progressivo e limite de tentativas; nenhuma operação
 *    mutável é reexecutada (sem replay).
 */

import { appError, toErrorDetail } from '../../shared/errors';
import type { ErrorDetail } from '../../shared/domain';
import { logger } from '../services/logger';
import { CODEX_METHODS, CODEX_NOTIFICATIONS } from './methods';
import {
  classify,
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  JSON_RPC,
  type IncomingMessage,
  type JsonRpcId,
} from './protocol';
import type { CodexTransport } from './transport';

export type ClientState = 'stopped' | 'starting' | 'handshaking' | 'ready' | 'restarting' | 'failed';

export interface ClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface CodexClientCallbacks {
  onNotification(method: string, params: unknown, generation: number): void | Promise<void>;
  /** Deve devolver o `result` da resposta ou lançar para responder com erro. */
  onServerRequest(method: string, params: unknown, generation: number): Promise<unknown>;
  onStateChange(state: ClientState, detail?: ErrorDetail): void;
  onStderr(text: string): void;
  /** Chamado depois de um reinício bem-sucedido, para reconciliar estado. */
  onReconnected(generation: number): void | Promise<void>;
}

export interface CodexClientOptions {
  createTransport(): CodexTransport;
  clientInfo: ClientInfo;
  callbacks: CodexClientCallbacks;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestarts?: number;
  /** Fábrica de atraso para testes. */
  delay?(ms: number): Promise<void>;
  /** Parâmetros extras do `initialize` (recursos experimentais explícitos). */
  initializeExtras?: Record<string, unknown>;
}

interface Pending {
  generation: number;
  method: string;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

const QUEUE_HIGH_WATER = 512;

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CodexAppServerClient {
  private transport: CodexTransport | null = null;
  private state: ClientState = 'stopped';
  private generation = 0;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private queue: Array<() => Promise<void>> = [];
  private draining = false;
  private paused = false;
  private restartCount = 0;
  private stopping = false;
  private initializeResult: unknown = null;
  private lastError: ErrorDetail | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(private readonly options: CodexClientOptions) {}

  get currentState(): ClientState {
    return this.state;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get restarts(): number {
    return this.restartCount;
  }

  get handshakeResult(): unknown {
    return this.initializeResult;
  }

  get diagnostic(): ErrorDetail | null {
    return this.lastError;
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /* ------------------------------------------------------------------ *
   * Ciclo de vida
   * ------------------------------------------------------------------ */

  async start(): Promise<void> {
    if (this.state === 'ready') return;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.setState('starting');
    this.generation += 1;
    const generation = this.generation;
    const transport = this.options.createTransport();
    this.transport = transport;

    try {
      await transport.start({
        onLine: (line) => this.handleLine(line, generation),
        onStderr: (text) => this.options.callbacks.onStderr(text),
        onExit: (info) => this.handleExit(info, generation),
        onSpawnError: (err) => {
          logger.error('codex', 'Erro no processo do Codex', err);
        },
      });
    } catch (err) {
      this.transport = null;
      const detail = toErrorDetail(err, 'codexMissing');
      this.lastError = detail;
      this.setState('failed', detail);
      throw err;
    }

    try {
      await this.performHandshake(generation);
    } catch (err) {
      const detail = toErrorDetail(err, 'codexIncompatible');
      this.lastError = detail;
      await this.hardStop();
      this.setState('failed', detail);
      throw err;
    }

    this.restartCount = 0;
    this.lastError = null;
    this.setState('ready');
  }

  private async performHandshake(generation: number): Promise<void> {
    this.setState('handshaking');
    const timeoutMs = this.options.handshakeTimeoutMs ?? 20_000;
    const params = {
      clientInfo: {
        name: this.options.clientInfo.name,
        title: this.options.clientInfo.title,
        version: this.options.clientInfo.version,
      },
      ...(this.options.initializeExtras ?? {}),
    };
    this.initializeResult = await this.sendRequest(CODEX_METHODS.initialize, params, {
      timeoutMs,
      generation,
      allowBeforeReady: true,
    });
    // Só depois da RESPOSTA a notificação `initialized` é enviada.
    this.writeRaw(encodeNotification(CODEX_NOTIFICATIONS.initialized), generation);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.hardStop();
    this.setState('stopped');
  }

  private async hardStop(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.failAllPending(appError('cancelled', { message: 'A conexão com o Codex foi encerrada.' }));
    this.queue = [];
    if (transport) {
      try {
        await transport.stop();
      } catch (err) {
        logger.warn('codex', 'Falha ao encerrar o transporte', err);
      }
    }
  }

  private handleExit(info: { code: number | null; signal: string | null }, generation: number): void {
    if (generation !== this.generation) return;
    logger.warn('codex', 'Processo do Codex encerrou', info);
    this.transport = null;
    this.failAllPending(
      appError('protocol', {
        message: 'O processo do Codex encerrou antes de concluir a operação.',
        action: 'Reinicie a conexão em Configurações › Codex. Nenhum comando foi reexecutado automaticamente.',
        technical: `code=${info.code ?? 'null'} signal=${info.signal ?? 'null'}`,
      }),
    );
    if (this.stopping) {
      this.setState('stopped');
      return;
    }
    void this.scheduleRestart();
  }

  private async scheduleRestart(): Promise<void> {
    const maxRestarts = this.options.maxRestarts ?? 5;
    if (this.restartCount >= maxRestarts) {
      const detail = toErrorDetail(
        appError('codexIncompatible', {
          message: `O Codex encerrou ${this.restartCount} vezes seguidas e o aplicativo parou de tentar reiniciar.`,
          action: 'Verifique o executável em Configurações › Codex e use "Tentar novamente".',
        }),
      );
      this.lastError = detail;
      this.setState('failed', detail);
      return;
    }
    this.restartCount += 1;
    const backoff = Math.min(15_000, 500 * 2 ** (this.restartCount - 1));
    this.setState('restarting');
    logger.info('codex', 'Reiniciando o Codex', { attempt: this.restartCount, backoffMs: backoff });
    await (this.options.delay ?? defaultDelay)(backoff);
    if (this.stopping) return;
    try {
      await this.doStart();
      // Reconciliação: quem usa o cliente relê o estado real das conversas.
      // Nenhuma operação mutável é repetida aqui.
      await this.options.callbacks.onReconnected(this.generation);
    } catch (err) {
      logger.warn('codex', 'Tentativa de reinício falhou', toErrorDetail(err));
      if (!this.stopping) void this.scheduleRestart();
    }
  }

  private setState(state: ClientState, detail?: ErrorDetail): void {
    if (this.state === state && !detail) return;
    this.state = state;
    this.options.callbacks.onStateChange(state, detail);
  }

  /* ------------------------------------------------------------------ *
   * Envio
   * ------------------------------------------------------------------ */

  async request<T = unknown>(method: string, params?: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    if (this.state !== 'ready') {
      throw appError('protocol', {
        message: 'A conexão com o Codex ainda não está pronta.',
        action: 'Aguarde a inicialização ou reinicie a conexão em Configurações › Codex.',
        technical: `estado=${this.state}`,
      });
    }
    return (await this.sendRequest(method, params, {
      timeoutMs: options.timeoutMs,
      generation: this.generation,
      allowBeforeReady: false,
    })) as T;
  }

  private sendRequest(
    method: string,
    params: unknown,
    options: { timeoutMs?: number; generation: number; allowBeforeReady: boolean },
  ): Promise<unknown> {
    const generation = options.generation;
    if (generation !== this.generation) {
      return Promise.reject(appError('cancelled', { message: 'A conexão foi substituída antes do envio.' }));
    }
    const id = this.nextId++;
    const key = `${generation}:${id}`;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? 60_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(
          appError('timeout', {
            message: `O Codex não respondeu a "${method}" em ${Math.round(timeoutMs / 1000)}s.`,
            action: 'Tente novamente; se persistir, reinicie a conexão em Configurações › Codex.',
          }),
        );
      }, timeoutMs);
      this.pending.set(key, { generation, method, resolve, reject, timer });
      try {
        this.writeRaw(encodeRequest(id, method, params), generation);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.state !== 'ready') {
      throw appError('protocol', { message: 'A conexão com o Codex ainda não está pronta.' });
    }
    this.writeRaw(encodeNotification(method, params), this.generation);
  }

  /** Responde a uma requisição INICIADA PELO SERVIDOR. */
  respond(id: JsonRpcId, result: unknown, generation: number): void {
    if (generation !== this.generation) {
      logger.warn('codex', 'Resposta descartada: pertence a uma conexão encerrada', { id });
      return;
    }
    this.writeRaw(encodeResponse(id, result), generation);
  }

  respondError(id: JsonRpcId, code: number, message: string, generation: number, data?: unknown): void {
    if (generation !== this.generation) return;
    this.writeRaw(encodeErrorResponse(id, code, message, data), generation);
  }

  private writeRaw(payload: string, generation: number): void {
    if (generation !== this.generation) {
      throw appError('cancelled', { message: 'A conexão foi substituída antes do envio.' });
    }
    const transport = this.transport;
    if (!transport) {
      throw appError('protocol', { message: 'O processo do Codex não está em execução.' });
    }
    transport.write(payload);
  }

  /* ------------------------------------------------------------------ *
   * Recepção
   * ------------------------------------------------------------------ */

  private handleLine(line: string, generation: number): void {
    const message = classify(line);
    if (!message) return;
    if (generation !== this.generation) {
      logger.debug('codex', 'Mensagem de conexão antiga descartada', { generation });
      return;
    }
    this.dispatch(message, generation);
  }

  private dispatch(message: IncomingMessage, generation: number): void {
    switch (message.kind) {
      case 'response':
      case 'error': {
        const key = `${generation}:${String(message.id)}`;
        const pending = this.pending.get(key);
        if (!pending) {
          logger.warn('codex', 'Resposta sem requisição correspondente', { id: message.id });
          return;
        }
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.kind === 'response') {
          pending.resolve(message.result);
        } else {
          pending.reject(mapRpcError(pending.method, message.error));
        }
        return;
      }
      case 'serverRequest': {
        this.enqueue(async () => {
          try {
            const result = await this.options.callbacks.onServerRequest(message.method, message.params, generation);
            this.respond(message.id, result, generation);
          } catch (err) {
            const detail = toErrorDetail(err);
            this.respondError(
              message.id,
              detail.code === 'approvalDenied' ? JSON_RPC.requestRejected : JSON_RPC.internalError,
              detail.message,
              generation,
            );
          }
        });
        return;
      }
      case 'notification': {
        this.enqueue(async () => {
          await this.options.callbacks.onNotification(message.method, message.params, generation);
        });
        return;
      }
      case 'invalid': {
        logger.warn('codex', 'Linha inválida recebida do App Server', {
          reason: message.reason,
          raw: message.raw,
        });
        return;
      }
      default:
        return;
    }
  }

  /** Fila serial: preserva a ordem relevante mesmo com handlers assíncronos. */
  private enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    if (this.queue.length > QUEUE_HIGH_WATER && !this.paused) {
      this.paused = true;
      this.transport?.pause();
      logger.warn('codex', 'Controle de fluxo ativado: leitura pausada', { queued: this.queue.length });
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) continue;
        try {
          await task();
        } catch (err) {
          logger.error('codex', 'Handler de evento falhou', err);
        }
        if (this.paused && this.queue.length < QUEUE_HIGH_WATER / 2) {
          this.paused = false;
          this.transport?.resume();
        }
      }
    } finally {
      this.draining = false;
      if (this.paused) {
        this.paused = false;
        this.transport?.resume();
      }
    }
  }

  private failAllPending(error: unknown): void {
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(error);
    }
  }

  /** Exposto para testes e diagnóstico. */
  get pendingCount(): number {
    return this.pending.size;
  }
}

function mapRpcError(method: string, error: { code: number; message: string; data?: unknown }): unknown {
  if (error.code === JSON_RPC.methodNotFound) {
    return appError('codexIncompatible', {
      message: `A versão instalada do Codex não implementa "${method}".`,
      action: 'Atualize o Codex CLI para usar este recurso. O restante do aplicativo continua funcionando.',
      technical: `${error.code}: ${error.message}`,
    });
  }
  if (error.code === JSON_RPC.invalidParams) {
    return appError('protocol', {
      message: `O Codex recusou os parâmetros de "${method}".`,
      action: 'Gere os tipos com "npm run codex:types" para alinhar o cliente à versão instalada.',
      technical: `${error.code}: ${error.message}`,
    });
  }
  if (/unauthorized|not (logged|signed) in|authentication/i.test(error.message)) {
    return appError('unauthorized', {
      message: 'O Codex informou que não há autenticação válida.',
      action: 'Faça login em Configurações › Codex › Autenticação.',
      technical: `${error.code}: ${error.message}`,
    });
  }
  if (/rate limit|quota/i.test(error.message)) {
    return appError('rateLimited', { technical: `${error.code}: ${error.message}` });
  }
  return appError('protocol', {
    message: `O Codex respondeu com erro em "${method}": ${error.message}`,
    technical: `${error.code}: ${error.message}`,
  });
}
