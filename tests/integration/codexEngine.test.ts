import { describe, expect, it, vi } from 'vitest';
import type { ApprovalDecision } from '../../src/shared/domain';
import { CodexEngine, buildTurnInput } from '../../src/main/engines/CodexEngine';
import { ApprovalBroker } from '../../src/main/tools/ApprovalBroker';
import type { CodexRuntime } from '../../src/main/codex/CodexRuntime';
import type { ConversationRow } from '../../src/main/persistence/repositories';
import { createRecordingSink } from '../helpers/recordingSink';
import { tick } from '../helpers/fakeCodexTransport';

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  const at = new Date().toISOString();
  return {
    id: 'c1',
    title: 'Conversa',
    titleIsLocal: true,
    engineId: 'codex',
    providerId: 'codex',
    modelId: 'gpt-x',
    workspacePath: '/projetos/app',
    mode: 'execute',
    archived: false,
    favorite: false,
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    messageCount: 0,
    parameters: { modelId: 'gpt-x', providerId: 'codex', engineId: 'codex' },
    lastSeq: 0,
    ...overrides,
  };
}

interface FakeRuntime {
  runtime: CodexRuntime;
  requests: Array<{ method: string; params: unknown }>;
  setResponse(method: string, value: unknown | (() => unknown)): void;
}

function fakeRuntime(): FakeRuntime {
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses = new Map<string, unknown | (() => unknown)>([
    ['thread/start', { threadId: 'thread-1' }],
    ['turn/start', { accepted: true }],
    ['turn/interrupt', {}],
    ['turn/steer', {}],
  ]);
  const runtime = {
    isReady: true,
    generation: 1,
    info: () => ({ found: true, initialized: true, generatedTypesAreProvisional: true, restartCount: 0 }),
    start: async () => ({ found: true, initialized: true, generatedTypesAreProvisional: true, restartCount: 0 }),
    request: async (method: string, params: unknown) => {
      requests.push({ method, params });
      const response = responses.get(method);
      if (response === undefined) {
        throw Object.assign(new Error('method not found'), {
          detail: { code: 'codexIncompatible', message: `Sem ${method}`, retryable: false },
        });
      }
      return typeof response === 'function' ? (response as () => unknown)() : response;
    },
    listSkills: async () => [],
  } as unknown as CodexRuntime;

  return {
    runtime,
    requests,
    setResponse: (method, value) => responses.set(method, value),
  };
}

function engineWith(options: { onApproval?: (id: string, broker: ApprovalBroker) => void } = {}): {
  engine: CodexEngine;
  runtime: FakeRuntime;
  broker: ApprovalBroker;
  requested: Array<{ id: string; title: string; decisions: ApprovalDecision[] }>;
} {
  const runtime = fakeRuntime();
  const requested: Array<{ id: string; title: string; decisions: ApprovalDecision[] }> = [];
  const broker = new ApprovalBroker({
    onRequested: (request) => {
      requested.push({ id: request.id, title: request.title, decisions: request.allowedDecisions });
      options.onApproval?.(request.id, broker);
    },
    onResolved: () => undefined,
  });
  const engine = new CodexEngine({
    runtime: runtime.runtime,
    approvals: broker,
    developerMode: () => false,
    isPathAuthorized: () => true,
  });
  return { engine, runtime, broker, requested };
}

