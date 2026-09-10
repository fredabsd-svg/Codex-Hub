/**
 * Adaptador direto do OpenRouter — integração de primeira classe.
 *
 * Independente do Codex CLI: funciona com apenas uma chave de API.
 *
 * Endpoints usados (documentação consultada em 2026-09; ver PROVIDERS.md):
 *   GET  {base}/models             → catálogo com propriedades
 *   GET  {base}/key                → informações da credencial e limites
 *   GET  {base}/credits            → crédito total e uso acumulado
 *   POST {base}/chat/completions   → conversa (SSE quando `stream: true`)
 *
 * Referências:
 *   https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties
 *   https://openrouter.ai/docs/api_reference/overview
 *   https://openrouter.ai/docs/guides/features/tool-calling
 *   https://openrouter.ai/docs/guides/routing/provider-selection
 */

import type {
  CapabilityMap,
  ModelCatalogPage,
  ModelDescriptor,
  ModelPricing,
  ProviderConnection,
  ProviderDescriptor,
  RateLimitWindow,
  UsageSnapshot,
} from '../../shared/domain';
import { cap } from '../../shared/capabilities';
import { appError, toErrorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import { httpJson, httpRequest, httpErrorFrom, extractMessage } from './http';
import { streamChatCompletions } from './chatCompletions';
import type {
  ModelProvider,
  ProviderChatRequest,
  ProviderStreamEvent,
} from './types';

export const OPENROUTER_PROVIDER_ID = 'openrouter';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export const OPENROUTER_DESCRIPTOR: ProviderDescriptor = {
  id: OPENROUTER_PROVIDER_ID,
  kind: 'openrouter',
  label: 'OpenRouter',
  description:
    'Catálogo amplo de modelos de vários fornecedores com uma única chave. Funciona sem o Codex CLI instalado.',
  engines: ['direct', 'codex'],
  authKinds: ['apiKey'],
  baseUrl: OPENROUTER_BASE_URL,
  userDefined: false,
  docsUrl: 'https://openrouter.ai/docs/api_reference/overview',
};

/* ------------------------------------------------------------------ *
 * Tipos brutos (parseados defensivamente)
 * ------------------------------------------------------------------ */

interface RawModel {
  id?: unknown;
  canonical_slug?: unknown;
  name?: unknown;
  created?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
    modality?: unknown;
    tokenizer?: unknown;
  };
  pricing?: Record<string, unknown>;
  top_provider?: { context_length?: unknown; max_completion_tokens?: unknown; is_moderated?: unknown };
  supported_parameters?: unknown;
}

interface RawKeyInfo {
  data?: {
    label?: unknown;
    limit?: unknown;
    usage?: unknown;
    limit_remaining?: unknown;
    is_free_tier?: unknown;
    is_provisioning_key?: unknown;
    rate_limit?: { requests?: unknown; interval?: unknown };
  };
}

