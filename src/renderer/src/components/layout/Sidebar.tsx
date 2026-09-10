/**
 * Barra lateral: identidade do aplicativo, nova conversa, pesquisa, conversas
 * agrupadas, favoritos, workspaces recentes e acesso ao catálogo, skills e
 * configurações.
 *
 * Cada linha assina só as ações de que precisa (seletores individuais): o
 * store muda a cada quadro durante o streaming, e assinar o store inteiro
 * renderizava todas as linhas de novo a cada delta.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ConversationSummary } from '@shared/domain';
import { t } from '../../i18n';
import { formatRelative, truncateMiddle } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, IconButton, Input, SectionTitle } from '../ui/primitives';
import { Popover, Tooltip } from '../ui/Popover';
import {
  IconArchive,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFolder,
  IconGrid,
  IconFork,
  IconList,
  IconMore,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSkill,
  IconSpark,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '../ui/icons';

interface Group {
  key: string;
  label: string;
  conversations: ConversationSummary[];
}

const DAY = 24 * 60 * 60 * 1000;

function groupByPeriod(conversations: ConversationSummary[]): Group[] {
  const now = Date.now();
  const buckets: Group[] = [
    { key: 'today', label: t('sidebar.today'), conversations: [] },
    { key: 'yesterday', label: t('sidebar.yesterday'), conversations: [] },
    { key: 'week', label: t('sidebar.last7Days'), conversations: [] },
    { key: 'month', label: t('sidebar.last30Days'), conversations: [] },
    { key: 'older', label: t('sidebar.older'), conversations: [] },
  ];
  for (const conversation of conversations) {
    const age = now - new Date(conversation.updatedAt).getTime();
    const index = age < DAY ? 0 : age < 2 * DAY ? 1 : age < 7 * DAY ? 2 : age < 30 * DAY ? 3 : 4;
    buckets[index]?.conversations.push(conversation);
  }
  return buckets.filter((bucket) => bucket.conversations.length > 0);
}

export function Sidebar({
  onNewConversation,
  forceCollapsed = false,
}: {
  onNewConversation(): void;
  /** Janela estreita: mostra só o trilho de ícones, sem alterar a preferência. */
  forceCollapsed?: boolean;
}) {
  const layout = useUiStore((state) => state.layout);
  const setLayout = useUiStore((state) => state.setLayout);
  const openDialog = useUiStore((state) => state.openDialog);
  const applySettings = useAppStore((state) => state.applySettings);
  const workspaces = useAppStore((state) => state.workspaces);
  const appName = useAppStore((state) => state.appName);
  const appVersion = useAppStore((state) => state.appVersion);

  const conversations = useConversationStore((state) => state.conversations);
  const activeId = useConversationStore((state) => state.activeId);
  const setActive = useConversationStore((state) => state.setActive);

  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [groupByWorkspace, setGroupByWorkspace] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return conversations
      .filter((conversation) => conversation.archived === showArchived)
      .filter(
        (conversation) =>
          needle === '' ||
          conversation.title.toLowerCase().includes(needle) ||
          (conversation.lastMessagePreview ?? '').toLowerCase().includes(needle),
      );
  }, [conversations, query, showArchived]);

  const favorites = filtered.filter((conversation) => conversation.favorite);
  const rest = filtered.filter((conversation) => !conversation.favorite);
  const archivedCount = useMemo(() => conversations.filter((c) => c.archived).length, [conversations]);
  const activeCount = conversations.length - archivedCount;

  const groups: Group[] = useMemo(() => {
    if (!groupByWorkspace) return groupByPeriod(rest);
    const byWorkspace = new Map<string, ConversationSummary[]>();
    for (const conversation of rest) {
      const key = conversation.workspacePath ?? '__none__';
      byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), conversation]);
    }
    return [...byWorkspace.entries()]
      .map(([key, list]) => ({
        key,
        label: key === '__none__' ? t('sidebar.noWorkspace') : truncateMiddle(key, 34),
        conversations: list,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }, [groupByWorkspace, rest]);

  if (layout.sidebarCollapsed || forceCollapsed) {
    return (
      <nav
        aria-label={t('sidebar.navLabel')}
        className="flex w-12 flex-none flex-col items-center gap-1 border-r py-2"
        style={{ background: 'var(--surface-1)' }}
      >
        <IconButton
          label={t('workspaceExperience.home')}
          active={!activeId}
          onClick={() => void setActive(null)}
        >
          <IconGrid />
        </IconButton>
        {!forceCollapsed ? (
          <Tooltip content={t('sidebar.expand')}>
            <IconButton
              label={t('sidebar.expand')}
              onClick={() => {
                setLayout({ sidebarCollapsed: false });
                void applySettings({ layout: { sidebarCollapsed: false } });
              }}
            >
              <IconChevronRight />
            </IconButton>
          </Tooltip>
        ) : null}
        <Tooltip content={`${t('sidebar.newConversation')} (Ctrl+N)`}>
          <IconButton label={t('sidebar.newConversation')} onClick={onNewConversation}>
            <IconPlus />
          </IconButton>
        </Tooltip>
        <Tooltip content={`${t('palette.title')} (Ctrl+K)`}>
          <IconButton label={t('palette.title')} onClick={() => openDialog('palette')}>
            <IconSearch />
          </IconButton>
        </Tooltip>
        <Tooltip content={t('catalog.title')}>
          <IconButton label={t('catalog.title')} onClick={() => openDialog('catalog')}>
            <IconList />
          </IconButton>
        </Tooltip>
        <div className="mt-auto">
          <Tooltip content={`${t('sidebar.settings')} (Ctrl+,)`}>
            <IconButton label={t('sidebar.settings')} onClick={() => openDialog('settings')}>
              <IconSettings />
            </IconButton>
          </Tooltip>
        </div>
      </nav>
    );
  }

  return (
    <nav
      aria-label={t('sidebar.navLabel')}
      className="flex h-full flex-none flex-col border-r"
      style={{ width: layout.sidebarWidth, background: 'var(--surface-1)' }}
    >
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="ch-avatar" aria-hidden="true">
          <IconSpark size={13} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--text)]">
          {appName}
        </span>
        <span className="ch-mono text-[10.5px] text-[var(--text-faint)]" title={`Versão ${appVersion}`}>
          v{appVersion}
        </span>
        <IconButton
          size="sm"
          label={t('sidebar.collapse')}
          onClick={() => {
            setLayout({ sidebarCollapsed: true });
            void applySettings({ layout: { sidebarCollapsed: true } });
          }}
        >
          <IconChevronLeft size={14} />
        </IconButton>
      </div>

      <div className="px-2.5 pb-1.5 pt-1.5">
        <Button
          variant="subtle"
          size="sm"
          iconLeft={<IconGrid />}
          onClick={() => void setActive(null)}
          block
          className="mb-2"
          aria-current={!activeId ? 'page' : undefined}
        >
          {t('workspaceExperience.home')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          iconLeft={<IconPlus />}
          onClick={onNewConversation}
          block
          title={`${t('sidebar.newConversation')} (Ctrl+N)`}
        >
          {t('sidebar.newConversation')}
        </Button>
      </div>

      <div className="relative px-2.5 pb-2">
        <IconSearch
          size={14}
          className="pointer-events-none absolute left-4.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('sidebar.searchPlaceholder')}
          aria-label={t('common.search')}
          className="h-8 pl-7 text-[13px]"
        />
      </div>

      <div className="flex items-center gap-1 px-2.5 pb-1.5">
        <FilterTab active={!showArchived} onClick={() => setShowArchived(false)}>
          {t('sidebar.active')}
          <TabCount>{activeCount}</TabCount>
        </FilterTab>
        <FilterTab active={showArchived} onClick={() => setShowArchived(true)}>
          {t('sidebar.archived')}
          <TabCount>{archivedCount}</TabCount>
        </FilterTab>
        <div className="ml-auto">
          <Tooltip content={groupByWorkspace ? t('sidebar.groupByPeriod') : t('sidebar.groupByWorkspace')}>
            <IconButton
              size="sm"
              label={groupByWorkspace ? t('sidebar.groupByPeriod') : t('sidebar.groupByWorkspace')}
              active={groupByWorkspace}
              onClick={() => setGroupByWorkspace((value) => !value)}
            >
              <IconFolder size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {filtered.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12.5px] leading-relaxed text-[var(--text-faint)]">
            {query.trim() === '' ? t('sidebar.emptyConversations') : t('sidebar.emptySearch')}
          </p>
        ) : null}

        {favorites.length > 0 ? (
          <section className="mb-2">
            <SectionTitle>{t('sidebar.favorites')}</SectionTitle>
            <ul className="mt-1 space-y-0.5">
              {favorites.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                  onSelect={() => void setActive(conversation.id)}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} className="mb-2">
            <SectionTitle>{group.label}</SectionTitle>
            <ul className="mt-1 space-y-0.5">
              {group.conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeId}
                  onSelect={() => void setActive(conversation.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {workspaces.length > 0 ? (
        <div className="border-t px-1.5 py-2">
          <SectionTitle>{t('sidebar.recentWorkspaces')}</SectionTitle>
          <ul className="mt-1 space-y-0.5">
            {workspaces.slice(0, 3).map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  onClick={() => openDialog('workspaces')}
                  className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-3)]"
                  title={workspace.path}
                >
                  <IconFolder size={14} className="flex-none text-[var(--text-faint)]" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text-muted)]">
                    {workspace.name}
                  </span>
                  {workspace.git?.isRepository && workspace.git.branch ? (
                    <Badge tone="neutral" title={`Branch ${workspace.git.branch}`}>
                      {truncateMiddle(workspace.git.branch, 14)}
                    </Badge>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="sm" iconLeft={<IconList />} onClick={() => openDialog('catalog')}>
          {t('sidebar.catalog')}
        </Button>
        <Button variant="ghost" size="sm" iconLeft={<IconSkill />} onClick={() => openDialog('skills')}>
          {t('sidebar.skills')}
        </Button>
        <div className="ml-auto">
          <Tooltip content={`${t('sidebar.settings')} (Ctrl+,)`}>
            <IconButton label={t('sidebar.settings')} onClick={() => openDialog('settings')}>
              <IconSettings />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </nav>
  );
}

function TabCount({ children }: { children: number }) {
  if (children === 0) return null;
  return <span className="ml-1 text-[10.5px] font-normal text-[var(--text-faint)]">{children}</span>;
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11.5px] font-medium transition-colors',
        active ? 'text-[var(--text)]' : 'text-[var(--text-faint)] hover:text-[var(--text-muted)]',
      )}
      style={active ? { background: 'var(--surface-3)' } : undefined}
    >
      {children}
    </button>
  );
}

