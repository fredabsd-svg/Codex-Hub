/**
 * Item da conversa.
 *
 * Cada tipo tem uma apresentação própria: mensagem, resumo de raciocínio,
 * plano, comando, ferramenta, alteração de arquivo, aviso e erro.
 * Itens técnicos podem ser expandidos sem interromper a leitura.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AttachmentDelivery, ConversationItem, PlanStep } from '@shared/domain';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { describeUsage, formatBytes, formatDuration, formatTime } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { Badge, IconButton, Spinner } from '../../components/ui/primitives';
import { Tooltip } from '../../components/ui/Popover';
import { CodeBlock, TerminalOutput } from './CodeBlock';
import { DiffView } from '../diff/DiffView';
import {
  IconAlert,
  IconBrain,
  IconCheck,
  IconCopy,
  IconDiff,
  IconFile,
  IconFork,
  IconInfo,
  IconList,
  IconSpark,
  IconTerminal,
} from '../../components/ui/icons';

export function MessageItem({
  item,
  onFork,
  developerMode,
}: {
  item: ConversationItem;
  onFork(itemId: string): void;
  developerMode: boolean;
}) {
  switch (item.kind) {
    case 'userMessage':
      return <UserMessage item={item} onFork={onFork} />;
    case 'agentMessage':
      return <AgentMessage item={item} onFork={onFork} />;
    case 'reasoningSummary':
      return <ReasoningBlock item={item} />;
    case 'plan':
      return <PlanBlock item={item} />;
    case 'commandExecution':
      return <CommandBlock item={item} />;
    case 'toolCall':
      return <ToolBlock item={item} developerMode={developerMode} />;
    case 'fileChange':
      return <FileChangeBlock item={item} />;
    case 'error':
      return <ErrorBlock item={item} />;
    case 'notice':
    default:
      return <NoticeBlock item={item} />;
  }
}

/* ------------------------------------------------------------------ *
 * Mensagens
 * ------------------------------------------------------------------ */

function useOpenLink(): (url: string) => void {
  return (url: string) => {
    void invoke('shell:openExternal', { url });
  };
}

