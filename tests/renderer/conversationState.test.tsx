// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useConversationStore as store } from '../../src/renderer/src/stores/conversationStore';
import { conversationFixture, installFakeBridge, itemFixture, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() =>
  store.setState({
    conversations: [conversationFixture()],
    activeId: 'c1',
    items: {},
    drafts: {},
    runtime: {},
    loadingItems: false,
    history: {},
    sending: {},
    focusedItem: null,
  }),
);
afterEach(() => bridge?.restore());

describe('Conversas — respostas concorrentes do IPC', () => {
  it('carrega páginas anteriores e localiza uma mensagem fora dos 500 itens recentes', async () => {
    const all = Array.from({ length: 650 }, (_, index) =>
      itemFixture({ id: `m${index + 1}`, seq: index + 1 }),
    );
    bridge = installFakeBridge({
      overrides: {
        'conversations:items': (payload) => {
          const { beforeSeq, limit = 500 } = payload as { beforeSeq?: number; limit?: number };
          return all.filter((item) => beforeSeq === undefined || item.seq! < beforeSeq).slice(-limit);
        },
      },
    });
    await store.getState().setActive('c1');
    expect(store.getState().items.c1).toHaveLength(500);
    expect(store.getState().history.c1?.hasMore).toBe(true);
    await store.getState().revealItem('c1', 'm20');
    expect(store.getState().items.c1).toHaveLength(650);
    expect(store.getState().items.c1?.[0]?.id).toBe('m1');
    expect(store.getState().history.c1?.hasMore).toBe(false);
    expect(store.getState().focusedItem?.itemId).toBe('m20');
    expect(bridge.callsTo('conversations:items')[1]).toMatchObject({ beforeSeq: 151 });
  });

  it('ignora um delta duplicado sem duplicar texto', async () => {
    bridge = installFakeBridge();
    const at = new Date().toISOString();
    const base = { conversationId: 'c1', at, engineId: 'direct' as const, providerId: 'openrouter' };
    store.getState().applyEvent({ ...base, type: 'item/started', item: itemFixture({ text: '' }), seq: 1 });
    store.getState().applyEvent({ ...base, type: 'item/textDelta', itemId: 'i1', delta: 'Uma vez', seq: 2 });
    store.getState().applyEvent({ ...base, type: 'item/textDelta', itemId: 'i1', delta: 'Uma vez', seq: 2 });
    store.getState().applyEvent({ ...base, type: 'turn/completed', turnId: 't1', seq: 3 });
    expect(store.getState().items.c1?.[0]?.text).toBe('Uma vez');
  });

  it('mantém o indicador de carregamento da conversa atual quando outra termina de carregar', async () => {
    const first = deferred<ReturnType<typeof itemFixture>[]>();
    const second = deferred<ReturnType<typeof itemFixture>[]>();
    bridge = installFakeBridge({
      overrides: {
        'conversations:items': (payload) =>
          (payload as { conversationId: string }).conversationId === 'c1' ? first.promise : second.promise,
      },
    });
    store.setState({ conversations: [conversationFixture(), conversationFixture({ id: 'c2' })] });
    const a = store.getState().setActive('c1');
    const b = store.getState().setActive('c2');
    first.resolve([]);
    await a;
    expect(store.getState().activeId).toBe('c2');
    expect(store.getState().loadingItems).toBe(true);
    second.resolve([]);
    await b;
    expect(store.getState().loadingItems).toBe(false);
  });
  it('mantém o estado concluído quando a resposta termina antes do envio retornar', async () => {
    bridge = installFakeBridge({
      overrides: {
        'turn:send': () => {
          bridge.emitDomain({
            type: 'turn/completed',
            conversationId: 'c1',
            turnId: 't1',
            seq: 2,
            at: new Date().toISOString(),
            engineId: 'direct',
            providerId: 'openrouter',
          });
          // O componente App normalmente encaminha o evento ao store.
          store.getState().applyEvent({
            type: 'turn/completed',
            conversationId: 'c1',
            turnId: 't1',
            seq: 2,
            at: new Date().toISOString(),
            engineId: 'direct',
            providerId: 'openrouter',
          });
          return { accepted: true, turnId: 't1' };
        },
      },
    });
    await store.getState().send({ conversationId: 'c1', text: 'olá' });
    expect(store.getState().runtime.c1?.status).toBe('completed');
  });

  it('preserva a próxima mensagem digitada enquanto o envio está pendente', async () => {
    const response = deferred<{ accepted: true; turnId: string }>();
    bridge = installFakeBridge({ overrides: { 'turn:send': () => response.promise } });
    store.getState().setDraftText('c1', 'primeira mensagem');
    const sent = store.getState().send({ conversationId: 'c1', text: 'primeira mensagem' });
    store.getState().setDraftText('c1', 'próxima mensagem');
    response.resolve({ accepted: true, turnId: 't1' });
    await sent;
    expect(store.getState().drafts.c1?.text).toBe('próxima mensagem');
    expect(bridge.callsTo('conversations:saveDraft').at(-1)).toMatchObject({ text: 'próxima mensagem' });
  });

  it('recusa um segundo envio enquanto aguarda a primeira chamada de IPC', async () => {
    const response = deferred<{ accepted: true; turnId: string }>();
    bridge = installFakeBridge({ overrides: { 'turn:send': () => response.promise } });
    const first = store.getState().send({ conversationId: 'c1', text: 'olá' });
    const second = store.getState().send({ conversationId: 'c1', text: 'olá' });
    response.resolve({ accepted: true, turnId: 't1' });
    await first;
    expect(await second).toBe(false);
    expect(bridge.callsTo('turn:send')).toHaveLength(1);
  });

  it('mescla o histórico atrasado com os eventos novos sem perder mensagens', async () => {
    const response = deferred<ReturnType<typeof itemFixture>[]>();
    bridge = installFakeBridge({ overrides: { 'conversations:items': () => response.promise } });
    const selected = store.getState().setActive('c1');
    const fresh = itemFixture({ id: 'new', seq: 2, text: 'Resposta nova' });
    store.getState().applyEvent({
      type: 'item/completed',
      item: fresh,
      conversationId: 'c1',
      seq: 1,
      at: fresh.createdAt,
      engineId: 'direct',
      providerId: 'openrouter',
    });
    response.resolve([itemFixture({ id: 'old', seq: 1, text: 'Histórico antigo' })]);
    await selected;
    expect(store.getState().items.c1?.map((item) => item.id)).toEqual(['old', 'new']);
  });

  it('não substitui o texto digitado pelo rascunho carregado com atraso', async () => {
    const response = deferred<{ text: string; attachments: [] }>();
    bridge = installFakeBridge({ overrides: { 'conversations:readDraft': () => response.promise } });
    store.setState({ items: { c1: [] } });
    const selected = store.getState().setActive('c1');
    store.getState().setDraftText('c1', 'Texto novo');
    response.resolve({ text: 'Rascunho antigo', attachments: [] });
    await selected;
    expect(store.getState().drafts.c1?.text).toBe('Texto novo');
  });
});
