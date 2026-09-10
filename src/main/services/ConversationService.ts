/**
 * Orquestração de conversas.
 *
 * Responsabilidades:
 *  - CRUD de conversas, itens e rascunhos;
 *  - despacho de turnos para o motor escolhido;
 *  - persistência do que realmente aconteceu e transmissão ao renderer;
 *  - impedir dois turnos concorrentes na mesma conversa;
 *  - deixar claro quando repetir/editar cria uma RAMIFICAÇÃO;
 *  - após reinício, recuperar histórico e marcar operações incompletas sem
 *    reexecutar nada.
 */

import { randomUUID } from 'node:crypto';
import type {
  ApprovalRequest,
  AttachmentRef,
  ConversationItem,
  ConversationStatus,
  ConversationSummary,
  EffectivePolicy,
  EngineId,
  ErrorDetail,
  FileDiff,
  OperationMode,
  PlanStep,
  SkillDescriptor,
  TokenUsage,
  TurnParameters,
} from '../../shared/domain';
import { appError, toErrorDetail } from '../../shared/errors';
import type { CreateConversationInput, ForkConversationInput, SearchConversationsResult, SendTurnInput } from '../../shared/ipc';
import type { Database } from '../persistence/database';
import { conversationToSummary, type ConversationRow } from '../persistence/repositories';
import type { ExecutionEngine, NewItem, StatusValue, TurnSink } from '../engines/types';
import type { EventBus } from './EventBus';
import { logger } from './logger';
import type { AttachmentService } from './AttachmentService';
import type { WorkspaceService } from './WorkspaceService';

export interface ConversationServiceDeps {
  db: Database;
  bus: EventBus;
  attachments: AttachmentService;
  workspaces: WorkspaceService;
  engineFor(engineId: EngineId): ExecutionEngine;
  skillsFor(engineId: EngineId, workspacePath?: string): Promise<SkillDescriptor[]>;
  onCatalogUse(providerId: string, modelId: string): void;
}

interface ActiveTurn {
  turnId: string;
  abort: AbortController;
  startedAt: number;
}

/** Saída de terminal retida por item, para não travar a interface. */
const MAX_RETAINED_OUTPUT = 200 * 1024;

export class ConversationService {
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly openedInEngine = new Set<string>();

  constructor(private readonly deps: ConversationServiceDeps) {}

  /* ------------------------------------------------------------------ *
   * Leitura
   * ------------------------------------------------------------------ */

  list(includeArchived = false): ConversationSummary[] {
    return this.deps.db.conversations.list(includeArchived);
  }

  read(conversationId: string): ConversationSummary | null {
    const row = this.deps.db.conversations.read(conversationId);
    return row ? conversationToSummary(row) : null;
  }

  readRow(conversationId: string): ConversationRow | null {
    return this.deps.db.conversations.read(conversationId);
  }

  items(conversationId: string, options: { limit?: number; beforeSeq?: number } = {}): ConversationItem[] {
    const rows = this.deps.db.items.list(conversationId, options);
    const last = rows[rows.length - 1];
    if (last) this.deps.bus.primeSeq(conversationId, last.seq);
    return rows;
  }

  search(query: string, limit = 50): SearchConversationsResult {
    const needle = query.trim().toLowerCase();
    const conversations = this.list(true).filter(
      (c) =>
        needle === '' ||
        c.title.toLowerCase().includes(needle) ||
        (c.lastMessagePreview ?? '').toLowerCase().includes(needle),
    );
    return {
      conversations: conversations.slice(0, limit),
      matches: needle === '' ? [] : this.deps.db.items.search(needle, limit),
    };
  }

  /* ------------------------------------------------------------------ *
   * Escrita
   * ------------------------------------------------------------------ */

  create(input: CreateConversationInput): ConversationSummary {
    const workspaceRow = input.workspacePath ? this.deps.workspaces.findByPath(input.workspacePath) : null;
    if (input.workspacePath && !workspaceRow) {
      // Registra implicitamente para que o guard tenha uma raiz conhecida.
      logger.info('conversations', 'Workspace não registrado; será registrado ao usar');
    }
    const parameters: TurnParameters = {
      modelId: input.modelId,
      providerId: input.providerId,
      engineId: input.engineId,
    };
    const row = this.deps.db.conversations.create({
      engineId: input.engineId,
      providerId: input.providerId,
      modelId: input.modelId,
      workspaceId: workspaceRow?.id,
      workspacePath: workspaceRow?.path ?? input.workspacePath,
      mode: input.mode,
      title: input.title,
      parameters,
    });
    this.notifyConversationsChanged();
    return conversationToSummary(row);
  }

