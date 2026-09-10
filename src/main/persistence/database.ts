import { join } from 'node:path';
import { logger } from '../services/logger';
import { MIGRATIONS } from './migrations';
import {
  CatalogCacheRepository,
  CompatibleProviderRepository,
  ConversationRepository,
  DraftRepository,
  ItemRepository,
  PreferencesRepository,
  WorkspaceRepository,
} from './repositories';
import { TransactionalStore } from './store';

export interface Database {
  store: TransactionalStore;
  conversations: ConversationRepository;
  items: ItemRepository;
  drafts: DraftRepository;
  workspaces: WorkspaceRepository;
  catalog: CatalogCacheRepository;
  compatibleProviders: CompatibleProviderRepository;
  prefs: PreferencesRepository;
}

/**
 * Abre o banco em `<userData>/data`. Nunca dentro do diretório de instalação
 * nem do ASAR.
 */
export function openDatabase(userDataDir: string): Database {
  const store = new TransactionalStore(join(userDataDir, 'data'));
  store.open(MIGRATIONS);

  const conversations = new ConversationRepository(store);
  const items = new ItemRepository(store, conversations);

  const recovered = items.markIncompleteAfterRestart();
  if (recovered > 0) {
    logger.warn('database', 'Itens incompletos marcados após reinício', { count: recovered });
  }

  return {
    store,
    conversations,
    items,
    drafts: new DraftRepository(store),
    workspaces: new WorkspaceRepository(store),
    catalog: new CatalogCacheRepository(store),
    compatibleProviders: new CompatibleProviderRepository(store),
    prefs: new PreferencesRepository(store),
  };
}
