/**
 * Testes com CREDENCIAL REAL do OpenRouter.
 *
 * Não rodam em `npm test`. Só por `npm run test:live`, e apenas quando
 * `OPENROUTER_API_KEY` e `OPENROUTER_LIVE_MODEL` estão definidos.
 *
 * Sem essas variáveis os testes são IGNORADOS explicitamente — nunca marcados
 * como sucesso. Se a conta não tiver saldo ou acesso ao modelo, a falha é
 * reportada como falha, não escondida.
 */

import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../../src/main/providers/OpenRouterProvider';
import type { ProviderStreamEvent } from '../../src/main/providers/types';

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const modelId = process.env.OPENROUTER_LIVE_MODEL?.trim();
const enabled = Boolean(apiKey && modelId);

if (!enabled) {
  console.warn(
    '[live] OPENROUTER_API_KEY e/ou OPENROUTER_LIVE_MODEL não definidos: a suíte com credencial real foi IGNORADA (não aprovada).',
  );
}

describe.skipIf(!enabled)('OpenRouter com credencial real', () => {
  const provider = new OpenRouterProvider({ getSecret: () => apiKey, appTitle: 'Codex Hub (testes)' });

  it('valida a credencial', async () => {
    const connection = await provider.testConnection();
    expect(connection.state).toBe('connected');
  });

  it('descobre o catálogo e encontra o modelo configurado', async () => {
    const page = await provider.listModels({});
    expect(page.models.length).toBeGreaterThan(0);
    const found = page.models.find((model) => model.id === modelId);
    expect(found, `o modelo ${modelId} não está no catálogo desta credencial`).toBeDefined();
  });

  it('conversa com streaming e conclui', async () => {
    const page = await provider.listModels({});
    const model = page.models.find((entry) => entry.id === modelId);
    const events: ProviderStreamEvent[] = [];
    const controller = new AbortController();

    for await (const event of provider.streamChat({
      modelId: modelId as string,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Responda apenas: pronto' }] }],
      parameters: {
        modelId: modelId as string,
        providerId: 'openrouter',
        engineId: 'direct',
        maxOutputTokens: 32,
      },
      supportedParameters: model?.supportedParameters ?? [],
      signal: controller.signal,
      idempotencyKey: `live-${Date.now()}`,
    })) {
      events.push(event);
    }

    const text = events
      .filter((event) => event.type === 'textDelta')
      .map((event) => (event as { delta: string }).delta)
      .join('');
    expect(text.length).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('interrompe o streaming quando o sinal é abortado', async () => {
    const controller = new AbortController();
    const events: ProviderStreamEvent[] = [];
    for await (const event of provider.streamChat({
      modelId: modelId as string,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Escreva um parágrafo longo sobre compiladores.' }] }],
      parameters: { modelId: modelId as string, providerId: 'openrouter', engineId: 'direct' },
      supportedParameters: [],
      signal: controller.signal,
      idempotencyKey: `live-abort-${Date.now()}`,
    })) {
      events.push(event);
      if (event.type === 'textDelta') controller.abort();
    }
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'cancelled' });
  });

  it('lê uso quando a credencial tem acesso a esses dados', async () => {
    const usage = await provider.readUsage();
    // Não exigimos saldo: exigimos que o aplicativo diga o que NÃO obteve.
    if (!usage.balance) {
      expect(usage.unavailable?.length ?? 0).toBeGreaterThan(0);
    } else {
      expect(usage.balance.currency).toBe('USD');
    }
  });
});
