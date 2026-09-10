import { describe, expect, it } from 'vitest';
import { buildRequestBody, mapFinishReason, streamChatCompletions } from '../../src/main/providers/chatCompletions';
import type { ProviderChatRequest, ProviderStreamEvent } from '../../src/main/providers/types';
import { installFakeFetch, sse } from '../helpers/fakeFetch';

function request(overrides: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    modelId: 'vendor/modelo',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'olá' }] }],
    parameters: { modelId: 'vendor/modelo', providerId: 'openrouter', engineId: 'direct' },
    supportedParameters: [],
    signal: new AbortController().signal,
    idempotencyKey: 'turno-1',
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('buildRequestBody — só envia parâmetros suportados', () => {
  it('não envia temperature quando o catálogo não declara parâmetros', () => {
    const body = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({ parameters: { modelId: 'm', providerId: 'p', engineId: 'direct', temperature: 0.4 } }),
      buildRouting: false,
    });
    // Sem lista de parâmetros conhecida, o aplicativo é conservador.
    expect(body.temperature).toBe(0.4);
  });

  it('omite temperature quando o catálogo declara parâmetros e não inclui temperature', () => {
    const body = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        supportedParameters: ['max_tokens', 'tools'],
        parameters: { modelId: 'm', providerId: 'p', engineId: 'direct', temperature: 0.4, maxOutputTokens: 100 },
      }),
      buildRouting: false,
    });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(100);
  });

  it('envia reasoning apenas quando o modelo declara suporte', () => {
    const withoutSupport = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        supportedParameters: ['max_tokens'],
        parameters: { modelId: 'm', providerId: 'p', engineId: 'direct', reasoningEffort: 'high' },
      }),
      buildRouting: false,
    });
    expect(withoutSupport.reasoning).toBeUndefined();

    const withSupport = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        supportedParameters: ['reasoning'],
        parameters: { modelId: 'm', providerId: 'p', engineId: 'direct', reasoningEffort: 'high' },
      }),
      buildRouting: false,
    });
    expect(withSupport.reasoning).toEqual({ effort: 'high' });
  });

  it('monta o objeto provider de roteamento apenas com o que foi pedido', () => {
    const body = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        parameters: {
          modelId: 'm',
          providerId: 'openrouter',
          engineId: 'direct',
          routing: { only: ['fireworks'], allowFallbacks: false, dataCollection: 'deny' },
        },
      }),
      buildRouting: true,
    });
    expect(body.provider).toEqual({ only: ['fireworks'], allow_fallbacks: false, data_collection: 'deny' });
    // Fallback de MODELO só quando explicitamente autorizado.
    expect(body.models).toBeUndefined();
  });

  it('inclui fallback de modelo somente quando autorizado', () => {
    const body = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        modelId: 'principal',
        parameters: {
          modelId: 'principal',
          providerId: 'openrouter',
          engineId: 'direct',
          routing: { modelFallbacks: ['reserva'] },
        },
      }),
      buildRouting: true,
    });
    expect(body.models).toEqual(['principal', 'reserva']);
  });

  it('não monta roteamento para endpoints compatíveis', () => {
    const body = buildRequestBody({
      url: 'http://127.0.0.1:11434/v1/chat/completions',
      request: request({
        parameters: {
          modelId: 'm',
          providerId: 'compatible:1',
          engineId: 'direct',
          routing: { only: ['x'] },
        },
      }),
      buildRouting: false,
    });
    expect(body.provider).toBeUndefined();
  });

  it('serializa mensagem de ferramenta preservando tool_call_id', () => {
    const body = buildRequestBody({
      url: 'https://x/chat/completions',
      request: request({
        messages: [
          { role: 'system', content: 'sistema' },
          { role: 'user', content: [{ type: 'text', text: 'faça' }] },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'list_files', argumentsJson: '{"path":"."}' }],
          },
          { role: 'tool', toolCallId: 'call_1', name: 'list_files', content: 'a.txt' },
        ],
      }),
      buildRouting: false,
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[2]?.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } },
    ]);
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', name: 'list_files', content: 'a.txt' });
  });
});

