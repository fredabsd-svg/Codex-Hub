/**
 * Painel direito: arquivos, diff, saída de comandos e contexto do turno.
 * Recolhível e redimensionável, com tamanho persistido.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ConversationItem, ConversationSummary } from '@shared/domain';
import type { FileTreeNode } from '@shared/ipc';
import { t } from '../../i18n';
import { errorOf, invoke } from '../../lib/api';
import { describeUsage, formatBytes, formatContextWindow, NOT_INFORMED } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore, type RightPanelTab } from '../../stores/uiStore';
import { Badge, EmptyState, IconButton, Spinner } from '../ui/primitives';
import { CapabilityChip } from '../ui/CapabilityChip';
import { DiffSummary, DiffView } from '../../features/diff/DiffView';
import { MonacoViewer } from '../../features/diff/MonacoViewer';
import { TerminalOutput } from '../../features/chat/CodeBlock';
import { IconChevronDown, IconChevronRight, IconFile, IconFolder, IconRefresh } from '../ui/icons';

const TABS: Array<{ value: RightPanelTab; label: string }> = [
  { value: 'files', label: t('rightPanel.files') },
  { value: 'diff', label: t('rightPanel.diff') },
  { value: 'output', label: t('rightPanel.output') },
  { value: 'context', label: t('rightPanel.context') },
];

export function RightPanel({ conversation }: { conversation: ConversationSummary | null }) {
  const layout = useUiStore((state) => state.layout);
  const setLayout = useUiStore((state) => state.setLayout);
  const applySettings = useAppStore((state) => state.applySettings);
  const runtime = useConversationStore((state) => (conversation ? state.runtime[conversation.id] : undefined));
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));

  const diffs = runtime?.diffs ?? [];
  const commandItems = useMemo(
    () => (items ?? []).filter((item) => item.kind === 'commandExecution' && item.command),
    [items],
  );

  const setTab = (tab: RightPanelTab): void => {
    setLayout({ rightPanelTab: tab });
    void applySettings({ layout: { rightPanelTab: tab } });
  };

  return (
    <aside
      aria-label="Painel de contexto"
      className="flex h-full min-h-0 flex-none flex-col border-l"
      style={{ width: layout.rightPanelWidth, background: 'var(--surface-1)' }}
    >
      <div className="flex flex-none items-center gap-0.5 border-b px-1.5 py-1.5" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={layout.rightPanelTab === tab.value}
            onClick={() => setTab(tab.value)}
            className={clsx(
              'rounded-[var(--radius-xs)] px-2 py-1 text-[12.5px] font-medium transition-colors',
              layout.rightPanelTab === tab.value
                ? 'text-[var(--text)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]',
            )}
            style={layout.rightPanelTab === tab.value ? { background: 'var(--surface-3)' } : undefined}
          >
            {tab.label}
            {tab.value === 'diff' && diffs.length > 0 ? (
              <span className="ml-1.5">
                <Badge tone="accent">{diffs.length}</Badge>
              </span>
            ) : null}
          </button>
        ))}
        <div className="ml-auto">
          <IconButton
            label={t('rightPanel.close')}
            onClick={() => {
              setLayout({ rightPanelCollapsed: true });
              void applySettings({ layout: { rightPanelCollapsed: true } });
            }}
          >
            <IconChevronRight />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden" role="tabpanel">
        {layout.rightPanelTab === 'files' ? (
          <FilesTab conversation={conversation} />
        ) : layout.rightPanelTab === 'diff' ? (
          <div className="flex h-full min-h-0 flex-col">
            {diffs.length > 0 ? (
              <div className="flex-none border-b px-2.5 py-1.5">
                <DiffSummary files={diffs} />
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              <DiffView files={diffs} />
            </div>
          </div>
        ) : layout.rightPanelTab === 'output' ? (
          <OutputTab items={commandItems} />
        ) : (
          <ContextTab conversation={conversation} />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Arquivos
 * ------------------------------------------------------------------ */

