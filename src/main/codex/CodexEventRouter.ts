/**
 * Tradução de notificações do Codex App Server para eventos de domínio.
 *
 * Princípios:
 *  - só eventos REAIS são traduzidos. Nada é fabricado para preencher a
 *    interface;
 *  - notificação desconhecida é registrada (modo desenvolvedor) e ignorada,
 *    nunca tratada como erro fatal;
 *  - o estado da conversa é derivado dos eventos, não do simples recebimento
 *    de uma requisição;
 *  - resumo de raciocínio só aparece quando a API o envia para exibição.
 */

import type { ErrorDetail, FileDiff, PlanStep, TokenUsage } from '../../shared/domain';
import { errorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import { CODEX_EVENTS } from './methods';
import { arr, asRecord, bool, deepPick, deltaOf, int, itemIdOf, pick, str, threadIdOf, turnIdOf } from './parse';
import type { TurnSink } from '../engines/types';

export interface RouterTarget {
  conversationId: string;
  sink: TurnSink;
  /** IDs de item do Codex → IDs de item locais. */
  itemMap: Map<string, string>;
  onTurnCompleted(turnId: string | undefined, usage: TokenUsage | undefined): void;
  onTurnFailed(turnId: string | undefined, error: ErrorDetail): void;
  onDiff(files: FileDiff[]): void;
}

export interface RouterHost {
  /** Resolve o alvo pelo ID nativo da thread. */
  targetForThread(threadId: string | undefined): RouterTarget | null;
  developerMode(): boolean;
}

export class CodexEventRouter {
  constructor(private readonly host: RouterHost) {}

  handle(method: string, params: unknown): void {
    const threadId = threadIdOf(params);
    const target = this.host.targetForThread(threadId);

    switch (method) {
      case CODEX_EVENTS.threadStarted: {
        if (!target || !threadId) return;
        target.sink.nativeThread(threadId);
        target.sink.status('ready');
        return;
      }
      case CODEX_EVENTS.turnStarted: {
        if (!target) return;
        target.sink.status('running');
        return;
      }
      case CODEX_EVENTS.turnCompleted: {
        if (!target) return;
        const usage = readUsage(params);
        if (usage) target.sink.usage(usage);
        target.onTurnCompleted(turnIdOf(params), usage);
        return;
      }
      case CODEX_EVENTS.turnFailed: {
        if (!target) return;
        target.onTurnFailed(turnIdOf(params), readError(params));
        return;
      }
      case CODEX_EVENTS.itemStarted: {
        if (!target) return;
        this.handleItemStarted(target, params);
        return;
      }
      case CODEX_EVENTS.itemUpdated:
      case CODEX_EVENTS.itemCompleted: {
        if (!target) return;
        this.handleItemCompleted(target, params, method === CODEX_EVENTS.itemCompleted);
        return;
      }
      case CODEX_EVENTS.agentMessageDelta: {
        if (!target) return;
        const localId = this.ensureItem(target, params, 'agentMessage', 'assistant');
        const delta = deltaOf(params);
        if (localId && delta) target.sink.textDelta(localId, delta);
        return;
      }
      case CODEX_EVENTS.reasoningSummaryTextDelta: {
        if (!target) return;
        const localId = this.ensureItem(target, params, 'reasoningSummary', 'assistant');
        const delta = deltaOf(params);
        if (localId && delta) target.sink.reasoningDelta(localId, delta);
        return;
      }
      case CODEX_EVENTS.planDelta: {
        if (!target) return;
        const localId = this.ensureItem(target, params, 'plan', 'assistant');
        const steps = readPlan(params);
        if (localId && steps.length > 0) target.sink.planUpdated(localId, steps);
        return;
      }
      case CODEX_EVENTS.commandExecutionOutputDelta: {
        if (!target) return;
        const localId = this.ensureItem(target, params, 'commandExecution', 'tool');
        const chunk = deltaOf(params);
        const stream = str(deepPick(params, ['stream', 'channel'])) === 'stderr' ? 'stderr' : 'stdout';
        if (localId && chunk) target.sink.outputDelta(localId, chunk, stream);
        return;
      }
      case CODEX_EVENTS.turnDiffUpdated: {
        if (!target) return;
        const files = readDiff(params);
        target.onDiff(files);
        target.sink.diffUpdated(files);
        return;
      }
      case CODEX_EVENTS.error: {
        const detail = readError(params);
        if (target) target.sink.error(detail);
        else logger.warn('codex', 'Erro sem conversa associada', { message: detail.message });
        return;
      }
      default: {
        if (this.host.developerMode()) {
          logger.debug('codex', 'Notificação não tratada', { method, params });
        }
        return;
      }
    }
  }

  private handleItemStarted(target: RouterTarget, params: unknown): void {
    const nativeId = itemIdOf(pick(params, 'item') ?? params);
    const item = asRecord(pick(params, 'item')) ?? asRecord(params) ?? {};
    const kind = mapItemKind(str(pick(item, 'type', 'itemType', 'kind')));
    const localId = target.sink.newItemId();
    if (nativeId) target.itemMap.set(nativeId, localId);

    const command = readCommand(item);
    target.sink.itemStarted({
      id: localId,
      role: kind === 'commandExecution' || kind === 'toolCall' ? 'tool' : 'assistant',
      kind,
      status: 'streaming',
      engineId: 'codex',
      nativeId,
      text: str(deepPick(item, ['text', 'message'])) ?? '',
      command,
      plan: kind === 'plan' ? readPlan(item) : undefined,
    });
  }

  private handleItemCompleted(target: RouterTarget, params: unknown, completed: boolean): void {
    const item = asRecord(pick(params, 'item')) ?? asRecord(params) ?? {};
    const nativeId = itemIdOf(item);
    const localId = nativeId ? target.itemMap.get(nativeId) : undefined;
    if (!localId) {
      // Item que nunca teve `started`: cria agora com o conteúdo final.
      const kind = mapItemKind(str(pick(item, 'type', 'itemType', 'kind')));
      const created = target.sink.itemStarted({
        role: kind === 'commandExecution' || kind === 'toolCall' ? 'tool' : 'assistant',
        kind,
        status: completed ? 'completed' : 'streaming',
        engineId: 'codex',
        nativeId,
        text: str(deepPick(item, ['text', 'message'])),
        command: readCommand(item),
        plan: kind === 'plan' ? readPlan(item) : undefined,
        fileChange: readFileChange(item),
      });
      if (nativeId) target.itemMap.set(nativeId, created.id);
      return;
    }
    const text = str(deepPick(item, ['text', 'message']));
    const command = readCommand(item);
    target.sink.itemCompleted(localId, {
      status: completed ? 'completed' : 'streaming',
      ...(text !== undefined ? { text } : {}),
      ...(command ? { command } : {}),
      ...(readFileChange(item) ? { fileChange: readFileChange(item) } : {}),
    });
  }

  private ensureItem(
    target: RouterTarget,
    params: unknown,
    kind: 'agentMessage' | 'reasoningSummary' | 'plan' | 'commandExecution',
    role: 'assistant' | 'tool',
  ): string | null {
    const nativeId = itemIdOf(params);
    if (nativeId) {
      const existing = target.itemMap.get(nativeId);
      if (existing) return existing;
    }
    const localId = target.sink.newItemId();
    if (nativeId) target.itemMap.set(nativeId, localId);
    target.sink.itemStarted({
      id: localId,
      role,
      kind,
      status: 'streaming',
      engineId: 'codex',
      nativeId,
      text: '',
      command:
        kind === 'commandExecution'
          ? { command: '(comando em execução)', output: '', outputTruncated: false, totalOutputBytes: 0 }
          : undefined,
    });
    return localId;
  }
}

function mapItemKind(raw: string | undefined): 'agentMessage' | 'reasoningSummary' | 'plan' | 'commandExecution' | 'fileChange' | 'toolCall' | 'error' | 'notice' {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('agentmessage') || value === 'assistant_message' || value === 'message') return 'agentMessage';
  if (value.includes('reasoning')) return 'reasoningSummary';
  if (value.includes('plan') || value.includes('todo')) return 'plan';
  if (value.includes('command')) return 'commandExecution';
  if (value.includes('filechange') || value.includes('patch') || value.includes('diff')) return 'fileChange';
  if (value.includes('tool') || value.includes('mcp')) return 'toolCall';
  if (value.includes('error')) return 'error';
  return 'notice';
}

