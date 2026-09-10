/**
 * Catálogo de modelos.
 *
 * Responsabilidades:
 *  - buscar o catálogo dinâmico de cada provedor;
 *  - manter cache local com data de coleta e permitir refresh manual;
 *  - mesclar observações de capacidade TESTADAS sobre as DECLARADAS;
 *  - aceitar IDs manuais, marcados como não verificados;
 *  - nunca transformar dado ausente em zero, gratuito ou ilimitado.
 */

import type { Capability, CapabilityKey, ModelCatalogPage, ModelDescriptor } from '../../shared/domain';
import { toErrorDetail } from '../../shared/errors';
import { logger } from '../services/logger';
import type { CatalogCacheRepository, PreferencesRepository } from '../persistence/repositories';
import type { ModelProvider } from './types';

/** Idade a partir da qual o cache é considerado velho (mas ainda utilizável). */
export const CATALOG_STALE_MS = 6 * 60 * 60 * 1000;

export class ModelCatalog {
  private readonly inflight = new Map<string, Promise<ModelCatalogPage>>();

  constructor(
    private readonly cache: CatalogCacheRepository,
    private readonly prefs: PreferencesRepository,
    private readonly resolveProvider: (providerId: string) => ModelProvider | null,
  ) {}

  /** Lê do cache sem tocar a rede. */
  cached(providerId: string): ModelCatalogPage | null {
    const row = this.cache.read(providerId);
    if (!row) return null;
    return {
      providerId,
      models: this.decorate(providerId, row.models),
      fetchedAt: row.fetchedAt,
      fromCache: true,
      nextCursor: row.nextCursor,
      warning: row.warning,
    };
  }