interface RawCredits {
  data?: { total_credits?: unknown; total_usage?: unknown };
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function parsePricing(raw: Record<string, unknown> | undefined): ModelPricing {
  if (!raw) return { currency: 'USD', unknown: true };
  const prompt = num(raw.prompt);
  const completion = num(raw.completion);
  const image = num(raw.image);
  const request = num(raw.request);
  const webSearch = num(raw.web_search);
  const internalReasoning = num(raw.internal_reasoning);
  const anyKnown = [prompt, completion, image, request, webSearch, internalReasoning].some((v) => v !== undefined);
  return {
    promptPerToken: prompt,
    completionPerToken: completion,
    imagePerImage: image,
    requestPerRequest: request,
    webSearchPerRequest: webSearch,
    internalReasoningPerToken: internalReasoning,
    currency: 'USD',
    unknown: !anyKnown,
  };
}

export function capabilitiesFromModel(model: {
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
}): CapabilityMap {
  const params = new Set(model.supportedParameters.map((p) => p.toLowerCase()));
  const inputs = new Set(model.inputModalities.map((m) => m.toLowerCase()));
  const declared = 'declared' as const;

  const map: CapabilityMap = {
    chat: cap('supported', declared, 'Modelo listado no catálogo de chat do provedor.'),
    streaming: cap('supported', declared, 'O endpoint de Chat Completions aceita `stream: true`.'),
    imageInput: inputs.has('image')
      ? cap('supported', declared, 'O catálogo declara `image` entre as modalidades de entrada.')
      : inputs.size > 0
        ? cap('unsupported', declared, 'O catálogo não declara `image` entre as modalidades de entrada.')
        : cap('unknown', 'inferred', 'O catálogo não informou as modalidades de entrada.'),
    fileInput: cap(
      'supported',
      declared,
      'Arquivos são lidos por ferramentas autorizadas ou extraídos localmente antes do envio.',
    ),
  };

  if (params.size === 0) {
    map.toolCalling = cap('unknown', 'inferred', 'O catálogo não informou os parâmetros suportados.');
    map.temperature = cap('unknown', 'inferred', 'O catálogo não informou os parâmetros suportados.');
    map.reasoningEffort = cap('unknown', 'inferred', 'O catálogo não informou os parâmetros suportados.');
    return map;
  }

  map.toolCalling = params.has('tools') || params.has('tool_choice')
    ? cap('supported', declared, 'O catálogo declara o parâmetro `tools`.')
    : cap('unsupported', declared, 'O catálogo não declara o parâmetro `tools` para este modelo.');

  map.temperature = params.has('temperature')
    ? cap('supported', declared, 'O catálogo declara o parâmetro `temperature`.')
    : cap('unsupported', declared, 'O catálogo não declara o parâmetro `temperature`.');

  const hasReasoning = params.has('reasoning') || params.has('include_reasoning') || params.has('reasoning_effort');
  map.reasoningEffort = hasReasoning
    ? cap('supported', declared, 'O catálogo declara parâmetros de raciocínio.')
    : cap('unsupported', declared, 'O catálogo não declara parâmetros de raciocínio.');
  map.reasoningSummary = hasReasoning
    ? cap('unknown', 'inferred', 'Só aparece quando a resposta traz o campo de raciocínio para exibição.')
    : cap('unsupported', declared, 'O modelo não declara suporte a raciocínio.');

  map.taskExecution = cap(
    'unsupported',
    declared,
    'No motor direto a execução de comandos arbitrários está desabilitada. Use o motor Codex para executar tarefas.',
  );

  return map;
}

export function parseModel(raw: RawModel, providerId: string): ModelDescriptor | null {
  const id = typeof raw.id === 'string' ? raw.id : null;
  if (!id) return null;
  const inputModalities = strArray(raw.architecture?.input_modalities);
  const outputModalities = strArray(raw.architecture?.output_modalities);
  const supportedParameters = strArray(raw.supported_parameters);
  const created = num(raw.created);

  const base = {
    inputModalities: inputModalities.length > 0 ? inputModalities : inferModalities(raw.architecture?.modality, 'in'),
    outputModalities:
      outputModalities.length > 0 ? outputModalities : inferModalities(raw.architecture?.modality, 'out'),
    supportedParameters,
  };

  return {
    id,
    providerId,
    displayName: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id,
    vendor: id.includes('/') ? id.split('/')[0] : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputModalities: base.inputModalities,
    outputModalities: base.outputModalities,
    contextWindow: num(raw.context_length) ?? num(raw.top_provider?.context_length),
    maxOutputTokens: num(raw.top_provider?.max_completion_tokens),
    supportedParameters,
    pricing: parsePricing(raw.pricing),
    capabilities: capabilitiesFromModel(base),
    unverified: false,
    createdAt: created !== undefined ? new Date(created * 1000).toISOString() : undefined,
  };
}

/** `architecture.modality` vem no formato "text+image->text". */
function inferModalities(modality: unknown, side: 'in' | 'out'): string[] {
  if (typeof modality !== 'string' || !modality.includes('->')) return [];
  const [input, output] = modality.split('->');
  const target = side === 'in' ? input : output;
  return (target ?? '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

export interface OpenRouterProviderOptions {
  descriptor?: ProviderDescriptor;
  getSecret(): string | undefined;
  /** Título enviado em `X-Title` para atribuição no painel do OpenRouter. */
  appTitle?: string;
}

export class OpenRouterProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(private readonly options: OpenRouterProviderOptions) {
    this.descriptor = options.descriptor ?? OPENROUTER_DESCRIPTOR;
  }

  private get baseUrl(): string {
    return (this.descriptor.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
  }

  hasCredential(): boolean {
    return typeof this.options.getSecret() === 'string';
  }

  private requireSecret(): string {
    const secret = this.options.getSecret();
    if (!secret) {
      throw appError('unauthorized', {
        message: 'Nenhuma chave do OpenRouter está configurada.',
        action: 'Abra Configurações › Provedores › OpenRouter e informe a chave.',
      });
    }
    return secret;
  }

  private headers(): Record<string, string> {
    return { 'X-Title': this.options.appTitle ?? 'Codex Hub' };
  }

  async testConnection(signal?: AbortSignal): Promise<ProviderConnection> {
    const base: ProviderConnection = {
      providerId: this.descriptor.id,
      state: 'connecting',
      lastCheckedAt: new Date().toISOString(),
    };
    if (!this.hasCredential()) {
      return {
        ...base,
        state: 'disconnected',
        message: 'Nenhuma chave configurada para o OpenRouter.',
        actionHint: 'Informe a chave para descobrir o catálogo e conversar.',
      };
    }
    try {
      const info = await httpJson<RawKeyInfo>({
        url: `${this.baseUrl}/key`,
        bearer: this.requireSecret(),
        headers: this.headers(),
        signal,
        timeoutMs: 20_000,
      });
      const label = typeof info?.data?.label === 'string' ? info.data.label : undefined;
      const freeTier = info?.data?.is_free_tier === true;
      return {
        ...base,
        state: 'connected',
        accountLabel: label,
        planLabel: freeTier ? 'Camada gratuita' : undefined,
        message: 'Credencial validada pelo OpenRouter.',
      };
    } catch (err) {
      const detail = toErrorDetail(err, 'network');
      const state: ProviderConnection['state'] =
        detail.code === 'unauthorized' || detail.code === 'forbidden'
          ? 'unauthorized'
          : detail.code === 'network' || detail.code === 'timeout'
            ? 'unavailable'
            : 'error';
      return { ...base, state, message: detail.message, actionHint: detail.action };
    }
  }

  async listModels(options: { cursor?: string; signal?: AbortSignal } = {}): Promise<ModelCatalogPage> {
    // O catálogo público não exige credencial; com credencial o provedor pode
    // devolver o conjunto aplicável à conta.
    const secret = this.options.getSecret();
    const raw = await httpJson<{ data?: unknown }>({
      url: `${this.baseUrl}/models`,
      bearer: secret,
      headers: this.headers(),
      signal: options.signal,
      timeoutMs: 45_000,
    });
    const list = Array.isArray(raw?.data) ? (raw.data as RawModel[]) : [];
    const models: ModelDescriptor[] = [];
    let skipped = 0;
    for (const item of list) {
      const parsed = parseModel(item, this.descriptor.id);
      if (parsed) models.push(parsed);
      else skipped += 1;
    }
    models.sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
    return {
      providerId: this.descriptor.id,
      models,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      warning:
        skipped > 0
          ? `${skipped} entrada(s) do catálogo foram ignoradas por não trazerem um ID de modelo.`
          : undefined,
    };
  }

  capabilitiesFor(model: ModelDescriptor): CapabilityMap {
    return capabilitiesFromModel(model);
  }

  async readUsage(signal?: AbortSignal): Promise<UsageSnapshot> {
    const fetchedAt = new Date().toISOString();
    const unavailable: string[] = [];
    if (!this.hasCredential()) {
      return {
        providerId: this.descriptor.id,
        fetchedAt,
        unavailable: ['Sem credencial: saldo, gasto e limites não podem ser consultados.'],
      };
    }
    const secret = this.requireSecret();
    let balance: UsageSnapshot['balance'];
    let spend: UsageSnapshot['spend'];
    const rateLimits: RateLimitWindow[] = [];

    try {
      const credits = await httpJson<RawCredits>({
        url: `${this.baseUrl}/credits`,
        bearer: secret,
        headers: this.headers(),
        signal,
        timeoutMs: 20_000,
      });
      const total = num(credits?.data?.total_credits);
      const used = num(credits?.data?.total_usage);
      if (total !== undefined && used !== undefined) {
        balance = { amount: total - used, currency: 'USD', label: 'Crédito disponível' };
        spend = { amount: used, currency: 'USD', windowLabel: 'Uso acumulado da conta' };
      } else {
        unavailable.push('O provedor não informou crédito total e uso acumulado.');
      }
    } catch (err) {
      unavailable.push(`Crédito indisponível: ${toErrorDetail(err).message}`);
    }

    try {
      const key = await httpJson<RawKeyInfo>({
        url: `${this.baseUrl}/key`,
        bearer: secret,
        headers: this.headers(),
        signal,
        timeoutMs: 20_000,
      });
      const limit = num(key?.data?.limit);
      const usage = num(key?.data?.usage);
      const remaining = num(key?.data?.limit_remaining);
      if (limit !== undefined) {
        rateLimits.push({
          label: 'Limite desta chave',
          limit,
          remaining: remaining ?? (usage !== undefined ? limit - usage : undefined),
          usedPercent: usage !== undefined && limit > 0 ? Math.min(100, (usage / limit) * 100) : undefined,
        });
      } else {
        unavailable.push('Esta chave não tem limite de crédito informado pelo provedor.');
      }
      const requests = num(key?.data?.rate_limit?.requests);
      const interval = typeof key?.data?.rate_limit?.interval === 'string' ? key.data.rate_limit.interval : undefined;
      if (requests !== undefined && interval) {
        rateLimits.push({ label: `Requisições por ${interval}`, limit: requests });
      }
    } catch (err) {
      unavailable.push(`Limites indisponíveis: ${toErrorDetail(err).message}`);
    }

    return {
      providerId: this.descriptor.id,
      balance,
      spend,
      rateLimits: rateLimits.length > 0 ? rateLimits : undefined,
      fetchedAt,
      unavailable: unavailable.length > 0 ? unavailable : undefined,
    };
  }

  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    const secret = this.requireSecret();
    return streamChatCompletions({
      url: `${this.baseUrl}/chat/completions`,
      bearer: secret,
      extraHeaders: this.headers(),
      request,
      buildRouting: true,
    });
  }

  /**
   * Requisição mínima e não-streaming usada para VERIFICAR uma capacidade.
   * O resultado é registrado como `tested`, distinto de `declared`.
   */
  async probeToolCalling(modelId: string, signal?: AbortSignal): Promise<{ supported: boolean; reason: string }> {
    const secret = this.requireSecret();
    const response = await httpRequest({
      url: `${this.baseUrl}/chat/completions`,
      method: 'POST',
      bearer: secret,
      headers: this.headers(),
      signal,
      timeoutMs: 45_000,
      body: {
        model: modelId,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Responda apenas: ok' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'codex_hub_probe',
              description: 'Sonda de verificação de suporte a ferramentas. Não deve ser chamada.',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
          },
        ],
      },
    });
    const raw = await response.text();
    if (response.ok) {
      return { supported: true, reason: 'O provedor aceitou uma requisição com `tools` para este modelo.' };
    }
    const message = extractMessage(safeJson(raw)) ?? raw.slice(0, 200);
    if (/tool|function.calling/i.test(message)) {
      return { supported: false, reason: `O provedor recusou o parâmetro tools: ${message.slice(0, 160)}` };
    }
    logger.debug('openrouter', 'Sonda de ferramentas inconclusiva', { status: response.status });
    throw httpErrorFrom(response.status, raw);
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
