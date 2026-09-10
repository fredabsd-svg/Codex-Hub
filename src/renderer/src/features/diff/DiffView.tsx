/**
 * Visualização de diff.
 *
 * Renderização própria (unificada e lado a lado) a partir do diff unificado,
 * com navegação entre alterações e indicação de arquivo binário.
 * O Monaco entra sob demanda apenas na visualização de arquivo completo
 * (ver `MonacoViewer`), para não carregar o editor na primeira pintura.
 */

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { FileDiff } from '@shared/domain';
import { t } from '../../i18n';
import { Badge, Button, EmptyState, IconButton, Segmented } from '../../components/ui/primitives';
import { IconArrowDown, IconDiff, IconFile } from '../../components/ui/icons';

interface ParsedLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export function parseUnifiedDiff(unified: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const raw of unified.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      continue;
    }
    if (raw.startsWith('new file mode') || raw.startsWith('deleted file mode') || raw.startsWith('similarity index')) {
      continue;
    }
    if (raw.startsWith('rename from') || raw.startsWith('rename to')) {
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNumber = Number.parseInt(hunk[1] ?? '1', 10);
      newNumber = Number.parseInt(hunk[2] ?? '1', 10);
      out.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ kind: 'add', text: raw.slice(1), newNumber });
      newNumber += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      out.push({ kind: 'del', text: raw.slice(1), oldNumber });
      oldNumber += 1;
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw === '' && out.length === 0) continue;
    out.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNumber, newNumber });
    oldNumber += 1;
    newNumber += 1;
  }
  return out;
}

