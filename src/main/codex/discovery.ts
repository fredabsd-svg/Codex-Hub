/**
 * Descoberta e resolução segura do executável do Codex CLI.
 *
 * Ordem: caminho configurado → PATH → locais de instalação conhecidos.
 *
 * Resolução de launcher no Windows:
 *  - um `.cmd`/`.bat` NÃO é um `.exe`. Ele só executa através do interpretador
 *    de comandos. Este módulo identifica o tipo e devolve a forma correta de
 *    spawn (`command` + `args`), SEM concatenar texto em uma linha de shell e
 *    sem usar `shell: true`.
 *  - a preferência é sempre pelo binário nativo, quando existir.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { logger } from '../services/logger';

const isWindows = process.platform === 'win32';

export type LauncherKind = 'native' | 'windowsShellScript' | 'nodeScript';

export interface ResolvedExecutable {
  /** Caminho do arquivo encontrado. */
  filePath: string;
  kind: LauncherKind;
  /** Comando efetivo a ser passado para `spawn`. */
  command: string;
  /** Argumentos que precedem os argumentos da aplicação. */
  prefixArgs: string[];
  discoveredVia: 'setting' | 'path' | 'wellKnown';
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (isWindows) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const pathext = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return pathext
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
}

function candidatesFor(base: string): string[] {
  if (!isWindows) return [base];
  if (extname(base) !== '') return [base];
  return [base, ...windowsExtensions().map((ext) => `${base}${ext}`)];
}

function searchPath(): string[] {
  const raw = process.env.PATH ?? '';
  return raw
    .split(delimiter)
    .map((p) => p.trim().replace(/^"|"$/g, ''))
    .filter((p) => p !== '');
}

function wellKnownLocations(): string[] {
  const home = homedir();
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'codex', 'codex.exe'),
      join(localAppData, 'codex', 'codex.exe'),
      join(home, '.codex', 'bin', 'codex.exe'),
      join(localAppData, 'npm', 'codex.cmd'),
      join(appData, 'npm', 'codex.cmd'),
      join(home, '.bun', 'bin', 'codex.exe'),
      join(programFiles, 'codex', 'codex.exe'),
      join(programFiles, 'nodejs', 'codex.cmd'),
    ];
  }
  return [
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    '/opt/homebrew/bin/codex',
    join(home, '.local', 'bin', 'codex'),
    join(home, '.codex', 'bin', 'codex'),
    join(home, '.bun', 'bin', 'codex'),
    join(home, '.npm-global', 'bin', 'codex'),
    join(home, '.volta', 'bin', 'codex'),
  ];
}

function classify(filePath: string, via: ResolvedExecutable['discoveredVia']): ResolvedExecutable {
  const ext = extname(filePath).toLowerCase();
  if (isWindows && (ext === '.cmd' || ext === '.bat')) {
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    // `cmd /d /s /c <arquivo> <args>` — argumentos passados como ARRAY.
    // Nenhum texto do usuário entra aqui, e não usamos `shell: true`.
    return {
      filePath,
      kind: 'windowsShellScript',
      command: comspec,
      prefixArgs: ['/d', '/s', '/c', filePath],
      discoveredVia: via,
    };
  }
  if (ext === '.ps1') {
    // Não executamos scripts PowerShell: exigimos o binário ou o launcher .cmd.
    return { filePath, kind: 'windowsShellScript', command: filePath, prefixArgs: [], discoveredVia: via };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return {
      filePath,
      kind: 'nodeScript',
      command: process.execPath,
      prefixArgs: [filePath],
      discoveredVia: via,
    };
  }
  return { filePath, kind: 'native', command: filePath, prefixArgs: [], discoveredVia: via };
}

export interface DiscoverOptions {
  /** Caminho configurado pela pessoa (Configurações › Codex). */
  configuredPath?: string;
  /** Nome base do executável. */
  binaryName?: string;
}

export function discoverCodexExecutable(options: DiscoverOptions = {}): ResolvedExecutable | null {
  const binaryName = options.binaryName ?? 'codex';

  const configured = options.configuredPath?.trim();
  if (configured) {
    const absolute = isAbsolute(configured) ? configured : resolve(configured);
    for (const candidate of candidatesFor(absolute)) {
      if (isExecutableFile(candidate)) return classify(candidate, 'setting');
    }
    logger.warn('codex', 'Caminho configurado do Codex não é um executável válido', { configured });
  }

  for (const dir of searchPath()) {
    for (const candidate of candidatesFor(join(dir, binaryName))) {
      if (isExecutableFile(candidate)) return classify(candidate, 'path');
    }
  }

  // Prefere binário nativo antes de launcher de script.
  const wellKnown = wellKnownLocations();
  const natives = wellKnown.filter((p) => !/\.(cmd|bat|ps1)$/i.test(p));
  const scripts = wellKnown.filter((p) => /\.(cmd|bat|ps1)$/i.test(p));
  for (const candidate of [...natives, ...scripts]) {
    if (existsSync(candidate) && isExecutableFile(candidate)) return classify(candidate, 'wellKnown');
  }

  return null;
}

/** Executa `codex --version` com timeout curto. Nunca lança. */
export async function readCodexVersion(
  executable: ResolvedExecutable,
  timeoutMs = 8000,
): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable.command, [...executable.prefixArgs, '--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish(undefined);
      return;
    }
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (out.length > 4096) child.kill();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(undefined);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out);
      finish(match?.[1] ?? (out.trim() === '' ? undefined : out.trim().split('\n')[0]?.slice(0, 80)));
    });
  });
}
