/**
 * Validação de caminhos na camada privilegiada.
 *
 * Não é comparação textual de prefixo. Cada caminho é:
 *  1. normalizado e resolvido para absoluto;
 *  2. resolvido fisicamente (`realpath`) até o ancestral existente mais profundo,
 *     o que neutraliza symlinks, junctions e reparse points do Windows;
 *  3. comparado com o `realpath` da raiz autorizada usando `path.relative`,
 *     com comparação insensível a caixa no Windows.
 *
 * Sem isso, `C:\ws\link -> C:\Windows` ou `..\..\etc` passariam por um
 * `startsWith` ingênuo.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { appError } from '../../shared/errors';

const isWindows = process.platform === 'win32';

/** Nomes de dispositivo reservados no Windows (com ou sem extensão). */
const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export interface ResolvedPath {
  /** Caminho absoluto lógico (sem resolver links). */
  absolutePath: string;
  /** Caminho fisicamente resolvido do ancestral existente + resto. */
  realPath: string;
  /** Caminho relativo à raiz, sempre com `/` para exibição. */
  relativePath: string;
  /** true quando o alvo (ou o ancestral resolvido) já existe. */
  exists: boolean;
}

/** `realpath` do ancestral existente mais profundo + segmentos inexistentes. */
export function realPathOfDeepestExisting(target: string): { realPath: string; exists: boolean } {
  const absolute = resolve(target);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native ? realpathSync.native(current) : realpathSync(current);
      return { realPath: tail.length ? join(real, ...tail.reverse()) : real, exists: tail.length === 0 };
    } catch {
      const parsed = parse(current);
      if (parsed.dir === current || parsed.base === '') {
        // Chegou na raiz sem nada existente: devolve o caminho normalizado.
        return { realPath: absolute, exists: false };
      }
      tail.push(parsed.base);
      current = parsed.dir;
    }
  }
}

function samePath(a: string, b: string): boolean {
  return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(rootReal: string, candidateReal: string): boolean {
  if (samePath(rootReal, candidateReal)) return true;
  const rel = relative(rootReal, candidateReal);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  const segments = rel.split(sep);
  if (segments.some((s) => s === '..')) return false;
  if (!isWindows) return true;
  // No Windows, `relative` já é insensível a caixa em muitos casos; reforçamos.
  const rel2 = relative(rootReal.toLowerCase(), candidateReal.toLowerCase());
  return rel2 !== '' && !isAbsolute(rel2) && !rel2.split(sep).some((s) => s === '..');
}

export function hasReservedWindowsName(candidate: string): boolean {
  if (!isWindows) return false;
  return candidate
    .split(/[\\/]/)
    .filter(Boolean)
    .some((segment) => {
      const base = (segment.split('.')[0] ?? '').toUpperCase();
      return RESERVED_WINDOWS_NAMES.has(base);
    });
}

export class PathGuard {
  private readonly rootReal: string;

  constructor(
    readonly rootPath: string,
    /** Raízes adicionais autorizadas explicitamente pela pessoa. */
    private readonly extraRoots: string[] = [],
  ) {
    this.rootReal = realPathOfDeepestExisting(rootPath).realPath;
  }

  get realRoot(): string {
    return this.rootReal;
  }

  private allRoots(): string[] {
    return [this.rootReal, ...this.extraRoots.map((r) => realPathOfDeepestExisting(r).realPath)];
  }

  /**
   * Resolve `candidate` (absoluto ou relativo à raiz) garantindo que fica
   * dentro de alguma raiz autorizada. Lança `workspaceDenied` caso contrário.
   */
  resolve(candidate: string): ResolvedPath {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw appError('validation', { message: 'Caminho vazio não é válido.' });
    }
    if (candidate.includes('\0')) {
      throw appError('validation', { message: 'Caminho contém caracteres inválidos.' });
    }
    const absolute = isAbsolute(candidate) ? normalize(candidate) : resolve(this.rootPath, candidate);
    const { realPath, exists } = realPathOfDeepestExisting(absolute);

    const inside = this.allRoots().some((root) => isInside(root, realPath));
    if (!inside) {
      throw appError('workspaceDenied', {
        message: `O caminho "${absolute}" está fora das raízes autorizadas.`,
        action: 'Escolha um caminho dentro do workspace ou autorize a pasta em Configurações › Workspaces.',
      });
    }

    const rel = relative(this.rootReal, realPath);
    return {
      absolutePath: absolute,
      realPath,
      relativePath: (rel === '' ? '.' : rel).split(sep).join('/'),
      exists,
    };
  }

  /** Igual a `resolve`, mas devolve `null` em vez de lançar. */
  tryResolve(candidate: string): ResolvedPath | null {
    try {
      return this.resolve(candidate);
    } catch {
      return null;
    }
  }

  contains(candidate: string): boolean {
    return this.tryResolve(candidate) !== null;
  }
}

/** Sanitiza um nome de arquivo vindo de fora para uso em pasta de anexos. */
export function safeFileName(raw: string, fallback = 'arquivo'): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  let name = base
    // Remoção intencional de caracteres de controle do nome de arquivo.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (name === '' || name === '.' || name === '..') name = fallback;
  if (isWindows) {
    const stem = (name.split('.')[0] ?? '').toUpperCase();
    if (RESERVED_WINDOWS_NAMES.has(stem)) name = `_${name}`;
  }
  // Limite conservador para caminhos longos no Windows.
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  return name;
}
