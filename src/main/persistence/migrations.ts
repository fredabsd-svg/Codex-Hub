import type { Migration } from './store';
import { DEFAULT_SETTINGS } from '../../shared/domain';

export const TABLES = {
  conversations: 'conversations',
  items: 'items',
  drafts: 'drafts',
  workspaces: 'workspaces',
  catalog: 'catalog',
  prefs: 'prefs',
  compatibleProviders: 'compatibleProviders',
  credentialsMeta: 'credentialsMeta',
} as const;

export const PREF_KEYS = {
  settings: 'settings',
  onboarding: 'onboarding',
  modelFavorites: 'modelFavorites',
  recentModels: 'recentModels',
  capabilityObservations: 'capabilityObservations',
} as const;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Cria tabelas base e as preferências padrão',
    up(ctx) {
      const existing = ctx.all(TABLES.prefs).find((r) => r.id === PREF_KEYS.settings);
      if (!existing) {
        ctx.put(TABLES.prefs, { id: PREF_KEYS.settings, value: DEFAULT_SETTINGS });
      }
      const onboarding = ctx.all(TABLES.prefs).find((r) => r.id === PREF_KEYS.onboarding);
      if (!onboarding) {
        ctx.put(TABLES.prefs, { id: PREF_KEYS.onboarding, value: { completed: false } });
      }
    },
  },
  {
    version: 2,
    description: 'Garante campos de favoritos e modo nas conversas existentes',
    up(ctx) {
      for (const row of ctx.all(TABLES.conversations)) {
        let changed = false;
        if (typeof row.favorite !== 'boolean') {
          row.favorite = false;
          changed = true;
        }
        if (typeof row.mode !== 'string') {
          row.mode = 'chat';
          changed = true;
        }
        if (typeof row.titleIsLocal !== 'boolean') {
          row.titleIsLocal = true;
          changed = true;
        }
        if (changed) ctx.put(TABLES.conversations, row);
      }
    },
  },
  {
    version: 3,
    description: 'Adiciona sequência monotônica de itens por conversa',
    up(ctx) {
      const bySeq = new Map<string, number>();
      const rows = ctx
        .all(TABLES.items)
        .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      for (const row of rows) {
        if (typeof row.seq === 'number') continue;
        const conversationId = String(row.conversationId ?? '');
        const next = (bySeq.get(conversationId) ?? 0) + 1;
        bySeq.set(conversationId, next);
        row.seq = next;
        ctx.put(TABLES.items, row);
      }
    },
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
