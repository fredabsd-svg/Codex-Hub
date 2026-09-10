/**
 * Transporte do App Server.
 *
 * `stdout` carrega APENAS o protocolo (JSONL). `stderr` é diagnóstico e passa
 * pela redação de segredos antes de qualquer registro.
 *
 * A interface existe para que os testes possam exercitar o cliente inteiro —
 * handshake, correlação de IDs, timeouts, queda de processo — sem depender do
 * Codex instalado.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appError } from '../../shared/errors';
import { logger } from '../services/logger';
import { redactText } from '../services/redact';
import { Utf8LineDecoder } from '../util/streams';
import type { ResolvedExecutable } from './discovery';
import { terminateProcessTree } from './processTree';

export interface TransportHandlers {
  onLine(line: string): void;
  onStderr(text: string): void;
  onExit(info: { code: number | null; signal: string | null }): void;
  onSpawnError(error: Error): void;
}

export interface CodexTransport {
  start(handlers: TransportHandlers): Promise<void>;
  write(data: string): void;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  readonly pid: number | undefined;
  readonly description: string;
}

export interface ChildProcessTransportOptions {
  executable: ResolvedExecutable;
  args: string[];
  cwd?: string;
  /**
   * Variáveis de ambiente adicionais. Segredos só entram aqui quando o
   * mecanismo é suportado pelo processo filho, com o menor escopo possível.
   */
  env?: Record<string, string>;
  maxLineBytes?: number;
}

export class ChildProcessTransport implements CodexTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: Utf8LineDecoder;

  constructor(private readonly options: ChildProcessTransportOptions) {
    this.decoder = this.createDecoder();
  }

  private createDecoder(): Utf8LineDecoder {
    return new Utf8LineDecoder({
      maxLineLength: this.options.maxLineBytes ?? 16 * 1024 * 1024,
      onOverflow: (dropped) =>
        logger.error('codex', 'Linha do protocolo excedeu o limite e foi descartada', { droppedChars: dropped }),
    });
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get description(): string {
    return `${this.options.executable.filePath} ${this.options.args.join(' ')}`.trim();
  }

  async start(handlers: TransportHandlers): Promise<void> {
    if (this.child) throw new Error('Transporte já iniciado');
    const { executable, args } = this.options;

    // Ambiente enxuto: herda o do app e acrescenta apenas o necessário.
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.options.env ?? {}) };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, ...args], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Nunca `shell: true`: argumentos vão como array.
        shell: false,
        // POSIX: novo grupo de processos para permitir matar a árvore.
        detached: process.platform !== 'win32',
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      throw appError('codexMissing', {
        message: 'Não foi possível iniciar o executável do Codex.',
        technical: err instanceof Error ? err.message : String(err),
      });
    }

    this.child = child;
    this.decoder = this.createDecoder();

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) handlers.onLine(line);
    });
    child.stdout.on('end', () => {
      for (const line of this.decoder.flush()) handlers.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      handlers.onStderr(redactText(chunk.toString('utf8')));
    });
    child.on('error', (err) => handlers.onSpawnError(err));
    child.on('exit', (code, signal) => {
      this.child = null;
      handlers.onExit({ code, signal });
    });

    // `spawn` é assíncrono: aguardamos o primeiro sinal de vida ou erro.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        resolvePromise();
      };
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        rejectPromise(
          appError('codexMissing', {
            message: `Não foi possível iniciar "${executable.filePath}".`,
            action: 'Verifique o caminho em Configurações › Codex e as permissões do arquivo.',
            technical: err.message,
          }),
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  write(data: string): void {
    const child = this.child;
    if (!child) throw appError('protocol', { message: 'O processo do Codex não está em execução.' });
    try {
      child.stdin.write(data);
    } catch (err) {
      throw appError('protocol', {
        message: 'Falha ao escrever no processo do Codex.',
        technical: err instanceof Error ? err.message : String(err),
      });
    }
  }

  pause(): void {
    this.child?.stdout.pause();
  }

  resume(): void {
    this.child?.stdout.resume();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await terminateProcessTree(child, { label: 'codex app-server' });
    this.child = null;
  }
}
