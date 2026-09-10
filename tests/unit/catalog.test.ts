import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelDescriptor } from '../../src/shared/domain';
import {
  OpenRouterProvider,
  capabilitiesFromModel,
  parseModel,
  parsePricing,
} from '../../src/main/providers/OpenRouterProvider';
import { CompatibleProvider } from '../../src/main/providers/CompatibleProvider';
import { ModelCatalog } from '../../src/main/providers/ModelCatalog';
import { openDatabase } from '../../src/main/persistence/database';
import { installFakeFetch } from '../helpers/fakeFetch';
import { estimateCost, usageFromRaw } from '../../src/main/providers/usage';

const RAW_MODEL = {
  id: 'vendor/modelo-grande',
  name: 'Vendor Modelo Grande',
  created: 1_700_000_000,
  description: 'Um modelo de exemplo.',
  context_length: 200_000,
  architecture: {
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    modality: 'text+image->text',
  },
  pricing: { prompt: '0.000003', completion: '0.000015', image: '0.0004', request: '0' },
  top_provider: { context_length: 200_000, max_completion_tokens: 64_000 },
  supported_parameters: ['temperature', 'max_tokens', 'tools', 'tool_choice', 'reasoning'],
};

describe('parseModel', () => {
  it('extrai todos os campos informados', () => {
    const model = parseModel(RAW_MODEL, 'openrouter');
    expect(model).not.toBeNull();
    expect(model?.id).toBe('vendor/modelo-grande');
    expect(model?.displayName).toBe('Vendor Modelo Grande');
    expect(model?.vendor).toBe('vendor');
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxOutputTokens).toBe(64_000);
    expect(model?.inputModalities).toEqual(['text', 'image']);
    expect(model?.unverified).toBe(false);
    expect(model?.createdAt).toBeDefined();
  });

  it('cai para o ID quando não há nome', () => {
    expect(parseModel({ id: 'so/id' }, 'openrouter')?.displayName).toBe('so/id');
  });

  it('devolve null sem ID (entrada inútil)', () => {
    expect(parseModel({ name: 'sem id' }, 'openrouter')).toBeNull();
  });

  it('deriva modalidades do campo modality quando as listas faltam', () => {
    const model = parseModel(
      { id: 'x/y', architecture: { modality: 'text+image->text' } },
      'openrouter',
    );
    expect(model?.inputModalities).toEqual(['text', 'image']);
    expect(model?.outputModalities).toEqual(['text']);
  });
});

describe('parsePricing', () => {
  it('marca desconhecido quando não há preço', () => {
    expect(parsePricing(undefined).unknown).toBe(true);
    expect(parsePricing({}).unknown).toBe(true);
  });

  it('aceita preço como string e preserva zero como zero', () => {
    const pricing = parsePricing({ prompt: '0', completion: '0' });
    expect(pricing.unknown).toBe(false);
    expect(pricing.promptPerToken).toBe(0);
  });

  it('não confunde ausência com gratuidade', () => {
    const pricing = parsePricing({ completion: '0.00001' });
    expect(pricing.promptPerToken).toBeUndefined();
    expect(pricing.unknown).toBe(false);
  });
});

describe('capabilitiesFromModel', () => {
  it('declara ferramentas suportadas quando o catálogo traz tools', () => {
    const caps = capabilitiesFromModel({
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['tools'],
    });
    expect(caps.toolCalling?.state).toBe('supported');
    expect(caps.toolCalling?.source).toBe('declared');
  });

  it('declara ferramentas NÃO suportadas quando há lista sem tools', () => {
    const caps = capabilitiesFromModel({
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['temperature'],
    });
    expect(caps.toolCalling?.state).toBe('unsupported');
  });

  it('deixa desconhecido quando o catálogo não informa parâmetros', () => {
    const caps = capabilitiesFromModel({ inputModalities: [], outputModalities: [], supportedParameters: [] });
    expect(caps.toolCalling?.state).toBe('unknown');
    expect(caps.imageInput?.state).toBe('unknown');
  });

  it('imagem suportada apenas quando declarada', () => {
    expect(
      capabilitiesFromModel({ inputModalities: ['text', 'image'], outputModalities: [], supportedParameters: ['tools'] })
        .imageInput?.state,
    ).toBe('supported');
    expect(
      capabilitiesFromModel({ inputModalities: ['text'], outputModalities: [], supportedParameters: ['tools'] })
        .imageInput?.state,
    ).toBe('unsupported');
  });

  it('execução de tarefas é não suportada no motor direto', () => {
    const caps = capabilitiesFromModel({
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['tools'],
    });
    expect(caps.taskExecution?.state).toBe('unsupported');
    expect(caps.taskExecution?.reason).toContain('motor direto');
  });
});