  rename(conversationId: string, title: string): ConversationSummary {
    // Renomear é LOCAL: o schema atual não expõe um método de renomear thread.
    const row = this.deps.db.conversations.update(conversationId, { title, titleIsLocal: true });
    this.notifyConversationsChanged();
    return conversationToSummary(row);
  }

  setFavorite(conversationId: string, favorite: boolean): ConversationSummary {
    const row = this.deps.db.conversations.update(conversationId, { favorite });
    this.notifyConversationsChanged();
    return conversationToSummary(row);
  }

  async archive(conversationId: string, archived: boolean): Promise<ConversationSummary> {
    const row = this.requireRow(conversationId);
    if (archived && this.activeTurns.has(conversationId)) {
      await this.interrupt(conversationId);
    }
    let next = this.deps.db.conversations.update(conversationId, { archived });
    if (row.engineId === 'codex' && row.nativeThreadId) {
      try {
        const engine = this.deps.engineFor('codex');
        await engine.closeConversation(row);
      } catch (err) {
        logger.debug('conversations', 'Falha ao fechar thread no motor', toErrorDetail(err));
      }
    }
    this.openedInEngine.delete(conversationId);
    next = this.deps.db.conversations.read(conversationId) ?? next;
    this.notifyConversationsChanged();
    return conversationToSummary(next);
  }

  async delete(conversationId: string): Promise<boolean> {
    if (this.activeTurns.has(conversationId)) await this.interrupt(conversationId);
    const removed = this.deps.db.conversations.delete(conversationId);
    this.deps.bus.forget(conversationId);
    this.openedInEngine.delete(conversationId);
    if (removed) this.notifyConversationsChanged();
    return removed;
  }

  setParameters(conversationId: string, patch: Partial<TurnParameters>): ConversationSummary {
    const row = this.requireRow(conversationId);
    const parameters: TurnParameters = { ...row.parameters, ...patch };
    const next = this.deps.db.conversations.update(conversationId, {
      parameters,
      modelId: parameters.modelId,
      providerId: parameters.providerId,
      engineId: parameters.engineId,
    });
    // Trocar de provedor/motor pode exigir nova sessão no motor.
    if (patch.providerId !== undefined && patch.providerId !== row.providerId) {
      this.openedInEngine.delete(conversationId);
    }
    if (patch.engineId !== undefined && patch.engineId !== row.engineId) {
      this.openedInEngine.delete(conversationId);
    }
    this.notifyConversationsChanged();
    return conversationToSummary(next);
  }

  setMode(conversationId: string, mode: OperationMode): ConversationSummary {
    const next = this.deps.db.conversations.update(conversationId, { mode });
    this.notifyConversationsChanged();
    return conversationToSummary(next);
  }

  /**
   * Vincula (ou desvincula) o workspace da conversa.
   *
   * Um turno EM ANDAMENTO não é redirecionado: `send` tira um snapshot do
   * caminho no início do turno e é esse valor que o motor usa.
   */
  async setWorkspace(conversationId: string, workspacePath: string | null): Promise<ConversationSummary> {
    const row = this.requireRow(conversationId);
    if (workspacePath === null) {
      const cleared = this.deps.db.conversations.update(conversationId, {
        workspacePath: undefined,
        workspaceId: undefined,
        mode: row.mode === 'chat' ? row.mode : 'chat',
      });
      this.notifyConversationsChanged();
      return conversationToSummary(cleared);
    }
    const workspace = await this.deps.workspaces.register(workspacePath);
    const next = this.deps.db.conversations.update(conversationId, {
      workspacePath: workspace.path,
      workspaceId: workspace.id,
    });
    if (this.activeTurns.has(conversationId)) {
      this.deps.bus.emitApp({
        type: 'diagnostics/notice',
        level: 'info',
        message:
          'O workspace desta conversa foi alterado, mas o turno em andamento continua na pasta em que começou.',
        at: new Date().toISOString(),
      });
    }
    // A mudança de raiz autorizada invalida a sessão aberta no motor.
    this.openedInEngine.delete(conversationId);
    this.notifyConversationsChanged();
    return conversationToSummary(next);
  }

