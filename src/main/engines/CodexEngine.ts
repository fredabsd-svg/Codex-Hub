/**
 * Motor Codex — execução real pelo Codex App Server.
 *
 * Este motor NÃO substitui o protocolo por chamadas isoladas a uma API de
 * inferência: cada operação usa os métodos do App Server.
 *
 * Aprovações chegam como REQUISIÇÕES INICIADAS PELO SERVIDOR e são respondidas
 * no `id` original, com o payload previsto pelo schema da versão instalada.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  AttachmentRef,
  CapabilityMap,
  EffectivePolicy,
  ErrorDetail,
  FileDiff,
  OperationMode,
  SkillDescriptor,
  TokenUsage,
} from '../../shared/domain';
import { ENGINE_CAPABILITIES } from '../../shared/capabilities';
import { appError, toErrorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import { CodexEventRouter, type RouterTarget } from '../codex/CodexEventRouter';
import type { CodexRuntime } from '../codex/CodexRuntime';
import { CODEX_METHODS, isApprovalRequestMethod } from '../codex/methods';
import { arr, asRecord, deepPick, str } from '../codex/parse';
import type { ApprovalBroker } from '../tools/ApprovalBroker';
import type { ConversationRow } from '../persistence/repositories';
import type { EngineTurnRequest, ExecutionEngine, TurnSink } from './types';

interface ThreadBinding {
  conversationId: string;
  nativeThreadId: string;
  sink: TurnSink;
  itemMap: Map<string, string>;
  activeTurn: {
    turnId: string;
    resolve(): void;
    reject(error: ErrorDetail): void;
    settled: boolean;
  } | null;
  lastDiff: FileDiff[];
}

export interface CodexEngineDeps {
  runtime: CodexRuntime;
  approvals: ApprovalBroker;
  developerMode(): boolean;
  /** Verificação de caminho autorizado antes de aprovar escrita. */
  isPathAuthorized(conversationId: string, path: string): boolean;
}

export class CodexEngine implements ExecutionEngine {
  readonly id = 'codex' as const;
  readonly capabilities: CapabilityMap = ENGINE_CAPABILITIES.codex;

  private readonly byThread = new Map<string, ThreadBinding>();
  private readonly byConversation = new Map<string, ThreadBinding>();
  private readonly router: CodexEventRouter;

  constructor(private readonly deps: CodexEngineDeps) {
    this.router = new CodexEventRouter({
      targetForThread: (threadId) => this.targetForThread(threadId),
      developerMode: () => this.deps.developerMode(),
    });
  }

  /** Chamado pelo `CodexRuntime` para cada notificação. */
  handleNotification(method: string, params: unknown): void {
    this.router.handle(method, params);
  }

  /** Chamado pelo `CodexRuntime` para cada requisição iniciada pelo servidor. */
  async handleServerRequest(method: string, params: unknown, generation: number): Promise<unknown> {
    if (!isApprovalRequestMethod(method)) {
      throw appError('protocol', {
        message: `O Codex pediu "${method}", que este aplicativo não implementa.`,
        technical: method,
      });
    }
    const threadId = str(deepPick(params, ['threadId', 'thread_id', 'conversationId']));
    const binding = threadId ? this.byThread.get(threadId) : undefined;
    const conversationId = binding?.conversationId ?? [...this.byConversation.keys()][0];
    if (!conversationId) {
      throw appError('protocol', { message: 'Aprovação recebida sem conversa associada.' });
    }

    const request = this.buildApprovalRequest(params, conversationId, binding);
    binding?.sink.status('awaitingApproval');
    const decision = await this.deps.approvals.request({ ...request, generation });
    binding?.sink.status('running');
    return this.approvalResponsePayload(decision);
  }

