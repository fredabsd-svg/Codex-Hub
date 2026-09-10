/**
 * Bloco de código com realce de sintaxe, numeração, quebra de linha, copiar e
 * expandir.
 *
 * O conteúdo é tratado como texto simples (não confiável): o realce produz
 * elementos React, nunca HTML. Blocos longos ficam colapsados por padrão, com
 * a contagem de linhas visível para que a leitura da conversa não seja
 * interrompida.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { highlight, isHighlightedLanguage } from '../../lib/highlight';
import { Badge, IconButton } from '../../components/ui/primitives';
import { Tooltip } from '../../components/ui/Popover';
import { IconCheck, IconCopy, IconWrap } from '../../components/ui/icons';

const COLLAPSE_THRESHOLD = 24;
const LINE_NUMBERS_THRESHOLD = 4;

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lines = useMemo(() => code.split('\n'), [code]);
  const collapsible = lines.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!collapsible);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSE_THRESHOLD);
  const showNumbers = lines.length >= LINE_NUMBERS_THRESHOLD;
  const label = language && language !== '' ? language.toLowerCase() : t('codeBlock.plainText');

  // O realce é feito sobre o texto visível, linha a linha, para que a
  // numeração e a quebra opcional funcionem sem cortar tokens.
  const rendered = useMemo(() => {
    const highlighted = isHighlightedLanguage(language);
    return visibleLines.map((line) => (highlighted ? highlight(line, language) : line));
  }, [visibleLines, language]);

  const copy = async (): Promise<void> => {
    await invoke('clipboard:writeText', { text: code });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={clsx('ch-code ch-inset overflow-hidden', wrap && 'ch-code-wrap')}>
      <div
        className="flex items-center justify-between gap-2 border-b px-2.5 py-1"
        style={{ background: 'var(--surface-2)' }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="ch-mono truncate text-[11px] font-medium text-[var(--text-muted)]">{label}</span>
          <Badge tone="neutral">{t('codeBlock.lines', { count: lines.length })}</Badge>
        </div>
        <div className="flex flex-none items-center gap-0.5">
          {collapsible ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
              aria-expanded={expanded}
            >
              {expanded ? t('codeBlock.collapse') : t('codeBlock.expand', { count: lines.length - COLLAPSE_THRESHOLD })}
            </button>
          ) : null}
          <Tooltip content={t('codeBlock.wrap')}>
            <IconButton size="sm" label={t('codeBlock.wrap')} active={wrap} onClick={() => setWrap((value) => !value)}>
              <IconWrap size={13} />
            </IconButton>
          </Tooltip>
          <Tooltip content={t('codeBlock.copy')}>
            <IconButton size="sm" label={t('codeBlock.copy')} onClick={() => void copy()}>
              {copied ? <IconCheck size={13} className="text-[var(--success)]" /> : <IconCopy size={13} />}
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <pre
        className="ch-mono overflow-x-auto px-3 py-2.5 text-[12.5px] leading-[1.6]"
        style={{ margin: 0, whiteSpace: 'pre' }}
        tabIndex={0}
      >
        <code className={clsx(showNumbers && 'ch-code-lines')}>
          {rendered.map((line, index) => (
            <LineRow key={index} number={showNumbers ? index + 1 : undefined}>
              {line}
            </LineRow>
          ))}
        </code>
      </pre>
      {!expanded && collapsible ? (
        <div className="px-3 pb-2 text-[11px] text-[var(--text-faint)]" style={{ background: 'var(--surface-inset)' }}>
          …
        </div>
      ) : null}
    </div>
  );
}

function LineRow({ number, children }: { number: number | undefined; children: React.ReactNode }) {
  if (number === undefined) {
    return (
      <>
        {children}
        {'\n'}
      </>
    );
  }
  return (
    <>
      <span className="ch-code-num" aria-hidden="true">
        {number}
      </span>
      <span>
        {children}
        {'\n'}
      </span>
    </>
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
    <div className="ch-code ch-inset overflow-hidden">
      <div
        className="flex items-center justify-between gap-2 border-b px-2.5 py-1"
        style={{ background: 'var(--surface-2)' }}
      >
        <span className="text-[11px] font-medium text-[var(--text-muted)]">{t('codeBlock.output')}</span>
        <div className="flex items-center gap-2">
          {truncated ? (
            <Badge tone="warning" title={t('codeBlock.truncatedHint')}>
              {t('codeBlock.truncated')}
            </Badge>
          ) : null}
          <span className="ch-mono text-[11px] text-[var(--text-faint)]">{formatBytes(totalBytes)}</span>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
            aria-expanded={expanded}
          >
            {expanded ? t('common.collapse') : t('common.expand')}
          </button>
        </div>
      </div>
      <pre
        className="ch-mono overflow-auto px-3 py-2 text-[12px] leading-[1.55]"
        style={{ margin: 0, maxHeight: expanded ? 640 : maxHeight, whiteSpace: 'pre-wrap' }}
      >
        <code>{output === '' ? t('codeBlock.noOutput') : output}</code>
      </pre>
    </div>
  );
}