  async list(providerId: string, options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelCatalogPage> {
    const cached = this.cached(providerId);
    if (!options.forceRefresh && cached && cached.models.length > 0) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CATALOG_STALE_MS) return cached;
    }
    return this.refresh(providerId, { signal: options.signal, fallback: cached });
  }

  async refresh(
    providerId: string,
    options: { signal?: AbortSignal; fallback?: ModelCatalogPage | null } = {},
  ): Promise<ModelCatalogPage> {
    const existing = this.inflight.get(providerId);
    if (existing) return existing;

    const provider = this.resolveProvider(providerId);
    if (!provider) {
      return {
        providerId,
        models: options.fallback?.models ?? [],
        fetchedAt: options.fallback?.fetchedAt ?? new Date().toISOString(),
        fromCache: true,
        warning: 'Provedor não registrado neste aplicativo.',
      };
    }

    const task = (async (): Promise<ModelCatalogPage> => {
      try {
        const page = await provider.listModels({ signal: options.signal });
        const manual = this.manualModels(providerId).filter((m) => !page.models.some((p) => p.id === m.id));
        const merged = [...page.models, ...manual];
        this.cache.write({
          id: providerId,
          models: merged,
          fetchedAt: page.fetchedAt,
          nextCursor: page.nextCursor,
          warning: page.warning,
        });
        return { ...page, models: this.decorate(providerId, merged) };
      } catch (err) {
        const detail = toErrorDetail(err, 'network');
        logger.warn('catalog', 'Falha ao atualizar o catálogo', { providerId, code: detail.code });
        const fallback = options.fallback ?? this.cached(providerId);
        if (fallback && fallback.models.length > 0) {
          return {
            ...fallback,
            fromCache: true,
            warning: `Não foi possível atualizar agora (${detail.message}). Mostrando o catálogo em cache de ${formatDate(fallback.fetchedAt)}.`,
          };
        }
        return {
          providerId,
          models: this.manualModels(providerId),
          fetchedAt: new Date().toISOString(),
          fromCache: false,
          warning: `${detail.message} ${detail.action ?? ''}`.trim(),
        };
      } finally {
        this.inflight.delete(providerId);
      }
    })();

    this.inflight.set(providerId, task);
    return task;
  }

  find(providerId: string, modelId: string): ModelDescriptor | null {
    const page = this.cached(providerId);
    return page?.models.find((m) => m.id === modelId) ?? null;
  }

  /** Adiciona um ID informado manualmente, sempre como não verificado. */
  addManualModel(providerId: string, modelId: string, displayName?: string): ModelCatalogPage {
    const row = this.cache.read(providerId);
    const models = row?.models ?? [];
    if (models.some((m) => m.id === modelId)) {
      return this.cached(providerId) ?? { providerId, models, fetchedAt: new Date().toISOString(), fromCache: true };
    }
    const descriptor: ModelDescriptor = {
      id: modelId,
      providerId,
      displayName: displayName?.trim() || modelId,
      inputModalities: [],
      outputModalities: [],
      supportedParameters: [],
      pricing: { currency: 'USD', unknown: true },
      capabilities: {
        chat: { state: 'unknown', source: 'inferred', reason: 'ID informado manualmente; nada foi verificado.' },
        streaming: { state: 'unknown', source: 'inferred' },
        toolCalling: { state: 'unknown', source: 'inferred' },
        imageInput: { state: 'unknown', source: 'inferred' },
      },
      unverified: true,
    };
    const next = [...models, descriptor];
    this.cache.write({
      id: providerId,
      models: next,
      fetchedAt: row?.fetchedAt ?? new Date().toISOString(),
      nextCursor: row?.nextCursor,
      warning: row?.warning,
    });
    return this.cached(providerId) as ModelCatalogPage;
  }

  private manualModels(providerId: string): ModelDescriptor[] {
    return (this.cache.read(providerId)?.models ?? []).filter((m) => m.unverified);
  }

  /** Aplica observações testadas sobre as capacidades declaradas. */
  private decorate(providerId: string, models: ModelDescriptor[]): ModelDescriptor[] {
    const observations = this.prefs.getCapabilityObservations().filter((o) => o.providerId === providerId);
    if (observations.length === 0) return models;
    const byModel = new Map<string, Array<{ capability: string; value: Capability }>>();
    for (const observation of observations) {
      const list = byModel.get(observation.modelId) ?? [];
      list.push({ capability: observation.capability, value: observation.capabilityValue });
      byModel.set(observation.modelId, list);
    }
    return models.map((model) => {
      const list = byModel.get(model.id);
      if (!list) return model;
      const capabilities = { ...model.capabilities };
      for (const { capability, value } of list) {
        capabilities[capability as CapabilityKey] = value;
      }
      return { ...model, capabilities };
    });
  }

  recordObservation(providerId: string, modelId: string, capability: CapabilityKey, value: Capability): void {
    this.prefs.recordCapabilityObservation({ providerId, modelId, capability, capabilityValue: value });
  }

  /**
   * Reage a um erro concreto do provedor.
   * Indisponibilidade temporária (rede, limite, 5xx) NÃO vira incompatibilidade.
   */
  applyErrorObservation(providerId: string, modelId: string, code: string, message: string): void {
    if (code === 'unsupportedParameter') {
      this.recordObservation(providerId, modelId, 'toolCalling', {
        state: 'unknown',
        source: 'tested',
        reason: `O provedor recusou um parâmetro: ${message.slice(0, 140)}`,
        observedAt: new Date().toISOString(),
      });
      return;
    }
    if (code === 'modelUnavailable') {
      this.recordObservation(providerId, modelId, 'chat', {
        state: 'unknown',
        source: 'tested',
        reason: 'O provedor respondeu que o modelo não está acessível a esta credencial.',
        observedAt: new Date().toISOString(),
      });
    }
    // rateLimited / providerUnavailable / network / timeout: nada é marcado.
  }

  favorites(): string[] {
    return this.prefs.getModelFavorites();
  }

  setFavorite(providerId: string, modelId: string, favorite: boolean): string[] {
    return this.prefs.setModelFavorite(providerId, modelId, favorite);
  }

  recents(): string[] {
    return this.prefs.getRecentModels();
  }

  noteUsed(providerId: string, modelId: string): void {
    this.prefs.pushRecentModel(providerId, modelId);
  }
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}
