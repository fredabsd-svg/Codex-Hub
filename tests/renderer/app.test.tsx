// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/src/App';
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
    filters: DEFAULT_FILTERS,
    probing: null,
  });
  useUiStore.setState({ dialog: null, toasts: [], autoScroll: true });
  useAppStore.setState({ ready: false, bootError: null, skills: [], usage: {}, notices: [] });
  resetOverlayStack();
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  cleanup();
  bridge?.restore();
});

describe('App — inicialização', () => {
  it('mostra o carregamento e depois a interface principal', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()] });
    render(<App />);
    expect(screen.getByText(/Carregando o aplicativo/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('navigation', { name: /Navegação principal/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Nova conversa/i })).toBeInTheDocument();
  });

  it('exibe erro de inicialização com ação e botão de tentar novamente', async () => {
    bridge = installFakeBridge({
      failures: {
        'app:getBootstrap': {
          code: 'persistence',
          message: 'Não foi possível abrir os dados locais.',
          action: 'Verifique o espaço em disco.',
          retryable: true,
        },
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/Não foi possível abrir os dados locais/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/Verifique o espaço em disco/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tentar novamente/i })).toBeInTheDocument();
  });

  it('avisa quando a ponte segura não está disponível', () => {
    render(<App />);
    expect(screen.getByText(/ponte segura/i)).toBeInTheDocument();
  });

  it('mostra o onboarding quando ainda não foi concluído', async () => {
    bridge = installFakeBridge({
      onboardingCompleted: false,
      connections: [{ providerId: 'openrouter', state: 'disconnected', message: 'Nenhuma credencial.' }],
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: /Escolha por onde começar/i })).toBeInTheDocument(),
    );
    // OpenRouter é a primeira opção e não exige conta ChatGPT.
    const dialog = screen.getByRole('dialog', { name: /Escolha por onde começar/i });
    expect(within(dialog).getByText('OpenRouter')).toBeInTheDocument();
    expect(within(dialog).getByText(/sem nenhuma conta ChatGPT/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/recomendado para começar/i)).toBeInTheDocument();
  });

  it('mostra avisos de inicialização com a ação sugerida', async () => {
    bridge = installFakeBridge({
      notices: [
        {
          level: 'warn',
          message: 'O armazenamento protegido do sistema não está disponível.',
          action: 'A chave ficará apenas nesta sessão.',
        },
      ],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText(/armazenamento protegido/i)).toBeInTheDocument());
    expect(screen.getByText(/apenas nesta sessão/i)).toBeInTheDocument();
  });
});

describe('App — conversas e streaming', () => {
  it('lista conversas e abre a selecionada', async () => {
    bridge = installFakeBridge({
      conversations: [conversationFixture(), conversationFixture({ id: 'c2', title: 'Outra conversa' })],
      items: { c1: [itemFixture({ text: 'Conteúdo da primeira.' })] },
    });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );
    await waitFor(() => expect(screen.getByText('Conteúdo da primeira.')).toBeInTheDocument());
  });

  it('aplica deltas de streaming vindos de eventos reais', async () => {
    const conversation = conversationFixture();
    bridge = installFakeBridge({ conversations: [conversation], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );

    const base = {
      seq: 1,
      at: new Date().toISOString(),
      engineId: 'direct' as const,
      providerId: 'openrouter',
      conversationId: 'c1',
      turnId: 't1',
    };
    bridge.emitDomain({
      ...base,
      type: 'item/started',
      itemId: 'i9',
      item: itemFixture({ id: 'i9', text: '', status: 'streaming' }),
    });
    bridge.emitDomain({ ...base, seq: 2, type: 'item/textDelta', itemId: 'i9', delta: 'Olá' });
    bridge.emitDomain({ ...base, seq: 3, type: 'item/textDelta', itemId: 'i9', delta: ' mundo' });

    await waitFor(() => expect(screen.getByText(/Olá mundo/)).toBeInTheDocument());
  });

  it('mostra o estado do turno e o botão de interromper', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );

    bridge.emitDomain({
      seq: 1,
      at: new Date().toISOString(),
      engineId: 'direct',
      providerId: 'openrouter',
      conversationId: 'c1',
      type: 'conversation/status',
      status: 'running',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Interromper/i })).toBeInTheDocument());
  });

  it('Ctrl+Enter no composer envia UMA vez, não duas', async () => {
    // Regressão: o composer e o atalho global escutavam o mesmo evento, o que
    // disparava dois envios — o segundo era recusado com "já existe um turno".
    bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );

    const textarea = screen.getByRole('textbox', { name: /Descreva a tarefa/i });
    await userEvent.type(textarea, 'uma mensagem só');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(bridge.callsTo('turn:send')).toHaveLength(1));
    // Uma espera extra garante que nenhum segundo envio chega atrasado.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.callsTo('turn:send')).toHaveLength(1);
  });

  it('mostra o erro do turno com mensagem e ação', async () => {
    bridge = installFakeBridge({
      conversations: [conversationFixture()],
      items: {
        c1: [
          itemFixture({
            id: 'err',
            role: 'system',
            kind: 'error',
            status: 'failed',
            text: 'falhou',
            errorDetail: {
              code: 'insufficientCredit',
              message: 'O provedor recusou por crédito insuficiente.',
              action: 'Adicione crédito e tente novamente.',
              retryable: true,
            },
          }),
        ],
      },
    });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );
    await waitFor(() => expect(screen.getByText(/crédito insuficiente/)).toBeInTheDocument());
    expect(screen.getByText(/Adicione crédito/)).toBeInTheDocument();
  });
});

describe('App — atalhos e navegação por teclado', () => {
  it('Ctrl+K abre a paleta de comandos e Esc fecha', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()] });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Nova conversa/i })).toBeInTheDocument());

    await userEvent.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: /Comandos e busca/i });
    expect(palette).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Comandos e busca/i })).not.toBeInTheDocument(),
    );
  });

  it('Ctrl+, abre as configurações', async () => {
    bridge = installFakeBridge();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Nova conversa/i })).toBeInTheDocument());
    await userEvent.keyboard('{Control>},{/Control}');
    expect(await screen.findByRole('dialog', { name: /^Configurações$/i })).toBeInTheDocument();
  });

  it('Esc sem sobreposição aberta interrompe o turno ativo', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(bridge.callsTo('turn:interrupt').length).toBeGreaterThan(0));
  });

  it('Esc com diálogo aberto NÃO interrompe o turno', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );

    await userEvent.keyboard('{Control>}k{/Control}');
    await screen.findByRole('dialog', { name: /Comandos e busca/i });
    await userEvent.keyboard('{Escape}');
    expect(bridge.callsTo('turn:interrupt')).toHaveLength(0);
  });

  it('o diálogo devolve o foco ao fechar', async () => {
    bridge = installFakeBridge();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Nova conversa/i })).toBeInTheDocument());
    const trigger = screen.getByRole('button', { name: /^Configurações$/i });
    trigger.focus();
    await userEvent.click(trigger);
    await screen.findByRole('dialog', { name: /^Configurações$/i });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('App — barra de status', () => {
  it('mostra o motor ativo e a política efetiva', async () => {
    bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] } });
    render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
      ).toBeInTheDocument(),
    );
    await userEvent.click(
      within(screen.getByRole('navigation', { name: /Navegação principal/i })).getByText('Ajustar o build'),
    );
    await waitFor(() => expect(screen.getByText('Motor direto')).toBeInTheDocument());
    expect(screen.getByText(/Política efetiva: somente leitura/)).toBeInTheDocument();
  });
});
