/**
 * Cliente de streaming do endpoint Chat Completions (OpenRouter e endpoints
 * compatíveis). Transporte HTTP + SSE — completamente distinto do JSONL do
 * Codex App Server.
 *
 * Trata explicitamente:
 *  - comentários SSE (keep-alive `: OPENROUTER PROCESSING`);
 *  - fragmentação de chunks e UTF-8 dividido (via `SseParser`);
 *  - `data: [DONE]`;
 *  - erro no meio do fluxo (`{"error": …}` dentro de um evento);
 *  - deltas de `tool_calls` acumulados por índice, entregues só quando completos;
 *  - interrupção por `AbortSignal`;
 *  - `usage` do último chunk quando o provedor envia.
 */

import { appError, toErrorDetail } from '../../shared/errors';
import { SseParser } from '../util/streams';
import { httpErrorFrom, httpRequest, extractMessage } from './http';
import type {
  FinishReason,
  ProviderChatRequest,
  ProviderContentPart,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderToolCall,
} from './types';
import { usageFromRaw } from './usage';

export interface ChatCompletionsStreamOptions {
  url: string;
  bearer?: string;
  extraHeaders?: Record<string, string>;
  request: ProviderChatRequest;
  /** Quando true, monta o objeto `provider` de roteamento do OpenRouter. */
  buildRouting: boolean;
  allowInsecureLocal?: boolean;
}

/** Sem inatividade por este tempo, o stream é considerado perdido. */
const IDLE_TIMEOUT_MS = 120_000;

interface ToolCallAccumulator {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

export function serializeMessages(messages: ProviderMessage[]): unknown[] {
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return { role: 'user', content: serializeParts(message.content) };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.argumentsJson },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: message.toolCallId, name: message.name, content: message.content };
      default:
        return message;
    }
  });
}

function serializeParts(parts: ProviderContentPart[]): unknown {
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'imageUrl') {
      return { type: 'image_url', image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    return { type: 'file', file: { filename: part.fileName, file_data: part.dataUrl } };
  });
}

/**
 * Monta o corpo enviando SOMENTE parâmetros declarados como suportados.
 * Quando o catálogo não informa parâmetros, nada opcional é enviado.
 */
export function buildRequestBody(options: ChatCompletionsStreamOptions): Record<string, unknown> {
  const { request } = options;
  const supported = new Set(request.supportedParameters.map((p) => p.toLowerCase()));
  const knows = supported.size > 0;
  const body: Record<string, unknown> = {
    model: request.modelId,
    messages: serializeMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
  };

  const p = request.parameters;
  if (p.temperature !== undefined && (!knows || supported.has('temperature'))) body.temperature = p.temperature;
  if (p.topP !== undefined && (!knows || supported.has('top_p'))) body.top_p = p.topP;
  if (p.maxOutputTokens !== undefined && (!knows || supported.has('max_tokens'))) body.max_tokens = p.maxOutputTokens;

  if (p.reasoningEffort !== undefined && knows && (supported.has('reasoning') || supported.has('reasoning_effort'))) {
    body.reasoning = { effort: p.reasoningEffort, ...(p.reasoningSummary ? { exclude: false } : {}) };
  }

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    if (!knows || supported.has('tool_choice')) body.tool_choice = 'auto';
  }

  if (options.buildRouting) {
    const routing = p.routing;
    const provider: Record<string, unknown> = {};
    if (routing?.order?.length) provider.order = routing.order;
    if (routing?.only?.length) provider.only = routing.only;
    if (routing?.ignore?.length) provider.ignore = routing.ignore;
    if (routing?.allowFallbacks !== undefined) provider.allow_fallbacks = routing.allowFallbacks;
    if (routing?.requireParameters !== undefined) provider.require_parameters = routing.requireParameters;
    if (routing?.dataCollection) provider.data_collection = routing.dataCollection;
    if (routing?.sort) provider.sort = routing.sort;
    if (routing?.maxPricePromptPerToken !== undefined || routing?.maxPriceCompletionPerToken !== undefined) {
      provider.max_price = {
        ...(routing.maxPricePromptPerToken !== undefined ? { prompt: routing.maxPricePromptPerToken } : {}),
        ...(routing.maxPriceCompletionPerToken !== undefined ? { completion: routing.maxPriceCompletionPerToken } : {}),
      };
    }
    if (Object.keys(provider).length > 0) body.provider = provider;
    // Fallback de MODELO só quando autorizado explicitamente pela pessoa.
    if (routing?.modelFallbacks?.length) body.models = [request.modelId, ...routing.modelFallbacks];
  }

  return body;
}

