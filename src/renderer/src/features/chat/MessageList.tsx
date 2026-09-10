/**
 * Lista de mensagens com streaming.
 *
 * Autoscroll acompanha o streaming somente se a pessoa estiver próxima do
 * final; caso contrário aparece "Ir para a resposta".
 *
 * Sem conversa selecionada, a área mostra a tela inicial com as ações
 * principais. Uma conversa vazia oferece sugestões que preenchem o composer.
 */

import { useCallback, useMemo } from 'react';
import type { ConversationItem, ConversationSummary } from '@shared/domain';
import { t, tList } from '../../i18n';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, EmptyState, Kbd, Spinner } from '../../components/ui/primitives';
import { IconArrowDown, IconFolder, IconList, IconPlus, IconSpark } from '../../components/ui/icons';
import { MessageItem, useVisibleItems } from './MessageItem';
import { ApprovalQueue } from '../approvals/ApprovalQueue';

const EMPTY_ITEMS: ConversationItem[] = [];

export function MessageList({
  conversation,
  onNewConversation,
  onFocusComposer,
}: {
  conversation: ConversationSummary | null;
  onNewConversation?(): void;
  onFocusComposer?(): void;
}) {
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));
  const runtime = useConversationStore((state) => (conversation ? state.runtime[conversation.id] : undefined));
  const loading = useConversationStore((state) => state.loadingItems);
  const fork = useConversationStore((state) => state.fork);
  const setDraftText = useConversationStore((state) => state.setDraftText);
  const developerMode = useAppStore((state) => state.settings.developerMode);
  const showReasoning = useAppStore((state) => state.settings.showReasoningSummaries);
  const openDialog = useUiStore((state) => state.openDialog);
  const pages = useCatalogStore((state) => state.pages);

  const approvals = useConversationStore((state) => state.approvals);

  const list = useVisibleItems(useMemo(() => items ?? EMPTY_ITEMS, [items]), showReasoning);
  const modelLabel = useMemo(() => {
    if (!conversation) return undefined;
    return pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId)?.displayName;
  }, [conversation, pages]);

  const pendingApprovals = useMemo(
    () => (conversation ? approvals.filter((request) => request.conversationId === conversation.id).length : 0),
    [approvals, conversation],
  );
  // A fila de aprovação entra na assinatura: uma solicitação nova precisa
  // rolar até ficar visível junto com os botões de decisão.
  const signature = useMemo(
    () => `${list.length}:${list[list.length - 1]?.text?.length ?? 0}:${runtime?.status ?? ''}:${pendingApprovals}`,
    [list, runtime?.status, pendingApprovals],
  );
  const { containerRef, atBottom, scrollToBottom } = useStickyScroll(signature);

  const conversationId = conversation?.id;
  const handleFork = useCallback(
    (itemId: string) => {
      if (conversationId) void fork(conversationId, itemId);
    },
    [conversationId, fork],
  );
  const handleEdit = useCallback(
    (item: ConversationItem) => {
      if (!conversationId) return;
      void (async () => {
        // Ramificação que termina antes da mensagem editada; o texto original
        // vai para o composer da nova conversa.
        const created = await fork(conversationId, item.id, { exclusive: true, silent: true });
        if (!created) return;
        setDraftText(created.id, item.text ?? '');
        onFocusComposer?.();
      })();
    },
    [conversationId, fork, setDraftText, onFocusComposer],
  );

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6">
        <div className="ch-anim-rise flex max-w-[520px] flex-col items-center text-center">
          <span className="ch-avatar mb-4" style={{ width: 44, height: 44, borderRadius: 14 }} aria-hidden="true">
            <IconSpark size={22} />
          </span>
          <h2 className="text-[18px] font-semibold text-[var(--text)]">{t('chat.homeTitle')}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('chat.homeBody')}</p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" iconLeft={<IconPlus />} onClick={onNewConversation}>
              {t('chat.homeNew')}
            </Button>
            <Button variant="secondary" iconLeft={<IconFolder />} onClick={() => openDialog('workspaces')}>
              {t('chat.homeWorkspace')}
            </Button>
            <Button variant="secondary" iconLeft={<IconList />} onClick={() => openDialog('catalog')}>
              {t('chat.homeCatalog')}
            </Button>
          </div>
          <p className="mt-6 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--text-faint)]">
            <span>
              <Kbd>Ctrl</Kbd>+<Kbd>N</Kbd> {t('shortcuts.newConversation').toLowerCase()}
            </span>
            <span>
              <Kbd>Ctrl</Kbd>+<Kbd>K</Kbd> {t('palette.title').toLowerCase()}
            </span>
            <span>
              <Kbd>Ctrl</Kbd>+<Kbd>,</Kbd> {t('settings.title').toLowerCase()}
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-y-auto px-5"
        style={{ paddingTop: 'var(--chat-pad-y)', paddingBottom: 'var(--chat-pad-y)' }}
        tabIndex={0}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('chat.logLabel')}
      >
        <div
          className="mx-auto flex w-full flex-col"
          style={{ maxWidth: 'var(--chat-max-width)', gap: 'var(--message-gap)' }}
        >
          {loading && list.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-muted)]">
              <Spinner /> {t('common.loading')}
            </div>
          ) : null}

          {!loading && list.length === 0 ? (
            <div className="flex flex-col items-center">
              <EmptyState icon={<IconSpark size={24} />} title={t('chat.emptyTitle')} body={t('chat.emptyBody')} />
              <div className="-mt-4 w-full max-w-[560px]">
                <p className="mb-2 text-center text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">
                  {t('chat.suggestionsTitle')}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {tList('chat.suggestions').map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="ch-chip"
                      onClick={() => {
                        setDraftText(conversation.id, suggestion);
                        onFocusComposer?.();
                      }}
                    >
                      <IconSpark size={12} className="flex-none text-[var(--accent)]" />
                      <span>{suggestion}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {conversation.forkedFromId ? (
            <div className="flex justify-center">
              <Badge tone="info">{t('chat.forkNotice')}</Badge>
            </div>
          ) : null}

          {list.map((item) => (
            <MessageItem
              key={item.id}
              item={item}
              developerMode={developerMode}
              modelLabel={item.modelId === conversation.modelId ? modelLabel : undefined}
              onFork={handleFork}
              onEdit={handleEdit}
            />
          ))}

          <ApprovalQueue conversationId={conversation.id} />

          {runtime?.status === 'running' && !list.some((item) => item.status === 'streaming') ? (
            <div className="ml-[34px] flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
              <Spinner size={12} /> {t('chat.streaming')}
            </div>
          ) : null}

          {runtime?.status === 'interrupting' ? (
            <div className="ml-[34px] flex items-center gap-2 text-[12.5px] text-[var(--warning)]">
              <Spinner size={12} /> {t('chat.interrupting')}
            </div>
          ) : null}

          {runtime?.status === 'cancelled' ? (
            <p className="ml-[34px] text-[12.5px] text-[var(--text-muted)]">{t('chat.cancelled')}</p>
          ) : null}

          <div className="h-2" />
        </div>
      </div>

      {!atBottom ? (
        <div className="pointer-events-none absolute bottom-3 left-0 right-0 flex justify-center">
          <div className="pointer-events-auto">
            <Button
              size="sm"
              variant="secondary"
              iconLeft={<IconArrowDown />}
              onClick={() => scrollToBottom()}
              className="shadow-[var(--shadow-popover)]"
            >
              {t('chat.goToAnswer')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
