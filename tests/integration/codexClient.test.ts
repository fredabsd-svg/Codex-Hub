import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, type CodexClientCallbacks } from '../../src/main/codex/CodexAppServerClient';
import { FakeCodexTransport, tick } from '../helpers/fakeCodexTransport';

function makeCallbacks(overrides: Partial<CodexClientCallbacks> = {}): {
  callbacks: CodexClientCallbacks;
  notifications: Array<{ method: string; params: unknown; generation: number }>;
  states: string[];
  stderr: string[];
  reconnects: number[];
} {
  const notifications: Array<{ method: string; params: unknown; generation: number }> = [];
  const states: string[] = [];
  const stderr: string[] = [];
  const reconnects: number[] = [];
  const callbacks: CodexClientCallbacks = {
    onNotification: (method, params, generation) => {
      notifications.push({ method, params, generation });
    },
    onServerRequest: async () => ({ decision: 'approved' }),
    onStateChange: (state) => {
      states.push(state);
    },
    onStderr: (text) => {
      stderr.push(text);
    },
    onReconnected: (generation) => {
      reconnects.push(generation);
    },
    ...overrides,
  };
  return { callbacks, notifications, states, stderr, reconnects };
}

describe('CodexAppServerClient — handshake', () => {
  it('envia initialize, aguarda a resposta e só então envia initialized', async () => {
    const transport = new FakeCodexTransport({ handshakeDelayMs: 5 });
    const { callbacks, states } = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'codex-hub', title: 'Codex Hub', version: '0.1.0' },
      callbacks,
    });

    const started = client.start();
    // Antes da resposta, `initialized` ainda não foi enviado.
    await tick(1);
    expect(transport.sentMethods()).toEqual(['initialize']);

    await started;
    expect(transport.sentMethods()).toEqual(['initialize', 'initialized']);
    expect(client.isReady).toBe(true);
    expect(states).toContain('handshaking');
    expect(states).toContain('ready');

    const initialize = transport.sent()[0];
    expect(initialize?.method).toBe('initialize');
    expect((initialize?.params as { clientInfo: { name: string; title: string; version: string } }).clientInfo).toEqual({
      name: 'codex-hub',
      title: 'Codex Hub',
      version: '0.1.0',
    });
  });

  it('recusa operações antes do handshake concluir', async () => {
    const transport = new FakeCodexTransport({ autoHandshake: false });
    const { callbacks } = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks,
      handshakeTimeoutMs: 50,
    });
    void client.start().catch(() => undefined);
    await tick(1);
    await expect(client.request('thread/start')).rejects.toMatchObject({
      detail: { code: 'protocol' },
    });
  });

  it('falha com erro de domínio quando o handshake estoura o tempo', async () => {
    const transport = new FakeCodexTransport({ autoHandshake: false });
    const { callbacks } = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks,
      handshakeTimeoutMs: 20,
    });
    await expect(client.start()).rejects.toMatchObject({ detail: { code: 'timeout' } });
    expect(client.currentState).toBe('failed');
  });

  it('refaz o handshake em cada nova conexão', async () => {
    let transport = new FakeCodexTransport();
    const { callbacks } = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => {
        transport = new FakeCodexTransport();
        return transport;
      },
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks,
      delay: async () => undefined,
    });
    await client.start();
    const firstGeneration = client.currentGeneration;
    await client.stop();
    await client.start();
    expect(client.currentGeneration).toBeGreaterThan(firstGeneration);
    expect(transport.sentMethods()).toEqual(['initialize', 'initialized']);
  });
});

describe('CodexAppServerClient — correlação e erros', () => {
  async function readyClient(overrides: Partial<CodexClientCallbacks> = {}): Promise<{
    client: CodexAppServerClient;
    transport: FakeCodexTransport;
    helpers: ReturnType<typeof makeCallbacks>;
  }> {
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks(overrides);
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
      requestTimeoutMs: 60,
      delay: async () => undefined,
    });
    await client.start();
    return { client, transport, helpers };
  }

  it('correlaciona respostas por id, mesmo fora de ordem', async () => {
    const { client, transport } = await readyClient();
    const first = client.request<{ n: number }>('a');
    const second = client.request<{ n: number }>('b');
    await tick(1);
    const idA = transport.lastRequestId('a');
    const idB = transport.lastRequestId('b');
    // Responde na ordem inversa.
    transport.emitJson({ id: idB, result: { n: 2 } });
    transport.emitJson({ id: idA, result: { n: 1 } });
    await expect(first).resolves.toEqual({ n: 1 });
    await expect(second).resolves.toEqual({ n: 2 });
    expect(client.pendingCount).toBe(0);
  });

  it('avisa quando o método não existe na versão instalada', async () => {
    const { client, transport } = await readyClient();
    const pending = client.request('thread/rename');
    await tick(1);
    transport.emitJson({
      id: transport.lastRequestId('thread/rename'),
      error: { code: -32601, message: 'method not found' },
    });
    await expect(pending).rejects.toMatchObject({
      detail: { code: 'codexIncompatible' },
    });
  });

  it('estoura o tempo e limpa a promessa pendente', async () => {
    const { client } = await readyClient();
    await expect(client.request('lento')).rejects.toMatchObject({ detail: { code: 'timeout' } });
    expect(client.pendingCount).toBe(0);
  });

  it('rejeita todas as pendências quando o processo morre e NÃO reexecuta nada', async () => {
    const { client, transport } = await readyClient();
    const pending = client.request('turn/start');
    await tick(1);
    expect(transport.sentMethods().filter((method) => method === 'turn/start')).toHaveLength(1);
    transport.emitExit(1, null);
    await expect(pending).rejects.toMatchObject({ detail: { code: 'protocol' } });
    await tick(10);
    // A reconexão refaz o handshake, mas a operação MUTÁVEL não é reenviada.
    expect(transport.sentMethods().filter((method) => method === 'turn/start')).toHaveLength(1);
  });

  it('descarta resposta de uma conexão antiga', async () => {
    let current = new FakeCodexTransport();
    const helpers = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => {
        current = new FakeCodexTransport();
        return current;
      },
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
      requestTimeoutMs: 60,
      delay: async () => undefined,
    });
    await client.start();
    const oldTransport = current;
    const pending = client.request('a');
    await tick(1);
    const oldId = oldTransport.lastRequestId('a');

    // Nova conexão: a geração muda.
    await client.stop();
    await expect(pending).rejects.toMatchObject({ detail: { code: 'cancelled' } });
    await client.start();

    // A resposta antiga chegando na conexão nova é ignorada sem lançar.
    expect(() => oldTransport.emitJson({ id: oldId, result: { tarde: true } })).not.toThrow();
    expect(client.pendingCount).toBe(0);
  });
});

