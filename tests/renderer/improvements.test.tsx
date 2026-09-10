// @vitest-environment jsdom
/**
 * Regressões das melhorias de funcionalidade e design:
 *  - foco inicial dos diálogos vai para o campo de busca, não para "Fechar";
 *  - atalhos globais ficam inativos com um diálogo aberto;
 *  - a paleta pesquisa no conteúdo das mensagens e mostra atalhos;
 *  - Enter envia quando a preferência está ligada; Shift+Enter quebra linha;
 *  - excluir conversa usa o diálogo de confirmação do sistema de design;
 *  - o painel de contexto soma tokens e custo da conversa.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/src/App';
import { Composer } from '../../src/renderer/src/features/chat/Composer';
import { RightPanel } from '../../src/renderer/src/components/layout/RightPanel';
import { useAppStore } from '../../src/renderer/src/stores/appStore';
import { useCatalogStore, DEFAULT_FILTERS } from '../../src/renderer/src/stores/catalogStore';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { resetOverlayStack } from '../../src/renderer/src/lib/overlayStack';
import { conversationFixture, installFakeBridge, itemFixture, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;

function resetStores(): void {
  useConversationStore.setState({
    conversations: [],
    activeId: null,
    items: {},
    runtime: {},
    drafts: {},
    approvals: [],
    loadingItems: false,
  });
  useCatalogStore.setState({
    pages: {},
    loading: {},
    favorites: [],
    recents: [],
    filters: DEFAULT_FILTERS,
    probing: null,
  });
  useUiStore.setState({ dialog: null, toasts: [], confirmRequest: null, autoScroll: true });
  useAppStore.setState({ ready: false, bootError: null, skills: [], usage: {}, notices: [] });
  resetOverlayStack();
}

beforeEach(resetStores);

afterEach(() => {
  cleanup();
  bridge?.restore();
});

async function openApp(options: Parameters<typeof installFakeBridge>[0] = {}): Promise<void> {
  bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] }, ...options });
  render(<App />);
  await waitFor(() =>
    expect(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    ).toBeInTheDocument(),
  );
}

describe('Diálogos — foco inicial', () => {
  it('Ctrl+K deixa o foco no campo de busca da paleta, não no botão Fechar', async () => {
    await openApp();
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: /Comandos e busca/i });
    const search = within(palette).getByRole('combobox');
    await waitFor(() => expect(document.activeElement).toBe(search));
    // Digitar já filtra: nada de "Enter fecha o diálogo" por foco no botão errado.
    await userEvent.keyboard('config');
    expect(within(palette).getByRole('option', { name: /Configurações/i })).toBeInTheDocument();
  });
});

describe('Atalhos globais com sobreposição aberta', () => {
  it('Ctrl+N não cria conversa enquanto as configurações estão abertas', async () => {
    await openApp();
    await userEvent.keyboard('{Control>},{/Control}');
    await screen.findByRole('dialog', { name: /^Configurações$/i });
    await userEvent.keyboard('{Control>}n{/Control}');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bridge.callsTo('conversations:create')).toHaveLength(0);
  });

  it('Ctrl+K alterna a paleta mesmo com ela aberta', async () => {
    await openApp();
    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: /Comandos e busca/i });
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Comandos e busca/i })).not.toBeInTheDocument(),
    );
  });
});

describe('Paleta de comandos', () => {
  it('pesquisa no conteúdo das mensagens pelo processo principal e mostra atalhos', async () => {
    await openApp({
      overrides: {
        'conversations:search': () => ({
          conversations: [],
          matches: [{ conversationId: 'c1', itemId: 'i1', snippet: '…trecho com a palavra rara…' }],
        }),
      },
    });
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: /Comandos e busca/i });
    expect(within(palette).getAllByText('Ctrl').length).toBeGreaterThan(0);
    await userEvent.keyboard('rara');
    await waitFor(() => expect(bridge.callsTo('conversations:search').length).toBeGreaterThan(0));
    expect(await within(palette).findByText(/palavra rara/)).toBeInTheDocument();
    expect(within(palette).getByText('Mensagens')).toBeInTheDocument();
  });

  it('oferece ações da conversa atual, incluindo exportação', async () => {
    await openApp();
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );
    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: /Comandos e busca/i });
    await userEvent.keyboard('exportar');
    expect(
      within(palette).getByRole('option', { name: /Exportar a conversa atual como Markdown/i }),
    ).toBeInTheDocument();
  });
});

describe('Composer — Enter envia', () => {
  beforeEach(() => {
    useConversationStore.setState({
      conversations: [conversationFixture()],
      activeId: 'c1',
      items: { c1: [] },
      drafts: { c1: { text: '', attachments: [] } },
    });
  });

  it('com a preferência ligada, Enter envia e Shift+Enter quebra linha', async () => {
    bridge = installFakeBridge();
    useAppStore.setState((state) => ({ settings: { ...state.settings, sendWithEnter: true } }));
    render(<Composer conversation={conversationFixture()} registerHandle={() => undefined} />);
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'linha 1');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(bridge.callsTo('turn:send')).toHaveLength(0);
    await userEvent.type(textarea, 'linha 2');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(bridge.callsTo('turn:send')).toHaveLength(1));
    expect(bridge.callsTo('turn:send')[0]).toMatchObject({ text: 'linha 1\nlinha 2' });
    expect(screen.getByRole('button', { name: /Enviar \(Enter\)/i })).toBeInTheDocument();
  });

  it('com a preferência desligada, Enter apenas quebra linha', async () => {
    bridge = installFakeBridge();
    useAppStore.setState((state) => ({ settings: { ...state.settings, sendWithEnter: false } }));
    render(<Composer conversation={conversationFixture()} registerHandle={() => undefined} />);
    await userEvent.type(screen.getByRole('textbox'), 'texto');
    await userEvent.keyboard('{Enter}');
    expect(bridge.callsTo('turn:send')).toHaveLength(0);
  });

  it('mostra o contador de caracteres e grava o rascunho ao desmontar', async () => {
    bridge = installFakeBridge();
    const view = render(<Composer conversation={conversationFixture()} registerHandle={() => undefined} />);
    await userEvent.type(screen.getByRole('textbox'), 'abc');
    expect(screen.getByText(/3 caracteres/)).toBeInTheDocument();
    view.unmount();
    await waitFor(() => expect(bridge.callsTo('conversations:saveDraft').length).toBeGreaterThan(0));
  });
});

describe('Excluir conversa', () => {
  it('pede confirmação no diálogo do sistema de design e só exclui ao confirmar', async () => {
    await openApp();
    // O clique com o botão direito cai na linha (div com o menu), não no <li>.
    const row = within(screen.getByRole('navigation', { name: /Navegação principal/i }))
      .getByText('Ajustar o build')
      .closest('button')?.parentElement as HTMLElement;
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('dialog', { name: /Ações da conversa/i });
    await userEvent.click(within(menu).getByRole('button', { name: /^Excluir$/i }));
    const confirm = await screen.findByRole('dialog', { name: /Excluir conversa/i });
    expect(within(confirm).getByText(/Ajustar o build/)).toBeInTheDocument();
    await userEvent.click(within(confirm).getByRole('button', { name: /Cancelar/i }));
    expect(bridge.callsTo('conversations:delete')).toHaveLength(0);

    fireEvent.contextMenu(row);
    const menuAgain = await screen.findByRole('dialog', { name: /Ações da conversa/i });
    await userEvent.click(within(menuAgain).getByRole('button', { name: /^Excluir$/i }));
    const confirmAgain = await screen.findByRole('dialog', { name: /Excluir conversa/i });
    await userEvent.click(within(confirmAgain).getByRole('button', { name: /^Excluir$/i }));
    await waitFor(() => expect(bridge.callsTo('conversations:delete')).toHaveLength(1));
  });
});

describe('Painel de contexto — totais', () => {
  it('soma tokens e custo informado dos itens da conversa', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      conversations: [conversationFixture()],
      activeId: 'c1',
      items: {
        c1: [
          itemFixture({
            id: 'a',
            usage: { totalTokens: 100, promptTokens: 80, completionTokens: 20, reportedCost: 0.01 },
          }),
          itemFixture({
            id: 'b',
            usage: { totalTokens: 50, promptTokens: 40, completionTokens: 10, reportedCost: 0.005 },
          }),
        ],
      },
    });
    useUiStore.setState((state) => ({
      layout: { ...state.layout, rightPanelTab: 'context', rightPanelCollapsed: false },
    }));
    render(<RightPanel conversation={conversationFixture()} />);
    expect(screen.getByText('Totais da conversa')).toBeInTheDocument();
    expect(screen.getByText('150')).toBeInTheDocument();
    expect(screen.getByText('USD 0.015000')).toBeInTheDocument();
  });
});