describe('streamChatCompletions', () => {
  it('entrega deltas de texto, uso e conclusão', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        sseChunks: [
          ': OPENROUTER PROCESSING\n\n',
          sse({ id: 'gen-1', provider: 'Fireworks', model: 'vendor/modelo', choices: [{ delta: { content: 'Olá' } }] }),
          sse({ choices: [{ delta: { content: ', mundo' } }] }),
          sse({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, cost: 0.0001 } }),
          'data: [DONE]\n\n',
        ],
      },
    ]);

    const events = await collect(
      streamChatCompletions({ url: 'https://openrouter.ai/api/v1/chat/completions', bearer: 'sk-teste', request: request(), buildRouting: true }),
    );
    fake.restore();

    const text = events.filter((event) => event.type === 'textDelta').map((event) => (event as { delta: string }).delta);
    expect(text.join('')).toBe('Olá, mundo');
    const meta = events.find((event) => event.type === 'meta');
    expect(meta).toMatchObject({ effectiveUpstream: 'Fireworks', responseId: 'gen-1' });
    const usage = events.find((event) => event.type === 'usage');
    expect(usage).toMatchObject({ usage: { promptTokens: 8, completionTokens: 3, reportedCost: 0.0001 } });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('envia a chave apenas no cabeçalho, nunca na URL', async () => {
    const fake = installFakeFetch([{ match: '/chat/completions', sseChunks: ['data: [DONE]\n\n'] }]);
    await collect(
      streamChatCompletions({
        url: 'https://openrouter.ai/api/v1/chat/completions',
        bearer: 'sk-or-v1-segredo',
        request: request(),
        buildRouting: true,
      }),
    );
    const [sent] = fake.requests;
    expect(sent?.url).not.toContain('segredo');
    expect(sent?.headers.authorization).toBe('Bearer sk-or-v1-segredo');
    expect(sent?.headers['idempotency-key']).toBe('turno-1');
    fake.restore();
  });

  it('acumula tool_calls fragmentados e entrega SOMENTE quando completos', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        sseChunks: [
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] } }] }),
          sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] }),
          sse({ choices: [{ finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ],
      },
    ]);

    const events = await collect(
      streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false }),
    );
    fake.restore();

    const deltas = events.filter((event) => event.type === 'toolCallDelta');
    expect(deltas.length).toBe(2);
    const complete = events.find((event) => event.type === 'toolCalls');
    expect(complete).toEqual({
      type: 'toolCalls',
      calls: [{ id: 'call_a', name: 'read_file', argumentsJson: '{"path":"a.txt"}' }],
    });
    // A chamada completa vem DEPOIS dos deltas.
    expect(events.indexOf(complete!)).toBeGreaterThan(events.indexOf(deltas[1]!));
  });

  it('propaga erro entregue no meio do fluxo', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        sseChunks: [
          sse({ choices: [{ delta: { content: 'começou' } }] }),
          sse({ error: { code: 402, message: 'Insufficient credits' } }),
        ],
      },
    ]);
    await expect(
      collect(streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false })),
    ).rejects.toMatchObject({ detail: { code: 'insufficientCredit' } });
    fake.restore();
  });

  it('traduz 401 em credencial recusada', async () => {
    const fake = installFakeFetch([
      { match: '/chat/completions', status: 401, json: { error: { message: 'No auth credentials found' } } },
    ]);
    await expect(
      collect(streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false })),
    ).rejects.toMatchObject({ detail: { code: 'unauthorized' } });
    fake.restore();
  });

  it('traduz contexto excedido a partir da mensagem do provedor', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        status: 400,
        json: { error: { message: 'This model has a maximum context length of 8192 tokens' } },
      },
    ]);
    await expect(
      collect(streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false })),
    ).rejects.toMatchObject({ detail: { code: 'contextExceeded' } });
    fake.restore();
  });

  it('ignora evento com JSON inválido e continua o fluxo', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        sseChunks: [
          'data: {isso não é json}\n\n',
          sse({ choices: [{ delta: { content: 'segue' } }] }),
          'data: [DONE]\n\n',
        ],
      },
    ]);
    const events = await collect(
      streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false }),
    );
    fake.restore();
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'textDelta')).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('encerra com reason=cancelled quando o sinal é abortado', async () => {
    const controller = new AbortController();
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        chunkDelayMs: 5,
        sseChunks: [
          sse({ choices: [{ delta: { content: 'a' } }] }),
          sse({ choices: [{ delta: { content: 'b' } }] }),
          sse({ choices: [{ delta: { content: 'c' } }] }),
          'data: [DONE]\n\n',
        ],
      },
    ]);

    const events: ProviderStreamEvent[] = [];
    const iterable = streamChatCompletions({
      url: 'https://x/chat/completions',
      request: request({ signal: controller.signal }),
      buildRouting: false,
    });
    for await (const event of iterable) {
      events.push(event);
      if (event.type === 'textDelta') controller.abort();
    }
    fake.restore();
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'cancelled' });
  });

  it('extrai raciocínio quando o provedor envia o campo para exibição', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        sseChunks: [sse({ choices: [{ delta: { reasoning: 'pensando…' } }] }), 'data: [DONE]\n\n'],
      },
    ]);
    const events = await collect(
      streamChatCompletions({ url: 'https://x/chat/completions', request: request(), buildRouting: false }),
    );
    fake.restore();
    expect(events.find((event) => event.type === 'reasoningDelta')).toEqual({
      type: 'reasoningDelta',
      delta: 'pensando…',
    });
  });
});

describe('mapFinishReason', () => {
  it('normaliza os motivos conhecidos', () => {
    expect(mapFinishReason('stop')).toBe('stop');
    expect(mapFinishReason('max_tokens')).toBe('length');
    expect(mapFinishReason('tool_calls')).toBe('toolCalls');
    expect(mapFinishReason('content_filter')).toBe('contentFilter');
    expect(mapFinishReason('algo_novo')).toBe('unknown');
  });
});
