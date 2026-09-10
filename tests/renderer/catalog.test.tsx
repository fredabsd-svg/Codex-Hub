// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CatalogDialog } from '../../src/renderer/src/features/catalog/CatalogDialog';
import { useAppStore } from '../../src/renderer/src/stores/appStore';
import { DEFAULT_FILTERS, useCatalogStore } from '../../src/renderer/src/stores/catalogStore';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { resetOverlayStack } from '../../src/renderer/src/lib/overlayStack';
import {
  CATALOG_FIXTURE,
  CODEX_DESCRIPTOR,
  OPENROUTER_DESCRIPTOR,
  conversationFixture,
  installFakeBridge,
  type FakeBridge,
} from '../helpers/fakeBridge';

let bridge: FakeBridge;

beforeEach(() => {
  useCatalogStore.setState({ pages: {}, loading: {}, favorites: [], filters: DEFAULT_FILTERS, probing: null });
  useConversationStore.setState({
    conversations: [conversationFixture()],
    activeId: 'c1',
    items: {},
    runtime: {},
    drafts: {},
    approvals: [],
    loadingItems: false,
  });
  useAppStore.setState({ providers: [OPENROUTER_DESCRIPTOR, CODEX_DESCRIPTOR] });
  useUiStore.setState({ toasts: [] });
  resetOverlayStack();
});

afterEach(() => {
  cleanup();
  bridge?.restore();
});

/** O nome do modelo aparece na lista E no painel de detalhes; escopo na lista. */
async function listRow(name: string): Promise<HTMLElement> {
  const list = await screen.findByRole('listbox', { name: /Catálogo de modelos/i });
  return within(list).getByText(name);
}

async function listHas(name: string): Promise<boolean> {
  const list = await screen.findByRole('listbox', { name: /Catálogo de modelos/i });
  return within(list).queryAllByText(name).length > 0;
}

describe('CatalogDialog', () => {
  it('lista os modelos com ID exato, contexto e capacidades', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    expect(await listRow('Vendor Modelo')).toBeInTheDocument();
    expect(screen.getAllByText('vendor/modelo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('128k tokens').length).toBeGreaterThan(0);
    // A capacidade traz o estado E a procedência no rótulo acessível.
    expect(screen.getAllByTitle(/Chamada de ferramentas: Suportado/).length).toBeGreaterThan(0);
  });

  it('mostra "Não informado" quando falta preço — nunca "grátis"', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await userEvent.click(await listRow('Vendor Sem Preço'));
    const details = await screen.findByText(/Ausência de preço não significa gratuito/i);
    expect(details).toBeInTheDocument();
    expect(screen.queryByText(/grátis/i)).toBeNull();
  });

  it('busca por ID exato filtra a lista', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await listRow('Vendor Modelo');
    await userEvent.type(screen.getByLabelText(/Buscar por nome ou ID exato/i), 'sem-preco');
    await waitFor(async () => expect(await listHas('Vendor Modelo')).toBe(false));
    expect(await listHas('Vendor Sem Preço')).toBe(true);
  });

  it('filtro de ferramentas remove o que não declara suporte', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await listRow('Vendor Sem Preço');
    await userEvent.click(screen.getByRole('switch', { name: /Somente com ferramentas/i }));
    await waitFor(async () => expect(await listHas('Vendor Sem Preço')).toBe(false));
    expect(await listHas('Vendor Modelo')).toBe(true);
  });

  it('filtro de preço zero NÃO inclui modelos sem preço informado', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await listRow('Vendor Modelo');
    await userEvent.click(screen.getByRole('switch', { name: /preço informado como zero/i }));
    // Nenhum modelo da fixture tem preço declarado como zero: a lista fica vazia
    // e o modelo SEM preço informado não entra no filtro.
    await waitFor(() => expect(screen.getByText(/Nenhum modelo corresponde aos filtros/i)).toBeInTheDocument());
    expect(screen.queryByRole('listbox', { name: /Catálogo de modelos/i })).toBeNull();
  });

  it('favoritar chama o processo principal', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await listRow('Vendor Modelo');
    await userEvent.click(screen.getAllByRole('button', { name: /^Favoritar$/i })[0] as HTMLElement);
    await waitFor(() => expect(bridge.callsTo('catalog:setFavorite')).toHaveLength(1));
  });

  it('adicionar ID manual marca como não verificado', async () => {
    bridge = installFakeBridge({
      overrides: {
        'catalog:addManualModel': () => ({
          ...CATALOG_FIXTURE,
          models: [
            ...CATALOG_FIXTURE.models,
            {
              id: 'meu-local',
              providerId: 'openrouter',
              displayName: 'meu-local',
              inputModalities: [],
              outputModalities: [],
              supportedParameters: [],
              pricing: { currency: 'USD', unknown: true },
              capabilities: { chat: { state: 'unknown', source: 'inferred' } },
              unverified: true,
            },
          ],
        }),
      },
    });
    render(<CatalogDialog open onClose={() => undefined} />);
    await listRow('Vendor Modelo');
    await userEvent.type(screen.getByLabelText(/Adicionar ID manualmente/i), 'meu-local');
    await userEvent.click(screen.getByRole('button', { name: /^Adicionar$/i }));
    await waitFor(async () => expect(await listHas('meu-local')).toBe(true));
    expect(screen.getByText('Não verificado')).toBeInTheDocument();
    // O nome de exibição cai para o ID quando não há nome informado.
    const list = screen.getByRole('listbox', { name: /Catálogo de modelos/i });
    expect(within(list).getAllByText('meu-local').length).toBeGreaterThanOrEqual(1);
  });

  it('usar o modelo selecionado altera os parâmetros da conversa', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await userEvent.click(await listRow('Vendor Modelo'));
    await userEvent.click(screen.getByRole('button', { name: /Usar este modelo/i }));
    await waitFor(() => expect(bridge.callsTo('conversations:setParameters')).toHaveLength(1));
    expect(bridge.callsTo('conversations:setParameters')[0]).toMatchObject({
      parameters: { modelId: 'vendor/modelo', providerId: 'openrouter', engineId: 'direct' },
    });
  });

  it('mostra o aviso do catálogo quando a atualização falha', async () => {
    bridge = installFakeBridge({
      overrides: {
        'catalog:list': () => ({
          providerId: 'openrouter',
          models: [],
          fetchedAt: new Date().toISOString(),
          fromCache: false,
          warning: 'A credencial foi recusada pelo provedor. Informe a chave novamente.',
        }),
      },
    });
    render(<CatalogDialog open onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/credencial foi recusada/i)).toBeInTheDocument());
  });

  it('a sonda de ferramentas aparece só para o OpenRouter e explica o que faz', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await userEvent.click(await listRow('Vendor Modelo'));
    const button = screen.getByRole('button', { name: /Verificar suporte a ferramentas/i });
    expect(button).toBeInTheDocument();
    expect(screen.getByText(/registra o resultado como verificado em uso/i)).toBeInTheDocument();
    await userEvent.click(button);
    await waitFor(() => expect(bridge.callsTo('catalog:probeCapability')).toHaveLength(1));
  });

  it('mostra o painel de detalhes com parâmetros suportados', async () => {
    bridge = installFakeBridge();
    render(<CatalogDialog open onClose={() => undefined} />);
    await userEvent.click(await listRow('Vendor Modelo'));
    const aside = screen.getByText('Parâmetros suportados').closest('aside') as HTMLElement;
    expect(within(aside).getByText('tools')).toBeInTheDocument();
    expect(within(aside).getByText('temperature')).toBeInTheDocument();
  });
});