  /**
   * Ramifica uma conversa a partir de um item. Deixa explícito na conversa nova
   * que ela é uma ramificação — nada é apresentado como "migração sem perda".
   */
  async fork(input: ForkConversationInput): Promise<ConversationSummary> {
    const source = this.requireRow(input.conversationId);
    const items = this.deps.db.items.list(input.conversationId);
    const cutIndex = input.fromItemId ? items.findIndex((i) => i.id === input.fromItemId) : items.length - 1;
    const kept = cutIndex >= 0 ? items.slice(0, cutIndex + 1) : items;

    let nativeThreadId: string | undefined;
    if (source.engineId === 'codex' && source.nativeThreadId) {
      try {
        const engine = this.deps.engineFor('codex');
        const forked = await tryCodexFork(engine, source, input.fromItemId);
        nativeThreadId = forked;
      } catch (err) {
        logger.info('conversations', 'thread/fork indisponível; ramificação apenas local', toErrorDetail(err));
      }
    }

    const created = this.deps.db.conversations.create({
      engineId: source.engineId,
      providerId: source.providerId,
      modelId: source.modelId,
      workspaceId: source.workspaceId,
      workspacePath: source.workspacePath,
      mode: source.mode,
      title: input.title ?? `${source.title} (ramificação)`,
      parameters: source.parameters,
      forkedFromId: source.id,
      forkedFromItemId: input.fromItemId,
    });
    if (nativeThreadId) this.deps.db.conversations.update(created.id, { nativeThreadId });

    this.deps.db.store.transaction(() => {
      for (const item of kept) {
        this.deps.db.items.append({
          conversationId: created.id,
          turnId: item.turnId,
          role: item.role,
          kind: item.kind,
          status: item.status,
          text: item.text,
          attachments: item.attachments,
          plan: item.plan,
          command: item.command,
          tool: item.tool,
          fileChange: item.fileChange,
          modelId: item.modelId,
          providerId: item.providerId,
          engineId: item.engineId,
          usage: item.usage,
        });
      }
      this.deps.db.items.append({
        conversationId: created.id,
        role: 'system',
        kind: 'notice',
        status: 'completed',
        text: nativeThreadId
          ? `Ramificação criada a partir de "${source.title}". O Codex criou uma nova thread para esta ramificação; a conversa original continua intacta.`
          : `Ramificação criada a partir de "${source.title}". O histórico anterior foi copiado localmente; a conversa original continua intacta.`,
      });
    });

    this.notifyConversationsChanged();
    return conversationToSummary(this.deps.db.conversations.read(created.id) as ConversationRow);
  }

  /* ------------------------------------------------------------------ *
   * Rascunhos
   * ------------------------------------------------------------------ */

  saveDraft(conversationId: string, text: string, attachmentIds: string[]): void {
    const attachments = this.deps.attachments.byIds(conversationId, attachmentIds);
    this.deps.db.drafts.save(conversationId, text, attachments);
  }

  readDraft(conversationId: string): { text: string; attachments: AttachmentRef[] } {
    const draft = this.deps.db.drafts.read(conversationId);
    const attachments = this.deps.attachments.restore(conversationId, draft.attachments);
    return { text: draft.text, attachments };
  }

  /* ------------------------------------------------------------------ *
   * Turnos
   * ------------------------------------------------------------------ */

  isRunning(conversationId: string): boolean {
    return this.activeTurns.has(conversationId);
  }

  async policyFor(conversationId: string): Promise<EffectivePolicy> {
    const row = this.requireRow(conversationId);
    const engine = this.deps.engineFor(row.engineId);
    return engine.effectivePolicy(row, row.mode);
  }