function readCommand(item: Record<string, unknown>): NonNullable<Parameters<TurnSink['itemStarted']>[0]['command']> | undefined {
  const raw = asRecord(pick(item, 'commandExecution', 'command_execution')) ?? item;
  const commandValue = deepPick(raw, ['command', 'commandLine', 'command_line']);
  const argv = arr(deepPick(raw, ['argv', 'args'])).filter((v): v is string => typeof v === 'string');
  const commandText =
    typeof commandValue === 'string'
      ? commandValue
      : Array.isArray(commandValue)
        ? commandValue.filter((v): v is string => typeof v === 'string').join(' ')
        : argv.length > 0
          ? argv.join(' ')
          : undefined;
  if (commandText === undefined && argv.length === 0) return undefined;
  const output = str(deepPick(raw, ['output', 'aggregatedOutput', 'aggregated_output'])) ?? '';
  return {
    command: commandText ?? argv.join(' '),
    argv: argv.length > 0 ? argv : undefined,
    cwd: str(deepPick(raw, ['cwd', 'workingDirectory', 'working_directory'])),
    exitCode: int(deepPick(raw, ['exitCode', 'exit_code'])),
    durationMs: int(deepPick(raw, ['durationMs', 'duration_ms'])),
    output,
    outputTruncated: bool(deepPick(raw, ['truncated', 'outputTruncated'])) ?? false,
    totalOutputBytes: int(deepPick(raw, ['totalOutputBytes', 'total_output_bytes'])) ?? Buffer.byteLength(output, 'utf8'),
  };
}