describe('CodexAppServerClient — requisições iniciadas pelo servidor', () => {
  it('responde no id original com o resultado do handler', async () => {
    const onServerRequest = vi.fn(async () => ({ decision: 'approved' }));
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks({ onServerRequest });
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
    });
    await client.start();

    transport.emitJson({ id: 99, method: 'execCommandApproval', params: { command: 'ls' } });
    await tick(2);

    expect(onServerRequest).toHaveBeenCalledWith('execCommandApproval', { command: 'ls' }, client.currentGeneration);
    const response = transport.sent().find((message) => message.id === 99 && 'result' in message);
    expect(response?.result).toEqual({ decision: 'approved' });
  });

  it('responde com erro quando o handler lança', async () => {
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks({
      onServerRequest: async () => {
        throw new Error('sem permissão');
      },
    });
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
    });
    await client.start();
    transport.emitJson({ id: 5, method: 'applyPatchApproval', params: {} });
    await tick(2);
    const response = transport.sent().find((message) => message.id === 5 && 'error' in message);
    expect(response).toBeDefined();
  });

  it('preserva a ordem das notificações mesmo com handler assíncrono', async () => {
    const order: string[] = [];
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks({
      onNotification: async (method) => {
        // Handler lento e desigual: a ordem precisa ser mantida pela fila.
        await tick(method === 'primeiro' ? 8 : 1);
        order.push(method);
      },
    });
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
    });
    await client.start();

    transport.emitJson({ method: 'primeiro' });
    transport.emitJson({ method: 'segundo' });
    transport.emitJson({ method: 'terceiro' });
    await tick(40);
    expect(order).toEqual(['primeiro', 'segundo', 'terceiro']);
  });

  it('linha inválida do servidor não derruba o cliente', async () => {
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
    });
    await client.start();
    expect(() => transport.emitLine('{isso não é json}')).not.toThrow();
    expect(client.isReady).toBe(true);
  });

  it('encaminha stderr para diagnóstico', async () => {
    const transport = new FakeCodexTransport();
    const helpers = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => transport,
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
    });
    await client.start();
    transport.emitStderr('aviso do runtime');
    expect(helpers.stderr).toContain('aviso do runtime');
  });
});

describe('CodexAppServerClient — reinício', () => {
  it('reinicia com atraso progressivo e reconcilia sem replay', async () => {
    const transports: FakeCodexTransport[] = [];
    const delays: number[] = [];
    const helpers = makeCallbacks();
    const client = new CodexAppServerClient({
      createTransport: () => {
        const transport = new FakeCodexTransport();
        transports.push(transport);
        return transport;
      },
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
      delay: async (ms) => {
        delays.push(ms);
      },
      maxRestarts: 3,
    });

    await client.start();
    const first = transports[0] as FakeCodexTransport;
    first.emitExit(1, null);
    await tick(5);

    expect(transports.length).toBeGreaterThan(1);
    expect(delays[0]).toBe(500);
    expect(helpers.reconnects.length).toBe(1);
    // A nova conexão refaz o handshake e nada mais.
    expect((transports[1] as FakeCodexTransport).sentMethods()).toEqual(['initialize', 'initialized']);
  });

  it('para de tentar após o limite e reporta diagnóstico', async () => {
    const helpers = makeCallbacks();
    let created = 0;
    const client = new CodexAppServerClient({
      createTransport: () => {
        created += 1;
        if (created === 1) return new FakeCodexTransport();
        // A partir da segunda tentativa, o processo nem inicia.
        return new FakeCodexTransport({ failStart: new Error('spawn ENOENT') });
      },
      clientInfo: { name: 'c', title: 'C', version: '1' },
      callbacks: helpers.callbacks,
      delay: async () => undefined,
      maxRestarts: 2,
    });
    await client.start();
    (client as unknown as { transport: FakeCodexTransport }).transport.emitExit(1, null);
    await tick(20);
    expect(client.currentState).toBe('failed');
    expect(client.diagnostic?.code).toBe('codexIncompatible');
  });
});
