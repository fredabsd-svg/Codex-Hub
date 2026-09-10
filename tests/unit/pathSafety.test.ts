import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PathGuard, hasReservedWindowsName, realPathOfDeepestExisting, safeFileName } from '../../src/main/services/pathSafety';

const root = mkdtempSync(join(tmpdir(), 'codex-hub-guard-'));
const workspace = join(root, 'workspace');
const outside = join(root, 'fora');

mkdirSync(join(workspace, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1;\n');
writeFileSync(join(outside, 'segredo.txt'), 'não deveria ser lido\n');

let symlinkCreated = false;
try {
  symlinkSync(outside, join(workspace, 'atalho'), 'dir');
  symlinkCreated = true;
} catch {
  // Alguns ambientes (e Windows sem privilégio) não permitem symlink.
  symlinkCreated = false;
}

describe('PathGuard', () => {
  const guard = new PathGuard(workspace);

  it('aceita caminho relativo dentro do workspace', () => {
    const resolved = guard.resolve('src/a.ts');
    expect(resolved.exists).toBe(true);
    expect(resolved.relativePath).toBe('src/a.ts');
  });

  it('aceita caminho absoluto dentro do workspace', () => {
    expect(guard.resolve(join(workspace, 'src', 'a.ts')).relativePath).toBe('src/a.ts');
  });

  it('recusa travessia com ..', () => {
    expect(() => guard.resolve('../fora/segredo.txt')).toThrowError(/fora das raízes autorizadas/);
    expect(() => guard.resolve('src/../../fora/segredo.txt')).toThrowError(/fora das raízes autorizadas/);
  });

  it('recusa caminho absoluto fora do workspace', () => {
    expect(() => guard.resolve(join(outside, 'segredo.txt'))).toThrowError(/fora das raízes autorizadas/);
  });

  it.runIf(symlinkCreated)('recusa symlink que aponta para fora — não é comparação de prefixo', () => {
    // Textualmente o caminho começa com o workspace; fisicamente, não.
    const candidate = join(workspace, 'atalho', 'segredo.txt');
    expect(candidate.startsWith(workspace)).toBe(true);
    expect(() => guard.resolve(candidate)).toThrowError(/fora das raízes autorizadas/);
  });

  it('aceita caminho que ainda não existe, desde que o ancestral seja autorizado', () => {
    const resolved = guard.resolve('src/novo/arquivo.ts');
    expect(resolved.exists).toBe(false);
    expect(resolved.relativePath).toBe('src/novo/arquivo.ts');
  });

  it('recusa caminho inexistente que escaparia do workspace', () => {
    expect(() => guard.resolve('../ainda-nao-existe/x.ts')).toThrowError(/fora das raízes autorizadas/);
  });

  it('recusa caminho vazio e com byte nulo', () => {
    expect(() => guard.resolve('')).toThrowError();
    expect(() => guard.resolve('src/a\u0000.ts')).toThrowError(/caracteres inválidos/);
  });

  it('tryResolve devolve null em vez de lançar', () => {
    expect(guard.tryResolve('../fora')).toBeNull();
    expect(guard.tryResolve('src/a.ts')).not.toBeNull();
  });

  it('raiz extra autorizada explicitamente é aceita', () => {
    const wider = new PathGuard(workspace, [outside]);
    expect(wider.contains(join(outside, 'segredo.txt'))).toBe(true);
    // A raiz principal continua sendo a de referência para o caminho relativo.
    expect(new PathGuard(workspace).contains(join(outside, 'segredo.txt'))).toBe(false);
  });

  it('resolve "." como a própria raiz', () => {
    expect(guard.resolve('.').relativePath).toBe('.');
  });
});

describe('realPathOfDeepestExisting', () => {
  it('resolve o ancestral existente e mantém o resto', () => {
    const { realPath, exists } = realPathOfDeepestExisting(join(workspace, 'src', 'nao', 'existe.ts'));
    expect(exists).toBe(false);
    expect(realPath.endsWith(join('nao', 'existe.ts'))).toBe(true);
  });

  it('marca exists=true quando o alvo existe', () => {
    expect(realPathOfDeepestExisting(join(workspace, 'src', 'a.ts')).exists).toBe(true);
  });
});

describe('safeFileName', () => {
  it('remove diretórios e caracteres inválidos', () => {
    expect(safeFileName('..\\..\\etc\\passwd')).toBe('passwd');
    expect(safeFileName('rela<t>ório:2024?.pdf')).toBe('rela_t_ório_2024_.pdf');
  });

  it('não deixa nome vazio nem só pontos', () => {
    expect(safeFileName('...')).toBe('arquivo');
    expect(safeFileName('')).toBe('arquivo');
  });

  it('limita o comprimento preservando a extensão', () => {
    const long = `${'a'.repeat(300)}.txt`;
    const safe = safeFileName(long);
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.endsWith('.txt')).toBe(true);
  });
});

describe('hasReservedWindowsName', () => {
  it('só reporta nomes reservados no Windows', () => {
    const result = hasReservedWindowsName('C:\\ws\\CON.txt');
    expect(result).toBe(process.platform === 'win32');
  });
});

afterAll(() => {
  // O diretório temporário é descartado pelo sistema; nada a limpar aqui.
});