describe('CodexEngine — abertura de conversa', () => {
  it('inicia a thread enviando cwd, modelo e política', async () => {
    const { engine, runtime } = engineWith();
    const sink = createRecordingSink();
    const opened = await engine.openConversation(conversation(), sink);
    expect(opened.nativeThreadId).toBe('thread-1');
    expect(sink.nativeThreads).toEqual(['thread-1']);
    const params = runtime.requests[0]?.params as Record<string, unknown>;
    expect(runtime.requests[0]?.method).toBe('thread/start');
    expect(params.cwd).toBe('/projetos/app');
    expect(params.model).toBe('gpt-x');
    expect(params.sandbox).toBe('workspace-write');
    expect(params.approvalPolicy).toBe('on-request');
  });

  it('falha com mensagem clara quando o servidor não devolve threadId', async () => {
    const { engine, runtime } = engineWith();
    runtime.setResponse('thread/start', {});
    await expect(engine.openConversation(conversation(), createRecordingSink())).rejects.toMatchObject({
      detail: { code: 'protocol' },
    });
  });

  it('retoma a thread existente e cai para nova thread com AVISO quando não dá', async () => {
    const { engine, runtime } = engineWith();
    // `thread/resume` não existe nesta "versão".
    const sink = createRecordingSink();
    const resumed = await engine.resumeConversation(conversation({ nativeThreadId: 'antiga' }), sink);
    expect(resumed.nativeThreadId).toBe('thread-1');
    expect(runtime.requests.map((request) => request.method)).toEqual(['thread/resume', 'thread/start']);
    expect(sink.itemsOfKind('notice')[0]?.text).toContain('Não foi possível retomar');
  });

  it('a política do Codex é SOLICITADA, não confirmada', () => {
    const { engine } = engineWith();
    const policy = engine.effectivePolicy(conversation(), 'execute');
    expect(policy.confirmedByRuntime).toBe(false);
    expect(policy.note).toContain('não afirma que ela foi aplicada');
  });
});