  async send(input: SendTurnInput): Promise<{ turnId: string; accepted: true }> {
    const row = this.requireRow(input.conversationId);

    if (input.asSteer) {
      const steered = await this.steer(input.conversationId, input.text);
      if (steered) return { turnId: this.activeTurns.get(input.conversationId)?.turnId ?? 'steer', accepted: true };
      throw appError('validation', {
        message: 'Não há turno em andamento que aceite orientação nesta conversa.',
        action: 'Envie como nova mensagem.',
      });
    }

    if (this.activeTurns.has(input.conversationId)) {
      throw appError('validation', {
        message: 'Já existe um turno em andamento nesta conversa.',
        action: 'Aguarde a conclusão, interrompa com Esc ou envie como orientação ao turno atual.',
      });
    }

    const parameters: TurnParameters = { ...row.parameters, ...(input.parameters ?? {}) };
    if (!parameters.modelId) {
      throw appError('validation', {
        message: 'Nenhum modelo está selecionado para esta conversa.',
        action: 'Escolha um modelo no cabeçalho antes de enviar.',
      });
    }

    // Snapshot do workspace no INÍCIO do turno: trocar o workspace na interface
    // depois disso não redireciona este turno.
    const conversationSnapshot: ConversationRow = { ...row, parameters };
    const engine = this.deps.engineFor(parameters.engineId ?? row.engineId);
    await engine.ensureReady();

    const attachments = this.deps.attachments.consume(input.conversationId, input.attachmentIds ?? []);
    const turnId = randomUUID();
    const abort = new AbortController();
    this.activeTurns.set(input.conversationId, { turnId, abort, startedAt: Date.now() });

    const sink = this.createSink(conversationSnapshot, turnId);

    // Item do usuário é persistido E anunciado ANTES de qualquer chamada
    // externa: a mensagem enviada aparece na conversa mesmo que o provedor
    // demore, falhe ou nunca responda.
    sink.itemStarted({
      turnId,
      role: 'user',
      kind: 'userMessage',
      status: 'completed',
      text: input.text,
      attachments: attachments.length > 0 ? attachments : undefined,
      modelId: parameters.modelId,
      providerId: parameters.providerId,
      engineId: parameters.engineId,
    });
    this.deps.db.drafts.clear(input.conversationId);
    if (row.titleIsLocal && row.title === 'Nova conversa' && input.text.trim() !== '') {
      this.deps.db.conversations.update(row.id, { title: deriveTitle(input.text), titleIsLocal: true });
      this.notifyConversationsChanged();
    }
    this.deps.onCatalogUse(parameters.providerId, parameters.modelId);

    const policy = engine.effectivePolicy(conversationSnapshot, row.mode);
    const skills = await this.deps.skillsFor(engine.id, row.workspacePath).catch(() => []);

    void (async () => {
      try {
        if (!this.openedInEngine.has(row.id)) {
          const opened = row.nativeThreadId
            ? await engine.resumeConversation(conversationSnapshot, sink)
            : await engine.openConversation(conversationSnapshot, sink);
          if (opened.nativeThreadId) {
            this.deps.db.conversations.update(row.id, { nativeThreadId: opened.nativeThreadId });
          }
          this.openedInEngine.add(row.id);
        }
        const latest = this.readRow(row.id) ?? conversationSnapshot;
        await engine.runTurn({
          // Workspace e modo vêm do SNAPSHOT do início do turno; apenas o ID
          // nativo da thread é atualizado a partir do estado mais recente.
          conversation: { ...conversationSnapshot, nativeThreadId: latest.nativeThreadId, parameters },
          turnId,
          text: input.text,
          attachments,
          parameters,
          policy,
          mode: row.mode,
          history: this.deps.db.items.list(row.id).filter((i) => i.turnId !== turnId),
          signal: abort.signal,
          sink,
          skills,
        });
      } catch (err) {
        const detail = toErrorDetail(err);
        logger.warn('conversations', 'Turno terminou com erro', { code: detail.code, conversationId: row.id });
        sink.turnFailed(detail);
        sink.status('error');
      } finally {
        this.activeTurns.delete(row.id);
      }
    })();

    return { turnId, accepted: true };
  }

  async steer(conversationId: string, text: string): Promise<boolean> {
    const row = this.requireRow(conversationId);
    const active = this.activeTurns.get(conversationId);
    if (!active) return false;
    const engine = this.deps.engineFor(row.engineId);
    const accepted = await engine.steer(row, text);
    if (accepted) {
      const item = this.deps.db.items.append({
        conversationId,
        turnId: active.turnId,
        role: 'user',
        kind: 'userMessage',
        status: 'completed',
        text,
      });
      // A orientação também precisa aparecer na conversa imediatamente.
      this.deps.bus.primeSeq(conversationId, item.seq);
      this.deps.bus.emitDomain({
        type: 'item/started',
        itemId: item.id,
        item,
        engineId: row.engineId,
        providerId: row.providerId,
        conversationId,
        turnId: active.turnId,
      });
      this.deps.bus.emitDomain({
        type: 'conversation/status',
        status: 'running',
        detail: 'Orientação entregue ao turno em andamento.',
        engineId: row.engineId,
        providerId: row.providerId,
        conversationId,
        turnId: active.turnId,
      });
    }
    return accepted;
  }