  private buildApprovalRequest(
    params: unknown,
    conversationId: string,
    binding: ThreadBinding | undefined,
  ): Parameters<ApprovalBroker['request']>[0] {
    const argv = arr(deepPick(params, ['argv', 'command', 'args'])).filter((v): v is string => typeof v === 'string');
    const commandRaw = deepPick(params, ['command', 'commandLine', 'command_line']);
    const display =
      typeof commandRaw === 'string' ? commandRaw : argv.length > 0 ? argv.join(' ') : undefined;
    const cwd = str(deepPick(params, ['cwd', 'workingDirectory', 'working_directory']));
    const reason = str(deepPick(params, ['reason', 'justification', 'explanation']));
    const files = readChangedFiles(params);
    const isPatch = files.length > 0 || /patch|fileChange/i.test(String(deepPick(params, ['type']) ?? ''));

    return {
      conversationId,
      turnId: binding?.activeTurn?.turnId,
      engineId: 'codex',
      kind: isPatch ? 'filePatch' : 'commandExecution',
      title: isPatch
        ? `Aplicar alterações em ${files.length} arquivo(s)`
        : display
          ? `Executar: ${display.slice(0, 120)}`
          : 'Executar comando',
      reason,
      command: display ? { argv: argv.length > 0 ? argv : [display], cwd, display } : undefined,
      files: files.length > 0 ? files : undefined,
      diffs: readApprovalDiffs(params),
      // "Permitir na sessão" só para comandos, com escopo pelo comando exato.
      sessionScopeKey: !isPatch && display ? `codex:command:${display}` : undefined,
      sessionScopeDescription: display
        ? `Aprova automaticamente apenas o comando exatamente igual a "${display.slice(0, 120)}" nesta conversa e nesta conexão com o Codex.`
        : undefined,
    };
  }

  /**
   * Payload de resposta às aprovações. A forma exata depende do schema da versão
   * instalada; enviamos os aliases mais comuns para maximizar compatibilidade
   * sem inventar campos novos.
   */
  private approvalResponsePayload(decision: ApprovalDecision): unknown {
    switch (decision) {
      case 'allowOnce':
        return { decision: 'approved', approved: true };
      case 'allowForSession':
        return { decision: 'approved_for_session', approved: true };
      case 'deny':
        return { decision: 'denied', approved: false };
      case 'cancel':
      default:
        return { decision: 'abort', approved: false };
    }
  }

  private targetForThread(threadId: string | undefined): RouterTarget | null {
    if (!threadId) {
      // Sem thread no payload: se houver exatamente uma conversa ativa, usa ela.
      const only = this.byConversation.size === 1 ? [...this.byConversation.values()][0] : undefined;
      return only ? this.toRouterTarget(only) : null;
    }
    const binding = this.byThread.get(threadId);
    return binding ? this.toRouterTarget(binding) : null;
  }

  private toRouterTarget(binding: ThreadBinding): RouterTarget {
    return {
      conversationId: binding.conversationId,
      sink: binding.sink,
      itemMap: binding.itemMap,
      onTurnCompleted: (turnId, usage) => this.completeTurn(binding, turnId, usage),
      onTurnFailed: (turnId, error) => this.failTurn(binding, turnId, error),
      onDiff: (files) => {
        binding.lastDiff = files;
      },
    };
  }

  private completeTurn(binding: ThreadBinding, _turnId: string | undefined, usage: TokenUsage | undefined): void {
    const active = binding.activeTurn;
    binding.sink.turnCompleted(usage);
    binding.sink.status('completed');
    if (active && !active.settled) {
      active.settled = true;
      active.resolve();
    }
  }

  private failTurn(binding: ThreadBinding, _turnId: string | undefined, error: ErrorDetail): void {
    const active = binding.activeTurn;
    binding.sink.turnFailed(error);
    binding.sink.status('error');
    if (active && !active.settled) {
      active.settled = true;
      active.reject(error);
    }
  }

  /* ------------------------------------------------------------------ *
   * ExecutionEngine
   * ------------------------------------------------------------------ */

  async ensureReady(): Promise<void> {
    if (this.deps.runtime.isReady) return;
    const info = await this.deps.runtime.start();
    if (!info.found) {
      throw appError('codexMissing', {
        message: info.diagnostic?.message ?? 'O executável do Codex não foi encontrado.',
        action: info.diagnostic?.action ?? 'Informe o caminho em Configurações › Codex.',
      });
    }
    if (!info.initialized) {
      throw appError('codexIncompatible', {
        message: info.diagnostic?.message ?? 'O handshake com o Codex App Server não concluiu.',
        action: info.diagnostic?.action ?? 'Verifique a versão instalada e tente conectar novamente.',
      });
    }
  }

