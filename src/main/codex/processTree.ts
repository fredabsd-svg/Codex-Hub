/**
 * Encerramento do processo do Codex e dos descendentes que pertencem ao app.
 *
 * POSIX: o filho é criado em um novo grupo de processos (`detached: true`),
 * então `kill(-pid)` alcança a árvore inteira.
 * Windows: `taskkill /PID <pid> /T /F` encerra a árvore; é o fallback
 * específico da plataforma porque `SIGTERM` não existe lá.
 *
 * Sequência: fecha `stdin` → término gentil → prazo → término forçado.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { logger } from '../services/logger';

export interface TerminateOptions {
  /** Tempo até escalar para término forçado. */
  graceMs?: number;
  label?: string;
}

export async function terminateProcessTree(child: ChildProcess, options: TerminateOptions = {}): Promise<void> {
  const graceMs = options.graceMs ?? 3000;
  const label = options.label ?? 'processo';
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  try {
    child.stdin?.end();
  } catch {
    /* ignore */
  }

  if (process.platform === 'win32') {
    runTaskkill(pid, false);
  } else {
    try {
      // Grupo de processos (negativo) — alcança descendentes.
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  }

  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
  ]);

  if (!timedOut) return;

  logger.warn('codex', `Prazo de encerramento esgotado; forçando término do ${label}`, { pid });
  if (process.platform === 'win32') {
    runTaskkill(pid, true);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }

  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
}

function runTaskkill(pid: number, force: boolean): void {
  try {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const child = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true, shell: false });
    child.on('error', (err) => logger.debug('codex', 'taskkill falhou', err));
  } catch (err) {
    logger.debug('codex', 'taskkill não pôde ser iniciado', err);
  }
}