  async interrupt(conversationId: string): Promise<boolean> {
    const row = this.readRow(conversationId);
    const active = this.activeTurns.get(conversationId);
    if (!row || !active) return false;
    this.setStatus(row, 'interrupting');
    active.abort.abort();
    const engine = this.deps.engineFor(row.engineId);
    await engine.interrupt(row).catch((err) => {
      logger.debug('conversations', 'Interrupção no motor falhou', toErrorDetail(err));
    });
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Sink
   * ------------------------------------------------------------------ */

  private createSink(conversation: ConversationRow, turnId: string): TurnSink {
    const conversationId = conversation.id;
    const providerId = conversation.providerId;
    const engineId = conversation.engineId;
    const emit = (input: Parameters<EventBus['emitDomain']>[0]): void => {
      this.deps.bus.emitDomain(input);
    };

    const base = { engineId, providerId, conversationId, turnId };

    return {
      newItemId: () => randomUUID(),

      status: (status: StatusValue, detail?: string) => {
        const mapped = status as ConversationStatus;
        this.deps.db.conversations.setStatus(conversationId, mapped);
        emit({ ...base, type: 'conversation/status', status: mapped, detail });
      },

      itemStarted: (item: NewItem): ConversationItem => {
        const row = this.deps.db.items.append({
          ...item,
          conversationId,
          turnId: item.turnId ?? turnId,
          providerId: item.providerId ?? providerId,
          engineId: item.engineId ?? engineId,
        });
        this.deps.bus.primeSeq(conversationId, row.seq);
        emit({ ...base, type: 'item/started', itemId: row.id, item: row });
        return row;
      },

      textDelta: (itemId: string, delta: string) => {
        this.deps.db.items.appendText(itemId, delta);
        emit({ ...base, type: 'item/textDelta', itemId, delta });
      },

      reasoningDelta: (itemId: string, delta: string) => {
        this.deps.db.items.appendText(itemId, delta);
        emit({ ...base, type: 'item/reasoningDelta', itemId, delta });
      },

      planUpdated: (itemId: string, steps: PlanStep[]) => {
        this.deps.db.items.update(itemId, { plan: steps, status: 'streaming' });
        emit({ ...base, type: 'item/planUpdated', itemId, steps });
      },

      outputDelta: (itemId: string, chunk: string, stream: 'stdout' | 'stderr') => {
        const current = this.deps.db.items.get(itemId);
        if (current) {
          const command = current.command ?? {
            command: '(comando)',
            output: '',
            outputTruncated: false,
            totalOutputBytes: 0,
          };
          const combined = `${command.output}${chunk}`;
          const totalBytes = command.totalOutputBytes + Buffer.byteLength(chunk, 'utf8');
          const retained =
            combined.length > MAX_RETAINED_OUTPUT ? combined.slice(combined.length - MAX_RETAINED_OUTPUT) : combined;
          this.deps.db.items.update(itemId, {
            status: 'streaming',
            command: {
              ...command,
              output: retained,
              outputTruncated: command.outputTruncated || retained.length < combined.length,
              totalOutputBytes: totalBytes,
            },
          });
        }
        emit({ ...base, type: 'item/outputDelta', itemId, chunk, stream });
      },

      itemCompleted: (itemId: string, patch?: Partial<ConversationItem>) => {
        const updated = this.deps.db.items.update(itemId, { ...patch, status: patch?.status ?? 'completed' });
        if (updated) emit({ ...base, type: 'item/completed', itemId, item: updated });
      },

      itemFailed: (itemId: string, error: ErrorDetail) => {
        this.deps.db.items.update(itemId, { status: 'failed', errorDetail: error });
        emit({ ...base, type: 'item/failed', itemId, error });
      },

      diffUpdated: (files: FileDiff[]) => {
        emit({ ...base, type: 'diff/updated', files });
      },

      usage: (usage: TokenUsage) => {
        emit({
          ...base,
          type: 'usage/updated',
          usage: {
            providerId,
            fetchedAt: new Date().toISOString(),
            spend:
              usage.reportedCost !== undefined
                ? { amount: usage.reportedCost, currency: usage.currency ?? 'USD', windowLabel: 'Custo deste turno' }
                : undefined,
            unavailable:
              usage.reportedCost === undefined && usage.estimatedCost === undefined
                ? ['O provedor não informou custo para este turno.']
                : undefined,
          },
        });
      },

      approvalRequested: (request: ApprovalRequest) => {
        emit({ ...base, type: 'approval/requested', request });
      },

      policy: (policy: EffectivePolicy) => {
        emit({ ...base, type: 'policy/effective', policy });
      },

      turnCompleted: (usage?: TokenUsage, effectiveUpstream?: string) => {
        // O estado persistido volta para "concluído": sem isso a lista de
        // conversas continuaria marcando "em execução" depois do fim do turno.
        this.deps.db.conversations.setStatus(conversationId, 'completed');
        emit({ ...base, type: 'turn/completed', turnId, usage, effectiveUpstream });
        this.notifyConversationsChanged();
      },

      turnFailed: (error: ErrorDetail) => {
        this.deps.db.items.append({
          conversationId,
          turnId,
          role: 'system',
          kind: 'error',
          status: 'failed',
          text: `${error.message}${error.action ? `\n${error.action}` : ''}`,
          errorDetail: error,
        });
        this.deps.db.conversations.setStatus(conversationId, 'error');
        emit({ ...base, type: 'turn/failed', turnId, error });
        this.notifyConversationsChanged();
      },

      turnCancelled: (reason?: string) => {
        this.deps.db.conversations.setStatus(conversationId, 'cancelled');
        emit({ ...base, type: 'turn/cancelled', turnId, reason });
        this.notifyConversationsChanged();
      },

      nativeThread: (threadId: string) => {
        this.deps.db.conversations.update(conversationId, { nativeThreadId: threadId });
        emit({ ...base, type: 'conversation/native', nativeThreadId: threadId });
      },

      titleSuggested: (title: string, isLocal: boolean) => {
        this.deps.db.conversations.update(conversationId, { title, titleIsLocal: isLocal });
        emit({ ...base, type: 'conversation/title', title, titleIsLocal: isLocal });
        this.notifyConversationsChanged();
      },

      error: (error: ErrorDetail) => {
        emit({ ...base, type: 'error', error });
      },
    };
  }

  /** Publica uma aprovação pendente para a interface. */
  publishApproval(request: ApprovalRequest): void {
    const row = this.readRow(request.conversationId);
    this.deps.bus.emitDomain({
      type: 'approval/requested',
      request,
      engineId: request.engineId,
      providerId: row?.providerId ?? 'desconhecido',
      conversationId: request.conversationId,
      turnId: request.turnId,
    });
  }

  publishApprovalResolved(request: ApprovalRequest, decision: string): void {
    const row = this.readRow(request.conversationId);
    this.deps.bus.emitDomain({
      type: 'approval/resolved',
      approvalId: request.id,
      decision,
      engineId: request.engineId,
      providerId: row?.providerId ?? 'desconhecido',
      conversationId: request.conversationId,
      turnId: request.turnId,
    });
  }

  /** Invalida vínculos com o motor sem reexecutar nada. */
  invalidateEngineBindings(): void {
    this.openedInEngine.clear();
  }

  private setStatus(row: ConversationRow, status: ConversationStatus): void {
    this.deps.db.conversations.setStatus(row.id, status);
    this.deps.bus.emitDomain({
      type: 'conversation/status',
      status,
      engineId: row.engineId,
      providerId: row.providerId,
      conversationId: row.id,
    });
  }

  private notifyConversationsChanged(): void {
    this.deps.bus.emitApp({ type: 'conversations/updated', at: new Date().toISOString() });
  }

  private requireRow(conversationId: string): ConversationRow {
    const row = this.deps.db.conversations.read(conversationId);
    if (!row) {
      throw appError('validation', {
        message: 'A conversa não foi encontrada.',
        action: 'Atualize a lista de conversas na barra lateral.',
      });
    }
    return row;
  }
}

function deriveTitle(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim() !== '') ?? text;
  const trimmed = firstLine.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed || 'Nova conversa';
}

async function tryCodexFork(
  engine: ExecutionEngine,
  source: ConversationRow,
  fromItemId: string | undefined,
): Promise<string | undefined> {
  const maybe = engine as ExecutionEngine & {
    forkThread?(conversation: ConversationRow, fromItemId?: string): Promise<string | undefined>;
  };
  if (typeof maybe.forkThread === 'function') return maybe.forkThread(source, fromItemId);
  return undefined;
}

export type { EventBus };