function ConversationRow({
  conversation,
  active,
  onSelect,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onSelect(): void;
}) {
  const rename = useConversationStore((state) => state.rename);
  const setFavorite = useConversationStore((state) => state.setFavorite);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [menuOpen, setMenuOpen] = useState(false);

  const commitRename = (): void => {
    const next = title.trim();
    if (next !== '' && next !== conversation.title) void rename(conversation.id, next);
    setRenaming(false);
  };

  const busy = conversation.status === 'running' || conversation.status === 'awaitingApproval';

  return (
    <li>
      <div
        className={clsx(
          'ch-row group relative flex items-center gap-1.5 rounded-[var(--radius-sm)] pl-2.5 pr-1 transition-colors',
          active ? 'ch-row-active bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-3)]',
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        {renaming ? (
          <form
            className="flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              commitRename();
            }}
          >
            <Input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              // Clicar fora CONFIRMA o novo título (antes, descartava em silêncio).
              onBlur={commitRename}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setTitle(conversation.title);
                  setRenaming(false);
                }
              }}
              className="h-7 text-[13px]"
              aria-label={t('sidebar.rename')}
            />
          </form>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            aria-current={active ? 'true' : undefined}
            className="min-w-0 flex-1 text-left"
            title={conversation.title}
          >
            <span
              className={clsx(
                'block truncate text-[13px] leading-tight',
                active ? 'font-medium text-[var(--text)]' : 'text-[var(--text-muted)]',
              )}
            >
              {conversation.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
              {busy ? (
                <span
                  aria-hidden="true"
                  className={clsx(
                    'h-1.5 w-1.5 flex-none rounded-full',
                    conversation.status === 'running' && 'ch-pulse',
                  )}
                  style={{
                    background: conversation.status === 'running' ? 'var(--accent)' : 'var(--warning)',
                  }}
                />
              ) : null}
              <span>{formatRelative(conversation.updatedAt)}</span>
              {busy ? (
                <Badge tone={conversation.status === 'running' ? 'accent' : 'warning'}>
                  {conversation.status === 'running' ? t('sidebar.running') : t('sidebar.awaiting')}
                </Badge>
              ) : null}
              {conversation.forkedFromId ? (
                <IconFork
                  size={11}
                  className="text-[var(--text-faint)]"
                  aria-label={t('sidebar.forkBadge')}
                />
              ) : null}
            </span>
          </button>
        )}

        <div
          className={clsx(
            'flex flex-none items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100',
            menuOpen || conversation.favorite ? 'opacity-100' : 'opacity-0',
          )}
        >
          <IconButton
            size="sm"
            label={conversation.favorite ? t('common.unfavorite') : t('common.favorite')}
            onClick={() => void setFavorite(conversation.id, !conversation.favorite)}
          >
            {conversation.favorite ? (
              <IconStarFilled size={13} className="text-[var(--warning)]" />
            ) : (
              <IconStar size={13} />
            )}
          </IconButton>
          <ConversationMenu
            conversation={conversation}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onRename={() => {
              setTitle(conversation.title);
              setRenaming(true);
            }}
          />
        </div>
      </div>
    </li>
  );
}