describe('CodexEngine — turnos e eventos', () => {
  /**
   * Dispara o turno e devolve a promessa SEM aguardá-la: os testes emitem os
   * eventos do servidor depois de `await tick()` e só então aguardam o fim.
   */
  function startTurn(
    engine: CodexEngine,
    sink: ReturnType<typeof createRecordingSink>,
    signal?: AbortSignal,
  ): Promise<void> {
    const row = conversation();
    return engine.runTurn({
      conversation: row,
      turnId: 'turno-1',
      text: 'rode os testes',
      attachments: [],
      parameters: row.parameters,
      policy: engine.effectivePolicy(row, row.mode),
      mode: row.mode,
      history: [],
      signal: signal ?? new AbortController().signal,
      sink,
      skills: [],
    });
  }

  it('só conclui o turno quando o EVENTO de conclusão chega — não na confirmação de recebimento', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    let resolved = false;
    const promise = startTurn(engine, sink).then(() => {
      resolved = true;
    });

    // `turn/start` já respondeu, mas o turno não terminou.
    await tick(10);
    expect(resolved).toBe(false);
    expect(sink.completed).toHaveLength(0);

    engine.handleNotification('turn/completed', {
      threadId: 'thread-1',
      turnId: 'turno-1',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await promise;
    expect(resolved).toBe(true);
    expect(sink.completed[0]?.usage).toMatchObject({ promptTokens: 10, completionTokens: 5 });
  });

  it('traduz deltas de mensagem, plano e saída de comando', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);

    engine.handleNotification('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'i1', delta: 'Vou ' });
    engine.handleNotification('item/agentMessage/delta', { threadId: 'thread-1', itemId: 'i1', delta: 'rodar.' });
    engine.handleNotification('item/plan/delta', {
      threadId: 'thread-1',
      itemId: 'p1',
      plan: [
        { id: 's1', text: 'Instalar', status: 'completed' },
        { id: 's2', text: 'Testar', status: 'in_progress' },
      ],
    });
    engine.handleNotification('item/commandExecution/outputDelta', {
      threadId: 'thread-1',
      itemId: 'cmd1',
      delta: 'ok\n',
      stream: 'stdout',
    });
    engine.handleNotification('turn/diff/updated', {
      threadId: 'thread-1',
      files: [{ path: 'src/a.ts', unifiedDiff: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n' }],
    });
    await tick(2);

    expect(sink.itemsOfKind('agentMessage')[0]?.text).toBe('Vou rodar.');
    expect(sink.itemsOfKind('plan')[0]?.plan).toEqual([
      { id: 's1', text: 'Instalar', status: 'completed' },
      { id: 's2', text: 'Testar', status: 'inProgress' },
    ]);
    expect(sink.itemsOfKind('commandExecution')[0]?.command?.output).toContain('ok');
    expect(sink.diffs[0]?.[0]?.path).toBe('src/a.ts');

    engine.handleNotification('turn/completed', { threadId: 'thread-1' });
    await promise;
  });

  it('traduz falha do turno em erro de domínio', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);
    engine.handleNotification('turn/failed', {
      threadId: 'thread-1',
      error: { message: 'rate limit exceeded for this account' },
    });
    await promise;
    expect(sink.failures[0]?.code).toBe('rateLimited');
  });

  it('ignora notificação desconhecida sem quebrar', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);
    expect(() => engine.handleNotification('algo/que/nao/existe', { threadId: 'thread-1' })).not.toThrow();
    engine.handleNotification('turn/completed', { threadId: 'thread-1' });
    await promise;
  });

  it('recusa dois turnos concorrentes na mesma conversa', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    const first = startTurn(engine, sink);
    await tick(10);
    const row = conversation();
    await expect(
      engine.runTurn({
        conversation: row,
        turnId: 'turno-2',
        text: 'outra coisa',
        attachments: [],
        parameters: row.parameters,
        policy: engine.effectivePolicy(row, row.mode),
        mode: row.mode,
        history: [],
        signal: new AbortController().signal,
        sink,
        skills: [],
      }),
    ).rejects.toMatchObject({ detail: { code: 'validation' } });
    engine.handleNotification('turn/completed', { threadId: 'thread-1' });
    await first;
  });

  it('interromper pede turn/interrupt e cancela aprovações pendentes', async () => {
    const { engine, runtime, broker } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);
    const pendingApproval = broker.request({
      conversationId: 'c1',
      engineId: 'codex',
      kind: 'commandExecution',
      title: 'Executar',
    });
    expect(await engine.interrupt(conversation())).toBe(true);
    await expect(pendingApproval).resolves.toBe('cancel');
    expect(runtime.requests.some((request) => request.method === 'turn/interrupt')).toBe(true);
    engine.handleNotification('turn/completed', { threadId: 'thread-1' });
    await promise;
  });

  it('orientação usa turn/steer e reporta indisponibilidade sem quebrar', async () => {
    const { engine, runtime } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);

    expect(await engine.steer(conversation(), 'foque nos testes')).toBe(true);
    expect(runtime.requests.some((request) => request.method === 'turn/steer')).toBe(true);

    runtime.setResponse('turn/steer', () => {
      throw Object.assign(new Error('sem método'), {
        detail: { code: 'codexIncompatible', message: 'Sem turn/steer', retryable: false },
      });
    });
    expect(await engine.steer(conversation(), 'outra coisa')).toBe(false);
    expect(sink.errors.some((error) => error.code === 'codexIncompatible')).toBe(true);

    engine.handleNotification('turn/completed', { threadId: 'thread-1' });
    await promise;
  });

  it('reinício invalida vínculos e encerra o turno sem reexecutar', async () => {
    const { engine } = engineWith();
    const sink = createRecordingSink();
    const promise = startTurn(engine, sink);
    await tick(10);
    engine.invalidateBindings('o processo foi reiniciado');
    await promise;
    expect(sink.failures[0]?.action).toContain('Nenhum comando foi reexecutado');
  });
});

