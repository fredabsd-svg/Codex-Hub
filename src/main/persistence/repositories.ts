import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  AttachmentRef,
  Capability,
  ConversationId,
  ConversationItem,
  ConversationStatus,
  ConversationSummary,
  ModelDescriptor,
  ProviderDescriptor,
  TurnParameters,
  WorkspaceSummary,
} from '../../shared/domain';
import { DEFAULT_SETTINGS } from '../../shared/domain';
import { PREF_KEYS, TABLES } from './migrations';
import type { TransactionalStore } from './store';

const nowIso = (): string => new Date().toISOString();

/* ------------------------------------------------------------------ *
 * Conversas
 * ------------------------------------------------------------------ */

export interface ConversationRow extends ConversationSummary {
  /** Última sequência de item atribuída. */
  lastSeq: number;
}

export class ConversationRepository {
  constructor(private readonly store: TransactionalStore) {}

  list(includeArchived = false): ConversationSummary[] {
    return this.store
      .all<ConversationRow>(TABLES.conversations)
      .filter((c) => includeArchived || !c.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toSummary);
  }

  read(id: ConversationId): ConversationRow | null {
    return this.store.get<ConversationRow>(TABLES.conversations, id);
  }

  create(input: {
    engineId: ConversationSummary['engineId'];
    providerId: string;
    modelId: string;
    workspaceId?: string;
    workspacePath?: string;
    mode: ConversationSummary['mode'];
    title?: string;
    parameters: TurnParameters;
    forkedFromId?: string;
    forkedFromItemId?: string;
  }): ConversationRow {
    const at = nowIso();
    const row: ConversationRow = {
      id: randomUUID(),
      title: input.title ?? 'Nova conversa',
      titleIsLocal: true,
      engineId: input.engineId,
      providerId: input.providerId,
      modelId: input.modelId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      mode: input.mode,
      archived: false,
      favorite: false,
      createdAt: at,
      updatedAt: at,
      status: 'idle',
      messageCount: 0,
      parameters: input.parameters,
      lastSeq: 0,
      forkedFromId: input.forkedFromId,
      forkedFromItemId: input.forkedFromItemId,
    };
    this.store.put(TABLES.conversations, row);
    return row;
  }

  update(id: ConversationId, patch: Partial<ConversationRow>): ConversationRow {
    const current = this.read(id);
    if (!current) throw new Error(`Conversa não encontrada: ${id}`);
    const next: ConversationRow = { ...current, ...patch, id: current.id, updatedAt: nowIso() };
    this.store.put(TABLES.conversations, next);
    return next;
  }

  setStatus(id: ConversationId, status: ConversationStatus): ConversationRow | null {
    const current = this.read(id);
    if (!current) return null;
    if (current.status === status) return current;
    return this.update(id, { status });
  }

  nextSeq(id: ConversationId): number {
    const current = this.read(id);
    if (!current) throw new Error(`Conversa não encontrada: ${id}`);
    const seq = current.lastSeq + 1;
    this.store.put(TABLES.conversations, { ...current, lastSeq: seq });
    return seq;
  }

  delete(id: ConversationId): boolean {
    if (!this.read(id)) return false;
    this.store.transaction(() => {
      for (const item of this.store.all<ItemRow>(TABLES.items)) {
        if (item.conversationId === id) this.store.delete(TABLES.items, item.id);
      }
      this.store.delete(TABLES.drafts, id);
      this.store.delete(TABLES.conversations, id);
    });
    return true;
  }

  count(): number {
    return this.store.count(TABLES.conversations);
  }
}

function toSummary(row: ConversationRow): ConversationSummary {
  const { lastSeq: _lastSeq, ...summary } = row;
  return summary;
}

export { toSummary as conversationToSummary };

/* ------------------------------------------------------------------ *
 * Itens
 * ------------------------------------------------------------------ */

export interface ItemRow extends ConversationItem {
  seq: number;
}

export class ItemRepository {
  constructor(
    private readonly store: TransactionalStore,
    private readonly conversations: ConversationRepository,
  ) {}

  list(conversationId: ConversationId, options: { limit?: number; beforeSeq?: number } = {}): ItemRow[] {
    const all = this.store
      .all<ItemRow>(TABLES.items)
      .filter((i) => i.conversationId === conversationId)
      .filter((i) => (options.beforeSeq === undefined ? true : i.seq < options.beforeSeq))
      .sort((a, b) => a.seq - b.seq);
    if (options.limit === undefined) return all;
    return all.slice(Math.max(0, all.length - options.limit));
  }

  get(id: string): ItemRow | null {
    return this.store.get<ItemRow>(TABLES.items, id);
  }

  append(item: Omit<ConversationItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): ItemRow {
    const at = nowIso();
    const seq = this.conversations.nextSeq(item.conversationId);
    const row: ItemRow = {
      ...item,
      id: item.id ?? randomUUID(),
      createdAt: at,
      updatedAt: at,
      seq,
    };
    this.store.transaction(() => {
      this.store.put(TABLES.items, row);
      const conversation = this.conversations.read(item.conversationId);
      if (conversation) {
        const preview = row.text?.slice(0, 160) ?? conversation.lastMessagePreview;
        this.conversations.update(item.conversationId, {
          messageCount: conversation.messageCount + 1,
          lastMessagePreview: row.kind === 'userMessage' || row.kind === 'agentMessage' ? preview : conversation.lastMessagePreview,
        });
      }
    });
    return row;
  }

