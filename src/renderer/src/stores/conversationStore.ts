/**
 * Estado de conversas, itens e streaming.
 *
 * Desempenho: deltas de texto e de saída são acumulados e aplicados por frame
 * (`requestAnimationFrame`), atualizando apenas os itens afetados. O conteúdo
 * final chega em `item/completed` e é aplicado ANTES de marcar a conclusão.
 *
 * Nenhum delta é perdido ao trocar de conversa: o buffer é indexado por item e
 * o `flush` é global, independente da conversa visível.
 */

import { create } from 'zustand';
import type {
  ApprovalDecision,
  ApprovalRequest,
  AttachmentRef,
  ConversationItem,
  ConversationStatus,
  ConversationSummary,
  EffectivePolicy,
  ErrorDetail,
  FileDiff,
  OperationMode,
  TurnParameters,
} from '@shared/domain';
import type { DomainEvent } from '@shared/events';
import type { ConversationExportFormat, CreateConversationInput, SendTurnInput } from '@shared/ipc';
import { renderConversationMarkdown } from '@shared/conversationExport';
import { t } from '../i18n';
import { errorOf, invoke } from '../lib/api';
import { useUiStore } from './uiStore';

export interface ConversationRuntime {
  status: ConversationStatus;
  statusDetail?: string;
  policy?: EffectivePolicy;
  diffs: FileDiff[];
  lastError?: ErrorDetail;
  activeTurnId?: string;
  /** `seq` mais alto já aplicado; usado para detectar lacunas. */
  lastSeq: number;
  gapDetected: boolean;
}

interface Draft {
  text: string;
  attachments: AttachmentRef[];
}

interface HistoryPage {
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
}

const HISTORY_PAGE_SIZE = 500;
const EMPTY_HISTORY: HistoryPage = { loaded: false, loading: false, hasMore: false };

interface ConversationState {
  conversations: ConversationSummary[];
  activeId: string | null;
  items: Record<string, ConversationItem[]>;
  runtime: Record<string, ConversationRuntime>;
  drafts: Record<string, Draft>;
  approvals: ApprovalRequest[];
  loadingItems: boolean;
  history: Record<string, HistoryPage>;
  sending: Record<string, boolean>;
  focusedItem: { conversationId: string; itemId: string; version: number } | null;

  refresh(includeArchived?: boolean): Promise<void>;
  setActive(conversationId: string | null): Promise<void>;
  loadHistory(conversationId: string, older?: boolean): Promise<void>;
  revealItem(conversationId: string, itemId: string): Promise<void>;
  create(input: CreateConversationInput): Promise<ConversationSummary | null>;
  rename(conversationId: string, title: string): Promise<void>;
  archive(conversationId: string, archived: boolean): Promise<void>;
  remove(conversationId: string): Promise<void>;
  setFavorite(conversationId: string, favorite: boolean): Promise<void>;
  fork(
    conversationId: string,
    fromItemId?: string,
    options?: { exclusive?: boolean; silent?: boolean },
  ): Promise<ConversationSummary | null>;
  /** Exporta a conversa para um arquivo escolhido pela pessoa. */
  exportConversation(conversationId: string, format: ConversationExportFormat): Promise<void>;
  /** Copia a conversa inteira como Markdown para a área de transferência. */
  copyAsMarkdown(conversationId: string): Promise<void>;
  setParameters(conversationId: string, parameters: Partial<TurnParameters>): Promise<void>;
  setMode(conversationId: string, mode: OperationMode): Promise<void>;

  setDraftText(conversationId: string, text: string): void;
  setDraftAttachments(conversationId: string, attachments: AttachmentRef[]): void;
  persistDraft(conversationId: string): Promise<void>;
  addAttachments(conversationId: string, refs: AttachmentRef[]): void;
  removeAttachment(conversationId: string, attachmentId: string): Promise<void>;

  send(input: SendTurnInput): Promise<boolean>;
  interrupt(conversationId: string): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  refreshApprovals(): Promise<void>;
  loadPolicy(conversationId: string): Promise<void>;