function readFileChange(item: Record<string, unknown>): { files: FileDiff[] } | undefined {
  const raw = pick(item, 'fileChange', 'file_change', 'changes', 'files');
  const files = readDiffList(raw);
  return files.length > 0 ? { files } : undefined;
}

export function readPlan(params: unknown): PlanStep[] {
  const raw = deepPick(params, ['plan', 'steps', 'items', 'todos']);
  const list = arr(raw);
  const steps: PlanStep[] = [];
  for (const [index, entry] of list.entries()) {
    if (typeof entry === 'string') {
      steps.push({ id: `step-${index}`, text: entry, status: 'pending' });
      continue;
    }
    const record = asRecord(entry);
    if (!record) continue;
    const text = str(pick(record, 'text', 'title', 'description', 'step'));
    if (!text) continue;
    steps.push({
      id: str(pick(record, 'id')) ?? `step-${index}`,
      text,
      status: mapPlanStatus(str(pick(record, 'status', 'state'))),
    });
  }
  return steps;
}

function mapPlanStatus(raw: string | undefined): PlanStep['status'] {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('progress') || value === 'active' || value === 'running') return 'inProgress';
  if (value.includes('complet') || value === 'done') return 'completed';
  if (value.includes('skip')) return 'skipped';
  return 'pending';
}

export function readDiff(params: unknown): FileDiff[] {
  const raw = deepPick(params, ['files', 'diff', 'changes', 'fileChanges']);
  const list = readDiffList(raw);
  if (list.length > 0) return list;
  // Alguns servidores enviam o diff unificado inteiro como texto.
  const unified = str(deepPick(params, ['unifiedDiff', 'unified_diff', 'patch', 'diff']));
  if (unified) {
    return [
      {
        path: str(deepPick(params, ['path'])) ?? 'alterações',
        changeKind: 'modify',
        binary: false,
        additions: countPrefixed(unified, '+'),
        deletions: countPrefixed(unified, '-'),
        unifiedDiff: unified,
      },
    ];
  }
  return [];
}

