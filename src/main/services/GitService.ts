/**
 * Leitura de estado do Git.
 *
 * Só leitura: nada de commit, reset, checkout ou clean automático.
 * Degrada corretamente quando o git não está instalado ou a pasta não é um
 * repositório — o motivo é informado em pt-BR.
 */

import { spawn } from 'node:child_process';
import type { GitFileChange, GitSummary } from '../../shared/domain';
import { logger } from './logger';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  failedToStart: boolean;
}

const MAX_OUTPUT = 4 * 1024 * 1024;

function runGit(cwd: string, args: string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // Argumentos como ARRAY, nunca linha de shell.
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', failedToStart: true });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ code: null, stdout, stderr: 'timeout', failedToStart: false });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, failedToStart: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, failedToStart: false });
    });
  });
}

export class GitService {
  private availability: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.availability !== null) return this.availability;
    const result = await runGit(process.cwd(), ['--version'], 5000);
    this.availability = !result.failedToStart && result.code === 0;
    if (!this.availability) logger.info('git', 'git não está disponível no PATH');
    return this.availability;
  }

  async summary(cwd: string): Promise<GitSummary> {
    if (!(await this.isAvailable())) {
      return {
        available: false,
        isRepository: false,
        unavailableReason: 'O git não foi encontrado no PATH. O estado do repositório não pode ser mostrado.',
      };
    }
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      return {
        available: true,
        isRepository: false,
        unavailableReason: 'Esta pasta não é um repositório Git.',
      };
    }
    const [branchResult, statusResult, upstreamResult] = await Promise.all([
      runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
      runGit(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
    ]);

    const branch = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
    const entries = parsePorcelain(statusResult.stdout);
    let ahead: number | undefined;
    let behind: number | undefined;
    if (upstreamResult.code === 0) {
      const parts = upstreamResult.stdout.trim().split(/\s+/);
      ahead = Number.parseInt(parts[0] ?? '', 10);
      behind = Number.parseInt(parts[1] ?? '', 10);
      if (!Number.isFinite(ahead)) ahead = undefined;
      if (!Number.isFinite(behind)) behind = undefined;
    }

    return {
      available: true,
      isRepository: true,
      branch: branch === 'HEAD' ? 'HEAD desanexado' : branch,
      ahead,
      behind,
      changedFiles: entries.length,
      dirty: entries.length > 0,
    };
  }

  async changes(cwd: string): Promise<GitFileChange[]> {
    if (!(await this.isAvailable())) return [];
    const status = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (status.code !== 0) return [];
    const entries = parsePorcelain(status.stdout);
    const numstat = await runGit(cwd, ['diff', '--numstat', '--no-color', 'HEAD', '--']);
    const counts = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    if (numstat.code === 0) {
      for (const line of numstat.stdout.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const [add, del, path] = parts;
        const binary = add === '-' || del === '-';
        counts.set(path ?? '', {
          additions: binary ? 0 : Number.parseInt(add ?? '0', 10) || 0,
          deletions: binary ? 0 : Number.parseInt(del ?? '0', 10) || 0,
          binary,
        });
      }
    }
    return entries.map((entry) => {
      const stat = counts.get(entry.path);
      return {
        path: entry.path,
        status: entry.status,
        oldPath: entry.oldPath,
        binary: stat?.binary ?? false,
        additions: stat?.additions,
        deletions: stat?.deletions,
      };
    });
  }

  /** Diff unificado do arquivo (ou de todo o repositório quando `path` é nulo). */
  async diff(cwd: string, path?: string, options: { staged?: boolean } = {}): Promise<string> {
    if (!(await this.isAvailable())) return '';
    const args = ['diff', '--no-color', '--no-ext-diff'];
    if (options.staged) args.push('--cached');
    args.push('HEAD', '--');
    if (path) args.push(path);
    const result = await runGit(cwd, args, 20_000);
    if (result.code !== 0) return '';
    return result.stdout;
  }

  /** Diff de um arquivo ainda não rastreado, montado a partir do conteúdo. */
  async isTracked(cwd: string, path: string): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    const result = await runGit(cwd, ['ls-files', '--error-unmatch', '--', path], 8000);
    return result.code === 0;
  }
}

interface PorcelainEntry {
  path: string;
  oldPath?: string;
  status: GitFileChange['status'];
}

export function parsePorcelain(raw: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const x = token[0] ?? ' ';
    const y = token[1] ?? ' ';
    const path = token.slice(3);
    if (path === '') continue;
    if (x === 'R' || y === 'R') {
      // Renomeações vêm com o caminho antigo no token seguinte.
      const oldPath = tokens[i + 1];
      i += 1;
      out.push({ path, oldPath, status: 'renamed' });
      continue;
    }
    out.push({ path, status: mapStatus(x, y) });
  }
  return out;
}

function mapStatus(x: string, y: string): GitFileChange['status'] {
  if (x === '?' || y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflicted';
  if (x === 'A' || y === 'A') return 'added';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}