  update(id: string, patch: Partial<ItemRow>): ItemRow | null {
    const current = this.get(id);
    if (!current) return null;
    const next: ItemRow = { ...current, ...patch, id: current.id, seq: current.seq, updatedAt: nowIso() };
    this.store.put(TABLES.items, next);
    return next;
  }

  appendText(id: string, delta: string): ItemRow | null {
    const current = this.get(id);
    if (!current) return null;
    return this.update(id, { text: `${current.text ?? ''}${delta}`, status: 'streaming' });
  }

  count(): number {
    return this.store.count(TABLES.items);
  }

  /**
   * Marca operações incompletas após um encerramento abrupto.
   * NÃO reexecuta nada — apenas registra o estado real.
   */
  markIncompleteAfterRestart(): number {
    let touched = 0;
    this.store.transaction(() => {
      for (const item of this.store.all<ItemRow>(TABLES.items)) {
        if (item.status === 'pending' || item.status === 'streaming') {
          this.store.put(TABLES.items, {
            ...item,
            status: 'cancelled',
            updatedAt: nowIso(),
            errorDetail: {
              code: 'cancelled',
              message: 'Operação incompleta quando o aplicativo foi encerrado.',
              action: 'Reenvie a mensagem se quiser continuar. Nada foi executado novamente por conta própria.',
              retryable: false,
            },
          });
          touched += 1;
        }
      }
      for (const conversation of this.store.all<ConversationRow>(TABLES.conversations)) {
        if (
          conversation.status === 'running' ||
          conversation.status === 'awaitingApproval' ||
          conversation.status === 'interrupting' ||
          conversation.status === 'connecting'
        ) {
          this.store.put(TABLES.conversations, { ...conversation, status: 'idle', updatedAt: nowIso() });
        }
      }
    });
    return touched;
  }