  applyEvent(event: DomainEvent): void;
  runtimeOf(conversationId: string | null): ConversationRuntime;
}

const EMPTY_RUNTIME: ConversationRuntime = {
  status: 'idle',
  diffs: [],
  lastSeq: 0,
  gapDetected: false,
};

/* ------------------------------------------------------------------ *
 * Agrupamento de deltas por frame
 * ------------------------------------------------------------------ */

interface PendingDelta {
  conversationId: string;
  text: string;
  output: string;
}

const pending = new Map<string, PendingDelta>();
let frame: number | null = null;

function scheduleFlush(apply: () => void): void {
  if (frame !== null) return;
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => setTimeout(cb, 16);
  frame = schedule(() => {
    frame = null;
    apply();
  }) as unknown as number;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  const historyRequests = new Map<string, Promise<void>>();
  const flushDeltas = (): void => {
    if (pending.size === 0) return;
    const batch = new Map(pending);
    pending.clear();
    set((state) => {
      const items = { ...state.items };
      for (const [itemId, delta] of batch) {
        const list = items[delta.conversationId];
        if (!list) continue;
        const index = list.findIndex((item) => item.id === itemId);
        if (index < 0) continue;
        const current = list[index] as ConversationItem;
        const next: ConversationItem = {
          ...current,
          status: current.status === 'completed' ? current.status : 'streaming',
          text: delta.text === '' ? current.text : `${current.text ?? ''}${delta.text}`,
        };
        if (delta.output !== '' && current.command) {
          const combined = `${current.command.output}${delta.output}`;
          const retained = combined.length > 120_000 ? combined.slice(combined.length - 120_000) : combined;
          next.command = {
            ...current.command,
            output: retained,
            outputTruncated: current.command.outputTruncated || retained.length < combined.length,
            totalOutputBytes: current.command.totalOutputBytes + delta.output.length,
          };
        }
        const copy = [...list];
        copy[index] = next;
        items[delta.conversationId] = copy;
      }
      return { items };
    });
  };

  const queueDelta = (conversationId: string, itemId: string, text: string, output = ''): void => {
    const current = pending.get(itemId) ?? { conversationId, text: '', output: '' };
    current.text += text;
    current.output += output;
    pending.set(itemId, current);
    scheduleFlush(flushDeltas);
  };

  const patchRuntime = (conversationId: string, patch: Partial<ConversationRuntime>): void => {
    set((state) => ({
      runtime: {
        ...state.runtime,
        [conversationId]: { ...(state.runtime[conversationId] ?? EMPTY_RUNTIME), ...patch },
      },
    }));
  };

  const upsertItem = (conversationId: string, item: ConversationItem): void => {
    flushDeltas();
    set((state) => {
      const list = state.items[conversationId] ?? [];
      const index = list.findIndex((existing) => existing.id === item.id);
      const copy = [...list];
      if (index >= 0) copy[index] = { ...copy[index], ...item };
      else copy.push(item);
      return { items: { ...state.items, [conversationId]: copy } };
    });
  };

  return {
    conversations: [],
    activeId: null,
    items: {},
    runtime: {},
    drafts: {},
    approvals: [],
    loadingItems: false,
    history: {},
    sending: {},
    focusedItem: null,

    async refresh(includeArchived = true) {
      try {
        const conversations = await invoke('conversations:list', { includeArchived });
        set({ conversations });
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível listar as conversas');
      }
    },

    async setActive(conversationId) {
      set({
        activeId: conversationId,
        focusedItem: null,
        loadingItems: !!(conversationId && get().history[conversationId]?.loading),
      });
      if (!conversationId) return;
      const history =
        get().items[conversationId] === undefined || !get().history[conversationId]?.loaded
          ? get().loadHistory(conversationId)
          : Promise.resolve();
      if (get().drafts[conversationId] === undefined) {
        try {
          const draft = await invoke('conversations:readDraft', { conversationId });
          set((state) =>
            state.drafts[conversationId] || !state.conversations.some((c) => c.id === conversationId)
              ? state
              : { drafts: { ...state.drafts, [conversationId]: draft } },
          );
        } catch {
          // Um rascunho que já começou a ser editado tem prioridade.
        }
      }
      await history;
      await get().loadPolicy(conversationId);
    },

    async loadHistory(conversationId, older = false) {
      const pendingRequest = historyRequests.get(conversationId);
      if (pendingRequest) return pendingRequest;
      const page = get().history[conversationId] ?? EMPTY_HISTORY;
      const firstSeq = get().items[conversationId]?.find((item) => item.seq !== undefined)?.seq;
      if (older && (!page.hasMore || firstSeq === undefined)) return;
      set((state) => ({
        history: { ...state.history, [conversationId]: { ...page, loading: true } },
        loadingItems: state.activeId === conversationId ? true : state.loadingItems,
      }));
      const request = (async () => {
        try {
          const fetched = await invoke('conversations:items', {
            conversationId,
            limit: HISTORY_PAGE_SIZE,
            ...(older ? { beforeSeq: firstSeq } : {}),
          });
          flushDeltas();
          set((state) => {
            if (!state.conversations.some((c) => c.id === conversationId)) return state;
            // Eventos recebidos durante a leitura são mais recentes que o snapshot.
            const merged = [
              ...new Map(
                [...fetched, ...(state.items[conversationId] ?? [])].map((item) => [item.id, item]),
              ).values(),
            ];
            merged.sort((a, b) =>
              a.seq !== undefined && b.seq !== undefined
                ? a.seq - b.seq
                : a.createdAt.localeCompare(b.createdAt),
            );
            return {
              items: { ...state.items, [conversationId]: merged },
              history: {
                ...state.history,
                [conversationId]: {
                  loaded: true,
                  loading: false,
                  hasMore: fetched.length === HISTORY_PAGE_SIZE && (fetched[0]?.seq ?? 0) > 1,
                },
              },
            };
          });
        } catch (err) {
          useUiStore.getState().pushError(errorOf(err), 'Não foi possível carregar o histórico');
        } finally {
          historyRequests.delete(conversationId);
          set((state) => ({
            history: state.history[conversationId]
              ? { ...state.history, [conversationId]: { ...state.history[conversationId]!, loading: false } }
              : state.history,
            loadingItems: state.activeId === conversationId ? false : state.loadingItems,
          }));
        }
      })();
      historyRequests.set(conversationId, request);
      return request;
    },

    async revealItem(conversationId, itemId) {
      await get().setActive(conversationId);
      while (
        get().activeId === conversationId &&
        !get().items[conversationId]?.some((item) => item.id === itemId) &&
        get().history[conversationId]?.hasMore
      ) {
        const count = get().items[conversationId]?.length ?? 0;
        await get().loadHistory(conversationId, true);
        if ((get().items[conversationId]?.length ?? 0) <= count) break;
      }
      if (
        get().activeId === conversationId &&
        get().items[conversationId]?.some((item) => item.id === itemId)
      ) {
        set((state) => ({
          focusedItem: { conversationId, itemId, version: (state.focusedItem?.version ?? 0) + 1 },
        }));
      }
    },

    async create(input) {
      try {
        const conversation = await invoke('conversations:create', input);
        set((state) => ({
          conversations: [conversation, ...state.conversations],
          items: { ...state.items, [conversation.id]: [] },
          drafts: { ...state.drafts, [conversation.id]: { text: '', attachments: [] } },
          history: { ...state.history, [conversation.id]: { loaded: true, loading: false, hasMore: false } },
        }));
        await get().setActive(conversation.id);
        return conversation;
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível criar a conversa');
        return null;
      }
    },

    async rename(conversationId, title) {
      try {
        const updated = await invoke('conversations:rename', { conversationId, title });
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
        }));
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível renomear');
      }
    },

    async archive(conversationId, archived) {
      try {
        const updated = await invoke(archived ? 'conversations:archive' : 'conversations:unarchive', {
          conversationId,
        });
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
        }));
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível arquivar');
      }
    },

    async remove(conversationId) {
      try {
        await invoke('conversations:delete', { conversationId });
        set((state) => {
          const items = { ...state.items };
          const drafts = { ...state.drafts };
          const runtime = { ...state.runtime };
          const history = { ...state.history };
          delete items[conversationId];
          delete drafts[conversationId];
          delete runtime[conversationId];
          delete history[conversationId];
          return {
            conversations: state.conversations.filter((c) => c.id !== conversationId),
            items,
            drafts,
            runtime,
            history,
            activeId: state.activeId === conversationId ? null : state.activeId,
          };
        });
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível excluir');
      }
    },

    async setFavorite(conversationId, favorite) {
      try {
        const updated = await invoke('conversations:setFavorite', { conversationId, favorite });
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
        }));
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err));
      }
    },

    async fork(conversationId, fromItemId, options) {
      try {
        const created = await invoke('conversations:fork', {
          conversationId,
          fromItemId,
          exclusive: options?.exclusive,
        });
        set((state) => ({ conversations: [created, ...state.conversations] }));
        await get().setActive(created.id);
        if (!options?.silent) {
          useUiStore.getState().pushToast({
            tone: 'info',
            title: 'Ramificação criada',
            body: 'A conversa original permanece intacta. O histórico foi copiado para a nova ramificação.',
          });
        }
        return created;
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível ramificar');
        return null;
      }
    },

    async exportConversation(conversationId, format) {
      try {
        const result = await invoke('conversations:export', { conversationId, format });
        if (result.path) {
          useUiStore.getState().pushToast({
            tone: 'success',
            title: t('chat.exported'),
            body: t('chat.exportedBody', { path: result.path }),
          });
        }
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível exportar a conversa');
      }
    },

    async copyAsMarkdown(conversationId) {
      const conversation = get().conversations.find((c) => c.id === conversationId);
      if (!conversation) return;
      try {
        const items =
          get().items[conversationId] ?? (await invoke('conversations:items', { conversationId }));
        const text = renderConversationMarkdown({ conversation, items });
        await invoke('clipboard:writeText', { text });
        useUiStore.getState().pushToast({ tone: 'success', title: t('chat.copiedConversation') });
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível copiar a conversa');
      }
    },

    async setParameters(conversationId, parameters) {
      try {
        const updated = await invoke('conversations:setParameters', { conversationId, parameters });
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
        }));
        await get().loadPolicy(conversationId);
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível alterar os parâmetros');
      }
    },

    async setMode(conversationId, mode) {
      try {
        const updated = await invoke('conversations:setMode', { conversationId, mode });
        set((state) => ({
          conversations: state.conversations.map((c) => (c.id === conversationId ? updated : c)),
        }));
        await get().loadPolicy(conversationId);
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível mudar o modo');
      }
    },

    setDraftText(conversationId, text) {
      set((state) => ({
        drafts: {
          ...state.drafts,
          [conversationId]: { text, attachments: state.drafts[conversationId]?.attachments ?? [] },
        },
      }));
    },

    setDraftAttachments(conversationId, attachments) {
      set((state) => ({
        drafts: {
          ...state.drafts,
          [conversationId]: { text: state.drafts[conversationId]?.text ?? '', attachments },
        },
      }));
    },

    async persistDraft(conversationId) {
      const draft = get().drafts[conversationId];
      if (!draft) return;
      try {
        await invoke('conversations:saveDraft', {
          conversationId,
          text: draft.text,
          attachmentIds: draft.attachments.map((a) => a.id),
        });
      } catch {
        // Rascunho é conveniência: falha não interrompe o trabalho.
      }
    },

    addAttachments(conversationId, refs) {
      set((state) => {
        const draft = state.drafts[conversationId] ?? { text: '', attachments: [] };
        return {
          drafts: {
            ...state.drafts,
            [conversationId]: { ...draft, attachments: [...draft.attachments, ...refs] },
          },
        };
      });
      const failed = refs.filter((ref) => ref.error);
      for (const ref of failed) {
        useUiStore.getState().pushToast({
          tone: 'warning',
          title: `Anexo não preparado: ${ref.fileName}`,
          body: ref.error,
        });
      }
    },

    async removeAttachment(conversationId, attachmentId) {
      set((state) => {
        const draft = state.drafts[conversationId];
        if (!draft) return state;
        return {
          drafts: {
            ...state.drafts,
            [conversationId]: {
              ...draft,
              attachments: draft.attachments.filter((a) => a.id !== attachmentId),
            },
          },
        };
      });
      await invoke('attachments:discard', { conversationId, attachmentId }).catch(() => undefined);
    },

    async send(input) {
      const id = input.conversationId;
      if (get().sending[id]) return false;
      const previous = get().runtime[id] ?? EMPTY_RUNTIME;
      set((state) => ({ sending: { ...state.sending, [id]: true } }));
      if (!input.asSteer) patchRuntime(id, { status: 'connecting', lastError: undefined });
      try {
        const result = await invoke('turn:send', input);
        set((state) => {
          const draft = state.drafts[id];
          if (!draft) return state;
          const sentIds = new Set(input.asSteer ? [] : (input.attachmentIds ?? []));
          return {
            drafts: {
              ...state.drafts,
              [id]: {
                text: draft.text === input.text ? '' : draft.text,
                attachments: draft.attachments.filter((attachment) => !sentIds.has(attachment.id)),
              },
            },
          };
        });
        // Uma resposta rápida pode já ter concluído antes do ACK do IPC.
        if ((get().runtime[id]?.lastSeq ?? 0) === previous.lastSeq) {
          patchRuntime(id, { status: 'running', activeTurnId: result.turnId, lastError: undefined });
        }
        // O main limpa o rascunho aceito. Regrava uma próxima mensagem que
        // tenha sido digitada durante a conexão, para preservar também no disco.
        await get().persistDraft(id);
        return true;
      } catch (err) {
        const detail = errorOf(err);
        const unchanged = (get().runtime[id]?.lastSeq ?? 0) === previous.lastSeq;
        patchRuntime(id, { ...(unchanged ? { status: previous.status } : {}), lastError: detail });
        useUiStore.getState().pushError(detail, 'A mensagem não foi enviada');
        return false;
      } finally {
        set((state) => ({ sending: { ...state.sending, [id]: false } }));
      }
    },

    async interrupt(conversationId) {
      const current = get().runtime[conversationId];
      const wasActive = current?.status === 'running' || current?.status === 'awaitingApproval';
      // Retorno visual imediato: o processo principal confirma (ou corrige) por evento.
      if (wasActive) patchRuntime(conversationId, { status: 'interrupting' });
      try {
        await invoke('turn:interrupt', { conversationId });
      } catch (err) {
        if (wasActive) patchRuntime(conversationId, { status: current.status });
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível interromper');
      }
    },

    async resolveApproval(approvalId, decision) {
      try {
        await invoke('approvals:resolve', { approvalId, decision });
        set((state) => ({ approvals: state.approvals.filter((a) => a.id !== approvalId) }));
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível registrar a decisão');
      }
    },

    async refreshApprovals() {
      try {
        set({ approvals: await invoke('approvals:pending') });
      } catch {
        // silencioso: a fila é reconstruída pelos eventos
      }
    },

    async loadPolicy(conversationId) {
      try {
        const policy = await invoke('turn:policy', { conversationId });
        patchRuntime(conversationId, { policy });
      } catch {
        patchRuntime(conversationId, { policy: undefined });
      }
    },

    applyEvent(event) {
      const conversationId = event.conversationId;
      const current = get().runtime[conversationId] ?? EMPTY_RUNTIME;
      // Eventos repetidos não podem duplicar texto nem reabrir um turno concluído.
      if (event.seq <= current.lastSeq) return;
      // Detecção de lacuna na sequência: informa em vez de esconder.
      const gapDetected = current.gapDetected || (current.lastSeq > 0 && event.seq > current.lastSeq + 1);
      if (event.seq > current.lastSeq) {
        patchRuntime(conversationId, { lastSeq: event.seq, gapDetected });
      }

      switch (event.type) {
        case 'conversation/status':
          patchRuntime(conversationId, { status: event.status, statusDetail: event.detail });
          break;
        case 'conversation/native':
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId ? { ...c, nativeThreadId: event.nativeThreadId } : c,
            ),
          }));
          break;
        case 'conversation/title':
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === conversationId ? { ...c, title: event.title, titleIsLocal: event.titleIsLocal } : c,
            ),
          }));
          break;
        case 'turn/started':
          patchRuntime(conversationId, {
            activeTurnId: event.turnId,
            status: 'running',
            lastError: undefined,
          });
          break;
        case 'turn/completed':
          flushDeltas();
          patchRuntime(conversationId, { activeTurnId: undefined, status: 'completed' });
          break;
        case 'turn/failed':
          flushDeltas();
          patchRuntime(conversationId, { activeTurnId: undefined, status: 'error', lastError: event.error });
          break;
        case 'turn/cancelled':
          flushDeltas();
          patchRuntime(conversationId, { activeTurnId: undefined, status: 'cancelled' });
          break;
        case 'item/started':
          upsertItem(conversationId, event.item);
          break;
        case 'item/textDelta':
        case 'item/reasoningDelta':
          queueDelta(conversationId, event.itemId, event.delta);
          break;
        case 'item/outputDelta':
          queueDelta(conversationId, event.itemId, '', event.chunk);
          break;
        case 'item/planUpdated':
          flushDeltas();
          set((state) => {
            const list = state.items[conversationId] ?? [];
            return {
              items: {
                ...state.items,
                [conversationId]: list.map((item) =>
                  item.id === event.itemId ? { ...item, plan: event.steps } : item,
                ),
              },
            };
          });
          break;
        case 'item/completed':
          // O conteúdo final é aplicado ANTES de marcar concluído.
          upsertItem(conversationId, event.item);
          break;
        case 'item/failed':
          flushDeltas();
          set((state) => {
            const list = state.items[conversationId] ?? [];
            return {
              items: {
                ...state.items,
                [conversationId]: list.map((item) =>
                  item.id === event.itemId ? { ...item, status: 'failed', errorDetail: event.error } : item,
                ),
              },
            };
          });
          break;
        case 'diff/updated':
          patchRuntime(conversationId, { diffs: event.files });
          if (event.files.length > 0 && get().activeId === conversationId) {
            // Alteração em arquivo é o resultado principal do modo Executar:
            // o painel abre na aba de diff em vez de só trocar a aba escondida.
            // Em janelas estreitas o layout continua recolhendo o painel.
            useUiStore.getState().setLayout({ rightPanelTab: 'diff', rightPanelCollapsed: false });
          }
          break;
        case 'approval/requested':
          set((state) => ({
            approvals: [...state.approvals.filter((a) => a.id !== event.request.id), event.request],
          }));
          patchRuntime(conversationId, { status: 'awaitingApproval' });
          break;
        case 'approval/resolved':
          set((state) => ({ approvals: state.approvals.filter((a) => a.id !== event.approvalId) }));
          break;
        case 'policy/effective':
          patchRuntime(conversationId, { policy: event.policy });
          break;
        case 'error':
          patchRuntime(conversationId, { lastError: event.error });
          useUiStore.getState().pushError(event.error);
          break;
        case 'usage/updated':
        default:
          break;
      }
    },

    runtimeOf(conversationId) {
      if (!conversationId) return EMPTY_RUNTIME;
      return get().runtime[conversationId] ?? EMPTY_RUNTIME;
    },
  };
});

export function activeConversation(): ConversationSummary | null {
  const { conversations, activeId } = useConversationStore.getState();
  return conversations.find((c) => c.id === activeId) ?? null;
}