describe('CodexEngine — aprovações iniciadas pelo servidor', () => {
  it('responde ao id original com o payload de aprovação', async () => {
    const { engine, requested } = engineWith({
      onApproval: (id, broker) => broker.resolve(id, 'allowOnce'),
    });
    const sink = createRecordingSink();
    await engine.openConversation(conversation(), sink);

    const result = await engine.handleServerRequest(
      'execCommandApproval',
      { threadId: 'thread-1', command: ['npm', 'test'], cwd: '/projetos/app', reason: 'rodar a suíte' },
      1,
    );
    expect(result).toEqual({ decision: 'approved', approved: true });
    expect(requested[0]?.title).toContain('npm test');
    expect(requested[0]?.decisions).toContain('allowForSession');
    expect(sink.statuses).toContain('awaitingApproval');
  });

  it('recusa devolve decisão negada', async () => {
    const { engine } = engineWith({ onApproval: (id, broker) => broker.resolve(id, 'deny') });
    await engine.openConversation(conversation(), createRecordingSink());
    await expect(
      engine.handleServerRequest('execCommandApproval', { threadId: 'thread-1', command: 'ls' }, 1),
    ).resolves.toEqual({ decision: 'denied', approved: false });
  });

  it('cancelar devolve abort', async () => {
    const { engine } = engineWith({ onApproval: (id, broker) => broker.resolve(id, 'cancel') });
    await engine.openConversation(conversation(), createRecordingSink());
    await expect(
      engine.handleServerRequest('execCommandApproval', { threadId: 'thread-1', command: 'ls' }, 1),
    ).resolves.toEqual({ decision: 'abort', approved: false });
  });

  it('aprovação de patch mostra arquivos e NÃO oferece escopo de sessão', async () => {
    const { engine, requested } = engineWith({ onApproval: (id, broker) => broker.resolve(id, 'allowOnce') });
    await engine.openConversation(conversation(), createRecordingSink());
    await engine.handleServerRequest(
      'applyPatchApproval',
      {
        threadId: 'thread-1',
        changes: { 'src/a.ts': { unifiedDiff: '--- a\n+++ b\n' }, 'src/b.ts': { unifiedDiff: '' } },
      },
      1,
    );
    expect(requested[0]?.title).toContain('2 arquivo');
    expect(requested[0]?.decisions).not.toContain('allowForSession');
  });

  it('comando destrutivo não recebe opção de sessão', async () => {
    const { engine, requested } = engineWith({ onApproval: (id, broker) => broker.resolve(id, 'deny') });
    await engine.openConversation(conversation(), createRecordingSink());
    await engine.handleServerRequest(
      'execCommandApproval',
      { threadId: 'thread-1', command: 'rm -rf node_modules' },
      1,
    );
    expect(requested[0]?.decisions).not.toContain('allowForSession');
  });

  it('recusa método de servidor que o aplicativo não implementa', async () => {
    const { engine } = engineWith();
    await expect(engine.handleServerRequest('algoInesperado', {}, 1)).rejects.toMatchObject({
      detail: { code: 'protocol' },
    });
  });
});

describe('buildTurnInput — anexos', () => {
  it('envia imagem como localImage e documento como caminho absoluto', () => {
    const sink = createRecordingSink();
    const input = buildTurnInput(
      'analise',
      [
        { id: 'a', kind: 'image', fileName: 'tela.png', absolutePath: '/ws/.codex-hub/anexos/tela.png' },
        { id: 'b', kind: 'document', fileName: 'relatorio.pdf', absolutePath: '/ws/.codex-hub/anexos/relatorio.pdf' },
      ],
      sink,
    ) as Array<Record<string, unknown>>;

    expect(input[0]).toEqual({ type: 'text', text: 'analise' });
    expect(input[1]).toEqual({ type: 'localImage', path: '/ws/.codex-hub/anexos/tela.png' });
    // PDF NÃO é imagem: vai como referência de caminho.
    expect(input[2]?.type).toBe('text');
    expect(String(input[2]?.text)).toContain('relatorio.pdf');
  });

  it('avisa quando o anexo não tem caminho autorizado', () => {
    const sink = createRecordingSink();
    const input = buildTurnInput('x', [{ id: 'a', kind: 'image', fileName: 'sem-caminho.png' }], sink);
    expect(input).toHaveLength(1);
    expect(sink.itemsOfKind('notice')[0]?.text).toContain('não tem caminho autorizado');
  });

  it('nunca envia entrada vazia', () => {
    expect(buildTurnInput('   ', [])).toEqual([{ type: 'text', text: '(mensagem vazia)' }]);
  });
});

describe('CodexEngine — skills', () => {
  it('devolve lista vazia quando o runtime não está pronto', async () => {
    const runtime = fakeRuntime();
    Object.defineProperty(runtime.runtime, 'isReady', { value: false });
    const engine = new CodexEngine({
      runtime: runtime.runtime,
      approvals: new ApprovalBroker({ onRequested: vi.fn(), onResolved: vi.fn() }),
      developerMode: () => false,
      isPathAuthorized: () => true,
    });
    await expect(engine.listSkills()).resolves.toEqual([]);
  });
});
