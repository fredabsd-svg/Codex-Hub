import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ModelDescriptor, TurnParameters } from '../../src/shared/domain';
import { DirectEngine } from '../../src/main/engines/DirectEngine';
import { ApprovalBroker } from '../../src/main/tools/ApprovalBroker';
import { GitService } from '../../src/main/services/GitService';
import type { ModelCatalog } from '../../src/main/providers/ModelCatalog';
import type { ProviderRegistry } from '../../src/main/providers/registry';
import type { ModelProvider, ProviderChatRequest, ProviderStreamEvent } from '../../src/main/providers/types';
import type { ConversationRow } from '../../src/main/persistence/repositories';
import { createRecordingSink } from '../helpers/recordingSink';

const parameters: TurnParameters = { modelId: 'vendor/m', providerId: 'openrouter', engineId: 'direct' };

let workspace: string;

/** Provider falso: devolve roteiros de eventos, um por passo do ciclo. */
function scriptedProvider(scripts: ProviderStreamEvent[][]): { provider: ModelProvider; requests: ProviderChatRequest[] } {
  const requests: ProviderChatRequest[] = [];
  let step = 0;
  const provider: ModelProvider = {
    descriptor: {
      id: 'openrouter',
      kind: 'openrouter',
      label: 'OpenRouter',
      description: '',
      engines: ['direct'],
      authKinds: ['apiKey'],
      userDefined: false,
    },
    testConnection: async () => ({ providerId: 'openrouter', state: 'connected' }),
    listModels: async () => ({ providerId: 'openrouter', models: [], fetchedAt: '', fromCache: false }),
    readUsage: async () => ({ providerId: 'openrouter', fetchedAt: '' }),
    capabilitiesFor: () => ({}),
    hasCredential: () => true,
    streamChat: (request) => {
      requests.push(request);
      const script = scripts[step] ?? [{ type: 'finish', reason: 'stop' }];
      step += 1;
      return (async function* generate() {
        for (const event of script) {
          request.signal.throwIfAborted();
          yield event;
        }
      })();
    },
  };
  return { provider, requests };
}

function engineWith(
  provider: ModelProvider,
  model: ModelDescriptor | null,
  options: { onApproval?: (id: string, broker: ApprovalBroker) => void; limits?: Partial<{ maxSteps: number; maxDurationMs: number; maxResultBytes: number }> } = {},
): { engine: DirectEngine; broker: ApprovalBroker; observations: Array<{ code: string }> } {
  const observations: Array<{ code: string }> = [];
  const broker = new ApprovalBroker({
    onRequested: (request) => options.onApproval?.(request.id, broker),
    onResolved: () => undefined,
  });
  const providers = {
    get: () => provider,
    require: () => provider,
    isLocalProvider: () => false,
  } as unknown as ProviderRegistry;
  const catalog = {
    find: () => model,
    applyErrorObservation: (_p: string, _m: string, code: string) => observations.push({ code }),
    noteUsed: () => undefined,
  } as unknown as ModelCatalog;

  const engine = new DirectEngine({
    providers,
    catalog,
    approvals: broker,
    git: new GitService(),
    limits: () => ({
      maxSteps: options.limits?.maxSteps ?? 10,
      maxDurationMs: options.limits?.maxDurationMs ?? 60_000,
      maxResultBytes: options.limits?.maxResultBytes ?? 64 * 1024,
    }),
  });
  return { engine, broker, observations };
}

function conversation(overrides: Partial<ConversationRow> = {}): ConversationRow {
  const at = new Date().toISOString();
  return {
    id: 'c1',
    title: 'Conversa',
    titleIsLocal: true,
    engineId: 'direct',
    providerId: 'openrouter',
    modelId: 'vendor/m',
    workspacePath: workspace,
    mode: 'execute',
    archived: false,
    favorite: false,
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    messageCount: 0,
    parameters,
    lastSeq: 0,
    ...overrides,
  };
}

