/**
 * Adaptador genérico para endpoints compatíveis com o protocolo
 * OpenAI Chat Completions (`POST {base}/chat/completions`).
 *
 * Serve serviços locais como Ollama (`http://127.0.0.1:11434/v1`) e
 * LM Studio (`http://127.0.0.1:1234/v1`), além de gateways corporativos.
 *
 * O que este adaptador NÃO faz:
 *  - não promete compatibilidade universal: descoberta de modelos só acontece
 *    quando `GET {base}/models` responde no formato esperado;
 *  - não declara capacidades que não pode verificar. Tudo começa como
 *    `desconhecido` e só muda diante de evidência (declaração ou teste).
 */

import type {
  CapabilityMap,
  ModelCatalogPage,
  ModelDescriptor,
  ProviderConnection,
  ProviderDescriptor,
  UsageSnapshot,
} from '../../shared/domain';
import { cap } from '../../shared/capabilities';
import { toErrorDetail } from '../../shared/errors';
import { isLocalHost } from './http';
import { httpJson } from './http';
import { streamChatCompletions } from './chatCompletions';
import type { ModelProvider, ProviderChatRequest, ProviderStreamEvent } from './types';

export interface CompatibleProviderOptions {
  descriptor: ProviderDescriptor;
  getSecret(): string | undefined;
  extraHeaders?: Record<string, string>;
}

export class CompatibleProvider implements ModelProvider {
  readonly descriptor: ProviderDescriptor;

  constructor(private readonly options: CompatibleProviderOptions) {
    this.descriptor = options.descriptor;
  }

  private get baseUrl(): string {
    return (this.descriptor.baseUrl ?? '').replace(/\/+$/, '');
  }

  private get isLocal(): boolean {
    try {
      return isLocalHost(new URL(this.baseUrl).hostname);
    } catch {
      return false;
    }
  }

  hasCredential(): boolean {
    return typeof this.options.getSecret() === 'string';
  }

  async testConnection(signal?: AbortSignal): Promise<ProviderConnection> {
    const at = new Date().toISOString();
    try {
      const raw = await httpJson<{ data?: unknown; models?: unknown }>({
        url: `${this.baseUrl}/models`,
        bearer: this.options.getSecret(),
        headers: this.options.extraHeaders,
        signal,
        timeoutMs: 15_000,
        allowInsecureLocal: this.isLocal,
      });
      const count = countModels(raw);
      return {
        providerId: this.descriptor.id,
        state: 'connected',
        lastCheckedAt: at,
        message:
          count > 0
            ? `Endpoint respondeu e descobriu ${count} modelo(s).`
            : 'Endpoint respondeu, mas não listou modelos. É possível informar um ID manualmente.',
      };
    } catch (err) {
      const detail = toErrorDetail(err, 'network');
      const state: ProviderConnection['state'] =
        detail.code === 'unauthorized' || detail.code === 'forbidden'
          ? 'unauthorized'
          : detail.code === 'network' || detail.code === 'timeout'
            ? 'unavailable'
            : 'error';
      return {
        providerId: this.descriptor.id,
        state,
        lastCheckedAt: at,
        message: detail.message,
        actionHint: detail.action ?? 'Verifique a URL base e se o serviço está em execução.',
      };
    }
  }

  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelCatalogPage> {
    const fetchedAt = new Date().toISOString();
    try {
      const raw = await httpJson<{ data?: unknown; models?: unknown }>({
        url: `${this.baseUrl}/models`,
        bearer: this.options.getSecret(),
        headers: this.options.extraHeaders,
        signal: options.signal,
        timeoutMs: 20_000,
        allowInsecureLocal: this.isLocal,
      });
      const entries = extractEntries(raw);
      const models = entries
        .map((entry) => this.toDescriptor(entry))
        .filter((m): m is ModelDescriptor => m !== null)
        .sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
      return {
        providerId: this.descriptor.id,
        models,
        fetchedAt,
        fromCache: false,
        warning:
          models.length === 0
            ? 'Este endpoint não devolveu uma lista de modelos reconhecível. Informe o ID do modelo manualmente — ele aparecerá como não verificado.'
            : undefined,
      };
    } catch (err) {
      const detail = toErrorDetail(err, 'network');
      return {
        providerId: this.descriptor.id,
        models: [],
        fetchedAt,
        fromCache: false,
        warning: `Descoberta de modelos indisponível: ${detail.message} ${detail.action ?? ''}`.trim(),
      };
    }
  }

  private toDescriptor(entry: Record<string, unknown>): ModelDescriptor | null {
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.name === 'string' ? entry.name : null;
    if (!id) return null;
    const created = typeof entry.created === 'number' ? entry.created : undefined;
    return {
      id,
      providerId: this.descriptor.id,
      displayName: typeof entry.name === 'string' && entry.name !== '' ? entry.name : id,
      vendor: typeof entry.owned_by === 'string' ? entry.owned_by : undefined,
      inputModalities: [],
      outputModalities: [],
      contextWindow: readContext(entry),
      supportedParameters: [],
      pricing: { currency: 'USD', unknown: true },
      capabilities: this.baseCapabilities(),
      unverified: false,
      createdAt: created !== undefined ? new Date(created * 1000).toISOString() : undefined,
    };
  }

  private baseCapabilities(): CapabilityMap {
    return {
      chat: cap('supported', 'declared', 'O endpoint expõe /chat/completions.'),
      streaming: cap('unknown', 'inferred', 'Depende da implementação do endpoint; será verificado no primeiro uso.'),
      toolCalling: cap(
        'unknown',
        'inferred',
        'Este endpoint não informa parâmetros suportados. Só será conhecido após um uso real.',
      ),
      imageInput: cap('unknown', 'inferred', 'Este endpoint não informa modalidades de entrada.'),
      taskExecution: cap(
        'unsupported',
        'declared',
        'No motor direto a execução de comandos arbitrários está desabilitada.',
      ),
    };
  }

  capabilitiesFor(model: ModelDescriptor): CapabilityMap {
    return { ...this.baseCapabilities(), ...model.capabilities };
  }

  async readUsage(): Promise<UsageSnapshot> {
    return {
      providerId: this.descriptor.id,
      fetchedAt: new Date().toISOString(),
      unavailable: ['Endpoints compatíveis não expõem saldo nem gasto de forma padronizada.'],
    };
  }

  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderStreamEvent> {
    return streamChatCompletions({
      url: `${this.baseUrl}/chat/completions`,
      bearer: this.options.getSecret(),
      extraHeaders: this.options.extraHeaders,
      request,
      buildRouting: false,
      allowInsecureLocal: this.isLocal,
    });
  }
}

function extractEntries(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const candidates = [obj.data, obj.models];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
    }
  }
  return [];
}

function countModels(raw: unknown): number {
  return extractEntries(raw).length;
}

function readContext(entry: Record<string, unknown>): number | undefined {
  for (const key of ['context_length', 'context_window', 'max_context_length']) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  const details = entry.details;
  if (details && typeof details === 'object') {
    const value = (details as Record<string, unknown>).context_length;
    if (typeof value === 'number') return value;
  }
  return undefined;
}
