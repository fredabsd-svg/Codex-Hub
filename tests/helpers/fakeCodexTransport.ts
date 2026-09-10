/**
 * Transporte falso do App Server para testes.
 *
 * Permite exercitar o cliente inteiro — handshake, correlação de IDs,
 * timeouts, requisições do servidor, queda de processo e reinício — sem o
 * Codex instalado.
 */

import type { CodexTransport, TransportHandlers } from '../../src/main/codex/transport';

export class FakeCodexTransport implements CodexTransport {
  handlers: TransportHandlers | null = null;
  readonly written: string[] = [];
  paused = false;
  stopped = false;
  readonly pid = 4242;
  readonly description = 'fake codex app-server';

  constructor(
    private readonly options: {
      /** Falha ao iniciar (executável ausente, por exemplo). */
      failStart?: Error;
      /** Responde automaticamente ao `initialize`. */
      autoHandshake?: boolean;
      /** Atraso artificial antes de responder ao handshake. */
      handshakeDelayMs?: number;
      initializeResult?: unknown;
    } = {},
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    if (this.options.failStart) throw this.options.failStart;
    this.handlers = handlers;
    if (this.options.autoHandshake !== false) {
      // Responde ao primeiro `initialize` que chegar.
      this.autoRespondHandshake();
    }
  }

  private autoRespondHandshake(): void {
    const original = this.write.bind(this);
    this.write = (data: string): void => {
      original(data);
      for (const line of data.split('\n')) {
        if (line.trim() === '') continue;
        const parsed = JSON.parse(line) as { id?: number | string; method?: string };
        if (parsed.method === 'initialize' && parsed.id !== undefined) {
          const respond = (): void =>
            this.emitLine(
              JSON.stringify({
                id: parsed.id,
                result: this.options.initializeResult ?? {
                  protocolVersion: '1.0.0',
                  serverInfo: { name: 'codex-app-server', version: '9.9.9' },
                },
              }),
            );
          if (this.options.handshakeDelayMs) setTimeout(respond, this.options.handshakeDelayMs);
          else respond();
        }
      }
    };
  }

  write(data: string): void {
    this.written.push(data);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.handlers = null;
  }

  /* -------------------- Utilidades de teste -------------------- */

  emitLine(line: string): void {
    this.handlers?.onLine(line);
  }

  emitJson(value: unknown): void {
    this.emitLine(JSON.stringify(value));
  }

  emitStderr(text: string): void {
    this.handlers?.onStderr(text);
  }

  emitExit(code: number | null = 1, signal: string | null = null): void {
    this.handlers?.onExit({ code, signal });
  }

  /** Mensagens enviadas, já parseadas. */
  sent(): Array<Record<string, unknown>> {
    return this.written
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  sentMethods(): string[] {
    return this.sent()
      .map((message) => message.method)
      .filter((method): method is string => typeof method === 'string');
  }

  lastRequestId(method: string): number | string | undefined {
    const found = [...this.sent()].reverse().find((message) => message.method === method);
    return found?.id as number | string | undefined;
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
