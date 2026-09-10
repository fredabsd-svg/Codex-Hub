/**
 * Diff unificado mínimo (algoritmo LCS por linhas).
 *
 * Usado para mostrar alterações propostas ANTES de gravar e para exibir o que
 * foi alterado depois. Não pretende substituir `git diff`: quando o repositório
 * está disponível, o diff do Git é preferido para arquivos já rastreados.
 */

import type { FileDiff } from '../../shared/domain';

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 8000));
  if (sample.byteLength === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.byteLength > 0.1;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

type Op = { kind: 'equal' | 'add' | 'del'; line: string };

export function diffLines(before: string[], after: string[]): Op[] {
  const n = before.length;
  const m = after.length;
  // Prefixo/sufixo comum reduz muito o tamanho da matriz.
  let start = 0;
  while (start < n && start < m && before[start] === after[start]) start += 1;
  let endBefore = n;
  let endAfter = m;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const ops: Op[] = [];
  for (let i = 0; i < start; i += 1) ops.push({ kind: 'equal', line: before[i] as string });

  // LCS com limite de segurança: acima disso, tratamos como substituição total.
  if (a.length * b.length > 4_000_000) {
    for (const line of a) ops.push({ kind: 'del', line });
    for (const line of b) ops.push({ kind: 'add', line });
  } else {
    const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      const row = table[i] as number[];
      const nextRow = table[i + 1] as number[];
      for (let j = b.length - 1; j >= 0; j -= 1) {
        row[j] = a[i] === b[j] ? (nextRow[j + 1] as number) + 1 : Math.max(nextRow[j] as number, row[j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        ops.push({ kind: 'equal', line: a[i] as string });
        i += 1;
        j += 1;
      } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
        ops.push({ kind: 'del', line: a[i] as string });
        i += 1;
      } else {
        ops.push({ kind: 'add', line: b[j] as string });
        j += 1;
      }
    }
    while (i < a.length) {
      ops.push({ kind: 'del', line: a[i] as string });
      i += 1;
    }
    while (j < b.length) {
      ops.push({ kind: 'add', line: b[j] as string });
      j += 1;
    }
  }

  for (let k = endBefore; k < n; k += 1) ops.push({ kind: 'equal', line: before[k] as string });
  return ops;
}

/**
 * Divide em linhas descartando o `\n` final, para que um arquivo terminado em
 * nova linha não produza uma "linha vazia" artificial no diff.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function unifiedDiffText(path: string, before: string, after: string, context = 3): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const ops = diffLines(beforeLines, afterLines);

  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let current: Hunk | null = null;
  let equalRun: string[] = [];

  const flushContextBefore = (): void => {
    if (!current) return;
    const tail = equalRun.slice(-context);
    for (const line of tail) {
      current.lines.push(` ${line}`);
      current.oldLines += 1;
      current.newLines += 1;
    }
    equalRun = [];
  };

  for (const op of ops) {
    if (op.kind === 'equal') {
      if (current) {
        if (current.lines.length > 0 && equalRun.length < context) {
          current.lines.push(` ${op.line}`);
          current.oldLines += 1;
          current.newLines += 1;
          equalRun.push(op.line);
        } else {
          equalRun.push(op.line);
          if (equalRun.length > context) {
            hunks.push(current);
            current = null;
            equalRun = [op.line];
          }
        }
      } else {
        equalRun.push(op.line);
        if (equalRun.length > context * 2) equalRun = equalRun.slice(-context);
      }
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (!current) {
      const leading = equalRun.slice(-context);
      current = {
        oldStart: Math.max(1, oldLine - leading.length),
        newStart: Math.max(1, newLine - leading.length),
        oldLines: 0,
        newLines: 0,
        lines: [],
      };
      for (const line of leading) {
        current.lines.push(` ${line}`);
        current.oldLines += 1;
        current.newLines += 1;
      }
      equalRun = [];
    } else {
      flushContextBefore();
    }

    if (op.kind === 'del') {
      current.lines.push(`-${op.line}`);
      current.oldLines += 1;
      oldLine += 1;
    } else {
      current.lines.push(`+${op.line}`);
      current.newLines += 1;
      newLine += 1;
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) return '';

  const header = [`--- a/${path}`, `+++ b/${path}`];
  const body = hunks.map(
    (h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`,
  );
  return `${header.join('\n')}\n${body.join('\n')}\n`;
}

export function buildUnifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  changeKind: FileDiff['changeKind'],
): FileDiff {
  const beforeText = before ?? '';
  const afterText = after ?? '';
  const diff = unifiedDiffText(path, beforeText, afterText);
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return {
    path,
    changeKind,
    binary: false,
    additions,
    deletions,
    unifiedDiff: diff === '' ? undefined : diff,
  };
}

/** Converte a saída de `git diff` em `FileDiff[]` por arquivo. */
export function parseGitUnifiedDiff(raw: string): FileDiff[] {
  if (raw.trim() === '') return [];
  const files: FileDiff[] = [];
  const blocks = raw.split(/^diff --git /m).filter((b) => b.trim() !== '');
  for (const block of blocks) {
    const body = `diff --git ${block}`;
    const pathMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(body);
    const newPath = pathMatch?.[2] ?? pathMatch?.[1] ?? 'desconhecido';
    const oldPath = pathMatch?.[1];
    const binary = /^Binary files .* differ$/m.test(body) || /^GIT binary patch$/m.test(body);
    let changeKind: FileDiff['changeKind'] = 'modify';
    if (/^new file mode /m.test(body)) changeKind = 'add';
    else if (/^deleted file mode /m.test(body)) changeKind = 'delete';
    else if (/^rename from /m.test(body)) changeKind = 'rename';

    let additions = 0;
    let deletions = 0;
    for (const line of body.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    files.push({
      path: newPath,
      oldPath: changeKind === 'rename' ? oldPath : undefined,
      changeKind,
      binary,
      additions: binary ? 0 : additions,
      deletions: binary ? 0 : deletions,
      unifiedDiff: binary ? undefined : body,
    });
  }
  return files;
}
