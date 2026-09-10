// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/src/App';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useAppStore } from '../../src/renderer/src/stores/appStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { DEFAULT_FILTERS, useCatalogStore } from '../../src/renderer/src/stores/catalogStore';
import { resetOverlayStack } from '../../src/renderer/src/lib/overlayStack';
import { conversationFixture, installFakeBridge, itemFixture, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;
beforeEach(() => {
  useConversationStore.setState({
    conversations: [],
    activeId: null,
    items: {},
    drafts: {},
    runtime: {},
    history: {},
    sending: {},
    focusedItem: null,
    loadingItems: false,
    approvals: [],
  });
  useAppStore.setState({ ready: false, bootError: null, skills: [], usage: {}, notices: [] });
  useUiStore.setState({ dialog: null, confirmRequest: null, toasts: [], windowWidth: 1440 });
  useCatalogStore.setState({
    pages: {},
    loading: {},
    favorites: [],
    recents: [],
    filters: DEFAULT_FILTERS,
    probing: null,
  });
  resetOverlayStack();
});
afterEach(() => {
  cleanup();
  bridge?.restore();
});

describe('Espaço de trabalho', () => {
  it('prepara uma tarefa pronta no rascunho sem enviá-la automaticamente', async () => {
    bridge = installFakeBridge({ settings: { startupBehavior: 'home' } });
    render(<App />);
    await screen.findByRole('heading', { name: 'O que vamos construir hoje?' });
    await userEvent.click(screen.getByRole('button', { name: /Revisar código/ }));
    const composer = await screen.findByRole('textbox', { name: /Descreva a tarefa/i });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toContain('Revise este projeto'));
    expect(bridge.callsTo('conversations:create')).toHaveLength(1);
    expect(bridge.callsTo('turn:send')).toHaveLength(0);
  });

  it.each(['agentMessage', 'reasoningSummary'] as const)(
    'abre a busca com Ctrl+F e revela um item %s',
    async (kind) => {
      bridge = installFakeBridge({
        conversations: [conversationFixture()],
        settings: { showReasoningSummaries: false },
        items: { c1: [itemFixture({ kind, text: 'Uma decisão importante' })] },
        overrides: {
          'conversations:search': () => ({
            conversations: [],
            matches: [{ conversationId: 'c1', itemId: 'i1', snippet: 'Uma decisão importante' }],
          }),
        },
      });
      render(<App />);
      await screen.findByRole('log');
      await userEvent.keyboard('{Control>}f{/Control}');
      const dialog = await screen.findByRole('dialog', { name: 'Buscar nesta conversa' });
      await userEvent.type(within(dialog).getByRole('combobox'), 'decisão');
      const result = await within(dialog).findByRole('option');
      expect(bridge.callsTo('conversations:search').at(-1)).toMatchObject({
        conversationId: 'c1',
        query: 'decisão',
      });
      await userEvent.click(result);
      await waitFor(() => expect(document.getElementById('conversation-item-i1')).toHaveFocus());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('mantém o painel de contexto acessível em uma janela estreita', async () => {
    bridge = installFakeBridge({ settings: { startupBehavior: 'home' } });
    useUiStore.setState({ windowWidth: 960 });
    render(<App />);
    await screen.findByRole('heading', { name: 'O que vamos construir hoje?' });
    await userEvent.click(screen.getByRole('button', { name: /Abrir painel/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Painel de contexto' });
    expect(within(dialog).getByRole('tab', { name: 'Arquivos' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bridge.callsTo('turn:interrupt')).toHaveLength(0);
  });
});