  search(query: string, limit = 50): Array<{ conversationId: string; itemId: string; snippet: string }> {
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];
    const out: Array<{ conversationId: string; itemId: string; snippet: string }> = [];
    for (const item of this.store.all<ItemRow>(TABLES.items)) {
      const text = item.text;
      if (!text) continue;
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 60);
      out.push({
        conversationId: item.conversationId,
        itemId: item.id,
        snippet: `${start > 0 ? '…' : ''}${text.slice(start, idx + needle.length + 80)}${idx + needle.length + 80 < text.length ? '…' : ''}`,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Rascunhos
 * ------------------------------------------------------------------ */

export interface DraftRow {
  id: ConversationId;
  text: string;
  attachments: AttachmentRef[];
  updatedAt: string;
}

export class DraftRepository {
  constructor(private readonly store: TransactionalStore) {}

  read(conversationId: ConversationId): DraftRow {
    return (
      this.store.get<DraftRow>(TABLES.drafts, conversationId) ?? {
        id: conversationId,
        text: '',
        attachments: [],
        updatedAt: nowIso(),
      }
    );
  }

  save(conversationId: ConversationId, text: string, attachments: AttachmentRef[]): DraftRow {
    const row: DraftRow = { id: conversationId, text, attachments, updatedAt: nowIso() };
    if (text.trim() === '' && attachments.length === 0) {
      this.store.delete(TABLES.drafts, conversationId);
      return row;
    }
    this.store.put(TABLES.drafts, row);
    return row;
  }

  clear(conversationId: ConversationId): void {
    this.store.delete(TABLES.drafts, conversationId);
  }
}

/* ------------------------------------------------------------------ *
 * Workspaces
 * ------------------------------------------------------------------ */

export interface WorkspaceRow extends WorkspaceSummary {
  /** Raízes extras autorizadas explicitamente para escrita. */
  extraRoots: string[];
}

export class WorkspaceRepository {
  constructor(private readonly store: TransactionalStore) {}

  list(): WorkspaceRow[] {
    return this.store
      .all<WorkspaceRow>(TABLES.workspaces)
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
  }

  findByPath(path: string): WorkspaceRow | null {
    const needle = process.platform === 'win32' ? path.toLowerCase() : path;
    return (
      this.list().find((w) => (process.platform === 'win32' ? w.path.toLowerCase() : w.path) === needle) ?? null
    );
  }

  get(id: string): WorkspaceRow | null {
    return this.store.get<WorkspaceRow>(TABLES.workspaces, id);
  }

  upsertByPath(path: string, name: string): WorkspaceRow {
    const existing = this.findByPath(path);
    if (existing) {
      const next: WorkspaceRow = { ...existing, name, lastUsedAt: nowIso() };
      this.store.put(TABLES.workspaces, next);
      return next;
    }
    const row: WorkspaceRow = {
      id: randomUUID(),
      name,
      path,
      favorite: false,
      lastUsedAt: nowIso(),
      extraRoots: [],
    };
    this.store.put(TABLES.workspaces, row);
    return row;
  }

  update(id: string, patch: Partial<WorkspaceRow>): WorkspaceRow {
    const current = this.get(id);
    if (!current) throw new Error(`Workspace não encontrado: ${id}`);
    const next: WorkspaceRow = { ...current, ...patch, id: current.id };
    this.store.put(TABLES.workspaces, next);
    return next;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.store.delete(TABLES.workspaces, id);
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Cache de catálogo
 * ------------------------------------------------------------------ */

export interface CatalogRow {
  id: string; // providerId
  models: ModelDescriptor[];
  fetchedAt: string;
  nextCursor?: string;
  warning?: string;
}

export class CatalogCacheRepository {
  constructor(private readonly store: TransactionalStore) {}

  read(providerId: string): CatalogRow | null {
    return this.store.get<CatalogRow>(TABLES.catalog, providerId);
  }

  write(row: CatalogRow): CatalogRow {
    this.store.put(TABLES.catalog, row);
    return row;
  }

  clear(providerId: string): void {
    this.store.delete(TABLES.catalog, providerId);
  }
}

/* ------------------------------------------------------------------ *
 * Provedores compatíveis cadastrados pela pessoa
 * ------------------------------------------------------------------ */

export interface CompatibleProviderRow extends ProviderDescriptor {
  headers?: Record<string, string>;
  createdAt: string;
}

export class CompatibleProviderRepository {
  constructor(private readonly store: TransactionalStore) {}

  list(): CompatibleProviderRow[] {
    return this.store
      .all<CompatibleProviderRow>(TABLES.compatibleProviders)
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }

  get(id: string): CompatibleProviderRow | null {
    return this.store.get<CompatibleProviderRow>(TABLES.compatibleProviders, id);
  }

  put(row: CompatibleProviderRow): CompatibleProviderRow {
    this.store.put(TABLES.compatibleProviders, row);
    return row;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.store.delete(TABLES.compatibleProviders, id);
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * Preferências (nada sensível)
 * ------------------------------------------------------------------ */

interface PrefRow<T> {
  id: string;
  value: T;
}

export interface CapabilityObservation {
  providerId: string;
  modelId: string;
  capability: string;
  capabilityValue: Capability;
}

export class PreferencesRepository {
  constructor(private readonly store: TransactionalStore) {}

  private read<T>(key: string, fallback: T): T {
    const row = this.store.get<PrefRow<T>>(TABLES.prefs, key);
    return row ? row.value : fallback;
  }

  private write<T>(key: string, value: T): T {
    this.store.put<PrefRow<T>>(TABLES.prefs, { id: key, value });
    return value;
  }

  getSettings(): AppSettings {
    const stored = this.read<Partial<AppSettings>>(PREF_KEYS.settings, {});
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      layout: { ...DEFAULT_SETTINGS.layout, ...(stored.layout ?? {}) },
    };
  }

  updateSettings(patch: Partial<Omit<AppSettings, 'layout'>> & { layout?: Partial<AppSettings['layout']> }): AppSettings {
    const current = this.getSettings();
    const next: AppSettings = {
      ...current,
      ...patch,
      layout: { ...current.layout, ...(patch.layout ?? {}) },
    };
    this.write(PREF_KEYS.settings, next);
    return next;
  }

  isOnboardingCompleted(): boolean {
    return this.read<{ completed: boolean }>(PREF_KEYS.onboarding, { completed: false }).completed;
  }

  setOnboardingCompleted(completed: boolean): void {
    this.write(PREF_KEYS.onboarding, { completed });
  }

  getModelFavorites(): string[] {
    return this.read<string[]>(PREF_KEYS.modelFavorites, []);
  }

  setModelFavorite(providerId: string, modelId: string, favorite: boolean): string[] {
    const key = `${providerId}::${modelId}`;
    const current = new Set(this.getModelFavorites());
    if (favorite) current.add(key);
    else current.delete(key);
    return this.write(PREF_KEYS.modelFavorites, [...current]);
  }

  getRecentModels(): string[] {
    return this.read<string[]>(PREF_KEYS.recentModels, []);
  }

  pushRecentModel(providerId: string, modelId: string): string[] {
    const key = `${providerId}::${modelId}`;
    const current = this.getRecentModels().filter((k) => k !== key);
    current.unshift(key);
    return this.write(PREF_KEYS.recentModels, current.slice(0, 20));
  }

  getCapabilityObservations(): CapabilityObservation[] {
    return this.read<CapabilityObservation[]>(PREF_KEYS.capabilityObservations, []);
  }

  recordCapabilityObservation(observation: CapabilityObservation): CapabilityObservation[] {
    const current = this.getCapabilityObservations().filter(
      (o) =>
        !(
          o.providerId === observation.providerId &&
          o.modelId === observation.modelId &&
          o.capability === observation.capability
        ),
    );
    current.push(observation);
    return this.write(PREF_KEYS.capabilityObservations, current.slice(-500));
  }
}