export async function* streamChatCompletions(
  options: ChatCompletionsStreamOptions,
): AsyncGenerator<ProviderStreamEvent, void, undefined> {
  const { request } = options;
  const body = buildRequestBody(options);

  const response = await httpRequest({
    url: options.url,
    method: 'POST',
    bearer: options.bearer,
    headers: {
      Accept: 'text/event-stream',
      // Chave estável por tentativa: uma reconexão não gera nova cobrança
      // silenciosa em provedores que respeitam idempotência.
      'Idempotency-Key': request.idempotencyKey,
      ...(options.extraHeaders ?? {}),
    },
    body,
    signal: request.signal,
    timeoutMs: 15 * 60 * 1000,
    allowInsecureLocal: options.allowInsecureLocal,
  });

  if (!response.ok) {
    const raw = await response.text();
    throw httpErrorFrom(response.status, raw);
  }
  if (!response.body) {
    throw appError('protocol', { message: 'O provedor não devolveu corpo de resposta para o stream.' });
  }

  const parser = new SseParser({ maxLineLength: 4 * 1024 * 1024 });
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let finishReason: FinishReason | null = null;
  let sawUsage = false;
  let metaSent = false;
  let done = false;

  const reader = response.body.getReader();
  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
    }, IDLE_TIMEOUT_MS);
  };

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  request.signal.addEventListener('abort', onAbort, { once: true });

  try {
    resetIdle();
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      resetIdle();
      const events = parser.push(value as Uint8Array);
      for (const event of events) {
        if (event.data === '') continue; // keep-alive puro
        if (event.data.trim() === '[DONE]') {
          done = true;
          break;
        }
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          // Linha inválida no meio do fluxo: registra e segue.
          yield {
            type: 'error',
            error: toErrorDetail(
              appError('protocol', {
                message: 'Um evento do stream não pôde ser interpretado e foi ignorado.',
                technical: event.data.slice(0, 200),
              }),
            ),
          };
          continue;
        }

        // Erro entregue DENTRO do stream.
        if (payload.error) {
          const message = extractMessage(payload) ?? 'Erro reportado pelo provedor durante o streaming.';
          const status = readStatus(payload.error);
          throw status !== undefined
            ? httpErrorFrom(status, JSON.stringify(payload))
            : appError('providerUnavailable', { message, technical: JSON.stringify(payload).slice(0, 500) });
        }

        if (!metaSent) {
          metaSent = true;
          yield {
            type: 'meta',
            responseId: typeof payload.id === 'string' ? payload.id : undefined,
            effectiveUpstream: typeof payload.provider === 'string' ? payload.provider : undefined,
            modelId: typeof payload.model === 'string' ? payload.model : undefined,
          };
        }

        const usage = usageFromRaw(payload.usage);
        if (usage) {
          sawUsage = true;
          yield { type: 'usage', usage };
        }

        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        for (const choice of choices) {
          if (!choice || typeof choice !== 'object') continue;
          const c = choice as Record<string, unknown>;
          const delta = (c.delta ?? c.message) as Record<string, unknown> | undefined;
          if (delta) {
            const content = delta.content;
            if (typeof content === 'string' && content !== '') yield { type: 'textDelta', delta: content };
            else if (Array.isArray(content)) {
              for (const part of content) {
                if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
                  yield { type: 'textDelta', delta: (part as { text: string }).text };
                }
              }
            }
            const reasoning = delta.reasoning ?? delta.reasoning_content;
            if (typeof reasoning === 'string' && reasoning !== '') {
              yield { type: 'reasoningDelta', delta: reasoning };
            }
            const rawToolCalls = delta.tool_calls;
            if (Array.isArray(rawToolCalls)) {
              for (const rawCall of rawToolCalls) {
                if (!rawCall || typeof rawCall !== 'object') continue;
                const rc = rawCall as Record<string, unknown>;
                const index = typeof rc.index === 'number' ? rc.index : toolCalls.size;
                const accumulator = toolCalls.get(index) ?? { index, args: '' };
                if (typeof rc.id === 'string' && rc.id !== '') accumulator.id = rc.id;
                const fn = rc.function as Record<string, unknown> | undefined;
                if (fn) {
                  if (typeof fn.name === 'string' && fn.name !== '') accumulator.name = fn.name;
                  if (typeof fn.arguments === 'string') accumulator.args += fn.arguments;
                }
                toolCalls.set(index, accumulator);
                yield {
                  type: 'toolCallDelta',
                  index,
                  id: accumulator.id,
                  name: accumulator.name,
                  argumentsDelta: typeof fn?.arguments === 'string' ? fn.arguments : undefined,
                };
              }
            }
          }
          const reason = c.finish_reason ?? c.native_finish_reason;
          if (typeof reason === 'string' && reason !== '') finishReason = mapFinishReason(reason);
        }
      }
      if (done) break;
    }

    // Só agora as chamadas de ferramenta estão completas.
    if (toolCalls.size > 0) {
      const calls: ProviderToolCall[] = [...toolCalls.values()]
        .sort((a, b) => a.index - b.index)
        .map((acc, i) => ({
          id: acc.id ?? `call_${request.idempotencyKey}_${i}`,
          name: acc.name ?? '',
          argumentsJson: acc.args === '' ? '{}' : acc.args,
        }))
        .filter((c) => c.name !== '');
      if (calls.length > 0) {
        yield { type: 'toolCalls', calls };
        if (finishReason === null) finishReason = 'toolCalls';
      }
    }

    for (const event of parser.flush()) {
      if (event.data.trim() !== '' && event.data.trim() !== '[DONE]') {
        // Resto do buffer ao encerrar: nada a fazer além de registrar.
        continue;
      }
    }

    if (request.signal.aborted) {
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }
    if (!sawUsage) {
      // Nenhum dado oficial de uso: NÃO inventamos zero.
    }
    yield { type: 'finish', reason: finishReason ?? 'stop' };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    request.signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as Record<string, unknown>;
  const code = e.code ?? e.status;
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  if (typeof code === 'string') {
    const parsed = Number.parseInt(code, 10);
    if (Number.isFinite(parsed) && parsed >= 400 && parsed < 600) return parsed;
  }
  return undefined;
}

export function mapFinishReason(raw: string): FinishReason {
  const value = raw.toLowerCase();
  if (value === 'stop' || value === 'end_turn' || value === 'eos') return 'stop';
  if (value === 'length' || value === 'max_tokens') return 'length';
  if (value === 'tool_calls' || value === 'function_call' || value === 'tool_use') return 'toolCalls';
  if (value === 'content_filter') return 'contentFilter';
  if (value === 'error') return 'error';
  return 'unknown';
}