const modelWithTools: ModelDescriptor = {
  id: 'vendor/m',
  providerId: 'openrouter',
  displayName: 'M',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: ['tools', 'temperature'],
  pricing: { currency: 'USD', unknown: false, promptPerToken: 0.000001, completionPerToken: 0.000002 },
  capabilities: { toolCalling: { state: 'supported', source: 'declared' } },
  unverified: false,
};

const modelWithoutTools: ModelDescriptor = {
  ...modelWithTools,
  capabilities: { toolCalling: { state: 'unsupported', source: 'declared', reason: 'sem tools no catálogo' } },
  supportedParameters: ['temperature'],
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-hub-direct-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'index.ts'), 'export const versao = 1;\n');
});

function runTurn(
  engine: DirectEngine,
  sink: ReturnType<typeof createRecordingSink>,
  overrides: { mode?: ConversationRow['mode']; signal?: AbortSignal; conversation?: ConversationRow } = {},
): Promise<void> {
  const row = overrides.conversation ?? conversation({ mode: overrides.mode ?? 'execute' });
  return engine.runTurn({
    conversation: row,
    turnId: 't1',
    text: 'faça a tarefa',
    attachments: [],
    parameters,
    policy: engine.effectivePolicy(row, row.mode),
    mode: row.mode,
    history: [],
    signal: overrides.signal ?? new AbortController().signal,
    sink,
    skills: [],
  });
}

describe('DirectEngine — conversa simples', () => {
  it('publica deltas de texto e conclui o turno', async () => {
    const { provider } = scriptedProvider([
      [
        { type: 'meta', responseId: 'gen-1', effectiveUpstream: 'Fireworks' },
        { type: 'textDelta', delta: 'Olá' },
        { type: 'textDelta', delta: ', tudo bem?' },
        { type: 'usage', usage: { promptTokens: 10, completionTokens: 4 } },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'chat' });

    const message = sink.itemsOfKind('agentMessage')[0];
    expect(message?.text).toBe('Olá, tudo bem?');
    expect(message?.status).toBe('completed');
    expect(sink.completed).toHaveLength(1);
    expect(sink.completed[0]?.upstream).toBe('Fireworks');
    expect(sink.statuses).toContain('completed');
  });

  it('estima custo apenas quando há preço declarado, sempre rotulado', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'usage', usage: { promptTokens: 1000, completionTokens: 500 } }, { type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'chat' });
    expect(sink.usages[0]?.estimatedCost).toBeCloseTo(1000 * 0.000001 + 500 * 0.000002);
    expect(sink.usages[0]?.estimateBasis).toContain('Estimativa local');
  });

  it('avisa quando o turno termina sem texto', async () => {
    const { provider } = scriptedProvider([[{ type: 'finish', reason: 'stop' }]]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'chat' });
    expect(sink.itemsOfKind('notice').some((item) => item.text?.includes('sem produzir texto'))).toBe(true);
  });

  it('mostra resumo de raciocínio só quando a API envia', async () => {
    const { provider } = scriptedProvider([
      [{ type: 'reasoningDelta', delta: 'analisando…' }, { type: 'textDelta', delta: 'ok' }, { type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'chat' });
    expect(sink.itemsOfKind('reasoningSummary')[0]?.text).toBe('analisando…');
  });

  it('não envia ferramentas no modo Conversar', async () => {
    const { provider, requests } = scriptedProvider([[{ type: 'finish', reason: 'stop' }]]);
    const { engine } = engineWith(provider, modelWithTools);
    await runTurn(engine, createRecordingSink(), { mode: 'chat' });
    expect(requests[0]?.tools).toBeUndefined();
  });

  it('envia ferramentas de leitura no modo Planejar, sem escrita', async () => {
    const { provider, requests } = scriptedProvider([[{ type: 'finish', reason: 'stop' }]]);
    const { engine } = engineWith(provider, modelWithTools);
    await runTurn(engine, createRecordingSink(), { mode: 'plan' });
    const names = (requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('apply_file_changes');
  });

  it('avisa quando o modelo não suporta ferramentas em modo Executar', async () => {
    const { provider, requests } = scriptedProvider([[{ type: 'finish', reason: 'stop' }]]);
    const { engine } = engineWith(provider, modelWithoutTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'execute' });
    expect(requests[0]?.tools).toBeUndefined();
    expect(sink.itemsOfKind('notice').some((item) => item.text?.includes('não declara suporte a chamada de ferramentas'))).toBe(
      true,
    );
  });
});