/** Menu de ações de uma conversa (botão "…" ou clique com o botão direito). */
export function ConversationMenu({
  conversation,
  open,
  onOpenChange,
  onRename,
  align = 'end',
}: {
  conversation: ConversationSummary;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  onRename?(): void;
  align?: 'start' | 'end';
}) {
  const fork = useConversationStore((state) => state.fork);
  const archive = useConversationStore((state) => state.archive);
  const remove = useConversationStore((state) => state.remove);
  const exportConversation = useConversationStore((state) => state.exportConversation);
  const copyAsMarkdown = useConversationStore((state) => state.copyAsMarkdown);
  const confirm = useUiStore((state) => state.confirm);

  return (
    <Popover
      label={t('sidebar.actions')}
      align={align}
      width={232}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <IconButton size="sm" label={t('common.more')}>
          <IconMore size={14} />
        </IconButton>
      }
    >
      {(close) => (
        <div className="p-1">
          {onRename ? (
            <MenuItem
              label={t('sidebar.rename')}
              icon={<IconEdit size={14} />}
              onClick={() => {
                onRename();
                close();
              }}
            />
          ) : null}
          <MenuItem
            label={t('sidebar.fork')}
            icon={<IconFork size={14} />}
            onClick={() => {
              void fork(conversation.id);
              close();
            }}
          />
          <div className="ch-divider my-1" />
          <MenuItem
            label={t('sidebar.exportMarkdown')}
            icon={<IconDownload size={14} />}
            onClick={() => {
              void exportConversation(conversation.id, 'markdown');
              close();
            }}
          />
          <MenuItem
            label={t('sidebar.exportJson')}
            icon={<IconDownload size={14} />}
            onClick={() => {
              void exportConversation(conversation.id, 'json');
              close();
            }}
          />
          <MenuItem
            label={t('sidebar.copyMarkdown')}
            icon={<IconCopy size={14} />}
            onClick={() => {
              void copyAsMarkdown(conversation.id);
              close();
            }}
          />
          <div className="ch-divider my-1" />
          <MenuItem
            label={conversation.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
            icon={<IconArchive size={14} />}
            onClick={() => {
              void archive(conversation.id, !conversation.archived);
              close();
            }}
          />
          <MenuItem
            label={t('sidebar.delete')}
            icon={<IconTrash size={14} />}
            tone="danger"
            onClick={() => {
              close();
              void confirm({
                title: t('sidebar.deleteTitle'),
                body: t('sidebar.deleteBody', { title: conversation.title }),
                confirmLabel: t('sidebar.delete'),
                tone: 'danger',
              }).then((accepted) => {
                if (accepted) void remove(conversation.id);
              });
            }}
          />
        </div>
      )}
    </Popover>
  );
}

export function MenuItem({
  label,
  icon,
  onClick,
  tone = 'default',
  disabled,
  disabledReason,
  shortcut,
}: {
  label: string;
  icon?: React.ReactNode;
  onClick(): void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  disabledReason?: string;
  shortcut?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={clsx(
        'flex w-full items-center gap-2 rounded-[var(--radius-xs)] px-2 py-1.5 text-left text-[13px] transition-colors',
        'hover:bg-[var(--surface-3)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        tone === 'danger' ? 'text-[var(--danger)]' : 'text-[var(--text)]',
      )}
    >
      {icon ? <span className="flex-none text-[var(--text-faint)]">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut ? (
        <span className="ch-mono flex-none text-[10.5px] text-[var(--text-faint)]">{shortcut}</span>
      ) : null}
    </button>
  );
}