function FilesTab({ conversation }: { conversation: ConversationSummary | null }) {
  const settings = useAppStore((state) => state.settings);
  const pushError = useUiStore((state) => state.pushError);
  const [tree, setTree] = useState<FileTreeNode | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{ path: string; content: string; binary: boolean; truncated: boolean } | null>(
    null,
  );

  const workspacePath = conversation?.workspacePath;

  const loadTree = async (): Promise<void> => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      setTree(await invoke('workspaces:fileTree', { path: workspacePath, maxEntries: 3000 }));
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível listar os arquivos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelected(null);
    setTree(null);
    if (workspacePath) void loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  const openFile = async (path: string): Promise<void> => {
    if (!workspacePath) return;
    try {
      const file = await invoke('workspaces:readFile', { workspacePath, filePath: path, maxBytes: 512 * 1024 });
      setSelected({ path, content: file.content, binary: file.binary, truncated: file.truncated });
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível abrir o arquivo');
    }
  };

  if (!workspacePath) {
    return <EmptyState icon={<IconFolder size={22} />} title={t('rightPanel.noWorkspace')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center justify-between gap-2 border-b px-2.5 py-1.5">
        <span className="ch-mono truncate text-[11.5px] text-[var(--text-faint)]" title={workspacePath}>
          {tree?.name ?? workspacePath}
        </span>
        <IconButton size="sm" label={t('common.refresh')} onClick={() => void loadTree()}>
          <IconRefresh size={13} />
        </IconButton>
      </div>

      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-2 border-b px-2.5 py-1.5">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="text-[12px] text-[var(--accent)] underline underline-offset-2"
            >
              ← voltar à árvore
            </button>
            <span className="ch-mono min-w-0 flex-1 truncate text-[11.5px] text-[var(--text-muted)]">
              {selected.path}
            </span>
            {selected.truncated ? <Badge tone="warning">truncado</Badge> : null}
          </div>
          <div className="min-h-0 flex-1">
            {selected.binary ? (
              <EmptyState icon={<IconFile size={22} />} title={t('rightPanel.binaryFile')} body={selected.path} />
            ) : (
              <MonacoViewer
                value={selected.content}
                path={selected.path}
                theme={settings.theme === 'light' ? 'light' : 'dark'}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-1 py-1.5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[12.5px] text-[var(--text-muted)]">
              <Spinner /> {t('common.loading')}
            </div>
          ) : tree ? (
            <TreeNode node={tree} depth={0} onOpenFile={(path) => void openFile(path)} defaultOpen />
          ) : (
            <EmptyState title={t('common.empty')} />
          )}
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  onOpenFile,
  defaultOpen,
}: {
  node: FileTreeNode;
  depth: number;
  onOpenFile(path: string): void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? depth < 1);

  if (node.truncated) {
    return (
      <p className="px-2 py-1 text-[11.5px] text-[var(--text-faint)]" style={{ paddingLeft: 8 + depth * 12 }}>
        {node.name}
      </p>
    );
  }

  if (node.kind === 'file') {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(node.path)}
        className="flex w-full items-center gap-1.5 rounded-[var(--radius-xs)] py-[3px] pr-2 text-left transition-colors hover:bg-[var(--surface-3)]"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={node.path}
      >
        <IconFile size={13} className="flex-none text-[var(--text-faint)]" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-muted)]">{node.name}</span>
        {node.sizeBytes !== undefined ? (
          <span className="ch-mono flex-none text-[10.5px] text-[var(--text-faint)]">
            {formatBytes(node.sizeBytes)}
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-[var(--radius-xs)] py-[3px] pr-2 text-left transition-colors hover:bg-[var(--surface-3)]"
        style={{ paddingLeft: 4 + depth * 12 }}
      >
        {open ? (
          <IconChevronDown size={12} className="flex-none text-[var(--text-faint)]" />
        ) : (
          <IconChevronRight size={12} className="flex-none text-[var(--text-faint)]" />
        )}
        <IconFolder size={13} className="flex-none text-[var(--text-faint)]" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)]">{node.name}</span>
      </button>
      {open
        ? (node.children ?? []).map((child, index) => (
            <TreeNode key={`${child.path}-${index}`} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
          ))
        : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Saída
 * ------------------------------------------------------------------ */

function OutputTab({ items }: { items: ConversationItem[] }) {
  if (items.length === 0) {
    return <EmptyState title={t('rightPanel.noOutput')} />;
  }
  return (
    <div className="h-full space-y-3 overflow-auto p-2.5">
      {items.map((item) => (
        <div key={item.id}>
          <p className="ch-mono mb-1 truncate text-[11.5px] text-[var(--text-muted)]" title={item.command?.command}>
            $ {item.command?.command}
          </p>
          <TerminalOutput
            output={item.command?.output ?? ''}
            truncated={item.command?.outputTruncated ?? false}
            totalBytes={item.command?.totalOutputBytes ?? 0}
            maxHeight={200}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Contexto
 * ------------------------------------------------------------------ */

function ContextTab({ conversation }: { conversation: ConversationSummary | null }) {
  const pages = useCatalogStore((state) => state.pages);
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));

  if (!conversation) return <EmptyState title="Nenhuma conversa selecionada." />;

  const model = pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId);
  const lastUsage = [...(items ?? [])].reverse().find((item) => item.usage)?.usage;
  const parameters = conversation.parameters;

  return (
    <div className="h-full space-y-4 overflow-auto p-3 text-[12.5px]">
      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
          {t('rightPanel.effectiveParameters')}
        </h3>
        <dl className="space-y-1">
          <Row label="Provedor" value={conversation.providerId} />
          <Row label="Motor" value={conversation.engineId === 'codex' ? 'Codex App Server' : 'Motor direto'} />
          <Row label="Modelo" value={conversation.modelId} mono />
          <Row label="Modo" value={conversation.mode} />
          <Row label="Janela de contexto" value={formatContextWindow(model?.contextWindow)} />
          <Row label="Limite de saída" value={model?.maxOutputTokens ? String(model.maxOutputTokens) : NOT_INFORMED} />
          <Row label="Esforço de raciocínio" value={parameters.reasoningEffort ?? 'padrão do modelo'} />
          <Row label="Temperatura" value={parameters.temperature !== undefined ? String(parameters.temperature) : 'não enviada'} />
          <Row label="Personalidade" value={parameters.personality ?? 'não enviada'} />
        </dl>
        <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-faint)]">
          Parâmetros só são enviados quando o modelo declara suporte. "não enviada" significa que o aplicativo
          omite o campo na requisição.
        </p>
      </section>

      {model ? (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
            {t('rightPanel.capabilities')}
          </h3>
          <div className="flex flex-wrap gap-1">
            <CapabilityChip capability={model.capabilities.chat} capabilityKey="chat" />
            <CapabilityChip capability={model.capabilities.streaming} capabilityKey="streaming" />
            <CapabilityChip capability={model.capabilities.toolCalling} capabilityKey="toolCalling" />
            <CapabilityChip capability={model.capabilities.imageInput} capabilityKey="imageInput" />
            <CapabilityChip capability={model.capabilities.taskExecution} capabilityKey="taskExecution" />
            <CapabilityChip capability={model.capabilities.reasoningEffort} capabilityKey="reasoningEffort" />
          </div>
        </section>
      ) : null}

      {parameters.routing ? (
        <section>
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
            {t('rightPanel.routing')}
          </h3>
          <dl className="space-y-1">
            {parameters.routing.order?.length ? <Row label="Ordem" value={parameters.routing.order.join(', ')} /> : null}
            {parameters.routing.only?.length ? <Row label="Somente" value={parameters.routing.only.join(', ')} /> : null}
            {parameters.routing.ignore?.length ? (
              <Row label="Ignorar" value={parameters.routing.ignore.join(', ')} />
            ) : null}
            <Row
              label="Fallback entre fornecedores"
              value={parameters.routing.allowFallbacks === false ? 'desativado' : 'permitido'}
            />
            {parameters.routing.modelFallbacks?.length ? (
              <Row label="Fallback de modelo" value={parameters.routing.modelFallbacks.join(', ')} />
            ) : null}
          </dl>
          <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--text-faint)]">
            O OpenRouter é o roteador; o fornecedor de inferência escolhido por ele aparece em cada resposta quando
            informado.
          </p>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
          Uso do último turno
        </h3>
        <ul className="space-y-0.5 text-[var(--text-muted)]">
          {describeUsage(lastUsage).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd className={clsx('min-w-0 truncate text-right text-[var(--text)]', mono && 'ch-mono')} title={value}>
        {value}
      </dd>
    </div>
  );
}
