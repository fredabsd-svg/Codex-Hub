/**
 * Lista de mensagens com streaming.
 *
 * Autoscroll acompanha o streaming somente se a pessoa estiver próxima do
 * final; caso contrário aparece "Ir para a resposta".
 */

import { useMemo } from 'react';
import type { ConversationItem, ConversationSummary } from '@shared/domain';
import { t } from '../../i18n';
import { useStickyScroll } from '../../hooks/useStickyScroll';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { Badge, Button, EmptyState, Spinner } from '../../components/ui/primitives';
import { IconArrowDown, IconSpark } from '../../components/ui/icons';
import { MessageItem } from './MessageItem';
import { ApprovalQueue } from '../approvals/ApprovalQueue';

const EMPTY_ITEMS: ConversationItem[] = [];

export function MessageList({ conversation }: { conversation: ConversationSummary | null }) {
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));
  const runtime = useConversationStore((state) => (conversation ? state.runtime[conversation.id] : undefined));
  const loading = useConversationStore((state) => state.loadingItems);
  const fork = useConversationStore((state) => state.fork);
  const developerMode = useAppStore((state) => state.settings.developerMode);

  const approvals = useConversationStore((state) => state.approvals);

  const list = useMemo(() => items ?? EMPTY_ITEMS, [items]);
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

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          icon={<IconSpark size={24} />}
          title={t('chat.emptyTitle')}
          body={t('chat.emptyBody')}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" tabIndex={0} aria-label="Conversa">
        <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4">
          {loading && list.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-[var(--text-muted)]">
              <Spinner /> {t('common.loading')}
            </div>
          ) : null}

          {!loading && list.length === 0 ? (
            <EmptyState icon={<IconSpark size={24} />} title={t('chat.emptyTitle')} body={t('chat.emptyBody')} />
          ) : null}

          {conversation.forkedFromId ? (
            <div className="flex justify-center">
              <Badge tone="info">
                Esta conversa é uma ramificação. A original continua intacta na barra lateral.
              </Badge>
            </div>
          ) : null}

          {list.map((item) => (
            <MessageItem
              key={item.id}
              item={item}
              developerMode={developerMode}
              onFork={(itemId) => void fork(conversation.id, itemId)}
            />
          ))}

          <ApprovalQueue conversationId={conversation.id} />

          {runtime?.status === 'running' && !list.some((item) => item.status === 'streaming') ? (
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
              <Spinner size={12} /> {t('chat.streaming')}
            </div>
          ) : null}

          {runtime?.status === 'interrupting' ? (
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--warning)]">
              <Spinner size={12} /> Interrompendo…
            </div>
          ) : null}

          {runtime?.status === 'cancelled' ? (
            <p className="text-[12.5px] text-[var(--text-muted)]">{t('chat.cancelled')}</p>
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