  async openConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }> {
    await this.ensureReady();
    sink.status('connecting');

    const params: Record<string, unknown> = {};
    if (conversation.workspacePath) params.cwd = conversation.workspacePath;
    if (conversation.modelId) params.model = conversation.modelId;
    const policy = this.effectivePolicy(conversation, conversation.mode);
    params.approvalPolicy = mapApprovalPolicy(policy);
    params.sandbox = mapSandbox(policy);
    if (conversation.parameters.reasoningEffort) params.reasoningEffort = conversation.parameters.reasoningEffort;
    if (conversation.parameters.personality) params.personality = conversation.parameters.personality;

    const result = await this.deps.runtime.request<unknown>(CODEX_METHODS.threadStart, params, { timeoutMs: 45_000 });
    const threadId = str(deepPick(result, ['threadId', 'thread_id', 'id']));
    if (!threadId) {
      throw appError('protocol', {
        message: 'O Codex não devolveu um identificador de thread ao iniciar a conversa.',
        action: 'Gere os tipos com "npm run codex:types" e verifique a versão instalada.',
      });
    }
    this.bind(conversation.id, threadId, sink);
    sink.nativeThread(threadId);
    sink.status('ready');
    return { nativeThreadId: threadId };
  }

  async resumeConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }> {
    await this.ensureReady();
    if (!conversation.nativeThreadId) return this.openConversation(conversation, sink);
    sink.status('connecting');
    try {
      const result = await this.deps.runtime.request<unknown>(
        CODEX_METHODS.threadResume,
        { threadId: conversation.nativeThreadId, ...(conversation.workspacePath ? { cwd: conversation.workspacePath } : {}) },
        { timeoutMs: 45_000 },
      );
      const threadId = str(deepPick(result, ['threadId', 'thread_id', 'id'])) ?? conversation.nativeThreadId;
      this.bind(conversation.id, threadId, sink);
      sink.nativeThread(threadId);
      sink.status('ready');
      return { nativeThreadId: threadId };
    } catch (err) {
      const detail = toErrorDetail(err);
      logger.info('codex-engine', 'Retomada falhou; abrindo nova thread', { code: detail.code });
      sink.itemStarted({
        role: 'system',
        kind: 'notice',
        status: 'completed',
        text: `Não foi possível retomar a thread original no Codex (${detail.message}). Uma nova thread foi iniciada; o histórico anterior permanece salvo localmente.`,
      });
      return this.openConversation(conversation, sink);
    }
  }

  private bind(conversationId: string, threadId: string, sink: TurnSink): ThreadBinding {
    const previous = this.byConversation.get(conversationId);
    if (previous) this.byThread.delete(previous.nativeThreadId);
    const binding: ThreadBinding = {
      conversationId,
      nativeThreadId: threadId,
      sink,
      itemMap: previous?.itemMap ?? new Map(),
      activeTurn: null,
      lastDiff: [],
    };
    this.byThread.set(threadId, binding);
    this.byConversation.set(conversationId, binding);
    return binding;
  }

  async runTurn(request: EngineTurnRequest): Promise<void> {
    const { conversation, sink } = request;
    await this.ensureReady();
    let binding = this.byConversation.get(conversation.id);
    if (!binding) {
      const opened = conversation.nativeThreadId
        ? await this.resumeConversation(conversation, sink)
        : await this.openConversation(conversation, sink);
      binding = this.byConversation.get(conversation.id);
      if (!binding && opened.nativeThreadId) binding = this.bind(conversation.id, opened.nativeThreadId, sink);
    }
    if (!binding) {
      throw appError('protocol', { message: 'Não foi possível vincular a conversa a uma thread do Codex.' });
    }

    if (binding.activeTurn && !binding.activeTurn.settled) {
      throw appError('validation', {
        message: 'Já existe um turno em andamento nesta conversa.',
        action: 'Aguarde a conclusão, interrompa o turno ou envie a mensagem como orientação.',
      });
    }

    const input = buildTurnInput(request.text, request.attachments, sink);
    const params: Record<string, unknown> = {
      threadId: binding.nativeThreadId,
      input,
    };
    if (request.parameters.modelId) params.model = request.parameters.modelId;
    if (request.parameters.reasoningEffort) params.reasoningEffort = request.parameters.reasoningEffort;
    if (request.parameters.personality) params.personality = request.parameters.personality;
    if (request.skills.length > 0) {
      params.skills = request.skills
        .filter((s) => s.enabledLocally && s.availability === 'supported')
        .map((s) => ({ id: s.id, name: s.name }));
    }

    sink.status('running');
    sink.policy(request.policy);

    const completion = new Promise<void>((resolve, reject) => {
      const active = {
        turnId: request.turnId,
        settled: false,
        resolve: () => resolve(),
        reject: (error: ErrorDetail) => reject(appError(error.code, error)),
      };
      binding!.activeTurn = active;
    });

    const onAbort = (): void => {
      void this.interrupt(conversation).catch(() => undefined);
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    try {
      // A resposta de `turn/start` é apenas a CONFIRMAÇÃO DE RECEBIMENTO.
      // A conclusão vem por evento; não confundimos as duas coisas.
      await this.deps.runtime.request<unknown>(CODEX_METHODS.turnStart, params, { timeoutMs: 60_000 });
      await completion;
    } catch (err) {
      const detail = toErrorDetail(err);
      if (request.signal.aborted) {
        sink.turnCancelled('Turno interrompido.');
        sink.status('cancelled');
        return;
      }
      if (binding.activeTurn && !binding.activeTurn.settled) {
        binding.activeTurn.settled = true;
        sink.turnFailed(detail);
        sink.status('error');
      }
    } finally {
      request.signal.removeEventListener('abort', onAbort);
      if (binding.activeTurn?.turnId === request.turnId) binding.activeTurn = null;
    }
  }

  async steer(conversation: ConversationRow, text: string): Promise<boolean> {
    const binding = this.byConversation.get(conversation.id);
    if (!binding || !binding.activeTurn || binding.activeTurn.settled) return false;
    try {
      await this.deps.runtime.request(
        CODEX_METHODS.turnSteer,
        { threadId: binding.nativeThreadId, input: [{ type: 'text', text }] },
        { timeoutMs: 30_000 },
      );
      return true;
    } catch (err) {
      const detail = toErrorDetail(err);
      logger.info('codex-engine', 'turn/steer indisponível', { code: detail.code });
      binding.sink.error(detail);
      return false;
    }
  }

  async interrupt(conversation: ConversationRow): Promise<boolean> {
    const binding = this.byConversation.get(conversation.id);
    if (!binding) return false;
    binding.sink.status('interrupting');
    this.deps.approvals.cancelForConversation(conversation.id, 'Turno interrompido pela pessoa.');
    try {
      await this.deps.runtime.request(
        CODEX_METHODS.turnInterrupt,
        { threadId: binding.nativeThreadId },
        { timeoutMs: 20_000 },
      );
      return true;
    } catch (err) {
      logger.info('codex-engine', 'turn/interrupt falhou', toErrorDetail(err));
      return false;
    }
  }

  async closeConversation(conversation: ConversationRow): Promise<void> {
    const binding = this.byConversation.get(conversation.id);
    if (!binding) return;
    this.byThread.delete(binding.nativeThreadId);
    this.byConversation.delete(conversation.id);
  }

  /** Chamado após reinício do Codex: libera vínculos sem repetir turnos. */
  invalidateBindings(reason: string): void {
    const detail: ErrorDetail = {
      code: 'protocol',
      message: `A conexão com o Codex foi reiniciada: ${reason}`,
      action: 'Reenvie a mensagem se quiser continuar. Nenhum comando foi reexecutado automaticamente.',
      retryable: false,
    };
    for (const binding of this.byConversation.values()) {
      if (binding.activeTurn && !binding.activeTurn.settled) {
        binding.activeTurn.settled = true;
        // A interface precisa VER o que aconteceu, não apenas a promessa falhar.
        binding.sink.turnFailed(detail);
        binding.sink.status('error');
        binding.activeTurn.reject(detail);
      }
      binding.itemMap.clear();
    }
    this.byThread.clear();
    this.byConversation.clear();
  }

  effectivePolicy(conversation: ConversationRow, mode: OperationMode): EffectivePolicy {
    const hasWorkspace = typeof conversation.workspacePath === 'string' && conversation.workspacePath !== '';
    const sandbox: EffectivePolicy['sandbox'] =
      mode === 'execute' && hasWorkspace ? 'workspaceWrite' : 'readOnly';
    return {
      mode,
      approvals: mode === 'execute' ? 'onRequest' : 'always',
      sandbox,
      // Rede das ferramentas do agente: quem aplica é o sandbox do Codex.
      // Não prometemos interceptar toda conexão.
      toolNetwork: 'blocked',
      inferenceNetwork: 'allowed',
      // A política só é "aplicada" quando o runtime confirma. Antes disso, é
      // apenas a política SOLICITADA.
      confirmedByRuntime: false,
      note:
        'Política solicitada ao Codex no início da thread. O aplicativo não afirma que ela foi aplicada sem confirmação do runtime.',
    };
  }

  async listSkills(workspacePath?: string): Promise<SkillDescriptor[]> {
    if (!this.deps.runtime.isReady) return [];
    return this.deps.runtime.listSkills(workspacePath);
  }
}

