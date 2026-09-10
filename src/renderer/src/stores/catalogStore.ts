/**
 * Catálogo de modelos no renderer: busca, filtros, favoritos e recentes.
 *
 * Os dados vêm do processo principal já normalizados. A interface nunca
 * transforma ausência de informação em zero, "grátis" ou "ilimitado".
 */

import { create } from 'zustand';
import type { CapabilityKey, ModelCatalogPage, ModelDescriptor } from '@shared/domain';
import { errorOf, invoke } from '../lib/api';
import { useUiStore } from './uiStore';

export type CatalogSort = 'name' | 'priceAsc' | 'context' | 'recent';

export interface CatalogFilters {
  query: string;
  onlyFavorites: boolean;
  onlyTools: boolean;
  onlyImages: boolean;
  onlyZeroPrice: boolean;
  vendor: string | null;
  sort: CatalogSort;
}

interface CatalogState {
  pages: Record<string, ModelCatalogPage>;
  loading: Record<string, boolean>;
  favorites: string[];
  /** `providerId::modelId`, do mais recente ao mais antigo. */
  recents: string[];
  filters: CatalogFilters;
  probing: string | null;

  /** Recebe favoritos e recentes persistidos, no bootstrap. */
  hydrate(favorites: string[], recents: string[]): void;
  load(providerId: string, force?: boolean): Promise<void>;
  addManual(providerId: string, modelId: string, displayName?: string): Promise<void>;
  toggleFavorite(providerId: string, modelId: string): Promise<void>;
  probeTools(providerId: string, modelId: string): Promise<void>;
  setFilters(patch: Partial<CatalogFilters>): void;
  resetFilters(): void;
  modelOf(providerId: string, modelId: string): ModelDescriptor | undefined;
}

export const DEFAULT_FILTERS: CatalogFilters = {
  query: '',
  onlyFavorites: false,
  onlyTools: false,
  onlyImages: false,
  onlyZeroPrice: false,
  vendor: null,
  sort: 'name',
};

/**
 * Cargas em andamento por provedor.
 *
 * Quem chama `load` enquanto outra carga do mesmo provedor está em andamento
 * recebe A MESMA promessa — e portanto espera o resultado de verdade, em vez de
 * receber um `undefined` imediato e concluir que não há modelos.
 */
const inflight = new Map<string, Promise<void>>();
const markers = new Map<string, { done: boolean }>();

