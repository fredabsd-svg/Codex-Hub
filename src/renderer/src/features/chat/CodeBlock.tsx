/**
 * Bloco de código com copiar e expandir.
 *
 * O conteúdo é tratado como texto simples (não confiável): nada é interpretado
 * como HTML. Blocos longos ficam colapsados por padrão, com a contagem de
 * linhas visível para que a leitura da conversa não seja interrompida.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { invoke } from '../../lib/api';
import { Badge, IconButton } from '../../components/ui/primitives';
import { IconCheck, IconCopy } from '../../components/ui/icons';

const COLLAPSE_THRESHOLD = 24;

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lines = code.split('\n');
  const collapsible = lines.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible);
  const [copied, setCopied] = useState(false);

  const visible = expanded ? code : lines.slice(0, COLLAPSE_THRESHOLD).join('\n');

  const copy = async (): Promise<void> => {
    await invoke('clipboard:writeText', { text: code });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="ch-inset overflow-hidden">
      <div
        className="flex items-center justify-between gap-2 border-b px-2.5 py-1"
        style={{ background: 'var(--surface-2)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="ch-mono truncate text-[11px] text-[var(--text-faint)]">
            {language && language !== '' ? language : 'texto'}
          </span>
          <Badge tone="neutral">{lines.length} linha(s)</Badge>
        </div>
        <div className="flex flex-none items-center gap-0.5">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
              aria-expanded={expanded}
            >
              {expanded ? 'Recolher' : `Expandir (${lines.length - COLLAPSE_THRESHOLD} linhas ocultas)`}
            </button>
          ) : null}
          <IconButton size="sm" label="Copiar código" onClick={() => void copy()}>
            {copied ? <IconCheck size={13} className="text-[var(--success)]" /> : <IconCopy size={13} />}
          </IconButton>
        </div>
      </div>
      <pre
        className={clsx('ch-mono overflow-x-auto px-3 py-2.5 text-[12.5px] leading-[1.6]')}
        style={{ margin: 0, whiteSpace: 'pre' }}
      >
        <code>{visible}</code>
      </pre>
      {!expanded && collapsible ? (
        <div
          className="px-3 pb-2 text-[11px] text-[var(--text-faint)]"
          style={{ background: 'var(--surface-inset)' }}
        >
          …
        </div>
      ) : null}
    </div>
  );
}

/** Saída de terminal: monoespaçada, limitada e com aviso de truncamento. */
export function TerminalOutput({
  output,
  truncated,
  totalBytes,
  maxHeight = 260,
}: {
  output: string;
  truncated: boolean;
  totalBytes: number;
  maxHeight?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="ch-inset overflow-hidden">
      <div
        className="flex items-center justify-between gap-2 border-b px-2.5 py-1"
        style={{ background: 'var(--surface-2)' }}
      >
        <span className="text-[11px] text-[var(--text-faint)]">Saída</span>
        <div className="flex items-center gap-2">
          {truncated ? (
            <Badge tone="warning" title="A interface retém apenas o final da saída para manter a resposta fluida.">
              truncada
            </Badge>
          ) : null}
          <span className="ch-mono text-[11px] text-[var(--text-faint)]">{formatBytes(totalBytes)}</span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
            aria-expanded={expanded}
          >
            {expanded ? 'Recolher' : 'Expandir'}
          </button>
        </div>
      </div>
      <pre
        className="ch-mono overflow-auto px-3 py-2 text-[12px] leading-[1.55]"
        style={{ margin: 0, maxHeight: expanded ? 640 : maxHeight, whiteSpace: 'pre-wrap' }}
      >
        <code>{output === '' ? '(sem saída)' : output}</code>
      </pre>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