function UserMessage({ item, onFork }: { item: ConversationItem; onFork(itemId: string): void }) {
  const onOpenLink = useOpenLink();
  const [copied, setCopied] = useState(false);

  return (
    <article className="ch-anim-fade group flex flex-col items-end gap-1.5" aria-label={t('chat.you')}>
      <div
        className="ch-prose w-fit rounded-[var(--radius-lg)] border px-3.5 py-2.5"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
      >
        <div className="text-[13.5px] leading-relaxed text-[var(--text)]">
          {renderMarkdown(item.text ?? '', {
            onOpenLink,
            renderCodeBlock: (code, language, index) => <CodeBlock key={index} code={code} language={language} />,
          })}
        </div>
        {item.attachments && item.attachments.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5 border-t pt-2">
            {item.attachments.map((attachment) => (
              <li key={attachment.id}>
                <Tooltip
                  content={
                    attachment.error ??
                    describeDelivery(attachment.delivery) ??
                    attachment.absolutePath ??
                    attachment.fileName
                  }
                >
                  <span tabIndex={0} className="inline-flex">
                    <Badge tone={attachment.error ? 'danger' : 'neutral'}>
                      <IconFile size={11} /> {attachment.fileName}
                      {attachment.sizeBytes !== undefined ? ` · ${formatBytes(attachment.sizeBytes)}` : ''}
                    </Badge>
                  </span>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <span className="text-[10.5px] text-[var(--text-faint)]">{formatTime(item.createdAt)}</span>
        <IconButton
          size="sm"
          label={t('chat.copyMessage')}
          onClick={() => {
            void invoke('clipboard:writeText', { text: item.text ?? '' });
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <IconCheck size={12} className="text-[var(--success)]" /> : <IconCopy size={12} />}
        </IconButton>
        <Tooltip content={t('chat.retryCreatesFork')}>
          <IconButton size="sm" label={t('chat.retry')} onClick={() => onFork(item.id)}>
            <IconFork size={12} />
          </IconButton>
        </Tooltip>
      </div>
    </article>
  );
}

function AgentMessage({ item, onFork }: { item: ConversationItem; onFork(itemId: string): void }) {
  const onOpenLink = useOpenLink();
  const [copied, setCopied] = useState(false);
  const streaming = item.status === 'streaming';

  return (
    <article className="ch-anim-fade group flex flex-col gap-1.5" aria-label={t('chat.assistant')}>
      <div className="ch-prose text-[13.5px] leading-relaxed text-[var(--text)]">
        {renderMarkdown(item.text ?? '', {
          onOpenLink,
          renderCodeBlock: (code, language, index) => <CodeBlock key={index} code={code} language={language} />,
        })}
        {streaming ? (
          <span
            aria-hidden="true"
            className="ch-pulse ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px]"
            style={{ background: 'var(--accent)' }}
          />
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
        <span>{formatTime(item.createdAt)}</span>
        {item.modelId ? <span className="ch-mono truncate">{item.modelId}</span> : null}
        {item.effectiveUpstream ? (
          <Tooltip content={`${t('chat.upstreamLabel')}: ${item.effectiveUpstream}`}>
            <span tabIndex={0} className="inline-flex">
              <Badge tone="info">{item.effectiveUpstream}</Badge>
            </span>
          </Tooltip>
        ) : null}
        {item.usage ? (
          <Tooltip content={describeUsage(item.usage).join('\n')}>
            <span tabIndex={0} className="inline-flex">
              <Badge tone="neutral">
                {item.usage.totalTokens !== undefined ? `${item.usage.totalTokens} tokens` : 'uso'}
              </Badge>
            </span>
          </Tooltip>
        ) : null}
        <span className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <IconButton
            size="sm"
            label={t('chat.copyMessage')}
            onClick={() => {
              void invoke('clipboard:writeText', { text: item.text ?? '' });
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <IconCheck size={12} className="text-[var(--success)]" /> : <IconCopy size={12} />}
          </IconButton>
          <Tooltip content={t('chat.editCreatesFork')}>
            <IconButton size="sm" label={t('sidebar.fork')} onClick={() => onFork(item.id)}>
              <IconFork size={12} />
            </IconButton>
          </Tooltip>
        </span>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * Blocos técnicos
 * ------------------------------------------------------------------ */

function TechnicalBlock({
  icon,
  title,
  meta,
  tone = 'neutral',
  defaultOpen = false,
  children,
  wide,
}: {
  icon: React.ReactNode;
  title: string;
  meta?: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success' | 'info';
  defaultOpen?: boolean;
  children?: React.ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const borderColor =
    tone === 'danger'
      ? 'var(--danger)'
      : tone === 'warning'
        ? 'var(--warning)'
        : tone === 'accent'
          ? 'var(--accent)'
          : 'var(--border)';

  return (
    <section
      className={clsx('ch-anim-fade rounded-[var(--radius-md)] border', wide ? 'ch-prose-wide' : 'ch-prose')}
      style={{ background: 'var(--surface-1)', borderColor }}
    >
      <button
        type="button"
        onClick={() => children && setOpen((value) => !value)}
        aria-expanded={children ? open : undefined}
        className={clsx(
          'flex w-full items-center gap-2 px-3 py-2 text-left',
          children ? 'cursor-pointer hover:bg-[var(--surface-2)]' : 'cursor-default',
        )}
      >
        <span className="flex-none text-[var(--text-faint)]" aria-hidden="true">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">{title}</span>
        {meta}
        {children ? (
          <span className="flex-none text-[11px] text-[var(--text-faint)]">
            {open ? t('common.collapse') : t('common.expand')}
          </span>
        ) : null}
      </button>
      {open && children ? <div className="border-t px-3 py-2.5">{children}</div> : null}
    </section>
  );
}

function ReasoningBlock({ item }: { item: ConversationItem }) {
  const onOpenLink = useOpenLink();
  return (
    <TechnicalBlock
      icon={<IconBrain size={14} />}
      title={t('chat.reasoningSummary')}
      tone="neutral"
      defaultOpen={item.status === 'streaming'}
      meta={item.status === 'streaming' ? <Spinner size={12} /> : undefined}
    >
      <div className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
        {renderMarkdown(item.text ?? '', {
          onOpenLink,
          renderCodeBlock: (code, language, index) => <CodeBlock key={index} code={code} language={language} />,
        })}
      </div>
      <p className="mt-2 border-t pt-2 text-[11px] leading-snug text-[var(--text-faint)]">
        {t('chat.reasoningNote')}
      </p>
    </TechnicalBlock>
  );
}

function PlanBlock({ item }: { item: ConversationItem }) {
  const steps = item.plan ?? [];
  const done = steps.filter((step) => step.status === 'completed').length;
  return (
    <TechnicalBlock
      icon={<IconList size={14} />}
      title={t('chat.plan')}
      tone="accent"
      defaultOpen
      meta={<Badge tone="accent">{`${done}/${steps.length}`}</Badge>}
    >
      <ol className="space-y-1.5">
        {steps.map((step) => (
          <li key={step.id} className="flex items-start gap-2 text-[12.5px]">
            <StepMarker status={step.status} />
            <span
              className={clsx(
                'leading-snug',
                step.status === 'completed'
                  ? 'text-[var(--text-faint)] line-through'
                  : step.status === 'inProgress'
                    ? 'text-[var(--text)]'
                    : 'text-[var(--text-muted)]',
              )}
            >
              {step.text}
            </span>
          </li>
        ))}
        {steps.length === 0 ? (
          <li className="text-[12.5px] text-[var(--text-faint)]">O motor ainda não enviou etapas.</li>
        ) : null}
      </ol>
    </TechnicalBlock>
  );
}

function StepMarker({ status }: { status: PlanStep['status'] }) {
  if (status === 'completed') {
    return <IconCheck size={13} className="mt-[3px] flex-none text-[var(--success)]" />;
  }
  if (status === 'inProgress') {
    return <span className="mt-[5px] flex-none"><Spinner size={11} /></span>;
  }
  if (status === 'skipped') {
    return <span className="mt-[3px] flex-none text-[11px] text-[var(--text-faint)]">—</span>;
  }
  return (
    <span
      aria-hidden="true"
      className="mt-[6px] h-2 w-2 flex-none rounded-full border"
      style={{ borderColor: 'var(--border-strong)' }}
    />
  );
}

function CommandBlock({ item }: { item: ConversationItem }) {
  const command = item.command;
  const failed = command?.exitCode !== undefined && command.exitCode !== 0;
  return (
    <TechnicalBlock
      icon={<IconTerminal size={14} />}
      title={command?.command ?? t('chat.command')}
      tone={failed ? 'danger' : 'neutral'}
      defaultOpen={item.status === 'streaming' || failed}
      wide
      meta={
        <span className="flex flex-none items-center gap-1.5">
          {item.status === 'streaming' ? <Spinner size={12} /> : null}
          {command?.durationMs !== undefined ? (
            <span className="text-[11px] text-[var(--text-faint)]">{formatDuration(command.durationMs)}</span>
          ) : null}
          {command?.exitCode !== undefined ? (
            <Badge tone={failed ? 'danger' : 'success'}>saída {command.exitCode}</Badge>
          ) : null}
        </span>
      }
    >
      {command?.cwd ? (
        <p className="ch-mono mb-2 truncate text-[11.5px] text-[var(--text-faint)]" title={command.cwd}>
          {command.cwd}
        </p>
      ) : null}
      <TerminalOutput
        output={command?.output ?? ''}
        truncated={command?.outputTruncated ?? false}
        totalBytes={command?.totalOutputBytes ?? 0}
      />
    </TechnicalBlock>
  );
}

function ToolBlock({ item, developerMode }: { item: ConversationItem; developerMode: boolean }) {
  const tool = item.tool;
  const failed = item.status === 'failed' || Boolean(tool?.error);
  return (
    <TechnicalBlock
      icon={<IconSpark size={14} />}
      title={`${t('chat.tool')}: ${tool?.toolName ?? '—'}`}
      tone={failed ? 'danger' : 'neutral'}
      defaultOpen={failed}
      wide
      meta={
        <span className="flex flex-none items-center gap-1.5">
          {item.status === 'pending' ? <Spinner size={12} /> : null}
          {tool?.durationMs !== undefined ? (
            <span className="text-[11px] text-[var(--text-faint)]">{formatDuration(tool.durationMs)}</span>
          ) : null}
          {failed ? <Badge tone="danger">falhou</Badge> : item.status === 'completed' ? (
            <Badge tone="success">ok</Badge>
          ) : null}
        </span>
      }
    >
      {tool?.error ? (
        <p className="mb-2 text-[12.5px] leading-snug text-[var(--danger)]">{tool.error}</p>
      ) : null}
      {tool?.arguments !== undefined ? (
        <div className="mb-2">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Argumentos</p>
          <CodeBlock code={safeJson(tool.arguments)} language="json" />
        </div>
      ) : null}
      {tool?.result !== undefined && developerMode ? (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
            Resultado (modo desenvolvedor)
          </p>
          <CodeBlock code={safeJson(tool.result)} language="json" />
        </div>
      ) : null}
      {item.fileChange && item.fileChange.files.length > 0 ? (
        <div className="mt-2 max-h-[320px] overflow-hidden rounded-[var(--radius-sm)] border">
          <DiffView files={item.fileChange.files} />
        </div>
      ) : null}
    </TechnicalBlock>
  );
}

function FileChangeBlock({ item }: { item: ConversationItem }) {
  const files = item.fileChange?.files ?? [];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <TechnicalBlock
      icon={<IconDiff size={14} />}
      title={t('chat.fileChanges')}
      tone="accent"
      defaultOpen
      wide
      meta={
        <span className="flex flex-none items-center gap-2 text-[11px]">
          <Badge tone="neutral">{files.length} arquivo(s)</Badge>
          <span className="ch-mono" style={{ color: 'var(--diff-add-text)' }}>
            +{additions}
          </span>
          <span className="ch-mono" style={{ color: 'var(--diff-del-text)' }}>
            −{deletions}
          </span>
        </span>
      }
    >
      <div className="max-h-[420px] overflow-hidden rounded-[var(--radius-sm)] border">
        <DiffView files={files} />
      </div>
    </TechnicalBlock>
  );
}

function ErrorBlock({ item }: { item: ConversationItem }) {
  const detail = item.errorDetail;
  const [showTechnical, setShowTechnical] = useState(false);
  return (
    <section
      className="ch-anim-fade ch-prose rounded-[var(--radius-md)] border px-3 py-2.5"
      style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <IconAlert size={15} className="mt-[2px] flex-none text-[var(--danger)]" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium leading-snug text-[var(--text)]">
            {detail?.message ?? item.text ?? t('chat.failed')}
          </p>
          {detail?.action ? (
            <p className="mt-1 text-[12.5px] leading-snug text-[var(--text-muted)]">{detail.action}</p>
          ) : null}
          {detail?.technical ? (
            <>
              <button
                type="button"
                onClick={() => setShowTechnical((value) => !value)}
                className="mt-1.5 text-[11.5px] text-[var(--text-faint)] underline underline-offset-2"
                aria-expanded={showTechnical}
              >
                {t('chat.showTechnical')}
              </button>
              {showTechnical ? (
                <pre className="ch-mono mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--text-faint)]">
                  {detail.technical}
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function NoticeBlock({ item }: { item: ConversationItem }) {
  return (
    <section
      className="ch-anim-fade ch-prose flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border)' }}
    >
      <IconInfo size={14} className="mt-[2px] flex-none text-[var(--text-faint)]" />
      <p className="text-[12.5px] leading-snug text-[var(--text-muted)]">{item.text}</p>
    </section>
  );
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function describeDelivery(delivery: AttachmentDelivery | undefined): string | undefined {
  if (!delivery) return undefined;
  switch (delivery.type) {
    case 'codexImage':
    case 'codexLocalPath':
      return `Entregue ao Codex por caminho autorizado: ${delivery.path}`;
    case 'inlineImage':
      return `Imagem enviada ao provedor (${delivery.mimeType}, ${formatBytes(delivery.bytes)})`;
    case 'extractedText':
      return `Texto extraído localmente (${delivery.characters} caracteres${delivery.pages ? `, ${delivery.pages} página(s)` : ''})`;
    case 'toolReadable':
      return `Disponível no workspace para leitura pelas ferramentas: ${delivery.path}`;
    case 'failed':
      return delivery.reason;
    default:
      return undefined;
  }
}

export const MemoizedMessageItem = MessageItem;

export function useVisibleItems(items: ConversationItem[], showReasoning: boolean): ConversationItem[] {
  return useMemo(
    () => (showReasoning ? items : items.filter((item) => item.kind !== 'reasoningSummary')),
    [items, showReasoning],
  );
}
