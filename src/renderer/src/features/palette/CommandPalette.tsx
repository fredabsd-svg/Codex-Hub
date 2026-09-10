/**
 * Paleta de comandos e pesquisa (Ctrl+K).
 *
 * Navegação completa por teclado: setas movem, Enter executa, Esc fecha.
 * A busca cobre ações, a conversa atual, conversas, o CONTEÚDO das mensagens
 * (pesquisa no processo principal, com atraso curto), modelos e workspaces.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { OperationMode, ThemePreference } from '@shared/domain';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { truncateMiddle } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Input, Kbd, Spinner } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import {
  IconArchive,
  IconCopy,
  IconDownload,
  IconFolder,
  IconFork,
  IconKeyboard,
  IconList,
  IconMoon,
  IconPanelLeft,
  IconPanelRight,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSkill,
  IconSpark,
  IconStar,
  IconStop,
  IconSun,
  IconTerminal,
} from '../../components/ui/icons';

interface Entry {
  id: string;
  section: string;
  label: string;
  hint?: string;
  shortcut?: string;
  icon: React.ReactNode;
  run(): void;
}

interface MessageMatch {
  conversationId: string;
  itemId: string;
  snippet: string;
}

const SEARCH_DELAY_MS = 180;
const MIN_SEARCH_LENGTH = 2;

export function CommandPalette({
  open,
  onClose,
  onNewConversation,
}: {
  open: boolean;
  onClose(): void;
  onNewConversation(): void;
}) {
  const conversations = useConversationStore((state) => state.conversations);
  const setActive = useConversationStore((state) => state.setActive);
  const activeId = useConversationStore((state) => state.activeId);
  const runtime = useConversationStore((state) => (activeId ? state.runtime[activeId] : undefined));
  const setParameters = useConversationStore((state) => state.setParameters);
  const setMode = useConversationStore((state) => state.setMode);
  const interrupt = useConversationStore((state) => state.interrupt);
  const setFavorite = useConversationStore((state) => state.setFavorite);
  const archive = useConversationStore((state) => state.archive);
  const fork = useConversationStore((state) => state.fork);
  const exportConversation = useConversationStore((state) => state.exportConversation);
  const copyAsMarkdown = useConversationStore((state) => state.copyAsMarkdown);
  const workspaces = useAppStore((state) => state.workspaces);
  const settings = useAppStore((state) => state.settings);
  const applySettings = useAppStore((state) => state.applySettings);
  const openDialog = useUiStore((state) => state.openDialog);
  const layout = useUiStore((state) => state.layout);
  const setLayout = useUiStore((state) => state.setLayout);
  const pages = useCatalogStore((state) => state.pages);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [matches, setMatches] = useState<MessageMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const current = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setMatches([]);
    }
  }, [open]);

  // Busca no conteúdo das mensagens: no processo principal, com atraso curto.
  useEffect(() => {
    const needle = query.trim();
    if (!open || needle.length < MIN_SEARCH_LENGTH) {
      setMatches([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void invoke('conversations:search', { query: needle, limit: 12 })
        .then((result) => {
          if (!cancelled) setMatches(result.matches);
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const entries = useMemo<Entry[]>(() => {
    const needle = query.trim().toLowerCase();
    const matchesText = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle);
    const sectionActions = t('palette.sections.actions');
    const sectionCurrent = t('palette.sections.current');
    const toggleTheme = (theme: ThemePreference): void => void applySettings({ theme });
    const togglePanel = (key: 'sidebarCollapsed' | 'rightPanelCollapsed'): void => {
      const next = !layout[key];
      setLayout({ [key]: next });
      void applySettings({ layout: { [key]: next } });
    };

    const actions: Entry[] = [
      {
        id: 'action-new',
        section: sectionActions,
        label: t('sidebar.newConversation'),
        shortcut: 'Ctrl+N',
        icon: <IconPlus size={14} />,
        run: () => {
          onNewConversation();
          onClose();
        },
      },
      {
        id: 'action-workspace',
        section: sectionActions,
        label: t('header.chooseWorkspaceShort'),
        shortcut: 'Ctrl+O',
        icon: <IconFolder size={14} />,
        run: () => {
          void (async () => {
            const workspace = await invoke('workspaces:choose');
            if (workspace && activeId) {
              await invoke('conversations:setWorkspace', {
                conversationId: activeId,
                workspacePath: workspace.path,
              });
              await useConversationStore.getState().refresh(true);
            }
          })();
          onClose();
        },
      },
      {
        id: 'action-catalog',
        section: sectionActions,
        label: t('catalog.title'),
        icon: <IconList size={14} />,
        run: () => openDialog('catalog'),
      },
      {
        id: 'action-skills',
        section: sectionActions,
        label: t('skills.title'),
        icon: <IconSkill size={14} />,
        run: () => openDialog('skills'),
      },
      {
        id: 'action-sidebar',
        section: sectionActions,
        label: t('palette.actions.toggleSidebar'),
        shortcut: 'Ctrl+B',
        icon: <IconPanelLeft size={14} />,
        run: () => {
          togglePanel('sidebarCollapsed');
          onClose();
        },
      },
      {
        id: 'action-right',
        section: sectionActions,
        label: t('palette.actions.toggleRightPanel'),
        shortcut: 'Ctrl+J',
        icon: <IconPanelRight size={14} />,
        run: () => {
          togglePanel('rightPanelCollapsed');
          onClose();
        },
      },
      ...(settings.theme !== 'dark'
        ? [
            {
              id: 'action-theme-dark',
              section: sectionActions,
              label: t('palette.actions.themeDark'),
              icon: <IconMoon size={14} />,
              run: () => {
                toggleTheme('dark');
                onClose();
              },
            } satisfies Entry,
          ]
        : []),
      ...(settings.theme !== 'light'
        ? [
            {
              id: 'action-theme-light',
              section: sectionActions,
              label: t('palette.actions.themeLight'),
              icon: <IconSun size={14} />,
              run: () => {
                toggleTheme('light');
                onClose();
              },
            } satisfies Entry,
          ]
        : []),
      ...(settings.theme !== 'system'
        ? [
            {
              id: 'action-theme-system',
              section: sectionActions,
              label: t('palette.actions.themeSystem'),
              icon: <IconSun size={14} />,
              run: () => {
                toggleTheme('system');
                onClose();
              },
            } satisfies Entry,
          ]
        : []),
      {
        id: 'action-settings',
        section: sectionActions,
        label: t('settings.title'),
        shortcut: 'Ctrl+,',
        icon: <IconSettings size={14} />,
        run: () => openDialog('settings'),
      },
      {
        id: 'action-shortcuts',
        section: sectionActions,
        label: t('palette.actions.shortcuts'),
        icon: <IconKeyboard size={14} />,
        run: () => openDialog('settings', 'shortcuts'),
      },
      {
        id: 'action-logs',
        section: sectionActions,
        label: t('palette.actions.openLogs'),
        icon: <IconTerminal size={14} />,
        run: () => {
          void invoke('diagnostics:openLogFolder');
          onClose();
        },
      },
    ].filter((entry) => matchesText(entry.label));

    const currentActions: Entry[] = current
      ? (
          [
            ...(runtime?.status === 'running' || runtime?.status === 'awaitingApproval'
              ? [
                  {
                    id: 'current-interrupt',
                    section: sectionCurrent,
                    label: t('palette.actions.interrupt'),
                    shortcut: 'Esc',
                    icon: <IconStop size={14} />,
                    run: () => {
                      void interrupt(current.id);
                      onClose();
                    },
                  } satisfies Entry,
                ]
              : []),
            ...(['chat', 'plan', 'execute'] as OperationMode[])
              .filter((mode) => mode !== current.mode)
              .map(
                (mode) =>
                  ({
                    id: `current-mode-${mode}`,
                    section: sectionCurrent,
                    label:
                      mode === 'chat'
                        ? t('palette.actions.modeChat')
                        : mode === 'plan'
                          ? t('palette.actions.modePlan')
                          : t('palette.actions.modeExecute'),
                    hint: mode !== 'chat' && !current.workspacePath ? t('sidebar.noWorkspace') : undefined,
                    icon: <IconSpark size={14} />,
                    run: () => {
                      void setMode(current.id, mode);
                      onClose();
                    },
                  }) satisfies Entry,
              ),
            {
              id: 'current-favorite',
              section: sectionCurrent,
              label: current.favorite ? t('palette.actions.unfavorite') : t('palette.actions.favorite'),
              icon: <IconStar size={14} />,
              run: () => {
                void setFavorite(current.id, !current.favorite);
                onClose();
              },
            },
            {
              id: 'current-fork',
              section: sectionCurrent,
              label: t('palette.actions.fork'),
              icon: <IconFork size={14} />,
              run: () => {
                void fork(current.id);
                onClose();
              },
            },
            {
              id: 'current-export-md',
              section: sectionCurrent,
              label: t('palette.actions.exportMarkdown'),
              icon: <IconDownload size={14} />,
              run: () => {
                void exportConversation(current.id, 'markdown');
                onClose();
              },
            },
            {
              id: 'current-export-json',
              section: sectionCurrent,
              label: t('palette.actions.exportJson'),
              icon: <IconDownload size={14} />,
              run: () => {
                void exportConversation(current.id, 'json');
                onClose();
              },
            },
            {
              id: 'current-copy',
              section: sectionCurrent,
              label: t('palette.actions.copyMarkdown'),
              icon: <IconCopy size={14} />,
              run: () => {
                void copyAsMarkdown(current.id);
                onClose();
              },
            },
            {
              id: 'current-archive',
              section: sectionCurrent,
              label: t('palette.actions.archive'),
              icon: <IconArchive size={14} />,
              run: () => {
                void archive(current.id, true);
                onClose();
              },
            },
          ] as Entry[]
        ).filter((entry) => matchesText(entry.label))
      : [];

    const conversationEntries: Entry[] = conversations
      .filter((conversation) => matchesText(`${conversation.title} ${conversation.lastMessagePreview ?? ''}`))
      .slice(0, 10)
      .map((conversation) => ({
        id: `conv-${conversation.id}`,
        section: t('palette.sections.conversations'),
        label: conversation.title,
        hint: conversation.workspacePath ? truncateMiddle(conversation.workspacePath, 32) : undefined,
        icon: <IconSpark size={14} />,
        run: () => {
          void setActive(conversation.id);
          onClose();
        },
      }));

    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    const messageEntries: Entry[] = matches.map((match) => ({
      id: `msg-${match.itemId}`,
      section: t('palette.sections.messages'),
      label: match.snippet,
      hint: byId.get(match.conversationId)?.title,
      icon: <IconSearch size={14} />,
      run: () => {
        void setActive(match.conversationId);
        onClose();
      },
    }));

    const modelEntries: Entry[] =
      needle === ''
        ? []
        : Object.values(pages)
            .flatMap((page) => page.models)
            .filter((model) => matchesText(`${model.displayName} ${model.id}`))
            .slice(0, 8)
            .map((model) => ({
              id: `model-${model.providerId}-${model.id}`,
              section: t('palette.sections.models'),
              label: model.displayName,
              hint: model.id,
              icon: <IconList size={14} />,
              run: () => {
                if (activeId) {
                  void setParameters(activeId, {
                    modelId: model.id,
                    providerId: model.providerId,
                    engineId: model.providerId === 'codex' ? 'codex' : 'direct',
                  });
                }
                onClose();
              },
            }));

    const workspaceEntries: Entry[] = workspaces
      .filter((workspace) => matchesText(`${workspace.name} ${workspace.path}`))
      .slice(0, 6)
      .map((workspace) => ({
        id: `ws-${workspace.id}`,
        section: t('palette.sections.workspaces'),
        label: workspace.name,
        hint: workspace.path,
        icon: <IconFolder size={14} />,
        run: () => {
          if (activeId) {
            void (async () => {
              await invoke('conversations:setWorkspace', {
                conversationId: activeId,
                workspacePath: workspace.path,
              });
              await useConversationStore.getState().refresh(true);
            })();
          }
          onClose();
        },
      }));

    // Com uma busca ativa, os resultados de conteúdo vêm antes das ações.
    return needle === ''
      ? [...actions, ...currentActions, ...conversationEntries, ...workspaceEntries]
      : [...conversationEntries, ...messageEntries, ...actions, ...currentActions, ...modelEntries, ...workspaceEntries];
  }, [
    query,
    matches,
    conversations,
    workspaces,
    pages,
    activeId,
    current,
    runtime?.status,
    settings.theme,
    layout,
    onClose,
    onNewConversation,
    openDialog,
    setActive,
    setParameters,
    setMode,
    interrupt,
    setFavorite,
    archive,
    fork,
    exportConversation,
    copyAsMarkdown,
    applySettings,
    setLayout,
  ]);

  useEffect(() => {
    if (index >= entries.length) setIndex(Math.max(0, entries.length - 1));
  }, [entries.length, index]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  let lastSection = '';

  return (
    <Dialog open={open} onClose={onClose} title={t('palette.title')} width={640}>
      <Input
        autoFocus
        data-autofocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((value) => Math.min(entries.length - 1, value + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((value) => Math.max(0, value - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            entries[index]?.run();
          }
        }}
        placeholder={t('palette.placeholder')}
        aria-label={t('palette.placeholder')}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={entries[index] ? `palette-option-${index}` : undefined}
      />

      <ul
        id="palette-list"
        ref={listRef}
        role="listbox"
        aria-label={t('palette.title')}
        className="mt-2 max-h-[380px] overflow-y-auto"
      >
        {entries.length === 0 && !searching ? (
          <li className="px-2 py-6 text-center text-[12.5px] text-[var(--text-muted)]">{t('palette.empty')}</li>
        ) : null}
        {entries.map((entry, entryIndex) => {
          const showSection = entry.section !== lastSection;
          lastSection = entry.section;
          return (
            <li key={entry.id}>
              {showSection ? (
                <p className="px-2 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
                  {entry.section}
                </p>
              ) : null}
              <button
                type="button"
                id={`palette-option-${entryIndex}`}
                role="option"
                data-index={entryIndex}
                aria-selected={entryIndex === index}
                onMouseEnter={() => setIndex(entryIndex)}
                onClick={() => entry.run()}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left transition-colors',
                  entryIndex === index ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-2)]',
                )}
              >
                <span className="flex-none text-[var(--text-faint)]">{entry.icon}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">{entry.label}</span>
                {entry.hint ? (
                  <span className="max-w-[200px] flex-none truncate text-[11px] text-[var(--text-faint)]">
                    {entry.hint}
                  </span>
                ) : null}
                {entry.shortcut ? (
                  <span className="flex flex-none items-center gap-0.5">
                    {entry.shortcut.split('+').map((key, keyIndex) => (
                      <Kbd key={`${entry.id}-${keyIndex}`}>{key}</Kbd>
                    ))}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {searching ? (
          <li className="flex items-center gap-2 px-2 py-2 text-[12px] text-[var(--text-faint)]">
            <Spinner size={11} /> {t('palette.searching')}
          </li>
        ) : null}
      </ul>

      <p className="mt-2 text-[11px] text-[var(--text-faint)]">{t('palette.hint')}</p>
    </Dialog>
  );
}