export const useCatalogStore = create<CatalogState>((set, get) => ({
  pages: {},
  loading: {},
  favorites: [],
  recents: [],
  filters: DEFAULT_FILTERS,
  probing: null,

  hydrate(favorites, recents) {
    set({ favorites, recents });
  },

  async load(providerId, force = false) {
    const running = inflight.get(providerId);
    if (running && !force) return running;
    // Atualização forçada durante uma carga em andamento: espera a carga
    // terminar para não deixar duas tarefas gravando a mesma página.
    if (running) await running.catch(() => undefined);

    // Marcador próprio: o `finally` só limpa a entrada se ela ainda for desta
    // carga (uma carga forçada posterior pode ter substituído a entrada).
    const marker = { done: false };
    const task = (async (): Promise<void> => {
      set((state) => ({ loading: { ...state.loading, [providerId]: true } }));
      try {
        const page = force
          ? await invoke('catalog:refresh', { providerId })
          : await invoke('catalog:list', { providerId });
        set((state) => ({ pages: { ...state.pages, [providerId]: page } }));
        if (page.warning) {
          useUiStore.getState().pushToast({
            tone: page.models.length > 0 ? 'warning' : 'error',
            title: 'Catálogo de modelos',
            body: page.warning,
          });
        }
      } catch (err) {
        useUiStore.getState().pushError(errorOf(err), 'Não foi possível carregar o catálogo');
      } finally {
        marker.done = true;
        if (markers.get(providerId) === marker) {
          inflight.delete(providerId);
          markers.delete(providerId);
          set((state) => ({ loading: { ...state.loading, [providerId]: false } }));
        }
      }
    })();

    inflight.set(providerId, task);
    markers.set(providerId, marker);
    return task;
  },

  async addManual(providerId, modelId, displayName) {
    try {
      const page = await invoke('catalog:addManualModel', { providerId, modelId, displayName });
      set((state) => ({ pages: { ...state.pages, [providerId]: page } }));
      useUiStore.getState().pushToast({
        tone: 'info',
        title: `Modelo "${modelId}" adicionado`,
        body: 'Ele aparece marcado como não verificado: nada foi confirmado com o provedor.',
      });
    } catch (err) {
      useUiStore.getState().pushError(errorOf(err), 'Não foi possível adicionar o modelo');
    }
  },

  async toggleFavorite(providerId, modelId) {
    const key = `${providerId}::${modelId}`;
    const favorite = !get().favorites.includes(key);
    try {
      const favorites = await invoke('catalog:setFavorite', { providerId, modelId, favorite });
      set({ favorites });
    } catch (err) {
      useUiStore.getState().pushError(errorOf(err));
    }
  },

  async probeTools(providerId, modelId) {
    set({ probing: `${providerId}::${modelId}` });
    try {
      const page = await invoke('catalog:probeCapability', { providerId, modelId, capability: 'toolCalling' });
      set((state) => ({ pages: { ...state.pages, [providerId]: page } }));
      useUiStore.getState().pushToast({
        tone: 'success',
        title: 'Verificação concluída',
        body: 'O resultado foi registrado como "verificado em uso" no catálogo.',
      });
    } catch (err) {
      const detail = errorOf(err);
      useUiStore.getState().pushToast({
        tone: 'warning',
        title: 'Verificação inconclusiva',
        body: `${detail.message} ${detail.action ?? ''} Nada foi marcado como incompatível.`.trim(),
        technical: detail.technical,
      });
    } finally {
      set({ probing: null });
    }
  },

  setFilters(patch) {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
  },

  resetFilters() {
    set({ filters: DEFAULT_FILTERS });
  },

  modelOf(providerId, modelId) {
    return get().pages[providerId]?.models.find((model) => model.id === modelId);
  },
}));

/* ------------------------------------------------------------------ *
 * Seleção e ordenação
 * ------------------------------------------------------------------ */

function capabilityIs(model: ModelDescriptor, key: CapabilityKey, state: 'supported' | 'unknown'): boolean {
  return model.capabilities[key]?.state === state;
}

export function filterModels(
  models: ModelDescriptor[],
  filters: CatalogFilters,
  favorites: string[],
): ModelDescriptor[] {
  const needle = filters.query.trim().toLowerCase();
  const favoriteSet = new Set(favorites);

  const filtered = models.filter((model) => {
    if (needle !== '') {
      const haystack = `${model.displayName} ${model.id} ${model.vendor ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.onlyFavorites && !favoriteSet.has(`${model.providerId}::${model.id}`)) return false;
    if (filters.onlyTools && !capabilityIs(model, 'toolCalling', 'supported')) return false;
    if (filters.onlyImages && !capabilityIs(model, 'imageInput', 'supported')) return false;
    if (filters.onlyZeroPrice) {
      if (model.pricing.unknown) return false;
      const prompt = model.pricing.promptPerToken ?? 1;
      const completion = model.pricing.completionPerToken ?? 1;
      if (prompt !== 0 || completion !== 0) return false;
    }
    if (filters.vendor && model.vendor !== filters.vendor) return false;
    return true;
  });

  const sorted = [...filtered];
  switch (filters.sort) {
    case 'priceAsc':
      sorted.sort((a, b) => {
        // Preço desconhecido vai para o fim: não é zero.
        const av = a.pricing.unknown ? Number.POSITIVE_INFINITY : (a.pricing.promptPerToken ?? Number.POSITIVE_INFINITY);
        const bv = b.pricing.unknown ? Number.POSITIVE_INFINITY : (b.pricing.promptPerToken ?? Number.POSITIVE_INFINITY);
        if (av === bv) return a.displayName.localeCompare(b.displayName, 'pt-BR');
        return av - bv;
      });
      break;
    case 'context':
      sorted.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
      break;
    case 'recent':
      sorted.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      break;
    case 'name':
    default:
      sorted.sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
      break;
  }
  return sorted;
}

export function vendorsOf(models: ModelDescriptor[]): string[] {
  const vendors = new Set<string>();
  for (const model of models) if (model.vendor) vendors.add(model.vendor);
  return [...vendors].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
