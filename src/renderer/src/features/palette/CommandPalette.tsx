/**
 * Paleta de comandos e pesquisa (Ctrl+K).
 *
 * Navegação completa por teclado: setas movem, Enter executa, Esc fecha.
 * A busca cobre ações, conversas, modelos e workspaces.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { truncateMiddle } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Input, Kbd } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { IconFolder, IconList, IconPlus, IconSettings, IconSkill, IconSpark } from '../../components/ui/icons';

interface Entry {
  id: string;
  section: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run(): void;
}

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
  const setParameters = useConversationStore((state) => state.setParameters);
  const workspaces = useAppStore((state) => state.workspaces);
  const openDialog = useUiStore((state) => state.openDialog);
  const pages = useCatalogStore((state) => state.pages);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (text: string): boolean => needle === '' || text.toLowerCase().includes(needle);

    const actions: Entry[] = [
      {
        id: 'action-new',
        section: t('palette.sections.actions'),
        label: `${t('sidebar.newConversation')} (Ctrl+N)`,
        icon: <IconPlus size={14} />,
        run: () => {
          onNewConversation();
          onClose();
        },
      },
      {
        id: 'action-workspace',
        section: t('palette.sections.actions'),
        label: t('header.chooseWorkspace'),
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
        section: t('palette.sections.actions'),
        label: t('catalog.title'),
        icon: <IconList size={14} />,
        run: () => {
          openDialog('catalog');
        },
      },
      {
        id: 'action-skills',
        section: t('palette.sections.actions'),
        label: t('skills.title'),
        icon: <IconSkill size={14} />,
        run: () => {
          openDialog('skills');
        },
      },
      {
        id: 'action-settings',
        section: t('palette.sections.actions'),
        label: `${t('settings.title')} (Ctrl+,)`,
        icon: <IconSettings size={14} />,
        run: () => {
          openDialog('settings');
        },
      },
    ].filter((entry) => matches(entry.label));

    const conversationEntries: Entry[] = conversations
      .filter((conversation) => matches(`${conversation.title} ${conversation.lastMessagePreview ?? ''}`))
      .slice(0, 12)
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

    const modelEntries: Entry[] =
      needle === ''
        ? []
        : Object.values(pages)
            .flatMap((page) => page.models)
            .filter((model) => matches(`${model.displayName} ${model.id}`))
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
      .filter((workspace) => matches(`${workspace.name} ${workspace.path}`))
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

    return [...actions, ...conversationEntries, ...modelEntries, ...workspaceEntries];
  }, [query, conversations, workspaces, pages, activeId, onClose, onNewConversation, openDialog, setActive, setParameters]);

  useEffect(() => {
    if (index >= entries.length) setIndex(Math.max(0, entries.length - 1));
  }, [entries.length, index]);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  let lastSection = '';

  return (
    <Dialog open={open} onClose={onClose} title={t('palette.title')} width={620}>
      <Input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((current) => Math.min(entries.length - 1, current + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((current) => Math.max(0, current - 1));
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

      <ul id="palette-list" ref={listRef} role="listbox" aria-label={t('palette.title')} className="mt-2 max-h-[340px] overflow-y-auto">
        {entries.length === 0 ? (
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
                  <span className="ch-mono max-w-[220px] flex-none truncate text-[11px] text-[var(--text-faint)]">
                    {entry.hint}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
        <Kbd>Enter</Kbd> seleciona · <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> navegam · <Kbd>Esc</Kbd> fecha
      </p>
    </Dialog>
  );
}
