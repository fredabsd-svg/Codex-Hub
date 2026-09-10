import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A guarda de IPC é testada com um `ipcMain` falso: registramos handlers,
 * disparamos chamadas como se viessem do renderer e verificamos remetente,
 * validação de schema, limite de frequência e serialização de erro.
 */

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
}));

const { registerHandler, resetRateLimits } = await import('../../src/main/ipc/guard');
const { appError } = await import('../../src/shared/errors');

const authorizedSender = { id: 1 };
const otherSender = { id: 2 };

const policy = {
  isAuthorized: (contents: { id: number }) => contents.id === authorizedSender.id,
};

function invokeAs(channel: string, sender: { id: number }, payload: unknown, frameParent: unknown = null): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`canal não registrado: ${channel}`);
  return handler({ sender, senderFrame: { parent: frameParent } }, payload) as Promise<unknown>;
}

beforeEach(() => {
  handlers.clear();
  resetRateLimits();
});

describe('registerHandler', () => {
  it('devolve envelope de sucesso com os dados', async () => {
    registerHandler('settings:get', policy as never, () => ({ theme: 'dark' }));
    await expect(invokeAs('settings:get', authorizedSender, undefined)).resolves.toEqual({
      ok: true,
      data: { theme: 'dark' },
    });
  });

  it('recusa remetente não autorizado', async () => {
    registerHandler('settings:get', policy as never, () => ({ theme: 'dark' }));
    const result = (await invokeAs('settings:get', otherSender, undefined)) as { ok: boolean; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('forbidden');
  });

  it('recusa chamada vinda de subframe', async () => {
    registerHandler('settings:get', policy as never, () => ({ theme: 'dark' }));
    const result = (await invokeAs('settings:get', authorizedSender, undefined, { id: 'pai' })) as {
      ok: boolean;
      error: { message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.message).toContain('subframes');
  });

  it('valida o payload por schema antes de chamar o handler', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    registerHandler('conversations:rename', policy as never, handler);
    const result = (await invokeAs('conversations:rename', authorizedSender, { conversationId: 'c1' })) as {
      ok: boolean;
      error: { code: string; technical?: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('validation');
    expect(handler).not.toHaveBeenCalled();
  });

  it('entrega o payload já validado ao handler', async () => {
    const handler = vi.fn((input: unknown) => input);
    registerHandler('conversations:rename', policy as never, handler);
    await invokeAs('conversations:rename', authorizedSender, { conversationId: 'c1', title: 'Novo' });
    expect(handler).toHaveBeenCalledWith({ conversationId: 'c1', title: 'Novo' }, expect.anything());
  });

  it('serializa erro de domínio com mensagem e ação em pt-BR', async () => {
    registerHandler('turn:send', policy as never, () => {
      throw appError('unauthorized');
    });
    const result = (await invokeAs('turn:send', authorizedSender, { conversationId: 'c1', text: 'oi' })) as {
      ok: boolean;
      error: { code: string; message: string; action?: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unauthorized');
    expect(result.error.action).toContain('Configurações');
  });

  it('não deixa erro inesperado escapar como exceção', async () => {
    registerHandler('settings:get', policy as never, () => {
      throw new Error('boom');
    });
    const result = (await invokeAs('settings:get', authorizedSender, undefined)) as { ok: boolean; error: { code: string } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('internal');
  });

  it('aplica limite de frequência em operações sensíveis', async () => {
    registerHandler('providers:registerCompatible', policy as never, () => ({ id: 'x' }));
    const payload = { label: 'x', baseUrl: 'https://api.exemplo/v1', persist: false };
    const results: Array<{ ok: boolean; error?: { code: string } }> = [];
    for (let i = 0; i < 12; i += 1) {
      results.push((await invokeAs('providers:registerCompatible', authorizedSender, payload)) as { ok: boolean });
    }
    expect(results.slice(0, 10).every((result) => result.ok)).toBe(true);
    expect(results.some((result) => result.ok === false && result.error?.code === 'validation')).toBe(true);
  });

  it('recusa registrar canal sem schema declarado', () => {
    expect(() => registerHandler('canal:inexistente' as never, policy as never, () => null)).toThrowError(
      /sem schema declarado/,
    );
  });
});