export function DiffView({ files }: { files: FileDiff[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(files[0]?.path ?? null);
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const containerRef = useRef<HTMLDivElement>(null);
  const changeRefs = useRef<HTMLDivElement[]>([]);
  const [changeIndex, setChangeIndex] = useState(0);

  const selected = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const lines = useMemo(
    () => (selected?.unifiedDiff ? parseUnifiedDiff(selected.unifiedDiff) : []),
    [selected?.unifiedDiff],
  );

  const changeLineIndexes = useMemo(
    () => lines.map((line, index) => ({ line, index })).filter(({ line }) => line.kind !== 'context' && line.kind !== 'hunk'),
    [lines],
  );

  const jump = (delta: number): void => {
    if (changeLineIndexes.length === 0) return;
    const next = (changeIndex + delta + changeLineIndexes.length) % changeLineIndexes.length;
    setChangeIndex(next);
    const target = changeRefs.current[next];
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  if (files.length === 0) {
    return <EmptyState icon={<IconDiff size={22} />} title={t('rightPanel.noDiff')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-1.5 border-b px-2 py-1.5">
        <Segmented<'unified' | 'split'>
          ariaLabel="Modo de visualização do diff"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'unified', label: t('rightPanel.unified') },
            { value: 'split', label: t('rightPanel.split') },
          ]}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={t('rightPanel.previousChange')}
            onClick={() => jump(-1)}
            disabled={changeLineIndexes.length === 0}
          >
            <IconArrowDown size={13} style={{ transform: 'rotate(180deg)' }} />
          </IconButton>
          <span className="ch-mono px-1 text-[11px] text-[var(--text-faint)]">
            {changeLineIndexes.length === 0 ? '0/0' : `${changeIndex + 1}/${changeLineIndexes.length}`}
          </span>
          <IconButton
            size="sm"
            label={t('rightPanel.nextChange')}
            onClick={() => jump(1)}
            disabled={changeLineIndexes.length === 0}
          >
            <IconArrowDown size={13} />
          </IconButton>
        </div>
      </div>

      {files.length > 1 ? (
        <div className="flex-none overflow-x-auto border-b px-1.5 py-1">
          <div className="flex gap-1">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => {
                  setSelectedPath(file.path);
                  setChangeIndex(0);
                }}
                aria-pressed={file.path === selected?.path}
                className={clsx(
                  'flex flex-none items-center gap-1.5 rounded-[var(--radius-xs)] border px-2 py-1 text-[12px] transition-colors',
                  file.path === selected?.path ? 'text-[var(--text)]' : 'text-[var(--text-muted)]',
                )}
                style={{
                  background: file.path === selected?.path ? 'var(--accent-soft)' : 'var(--surface-1)',
                  borderColor: file.path === selected?.path ? 'var(--accent)' : 'var(--border)',
                }}
                title={file.path}
              >
                <IconFile size={12} />
                <span className="ch-mono max-w-[220px] truncate">{file.path}</span>
                {file.binary ? (
                  <Badge tone="warning">bin</Badge>
                ) : (
                  <span className="ch-mono text-[11px]">
                    <span style={{ color: 'var(--diff-add-text)' }}>+{file.additions}</span>{' '}
                    <span style={{ color: 'var(--diff-del-text)' }}>−{file.deletions}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div ref={containerRef} className="min-h-0 flex-1 overflow-auto">
        {!selected ? null : selected.binary ? (
          <EmptyState icon={<IconFile size={22} />} title={t('rightPanel.binaryFile')} body={selected.path} />
        ) : selected.changeKind === 'rename' && !selected.unifiedDiff ? (
          <EmptyState
            icon={<IconFile size={22} />}
            title="Arquivo renomeado"
            body={`${selected.oldPath ?? '?'} → ${selected.path}`}
          />
        ) : lines.length === 0 ? (
          <EmptyState icon={<IconDiff size={22} />} title="O motor não enviou o diff textual deste arquivo." />
        ) : view === 'unified' ? (
          <UnifiedLines lines={lines} changeRefs={changeRefs} activeIndex={changeIndex} />
        ) : (
          <SplitLines lines={lines} changeRefs={changeRefs} activeIndex={changeIndex} />
        )}
      </div>
    </div>
  );
}

function UnifiedLines({
  lines,
  changeRefs,
  activeIndex,
}: {
  lines: ParsedLine[];
  changeRefs: React.RefObject<HTMLDivElement[]>;
  activeIndex: number;
}) {
  let changeCounter = -1;
  return (
    <div>
      {lines.map((line, index) => {
        const isChange = line.kind === 'add' || line.kind === 'del';
        if (isChange) changeCounter += 1;
        const currentChange = changeCounter;
        return (
          <div
            key={index}
            ref={(node) => {
              if (isChange && node && changeRefs.current) changeRefs.current[currentChange] = node;
            }}
            className={clsx(
              'ch-diff-line',
              line.kind === 'add' && 'ch-diff-add',
              line.kind === 'del' && 'ch-diff-del',
              line.kind === 'hunk' && 'ch-diff-hunk',
              isChange && currentChange === activeIndex && 'outline outline-1 outline-[var(--accent)]',
            )}
          >
            <span className="ch-diff-num">{line.kind === 'add' ? '' : (line.oldNumber ?? '')}</span>
            <span className="ch-diff-num">{line.kind === 'del' ? '' : (line.newNumber ?? '')}</span>
            <span className="px-2">
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'hunk' ? '' : ' '}
              {line.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SplitLines({
  lines,
  changeRefs,
  activeIndex,
}: {
  lines: ParsedLine[];
  changeRefs: React.RefObject<HTMLDivElement[]>;
  activeIndex: number;
}) {
  // Emparelha remoções com adições para exibição lado a lado.
  const rows: Array<{ left?: ParsedLine; right?: ParsedLine; hunk?: string }> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] as ParsedLine;
    if (line.kind === 'hunk') {
      rows.push({ hunk: line.text });
      index += 1;
      continue;
    }
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const deletions: ParsedLine[] = [];
    const additions: ParsedLine[] = [];
    while (index < lines.length && lines[index]?.kind === 'del') {
      deletions.push(lines[index] as ParsedLine);
      index += 1;
    }
    while (index < lines.length && lines[index]?.kind === 'add') {
      additions.push(lines[index] as ParsedLine);
      index += 1;
    }
    const max = Math.max(deletions.length, additions.length);
    for (let i = 0; i < max; i += 1) {
      rows.push({ left: deletions[i], right: additions[i] });
    }
  }

  let changeCounter = -1;
  return (
    <div className="grid grid-cols-2 divide-x" style={{ borderColor: 'var(--border)' }}>
      {rows.map((row, rowIndex) => {
        const isChange = row.left?.kind === 'del' || row.right?.kind === 'add';
        if (isChange) changeCounter += 1;
        const currentChange = changeCounter;
        if (row.hunk !== undefined) {
          return (
            <div key={rowIndex} className="ch-diff-hunk col-span-2 px-3 py-0.5 ch-mono text-[12px]">
              {row.hunk}
            </div>
          );
        }
        return (
          <div
            key={rowIndex}
            ref={(node) => {
              if (isChange && node && changeRefs.current) changeRefs.current[currentChange] = node;
            }}
            className={clsx('col-span-2 grid grid-cols-2', isChange && currentChange === activeIndex && 'outline outline-1 outline-[var(--accent)]')}
          >
            <div
              className={clsx('ch-mono px-3 py-[1px] text-[12.5px]', row.left?.kind === 'del' && 'ch-diff-del')}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              <span className="mr-2 inline-block w-8 text-right text-[var(--diff-meta)]">
                {row.left?.oldNumber ?? ''}
              </span>
              {row.left?.text ?? ''}
            </div>
            <div
              className={clsx('ch-mono px-3 py-[1px] text-[12.5px]', row.right?.kind === 'add' && 'ch-diff-add')}
              style={{ whiteSpace: 'pre-wrap' }}
            >
              <span className="mr-2 inline-block w-8 text-right text-[var(--diff-meta)]">
                {row.right?.newNumber ?? ''}
              </span>
              {row.right?.text ?? ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DiffSummary({ files }: { files: FileDiff[] }) {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <Badge tone="neutral">{files.length} arquivo(s)</Badge>
      <span className="ch-mono" style={{ color: 'var(--diff-add-text)' }}>
        +{additions}
      </span>
      <span className="ch-mono" style={{ color: 'var(--diff-del-text)' }}>
        −{deletions}
      </span>
    </div>
  );
}

export function DiffActions({ onOpenPanel }: { onOpenPanel(): void }) {
  return (
    <Button size="sm" variant="ghost" iconLeft={<IconDiff />} onClick={onOpenPanel}>
      {t('rightPanel.diff')}
    </Button>
  );
}