function readDiffList(raw: unknown): FileDiff[] {
  const files: FileDiff[] = [];
  const record = asRecord(raw);
  if (record && !Array.isArray(raw)) {
    // Mapa caminho → diff.
    for (const [path, value] of Object.entries(record)) {
      const diff = toFileDiff(path, value);
      if (diff) files.push(diff);
    }
    return files;
  }
  for (const entry of arr(raw)) {
    const item = asRecord(entry);
    if (!item) continue;
    const path = str(pick(item, 'path', 'file', 'filePath', 'file_path', 'newPath'));
    if (!path) continue;
    const diff = toFileDiff(path, item);
    if (diff) files.push(diff);
  }
  return files;
}

function toFileDiff(path: string, value: unknown): FileDiff | null {
  const item = asRecord(value);
  if (!item) {
    if (typeof value === 'string') {
      return {
        path,
        changeKind: 'modify',
        binary: false,
        additions: countPrefixed(value, '+'),
        deletions: countPrefixed(value, '-'),
        unifiedDiff: value,
      };
    }
    return null;
  }
  const unified = str(pick(item, 'unifiedDiff', 'unified_diff', 'diff', 'patch'));
  const binary = bool(pick(item, 'binary', 'isBinary')) ?? false;
  return {
    path,
    oldPath: str(pick(item, 'oldPath', 'old_path', 'from')),
    changeKind: mapChangeKind(str(pick(item, 'kind', 'changeKind', 'change_kind', 'type', 'status'))),
    binary,
    additions: int(pick(item, 'additions', 'added', 'insertions')) ?? (unified ? countPrefixed(unified, '+') : 0),
    deletions: int(pick(item, 'deletions', 'removed')) ?? (unified ? countPrefixed(unified, '-') : 0),
    unifiedDiff: binary ? undefined : unified,
  };
}

function mapChangeKind(raw: string | undefined): FileDiff['changeKind'] {
  const value = (raw ?? '').toLowerCase();
  if (value.includes('add') || value.includes('creat') || value === 'a') return 'add';
  if (value.includes('del') || value.includes('remov') || value === 'd') return 'delete';
  if (value.includes('renam') || value === 'r') return 'rename';
  return 'modify';
}

function countPrefixed(text: string, prefix: '+' | '-'): number {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) count += 1;
  }
  return count;
}

export function readUsage(params: unknown): TokenUsage | undefined {
  const raw = asRecord(deepPick(params, ['usage', 'tokenUsage', 'token_usage']));
  if (!raw) return undefined;
  const usage: TokenUsage = {
    promptTokens: int(pick(raw, 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')),
    completionTokens: int(pick(raw, 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')),
    reasoningTokens: int(pick(raw, 'reasoningTokens', 'reasoning_tokens')),
    totalTokens: int(pick(raw, 'totalTokens', 'total_tokens')),
  };
  const hasAny = Object.values(usage).some((v) => v !== undefined);
  return hasAny ? usage : undefined;
}

export function readError(params: unknown): ErrorDetail {
  const raw = asRecord(deepPick(params, ['error'])) ?? asRecord(params);
  const message = str(pick(raw, 'message', 'reason', 'detail'));
  const code = str(pick(raw, 'code', 'type'));
  if (message && /unauthor|not.*(logged|signed)|authentication/i.test(message)) {
    return errorDetail('unauthorized', { technical: `${code ?? ''} ${message}`.trim() });
  }
  if (message && /rate.?limit|quota/i.test(message)) {
    return errorDetail('rateLimited', { technical: `${code ?? ''} ${message}`.trim() });
  }
  if (message && /context|token limit/i.test(message)) {
    return errorDetail('contextExceeded', { technical: `${code ?? ''} ${message}`.trim() });
  }
  return errorDetail('internal', {
    message: message ?? 'O Codex reportou um erro sem mensagem.',
    technical: code,
  });
}