describe('DirectEngine — ciclo de ferramentas', () => {
  it('executa o ciclo completo: chamada → aprovação → execução → resultado → conclusão', async () => {
    const { provider, requests } = scriptedProvider([
      [
        { type: 'textDelta', delta: 'Vou criar o arquivo.' },
        {
          type: 'toolCalls',
          calls: [
            {
              id: 'call_1',
              name: 'apply_file_changes',
              argumentsJson: JSON.stringify({
                summary: 'Cria versão',
                changes: [{ operation: 'create', path: 'src/versao.ts', content: 'export const v = 2;\n' }],
              }),
            },
          ],
        },
        { type: 'finish', reason: 'toolCalls' },
      ],
      [{ type: 'textDelta', delta: 'Pronto.' }, { type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools, {
      onApproval: (id, broker) => broker.resolve(id, 'allowOnce'),
    });
    const sink = createRecordingSink();
    await runTurn(engine, sink);

    // O arquivo foi realmente criado.
    expect(readFileSync(join(workspace, 'src', 'versao.ts'), 'utf8')).toContain('export const v = 2;');

    // A ferramenta aparece como item concluído com diff.
    const tool = sink.itemsOfKind('toolCall')[0];
    expect(tool?.status).toBe('completed');
    expect(tool?.fileChange?.files?.[0]?.path).toBe('src/versao.ts');
    expect(sink.diffs.at(-1)?.[0]?.path).toBe('src/versao.ts');

    // O resultado voltou ao modelo com o tool_call_id preservado.
    const followUp = requests[1];
    const toolMessage = followUp?.messages.find((message) => message.role === 'tool');
    expect(toolMessage).toMatchObject({ role: 'tool', toolCallId: 'call_1', name: 'apply_file_changes' });
    const assistantMessage = followUp?.messages.find((message) => message.role === 'assistant');
    expect(assistantMessage).toMatchObject({ toolCalls: [{ id: 'call_1' }] });

    // Chave de idempotência distinta por passo.
    expect(requests[0]?.idempotencyKey).not.toBe(requests[1]?.idempotencyKey);
    expect(sink.completed).toHaveLength(1);
  });

  it('recusa a ferramenta e devolve o ERRO ao modelo, sem gravar', async () => {
    const { provider, requests } = scriptedProvider([
      [
        {
          type: 'toolCalls',
          calls: [
            {
              id: 'call_1',
              name: 'apply_file_changes',
              argumentsJson: JSON.stringify({
                summary: 'x',
                changes: [{ operation: 'create', path: 'nao.txt', content: 'a' }],
              }),
            },
          ],
        },
        { type: 'finish', reason: 'toolCalls' },
      ],
      [{ type: 'textDelta', delta: 'Entendi, não vou insistir.' }, { type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools, {
      onApproval: (id, broker) => broker.resolve(id, 'deny'),
    });
    const sink = createRecordingSink();
    await runTurn(engine, sink);

    expect(existsSync(join(workspace, 'nao.txt'))).toBe(false);
    const tool = sink.itemsOfKind('toolCall')[0];
    expect(tool?.status).toBe('failed');
    const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
    expect((toolMessage as { content: string }).content).toContain('ERRO');
  });

  it('valida argumentos antes de executar e não repassa argumentos parciais', async () => {
    const { provider, requests } = scriptedProvider([
      [
        // Deltas parciais NÃO devem ser executados.
        { type: 'toolCallDelta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{"pa' },
        { type: 'toolCalls', calls: [{ id: 'call_1', name: 'read_file', argumentsJson: '{"caminho":"x"}' }] },
        { type: 'finish', reason: 'toolCalls' },
      ],
      [{ type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink);
    const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
    expect((toolMessage as { content: string }).content).toContain('Argumentos inválidos');
  });

  it('respeita o limite de passos', async () => {
    const loop: ProviderStreamEvent[] = [
      { type: 'toolCalls', calls: [{ id: 'c', name: 'list_files', argumentsJson: '{}' }] },
      { type: 'finish', reason: 'toolCalls' },
    ];
    const { provider } = scriptedProvider([loop, loop, loop, loop, loop]);
    const { engine } = engineWith(provider, modelWithTools, { limits: { maxSteps: 2 } });
    const sink = createRecordingSink();
    await runTurn(engine, sink);
    expect(sink.failures[0]?.code).toBe('toolLimit');
    expect(sink.failures[0]?.message).toContain('limite de 2 passos');
  });

  it('sem workspace, informa que as ferramentas estão indisponíveis', async () => {
    const { provider, requests } = scriptedProvider([
      [
        { type: 'toolCalls', calls: [{ id: 'c', name: 'list_files', argumentsJson: '{}' }] },
        { type: 'finish', reason: 'toolCalls' },
      ],
      [{ type: 'finish', reason: 'stop' }],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { conversation: conversation({ workspacePath: undefined }) });
    const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool');
    expect((toolMessage as { content: string }).content).toContain('Nenhum workspace');
  });
});

describe('DirectEngine — interrupção e falhas', () => {
  it('interrompe o turno e não conclui', async () => {
    const controller = new AbortController();
    const { provider } = scriptedProvider([
      [
        { type: 'textDelta', delta: 'começando' },
        { type: 'textDelta', delta: ' mais' },
        { type: 'finish', reason: 'stop' },
      ],
    ]);
    const { engine } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    // Aborta assim que o primeiro item aparece.
    const original = sink.textDelta.bind(sink);
    sink.textDelta = (itemId, delta) => {
      original(itemId, delta);
      controller.abort();
    };
    await runTurn(engine, sink, { mode: 'chat', signal: controller.signal });
    expect(sink.cancellations).toHaveLength(1);
    expect(sink.completed).toHaveLength(0);
    expect(sink.statuses).toContain('cancelled');
  });

  it('reporta erro do provedor e registra observação de capacidade', async () => {
    const provider: ModelProvider = {
      ...scriptedProvider([]).provider,
      streamChat: () =>
        (async function* generate(): AsyncGenerator<ProviderStreamEvent> {
          yield { type: 'textDelta', delta: 'a' };
          throw Object.assign(new Error('sem crédito'), {
            detail: { code: 'insufficientCredit', message: 'Sem crédito.', retryable: true },
          });
        })(),
    };
    const { engine, observations } = engineWith(provider, modelWithTools);
    const sink = createRecordingSink();
    await runTurn(engine, sink, { mode: 'chat' });
    expect(sink.failures[0]?.code).toBe('insufficientCredit');
    expect(observations[0]?.code).toBe('insufficientCredit');
    expect(sink.statuses).toContain('error');
  });

  it('não aceita orientação no meio do turno (motor sem esse protocolo)', async () => {
    const { provider } = scriptedProvider([[{ type: 'finish', reason: 'stop' }]]);
    const { engine } = engineWith(provider, modelWithTools);
    await expect(engine.steer()).resolves.toBe(false);
  });

  it('política declara execução de comandos indisponível neste motor', () => {
    const { provider } = scriptedProvider([[]]);
    const { engine } = engineWith(provider, modelWithTools);
    const policy = engine.effectivePolicy(conversation(), 'execute');
    expect(policy.toolNetwork).toBe('blocked');
    expect(policy.confirmedByRuntime).toBe(true);
    expect(policy.note).toContain('Execução de comandos arbitrários indisponível');
  });
});