/* ------------------------------------------------------------------ *
 * Auxiliares
 * ------------------------------------------------------------------ */

function mapApprovalPolicy(policy: EffectivePolicy): string {
  switch (policy.approvals) {
    case 'always':
      return 'untrusted';
    case 'onFailure':
      return 'on-failure';
    case 'never':
      return 'never';
    case 'onRequest':
    default:
      return 'on-request';
  }
}

function mapSandbox(policy: EffectivePolicy): string {
  switch (policy.sandbox) {
    case 'readOnly':
      return 'read-only';
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'workspaceWrite':
    default:
      return 'workspace-write';
  }
}

/**
 * Monta os itens de entrada do turno.
 *
 * Imagens vão como item de imagem (`image`/`localImage`, conforme o schema).
 * PDF, DOCX, XLSX, CSV, TXT e código NÃO são imagens: seguem como caminho
 * absoluto autorizado, para o runtime ler com suas próprias ferramentas.
 */
export function buildTurnInput(text: string, attachments: AttachmentRef[], sink?: TurnSink): unknown[] {
  const input: unknown[] = [];
  if (text.trim() !== '') input.push({ type: 'text', text });

  for (const attachment of attachments) {
    const path = attachment.absolutePath;
    if (!path) {
      sink?.itemStarted({
        role: 'system',
        kind: 'notice',
        status: 'completed',
        text: `O anexo "${attachment.fileName}" não tem caminho autorizado e não foi enviado ao Codex.`,
      });
      continue;
    }
    if (attachment.kind === 'image') {
      input.push({ type: 'localImage', path });
      continue;
    }
    input.push({
      type: 'text',
      text: `Arquivo anexado pela pessoa: ${path}\nLeia-o com suas ferramentas quando precisar do conteúdo.`,
    });
  }
  if (input.length === 0) input.push({ type: 'text', text: '(mensagem vazia)' });
  return input;
}