describe('OpenRouterProvider', () => {
  it('lista modelos do endpoint oficial', async () => {
    const fake = installFakeFetch([{ match: '/models', json: { data: [RAW_MODEL, { sem: 'id' }] } }]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const page = await provider.listModels();
    fake.restore();
    expect(page.models).toHaveLength(1);
    expect(page.warning).toContain('1 entrada');
    expect(page.fromCache).toBe(false);
  });

  it('testa a credencial pelo endpoint /key', async () => {
    const fake = installFakeFetch([{ match: '/key', json: { data: { label: 'chave-dev', is_free_tier: true } } }]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const connection = await provider.testConnection();
    fake.restore();
    expect(connection.state).toBe('connected');
    expect(connection.accountLabel).toBe('chave-dev');
    expect(connection.planLabel).toBe('Camada gratuita');
  });

  it('reporta credencial inválida sem lançar', async () => {
    const fake = installFakeFetch([{ match: '/key', status: 401, json: { error: { message: 'invalid' } } }]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-invalida' });
    const connection = await provider.testConnection();
    fake.restore();
    expect(connection.state).toBe('unauthorized');
    expect(connection.message).toBeTruthy();
  });

  it('reporta desconectado quando não há chave', async () => {
    const provider = new OpenRouterProvider({ getSecret: () => undefined });
    const connection = await provider.testConnection();
    expect(connection.state).toBe('disconnected');
    expect(provider.hasCredential()).toBe(false);
  });

  it('uso: informa o que NÃO pôde ser obtido em vez de zerar', async () => {
    const fake = installFakeFetch([
      { match: '/credits', status: 403, json: { error: { message: 'sem permissão' } } },
      { match: '/key', json: { data: { limit: null, rate_limit: { requests: 200, interval: '10s' } } } },
    ]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const usage = await provider.readUsage();
    fake.restore();
    expect(usage.balance).toBeUndefined();
    expect(usage.unavailable?.some((line) => line.includes('Crédito indisponível'))).toBe(true);
    expect(usage.rateLimits?.some((limit) => limit.label.includes('Requisições'))).toBe(true);
  });

  it('uso: calcula saldo a partir de crédito e consumo', async () => {
    const fake = installFakeFetch([
      { match: '/credits', json: { data: { total_credits: 10, total_usage: 2.5 } } },
      { match: '/key', json: { data: { limit: 20, usage: 5 } } },
    ]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const usage = await provider.readUsage();
    fake.restore();
    expect(usage.balance?.amount).toBeCloseTo(7.5);
    expect(usage.spend?.amount).toBeCloseTo(2.5);
  });

  it('sonda de ferramentas registra suporte quando o provedor aceita', async () => {
    const fake = installFakeFetch([{ match: '/chat/completions', json: { choices: [] } }]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const probe = await provider.probeToolCalling('vendor/modelo');
    fake.restore();
    expect(probe.supported).toBe(true);
  });

  it('sonda de ferramentas reconhece recusa explícita', async () => {
    const fake = installFakeFetch([
      {
        match: '/chat/completions',
        status: 400,
        json: { error: { message: 'This model does not support tool use' } },
      },
    ]);
    const provider = new OpenRouterProvider({ getSecret: () => 'sk-or-v1-teste' });
    const probe = await provider.probeToolCalling('vendor/modelo');
    fake.restore();
    expect(probe.supported).toBe(false);
    expect(probe.reason).toContain('tool');
  });
});

describe('CompatibleProvider', () => {
  const descriptor = {
    id: 'compatible:1',
    kind: 'compatible' as const,
    label: 'Ollama local',
    description: 'local',
    engines: ['direct' as const],
    authKinds: ['none' as const],
    baseUrl: 'http://127.0.0.1:11434/v1',
    userDefined: true,
  };

  it('descobre modelos no formato OpenAI', async () => {
    const fake = installFakeFetch([{ match: '/models', json: { data: [{ id: 'llama3.2' }, { id: 'qwen2.5' }] } }]);
    const provider = new CompatibleProvider({ descriptor, getSecret: () => undefined });
    const page = await provider.listModels();
    fake.restore();
    expect(page.models.map((model) => model.id)).toEqual(['llama3.2', 'qwen2.5']);
    // Nada é declarado além do que se sabe.
    expect(page.models[0]?.capabilities.toolCalling?.state).toBe('unknown');
    expect(page.models[0]?.pricing.unknown).toBe(true);
  });

  it('avisa quando a descoberta não é reconhecível, em vez de fingir catálogo', async () => {
    const fake = installFakeFetch([{ match: '/models', json: { algo: 'inesperado' } }]);
    const provider = new CompatibleProvider({ descriptor, getSecret: () => undefined });
    const page = await provider.listModels();
    fake.restore();
    expect(page.models).toHaveLength(0);
    expect(page.warning).toContain('manualmente');
  });

  it('não promete uso: declara indisponível', async () => {
    const provider = new CompatibleProvider({ descriptor, getSecret: () => undefined });
    const usage = await provider.readUsage();
    expect(usage.balance).toBeUndefined();
    expect(usage.unavailable?.[0]).toContain('não expõem saldo');
  });
});

describe('ModelCatalog', () => {
  function catalog(models: ModelDescriptor[] | Error): { catalog: ModelCatalog; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'codex-hub-catalog-'));
    const db = openDatabase(dir);
    const provider = {
      descriptor: { id: 'p1', kind: 'openrouter' as const, label: 'P', description: '', engines: ['direct' as const], authKinds: ['apiKey' as const], userDefined: false },
      testConnection: async () => ({ providerId: 'p1', state: 'connected' as const }),
      listModels: async () => {
        if (models instanceof Error) throw models;
        return { providerId: 'p1', models, fetchedAt: new Date().toISOString(), fromCache: false };
      },
      readUsage: async () => ({ providerId: 'p1', fetchedAt: new Date().toISOString() }),
      streamChat: () => {
        throw new Error('não usado');
      },
      capabilitiesFor: () => ({}),
      hasCredential: () => true,
    };
    return { catalog: new ModelCatalog(db.catalog, db.prefs, () => provider), dir };
  }

  const model: ModelDescriptor = {
    id: 'p1/m',
    providerId: 'p1',
    displayName: 'M',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedParameters: ['tools'],
    pricing: { currency: 'USD', unknown: true },
    capabilities: { toolCalling: { state: 'supported', source: 'declared' } },
    unverified: false,
  };

  it('guarda no cache e reusa sem tocar a rede', async () => {
    const { catalog: instance } = catalog([model]);
    const first = await instance.list('p1');
    expect(first.fromCache).toBe(false);
    const second = await instance.list('p1');
    expect(second.fromCache).toBe(true);
    expect(second.models).toHaveLength(1);
  });

  it('usa o cache com aviso quando a atualização falha', async () => {
    const { catalog: instance } = catalog([model]);
    await instance.list('p1');
    const failing = catalog(new Error('rede caiu'));
    // Cache diferente (outro diretório): sem cache anterior, devolve aviso.
    const page = await failing.catalog.refresh('p1');
    expect(page.models).toHaveLength(0);
    expect(page.warning).toBeTruthy();
  });

  it('adiciona modelo manual marcado como não verificado', () => {
    const { catalog: instance } = catalog([model]);
    const page = instance.addManualModel('p1', 'meu-modelo-local', 'Meu Local');
    const added = page.models.find((entry) => entry.id === 'meu-modelo-local');
    expect(added?.unverified).toBe(true);
    expect(added?.capabilities.chat?.state).toBe('unknown');
    expect(added?.pricing.unknown).toBe(true);
  });

  it('aplica observação testada sobre a declarada', async () => {
    const { catalog: instance } = catalog([model]);
    await instance.list('p1');
    instance.recordObservation('p1', 'p1/m', 'toolCalling', {
      state: 'unsupported',
      source: 'tested',
      reason: 'O provedor recusou tools.',
    });
    const page = instance.cached('p1');
    const decorated = page?.models.find((entry) => entry.id === 'p1/m');
    expect(decorated?.capabilities.toolCalling).toMatchObject({ state: 'unsupported', source: 'tested' });
  });

  it('indisponibilidade temporária NÃO vira incompatibilidade', async () => {
    const { catalog: instance } = catalog([model]);
    await instance.list('p1');
    instance.applyErrorObservation('p1', 'p1/m', 'rateLimited', 'limite atingido');
    instance.applyErrorObservation('p1', 'p1/m', 'network', 'timeout');
    const decorated = instance.cached('p1')?.models.find((entry) => entry.id === 'p1/m');
    expect(decorated?.capabilities.toolCalling?.state).toBe('supported');
  });

  it('erro de parâmetro incompatível marca como desconhecido, não como não suportado', async () => {
    const { catalog: instance } = catalog([model]);
    await instance.list('p1');
    instance.applyErrorObservation('p1', 'p1/m', 'unsupportedParameter', 'tools not supported here');
    const decorated = instance.cached('p1')?.models.find((entry) => entry.id === 'p1/m');
    expect(decorated?.capabilities.toolCalling?.state).toBe('unknown');
    expect(decorated?.capabilities.toolCalling?.source).toBe('tested');
  });

  it('mantém favoritos e recentes', async () => {
    const { catalog: instance } = catalog([model]);
    instance.setFavorite('p1', 'p1/m', true);
    expect(instance.favorites()).toContain('p1::p1/m');
    instance.noteUsed('p1', 'p1/m');
    expect(instance.recents()[0]).toBe('p1::p1/m');
    instance.setFavorite('p1', 'p1/m', false);
    expect(instance.favorites()).not.toContain('p1::p1/m');
  });
});

describe('uso e estimativas', () => {
  it('não transforma ausência em zero', () => {
    expect(usageFromRaw(undefined)).toBeUndefined();
    expect(usageFromRaw({})).toBeUndefined();
    expect(usageFromRaw({ prompt_tokens: 5 })).toEqual({
      promptTokens: 5,
      completionTokens: undefined,
      reasoningTokens: undefined,
      totalTokens: undefined,
      reportedCost: undefined,
      currency: undefined,
    });
  });

  it('estimativa só existe com preço declarado e é identificada', () => {
    const withoutPrice = estimateCost({ promptTokens: 100, completionTokens: 50 }, {
      ...({} as ModelDescriptor),
      pricing: { currency: 'USD', unknown: true },
    } as ModelDescriptor);
    expect(withoutPrice?.estimatedCost).toBeUndefined();

    const withPrice = estimateCost({ promptTokens: 100, completionTokens: 50 }, {
      ...({} as ModelDescriptor),
      pricing: { currency: 'USD', unknown: false, promptPerToken: 0.00001, completionPerToken: 0.00002 },
    } as ModelDescriptor);
    expect(withPrice?.estimatedCost).toBeCloseTo(100 * 0.00001 + 50 * 0.00002);
    expect(withPrice?.estimateBasis).toContain('Estimativa local');
  });

  it('custo informado pelo provedor tem precedência sobre estimativa', () => {
    const usage = estimateCost({ promptTokens: 10, reportedCost: 0.5 }, {
      ...({} as ModelDescriptor),
      pricing: { currency: 'USD', unknown: false, promptPerToken: 1 },
    } as ModelDescriptor);
    expect(usage?.estimatedCost).toBeUndefined();
    expect(usage?.reportedCost).toBe(0.5);
  });
});
