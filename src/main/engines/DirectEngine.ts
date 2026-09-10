/**
 * Motor direto: conversa e ciclo de ferramentas sobre um `ModelProvider`.
 *
 * Ciclo de ferramentas implementado por completo:
 *  1. solicita a geração;
 *  2. reúne a chamada COMPLETA (nunca argumentos parciais de streaming);
 *  3. valida os argumentos por schema;
 *  4. obtém autorização quando exigida (via `ApprovalBroker`);
 *  5. executa a ferramenta no processo principal;
 *  6. registra o resultado;
 *  7. devolve o resultado ao modelo preservando `tool_call_id`;
 *  8. continua até a conclusão ou um limite definido.
 *
 * Limitação declarada: comandos arbitrários de shell são indisponíveis neste
 * motor (ver src/main/tools/registry.ts). Não há troca automática de motor no
 * meio de uma execução com ferramentas.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  AttachmentRef,
  CapabilityMap,
  ConversationItem,
  EffectivePolicy,
  FileDiff,
  OperationMode,
  SkillDescriptor,
  TokenUsage,
  TurnParameters,
} from '../../shared/domain';
import { ENGINE_CAPABILITIES } from '../../shared/capabilities';
import { appError, toErrorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import { PathGuard } from '../services/pathSafety';
import type { GitService } from '../services/GitService';
import type { ModelCatalog } from '../providers/ModelCatalog';
import type { ProviderRegistry } from '../providers/registry';
import { estimateCost } from '../providers/usage';
import type { ProviderChatRequest, ProviderMessage, ProviderContentPart, ProviderToolCall } from '../providers/types';
import type { ApprovalBroker } from '../tools/ApprovalBroker';
import { executeTool, toolSchemasForMode, findTool, modeLabel } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import type { ConversationRow } from '../persistence/repositories';
import type { EngineTurnRequest, ExecutionEngine, TurnSink } from './types';

export interface DirectEngineDeps {
  providers: ProviderRegistry;
  catalog: ModelCatalog;
  approvals: ApprovalBroker;
  git: GitService;
  limits(): { maxSteps: number; maxDurationMs: number; maxResultBytes: number };
  /** Instruções personalizadas da pessoa, anexadas ao prompt de sistema. */
  customInstructions?(): string | undefined;
}

export class DirectEngine implements ExecutionEngine {
  readonly id = 'direct' as const;
  readonly capabilities: CapabilityMap = ENGINE_CAPABILITIES.direct;

  /** Turnos ativos por conversa, para interrupção. */
  private readonly active = new Map<string, { abort: AbortController; turnId: string }>();

  constructor(private readonly deps: DirectEngineDeps) {}

  async ensureReady(): Promise<void> {
    // O motor direto não tem processo externo; a prontidão é por provedor.
  }