function readChangedFiles(params: unknown): string[] {
  const out = new Set<string>();
  const changes = deepPick(params, ['changes', 'files', 'fileChanges']);
  const record = asRecord(changes);
  if (record && !Array.isArray(changes)) {
    for (const key of Object.keys(record)) out.add(key);
  }
  for (const entry of arr(changes)) {
    if (typeof entry === 'string') {
      out.add(entry);
      continue;
    }
    const item = asRecord(entry);
    const path = str(deepPick(item, ['path', 'file', 'filePath', 'file_path']));
    if (path) out.add(path);
  }
  return [...out];
}

function readApprovalDiffs(params: unknown): FileDiff[] | undefined {
  const changes = deepPick(params, ['changes', 'files', 'fileChanges']);
  const files: FileDiff[] = [];
  const record = asRecord(changes);
  if (record && !Array.isArray(changes)) {
    for (const [path, value] of Object.entries(record)) {
      const item = asRecord(value);
      const unified = str(deepPick(item, ['unifiedDiff', 'diff', 'patch']));
      files.push({
        path,
        changeKind: 'modify',
        binary: false,
        additions: 0,
        deletions: 0,
        unifiedDiff: unified,
      });
    }
  }
  return files.length > 0 ? files : undefined;
}

export type { ApprovalRequest };
