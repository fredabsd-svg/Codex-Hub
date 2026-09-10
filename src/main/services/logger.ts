/**
 * Log do processo principal com rotação e redação por padrão.
 *
 * - Arquivos em `app.getPath('logs')` (fora do diretório de instalação e do ASAR).
 * - Conteúdo de mensagens de conversa NÃO é registrado.
 * - Erros e diagnósticos passam pela redação antes de serem gravados.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redactText, redactValue } from './redact';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5;

export interface RecentError {
  at: string;
  scope: string;
  code: string;
  message: string;
}

class Logger {
  private dir: string | null = null;
  private file: string | null = null;
  private level: LogLevel = 'info';
  // Em testes (`CODEX_HUB_LOG_STDOUT=false`) o log não polui a saída.
  private toStdout = process.env.CODEX_HUB_LOG_STDOUT !== 'false';
  private enabled = true;
  private readonly recentErrors: RecentError[] = [];

  configure(options: { dir?: string; level?: LogLevel; toStdout?: boolean; enabled?: boolean }): void {
    if (options.dir) {
      this.dir = options.dir;
      this.file = join(options.dir, 'codex-hub.log');
      try {
        mkdirSync(options.dir, { recursive: true });
      } catch {
        this.file = null;
      }
    }
    if (options.level) this.level = options.level;
    if (typeof options.toStdout === 'boolean') this.toStdout = options.toStdout;
    if (typeof options.enabled === 'boolean') this.enabled = options.enabled;
  }

  get directory(): string | null {
    return this.dir;
  }

  get filePath(): string | null {
    return this.file;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] <= LEVEL_ORDER[this.level];
  }

  private rotate(): void {
    if (!this.file) return;
    try {
      if (!existsSync(this.file)) return;
      if (statSync(this.file).size < MAX_BYTES) return;
      for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (existsSync(from)) {
          if (i + 1 > MAX_FILES) unlinkSync(from);
          else renameSync(from, to);
        }
      }
      renameSync(this.file, `${this.file}.1`);
    } catch {
      /* rotação é best-effort */
    }
  }

  private write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;
    const at = new Date().toISOString();
    const safeMessage = redactText(message);
    let line = `${at} ${level.toUpperCase().padEnd(5)} [${scope}] ${safeMessage}`;
    if (data !== undefined) {
      try {
        line += ` ${JSON.stringify(redactValue(data))}`;
      } catch {
        line += ' [dados não serializáveis]';
      }
    }
    if (this.toStdout) {
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(line);
    }
    if (!this.enabled || !this.file) return;
    this.rotate();
    try {
      appendFileSync(this.file, `${line}\n`, 'utf8');
    } catch {
      /* nunca derrubar o app por causa de log */
    }
  }

  error(scope: string, message: string, data?: unknown): void {
    this.write('error', scope, message, data);
    this.recentErrors.push({
      at: new Date().toISOString(),
      scope,
      code: typeof data === 'object' && data && 'code' in data ? String((data as { code: unknown }).code) : 'error',
      message: redactText(message),
    });
    if (this.recentErrors.length > 50) this.recentErrors.shift();
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.write('warn', scope, message, data);
  }

  info(scope: string, message: string, data?: unknown): void {
    this.write('info', scope, message, data);
  }

  debug(scope: string, message: string, data?: unknown): void {
    this.write('debug', scope, message, data);
  }

  getRecentErrors(): RecentError[] {
    return [...this.recentErrors];
  }

  listFiles(): string[] {
    if (!this.dir) return [];
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith('codex-hub.log'))
        .map((f) => join(this.dir as string, f));
    } catch {
      return [];
    }
  }
}

export const logger = new Logger();