  async openConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }> {
    const provider = this.deps.providers.get(conversation.providerId);
    if (!provider) {
      throw appError('validation', {
        message: `O provedor "${conversation.providerId}" não está disponível para o motor direto.`,
        action: 'Escolha o OpenRouter ou um endpoint compatível cadastrado.',
      });
    }
    sink.status('ready');
    return {};
  }

  async resumeConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }> {
    // O histórico local é a autoridade neste motor.
    return this.openConversation(conversation, sink);
  }

  effectivePolicy(conversation: ConversationRow, mode: OperationMode): EffectivePolicy {
    const hasWorkspace = typeof conversation.workspacePath === 'string' && conversation.workspacePath !== '';
    return {
      mode,
      approvals: 'onRequest',
      sandbox: mode === 'execute' && hasWorkspace ? 'workspaceWrite' : 'readOnly',
      // Rede das FERRAMENTAS: nenhuma ferramenta do motor direto acessa a rede.
      toolNetwork: 'blocked',
      // Rede da INFERÊNCIA: necessária para falar com o provedor.
      inferenceNetwork: this.deps.providers.isLocalProvider(conversation.providerId) ? 'workspaceAllowed' : 'allowed',
      confirmedByRuntime: true,
      note:
        mode === 'execute' && !hasWorkspace
          ? 'Sem workspace selecionado, alterações de arquivo continuam indisponíveis.'
          : mode === 'execute'
            ? 'Execução de comandos arbitrários indisponível neste motor; ferramentas estruturadas de arquivo e Git estão ativas.'
            : undefined,
    };
  }

  async listSkills(): Promise<SkillDescriptor[]> {
    // Skills nativas são um recurso do Codex. No motor direto, elas só
    // fornecem instruções e referências — nunca execução automática.
    return [];
  }

  async steer(): Promise<boolean> {
    // Não há protocolo de orientação no meio do turno neste motor.
    return false;
  }

  async interrupt(conversation: ConversationRow): Promise<boolean> {
    const entry = this.active.get(conversation.id);
    if (!entry) return false;
    entry.abort.abort();
    this.deps.approvals.cancelForConversation(conversation.id, 'Turno interrompido pela pessoa.');
    return true;
  }

  async closeConversation(conversation: ConversationRow): Promise<void> {
    const entry = this.active.get(conversation.id);
    if (entry) entry.abort.abort();
    this.active.delete(conversation.id);
  }

  /* ------------------------------------------------------------------ *
   * Turno
   * ------------------------------------------------------------------ */

  async runTurn(request: EngineTurnRequest): Promise<void> {
    const { conversation, sink, parameters, mode } = request;
    const provider = this.deps.providers.require(conversation.providerId);
    const limits = this.deps.limits();
    const startedAt = Date.now();

    const abort = new AbortController();
    const onOuterAbort = (): void => abort.abort();
    request.signal.addEventListener('abort', onOuterAbort, { once: true });
    this.active.set(conversation.id, { abort, turnId: request.turnId });

    const model = this.deps.catalog.find(conversation.providerId, parameters.modelId);
    const supportedParameters = model?.supportedParameters ?? [];
    const toolsAvailable = mode !== 'chat' && this.toolCallingUsable(model?.capabilities);
    const toolSchemas = toolsAvailable ? toolSchemasForMode(mode) : undefined;

    const guard = conversation.workspacePath ? new PathGuard(conversation.workspacePath) : null;
    const messages = await this.buildMessages(request, guard, model?.capabilities);

    sink.status('running');
    sink.policy(request.policy);

    if (mode !== 'chat' && !toolsAvailable) {
      sink.itemStarted({
        role: 'system',
        kind: 'notice',
        status: 'completed',
        text:
          `O modelo selecionado não declara suporte a chamada de ferramentas, então o modo ${modeLabel(mode)} ` +
          'funciona apenas como conversa. Escolha um modelo com `tools` no catálogo para usar as ferramentas.',
      });
    }

    let totalUsage: TokenUsage | undefined;
    let effectiveUpstream: string | undefined;
    const accumulatedDiffs: FileDiff[] = [];
    let step = 0;

    try {
      for (;;) {
        step += 1;
        if (step > limits.maxSteps) {
          throw appError('toolLimit', {
            message: `O ciclo de ferramentas atingiu o limite de ${limits.maxSteps} passos.`,
            action: 'Aumente o limite em Configurações › Ferramentas ou divida a tarefa em etapas menores.',
          });
        }
        if (Date.now() - startedAt > limits.maxDurationMs) {
          throw appError('toolLimit', {
            message: `O turno excedeu o limite de duração (${Math.round(limits.maxDurationMs / 1000)}s).`,
            action: 'Aumente o limite em Configurações › Ferramentas ou reduza o escopo do pedido.',
          });
        }
        abort.signal.throwIfAborted();

        const messageItemId = sink.newItemId();
        let reasoningItemId: string | null = null;
        let textStarted = false;
        let sawText = false;
        const collected: ProviderToolCall[] = [];
        let reasoningText = '';
        let assistantText = '';
        // Uso DESTE passo: é o que fica registrado na mensagem. O acumulado
        // do turno vai para `sink.usage`.
        let stepUsage: TokenUsage | undefined;

        const chatRequest: ProviderChatRequest = {
          modelId: parameters.modelId,
          messages,
          tools: toolSchemas,
          parameters,
          supportedParameters,
          signal: abort.signal,
          // Chave por PASSO: uma reconexão não gera duas cobranças do mesmo passo.
          idempotencyKey: `${request.turnId}-${step}`,
        };

        for await (const event of provider.streamChat(chatRequest)) {
          abort.signal.throwIfAborted();
          switch (event.type) {
            case 'meta':
              if (event.effectiveUpstream) effectiveUpstream = event.effectiveUpstream;
              break;
            case 'textDelta':
              if (!textStarted) {
                textStarted = true;
                sink.itemStarted({
                  id: messageItemId,
                  role: 'assistant',
                  kind: 'agentMessage',
                  status: 'streaming',
                  text: '',
                  modelId: parameters.modelId,
                  providerId: conversation.providerId,
                  engineId: 'direct',
                });
              }
              sawText = true;
              assistantText += event.delta;
              sink.textDelta(messageItemId, event.delta);
              break;
            case 'reasoningDelta':
              // Só exibimos o que a API entrega para exibição. Nada é reconstruído.
              if (reasoningItemId === null) {
                reasoningItemId = sink.newItemId();
                sink.itemStarted({
                  id: reasoningItemId,
                  role: 'assistant',
                  kind: 'reasoningSummary',
                  status: 'streaming',
                  text: '',
                  modelId: parameters.modelId,
                  providerId: conversation.providerId,
                  engineId: 'direct',
                });
              }
              reasoningText += event.delta;
              sink.reasoningDelta(reasoningItemId, event.delta);
              break;
            case 'toolCallDelta':
              // Deltas de argumentos NÃO são executados.
              break;
            case 'toolCalls':
              collected.push(...event.calls);
              break;
            case 'usage':
              stepUsage = mergeUsage(stepUsage, estimateCost(event.usage, model ?? undefined));
              totalUsage = mergeUsage(totalUsage, estimateCost(event.usage, model ?? undefined));
              if (totalUsage) sink.usage(totalUsage);
              break;
            case 'finish':
              break;
            case 'error':
              sink.error(event.error);
              break;
            default:
              break;
          }
        }

        if (reasoningItemId !== null) {
          sink.itemCompleted(reasoningItemId, { text: reasoningText, status: 'completed' });
        }
        if (textStarted) {
          sink.itemCompleted(messageItemId, {
            text: assistantText,
            status: 'completed',
            usage: stepUsage,
            effectiveUpstream,
          });
        }

        if (collected.length === 0) {
          if (!sawText) {
            sink.itemStarted({
              role: 'assistant',
              kind: 'notice',
              status: 'completed',
              text: 'O modelo encerrou o turno sem produzir texto.',
            });
          }
          break;
        }

        // Registra a mensagem do assistente COM as chamadas, preservando os IDs.
        messages.push({ role: 'assistant', content: assistantText, toolCalls: collected });

        for (const call of collected) {
          abort.signal.throwIfAborted();
          const definition = findTool(call.name);
          const toolItemId = sink.newItemId();
          sink.itemStarted({
            id: toolItemId,
            role: 'tool',
            kind: 'toolCall',
            status: 'pending',
            engineId: 'direct',
            providerId: conversation.providerId,
            tool: {
              toolName: call.name,
              callId: call.id,
              arguments: safeParse(call.argumentsJson),
            },
          });

          if (!guard || !conversation.workspacePath) {
            const message =
              'Nenhum workspace está vinculado a esta conversa, então as ferramentas de arquivo e Git não podem ser usadas.';
            sink.itemCompleted(toolItemId, {
              status: 'failed',
              tool: { toolName: call.name, callId: call.id, error: message },
            });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: `ERRO: ${message}` });
            continue;
          }

          const ctx: ToolContext = {
            conversationId: conversation.id,
            turnId: request.turnId,
            workspacePath: conversation.workspacePath,
            guard,
            policy: request.policy,
            mode,
            approvals: this.deps.approvals,
            git: this.deps.git,
            signal: abort.signal,
            maxResultBytes: limits.maxResultBytes,
          };

          const startedTool = Date.now();
          if (definition?.mutating) sink.status('awaitingApproval');
          const outcome = await executeTool(call.name, call.argumentsJson, ctx);
          const durationMs = Date.now() - startedTool;
          sink.status('running');

          if (outcome.error) {
            const text = `ERRO: ${outcome.error.message}${outcome.error.action ? ` ${outcome.error.action}` : ''}`;
            sink.itemCompleted(toolItemId, {
              status: 'failed',
              tool: { toolName: call.name, callId: call.id, error: outcome.error.message, durationMs },
            });
            messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: text });
            continue;
          }

          const result = outcome.result;
          if (result?.diffs?.length) {
            accumulatedDiffs.push(...result.diffs);
            sink.diffUpdated(dedupeDiffs(accumulatedDiffs));
          }
          sink.itemCompleted(toolItemId, {
            status: 'completed',
            tool: {
              toolName: call.name,
              callId: call.id,
              arguments: safeParse(call.argumentsJson),
              result: result?.data,
              durationMs,
            },
            fileChange: result?.diffs?.length ? { files: result.diffs } : undefined,
          });
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: result?.content ?? '(sem conteúdo)',
          });
        }
      }

      sink.turnCompleted(totalUsage, effectiveUpstream);
      sink.status('completed');
    } catch (err) {
      if (abort.signal.aborted) {
        sink.turnCancelled('Turno interrompido.');
        sink.status('cancelled');
        return;
      }
      const detail = toErrorDetail(err, 'internal');
      this.deps.catalog.applyErrorObservation(
        conversation.providerId,
        parameters.modelId,
        detail.code,
        detail.technical ?? detail.message,
      );
      logger.warn('direct-engine', 'Turno falhou', { code: detail.code, conversationId: conversation.id });
      sink.turnFailed(detail);
      sink.status('error');
    } finally {
      request.signal.removeEventListener('abort', onOuterAbort);
      this.active.delete(conversation.id);
    }
  }

  private toolCallingUsable(capabilities: CapabilityMap | undefined): boolean {
    const state = capabilities?.toolCalling?.state;
    // `unknown` é tentado: o provedor decide. `unsupported` não é tentado.
    return state !== 'unsupported';
  }

  /* ------------------------------------------------------------------ *
   * Montagem do contexto
   * ------------------------------------------------------------------ */

  private async buildMessages(
    request: EngineTurnRequest,
    guard: PathGuard | null,
    capabilities: CapabilityMap | undefined,
  ): Promise<ProviderMessage[]> {
    const messages: ProviderMessage[] = [];
    messages.push({ role: 'system', content: this.systemPrompt(request) });

    for (const item of request.history) {
      if (item.kind === 'userMessage' && item.text) {
        messages.push({ role: 'user', content: [{ type: 'text', text: item.text }] });
      } else if (item.kind === 'agentMessage' && item.text) {
        messages.push({ role: 'assistant', content: item.text });
      }
      // Itens técnicos de turnos anteriores (ferramentas, comandos) não são
      // reenviados: seus IDs pertencem a requisições encerradas.
    }

    const parts: ProviderContentPart[] = [];
    if (request.text.trim() !== '') parts.push({ type: 'text', text: request.text });

    for (const attachment of request.attachments) {
      const part = await this.attachmentToPart(attachment, guard, capabilities);
      if (part) parts.push(part);
    }
    if (parts.length === 0) parts.push({ type: 'text', text: '(mensagem vazia)' });
    messages.push({ role: 'user', content: parts });
    return messages;
  }

  private systemPrompt(request: EngineTurnRequest): string {
    const lines = [
      'Você é o assistente do Codex Hub, um aplicativo desktop de programação.',
      'Responda em português do Brasil, de forma direta e técnica.',
      `Modo atual: ${modeLabel(request.mode)}.`,
    ];
    if (request.mode === 'chat') {
      lines.push('Neste modo não há ferramentas: nenhuma leitura ou alteração de arquivo é possível.');
    }
    if (request.mode === 'plan') {
      lines.push(
        'Neste modo você pode LER o workspace com as ferramentas autorizadas, mas não pode alterar arquivos.',
      );
    }
    if (request.mode === 'execute') {
      lines.push(
        'Neste modo você pode ler e propor alterações estruturadas de arquivo. Cada alteração passa por aprovação da pessoa.',
        'Execução de comandos arbitrários NÃO está disponível neste motor. Não sugira que executou comandos.',
      );
    }
    if (request.conversation.workspacePath) {
      lines.push(`Workspace autorizado: ${request.conversation.workspacePath}`);
      lines.push('Use caminhos relativos ao workspace nas ferramentas.');
    } else {
      lines.push('Nenhum workspace está vinculado: as ferramentas de arquivo e Git estão indisponíveis.');
    }
    const skills = request.skills.filter((s) => s.enabledLocally);
    if (skills.length > 0) {
      lines.push('', 'Instruções adicionais selecionadas pela pessoa (skills):');
      for (const skill of skills) {
        lines.push(`- ${skill.name}${skill.description ? `: ${skill.description}` : ''}`);
      }
      lines.push(
        'Estas skills fornecem orientação textual. Elas não concedem novas capacidades nem execução automática.',
      );
    }
    if (request.parameters.personality) {
      lines.push('', `Estilo pedido: ${request.parameters.personality}.`);
    }
    const custom = this.deps.customInstructions?.()?.trim();
    if (custom) {
      lines.push(
        '',
        'Instruções personalizadas da pessoa (definidas em Configurações). Elas orientam estilo e conteúdo, mas não concedem novas capacidades nem anulam as regras acima:',
        custom,
      );
    }
    return lines.join('\n');
  }

  private async attachmentToPart(
    attachment: AttachmentRef,
    guard: PathGuard | null,
    capabilities: CapabilityMap | undefined,
  ): Promise<ProviderContentPart | null> {
    if (!attachment.absolutePath || !guard) {
      return {
        type: 'text',
        text: `[Anexo "${attachment.fileName}" indisponível: sem caminho autorizado no workspace.]`,
      };
    }
    const safe = guard.tryResolve(attachment.absolutePath);
    if (!safe) {
      return {
        type: 'text',
        text: `[Anexo "${attachment.fileName}" recusado: está fora das raízes autorizadas do workspace.]`,
      };
    }

    if (attachment.kind === 'image') {
      if (capabilities?.imageInput?.state === 'unsupported') {
        return {
          type: 'text',
          text: `[A imagem "${attachment.fileName}" não foi enviada: o modelo selecionado não declara entrada de imagem.]`,
        };
      }
      try {
        const buffer = await readFile(safe.realPath);
        const mime = attachment.mimeType ?? 'image/png';
        return { type: 'imageUrl', url: `data:${mime};base64,${buffer.toString('base64')}` };
      } catch (err) {
        return {
          type: 'text',
          text: `[Falha ao ler a imagem "${attachment.fileName}": ${err instanceof Error ? err.message : String(err)}]`,
        };
      }
    }

    // Documentos e código: extração local. Um caminho local NÃO dá acesso ao
    // arquivo ao provedor remoto.
    const delivery = attachment.delivery;
    if (delivery?.type === 'extractedText') {
      try {
        const text = await readFile(safe.realPath, 'utf8');
        return {
          type: 'text',
          text: `[Conteúdo extraído de "${attachment.fileName}"]\n${text.slice(0, 200_000)}`,
        };
      } catch {
        return { type: 'text', text: `[Não foi possível reler "${attachment.fileName}".]` };
      }
    }
    if (delivery?.type === 'failed') {
      return { type: 'text', text: `[Anexo "${attachment.fileName}" não pôde ser preparado: ${delivery.reason}]` };
    }
    return {
      type: 'text',
      text: `[O arquivo "${attachment.fileName}" está disponível no workspace em ${safe.relativePath}. Use read_file para ler o conteúdo.]`,
    };
  }
}

function mergeUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    promptTokens: sum(current.promptTokens, next.promptTokens),
    completionTokens: sum(current.completionTokens, next.completionTokens),
    reasoningTokens: sum(current.reasoningTokens, next.reasoningTokens),
    totalTokens: sum(current.totalTokens, next.totalTokens),
    reportedCost: sum(current.reportedCost, next.reportedCost),
    estimatedCost: sum(current.estimatedCost, next.estimatedCost),
    estimateBasis: next.estimateBasis ?? current.estimateBasis,
    currency: next.currency ?? current.currency,
  };
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function dedupeDiffs(diffs: FileDiff[]): FileDiff[] {
  const byPath = new Map<string, FileDiff>();
  for (const diff of diffs) byPath.set(diff.path, diff);
  return [...byPath.values()];
}

/** Exposto para testes: gera IDs de turno. */
export function newTurnId(): string {
  return randomUUID();
}

/** Parâmetros efetivos, filtrando o que o modelo não suporta. */
export function effectiveParameters(
  requested: TurnParameters,
  capabilities: CapabilityMap | undefined,
): TurnParameters {
  const next: TurnParameters = { ...requested };
  if (capabilities?.reasoningEffort?.state === 'unsupported') delete next.reasoningEffort;
  if (capabilities?.temperature?.state === 'unsupported') delete next.temperature;
  if (capabilities?.personality?.state === 'unsupported') delete next.personality;
  return next;
}

export type { ConversationItem };
