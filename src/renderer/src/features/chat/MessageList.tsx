/**
 * Lista de mensagens com streaming.
 *
 * Autoscroll acompanha o streaming somente se a pessoa estiver próxima do
 * final; caso contrário aparece "Ir para a resposta".
 *
 * Sem conversa selecionada, a área mostra a tela inicial com as ações
 * principais. Uma conversa vazia oferece sugestões que preenchem o composer.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { ConversationItem, ConversationSummary } from '@shared/domain';
import { t } from '../../i18n';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { Badge, Button, EmptyState, Spinner } from '../../components/ui/primitives';
import { IconArrowDown, IconSpark } from '../../components/ui/icons';
import { MessageItem, useVisibleItems } from './MessageItem';
import { ApprovalQueue } from '../approvals/ApprovalQueue';
import { HomeScreen, TaskCards } from './HomeScreen';

const EMPTY_ITEMS: ConversationItem[] = [];

export function MessageList({
  conversation,
  onNewConversation,
  onFocusComposer,
}: {
  conversation: ConversationSummary | null;
  onNewConversation?(prompt?: string, workspacePath?: string): void;
  onFocusComposer?(): void;
}) {
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));
  const runtime = useConversationStore((state) =>
    conversation ? state.runtime[conversation.id] : undefined,
  );
  const loading = useConversationStore((state) => state.loadingItems);
  const fork = useConversationStore((state) => state.fork);
  const setDraftText = useConversationStore((state) => state.setDraftText);
  const developerMode = useAppStore((state) => state.settings.developerMode);
  const showReasoning = useAppStore((state) => state.settings.showReasoningSummaries);
  const history = useConversationStore((state) =>
    conversation ? state.history[conversation.id] : undefined,
  );
  const loadHistory = useConversationStore((state) => state.loadHistory);
  const focusedItem = useConversationStore((state) => state.focusedItem);
  const restoreScroll = useRef<{ top: number; height: number } | null>(null);
  const pages = useCatalogStore((state) => state.pages);

  const approvals = useConversationStore((state) => state.approvals);

  const list = useVisibleItems(
    useMemo(() => items ?? EMPTY_ITEMS, [items]),
    showReasoning,
    focusedItem?.conversationId === conversation?.id ? focusedItem?.itemId : undefined,
  );
  const modelLabel = useMemo(() => {
    if (!conversation) return undefined;
    return pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId)?.displayName;
  }, [conversation, pages]);

  const pendingApprovals = useMemo(
    () =>
      conversation ? approvals.filter((request) => request.conversationId === conversation.id).length : 0,
    [approvals, conversation],
  );
  // A fila de aprovação entra na assinatura: uma solicitação nova precisa
  // rolar até ficar visível junto com os botões de decisão.
  const signature = useMemo(
    () =>
      `${list.length}:${list[list.length - 1]?.text?.length ?? 0}:${runtime?.status ?? ''}:${pendingApprovals}`,
    [list, runtime?.status, pendingApprovals],
  );
  const { containerRef, atBottom, scrollToBottom } = useStickyScroll(signature, conversation?.id);

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

  useLayoutEffect(() => {
    const element = containerRef.current;
    const saved = restoreScroll.current;
    if (element && saved && !history?.loading) {
      element.scrollTop = saved.top + element.scrollHeight - saved.height;
      restoreScroll.current = null;
    }
  }, [items, history?.loading, containerRef]);

  useEffect(() => {
    if (!focusedItem || focusedItem.conversationId !== conversationId) return;
    const element = document.getElementById(`conversation-item-${focusedItem.itemId}`);
    element?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    element?.focus({ preventScroll: true });
  }, [focusedItem, conversationId]);

  if (!conversation)
    return <HomeScreen onNewConversation={(prompt, path) => onNewConversation?.(prompt, path)} />;

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
          {history?.hasMore ? (
            <div className="ch-history-control">
              <Button
                size="sm"
                variant="secondary"
                disabled={history.loading}
                onClick={() => {
                  const element = containerRef.current;
                  if (element)
                    restoreScroll.current = { top: element.scrollTop, height: element.scrollHeight };
                  void loadHistory(conversation.id, true);
                }}
              >
                {history.loading ? <Spinner size={12} /> : null} {t('workspaceExperience.olderMessages')}
              </Button>
              <p>{t('workspaceExperience.historyPartial')}</p>
            </div>
          ) : null}

          {loading && list.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-muted)]">
              <Spinner /> {t('common.loading')}
            </div>
          ) : null}

          {!loading && list.length === 0 ? (
            <div className="flex flex-col items-center">
              <EmptyState
                icon={<IconSpark size={24} />}
                title={t('chat.emptyTitle')}
                body={t('chat.emptyBody')}
              />
              <div className="w-full mb-6">
                <TaskCards
                  onChoose={(prompt) => {
                    setDraftText(conversation.id, prompt);
                    onFocusComposer?.();
                  }}
                />
              </div>
            </div>
          ) : null}

          {conversation.forkedFromId ? (
            <div className="flex justify-center">
              <Badge tone="info">{t('chat.forkNotice')}</Badge>
            </div>
          ) : null}

          {list.map((item) => (
            <div
              key={item.id}
              id={`conversation-item-${item.id}`}
              tabIndex={-1}
              className={focusedItem?.itemId === item.id ? 'ch-found-message' : undefined}
            >
              <MessageItem
                item={item}
                developerMode={developerMode}
                modelLabel={item.modelId === conversation.modelId ? modelLabel : undefined}
                onFork={handleFork}
                onEdit={handleEdit}
              />
            </div>
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
