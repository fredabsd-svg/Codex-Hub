import { describe, expect, it } from 'vitest';
import { buildUnifiedDiff, diffLines, isProbablyBinary, parseGitUnifiedDiff, unifiedDiffText } from '../../src/main/tools/diff';

describe('isProbablyBinary', () => {
  it('detecta byte nulo', () => {
    expect(isProbablyBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('aceita texto UTF-8 com acentos', () => {
    expect(isProbablyBinary(Buffer.from('função — ação\n', 'utf8'))).toBe(false);
  });

  it('trata arquivo vazio como texto', () => {
    expect(isProbablyBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe('diffLines', () => {
  it('identifica igualdade', () => {
    const ops = diffLines(['a', 'b'], ['a', 'b']);
    expect(ops.every((op) => op.kind === 'equal')).toBe(true);
  });

  it('identifica inserção e remoção', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
    expect(ops.filter((op) => op.kind === 'del').map((op) => op.line)).toEqual(['b']);
    expect(ops.filter((op) => op.kind === 'add').map((op) => op.line)).toEqual(['x']);
  });

  it('lida com arquivo vazio nos dois sentidos', () => {
    expect(diffLines([], ['a']).map((op) => op.kind)).toEqual(['add']);
    expect(diffLines(['a'], []).map((op) => op.kind)).toEqual(['del']);
  });
});

describe('unifiedDiffText', () => {
  it('gera cabeçalho e hunk', () => {
    const diff = unifiedDiffText('src/a.ts', 'linha1\nlinha2\nlinha3\n', 'linha1\nalterada\nlinha3\n');
    expect(diff).toContain('--- a/src/a.ts');
    expect(diff).toContain('+++ b/src/a.ts');
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('-linha2');
    expect(diff).toContain('+alterada');
  });

  it('devolve vazio quando nada mudou', () => {
    expect(unifiedDiffText('a.ts', 'igual\n', 'igual\n')).toBe('');
  });
});

describe('buildUnifiedDiff', () => {
  it('conta adições e remoções', () => {
    const diff = buildUnifiedDiff('a.ts', 'a\nb\n', 'a\nB\nc\n', 'modify');
    expect(diff.additions).toBe(2);
    expect(diff.deletions).toBe(1);
    expect(diff.binary).toBe(false);
    expect(diff.unifiedDiff).toBeDefined();
  });

  it('marca criação de arquivo', () => {
    const diff = buildUnifiedDiff('novo.ts', null, 'conteúdo\n', 'add');
    expect(diff.changeKind).toBe('add');
    expect(diff.additions).toBe(1);
  });

  it('marca remoção de arquivo', () => {
    const diff = buildUnifiedDiff('velho.ts', 'linha\n', null, 'delete');
    expect(diff.changeKind).toBe('delete');
    expect(diff.deletions).toBe(1);
  });
});

describe('parseGitUnifiedDiff', () => {
  it('separa por arquivo e classifica a mudança', () => {
    const raw = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-antigo',
      '+novo',
      'diff --git a/b.png b/b.png',
      'index 333..444 100644',
      'Binary files a/b.png and b/b.png differ',
      'diff --git a/c.ts b/c.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/c.ts',
      '@@ -0,0 +1 @@',
      '+criado',
    ].join('\n');

    const files = parseGitUnifiedDiff(raw);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ path: 'a.ts', changeKind: 'modify', additions: 1, deletions: 1 });
    expect(files[1]).toMatchObject({ path: 'b.png', binary: true, additions: 0, deletions: 0 });
    expect(files[1]?.unifiedDiff).toBeUndefined();
    expect(files[2]).toMatchObject({ path: 'c.ts', changeKind: 'add' });
  });

  it('devolve lista vazia para diff vazio', () => {
    expect(parseGitUnifiedDiff('')).toEqual([]);
    expect(parseGitUnifiedDiff('   \n')).toEqual([]);
  });
});
