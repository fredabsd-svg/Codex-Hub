// @vitest-environment jsdom
/**
 * Configurações › Codex — provedor de modelos do processo do Codex.
 *
 * O que estes testes protegem, do ponto de vista de quem usa:
 *  - o padrão continua sendo o provedor do próprio Codex;
 *  - escolher OpenRouter grava a preferência e não toca no motor da conversa;
 *  - a tela mostra o trecho do config.toml SEM a chave;
 *  - o estado é apresentado como solicitado/aceito, nunca como "validado";
 *  - sem credencial do OpenRouter, a tela diz o que fazer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/renderer/src/App';
import { useAppStore } from '../../src/renderer/src/stores/appStore';
import { useCatalogStore, DEFAULT_FILTERS } from '../../src/renderer/src/stores/catalogStore';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { resetOverlayStack } from '../../src/renderer/src/lib/overlayStack';
import { conversationFixture, installFakeBridge, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;

beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  bridge?.restore();
});

async function openCodexSettings(
  options: Parameters<typeof installFakeBridge>[0] = {},
): Promise<HTMLElement> {
  bridge = installFakeBridge({ conversations: [conversationFixture()], items: { c1: [] }, ...options });
  render(<App />);
  await waitFor(() => expect(screen.getByRole('navigation', { name: /Navegação principal/i })).toBeInTheDocument());
  await userEvent.keyboard('{Control>},{/Control}');
  const dialog = await screen.findByRole('dialog', { name: /^Configurações$/i });
  await userEvent.click(within(dialog).getByRole('button', { name: /^Codex$/i }));
  return dialog;
}

describe('Provedor de modelos do Codex', () => {
  it('vem no provedor do próprio Codex e não mostra opções do OpenRouter', async () => {
    const dialog = await openCodexSettings();
    const select = within(dialog).getByLabelText(/Provedor usado pelo Codex/i) as HTMLSelectElement;
    expect(select.value).toBe('default');
    expect(within(dialog).queryByText(/Equivalente no config\.toml/i)).not.toBeInTheDocument();
  });

  it('escolher OpenRouter grava a preferência e mantém o motor da conversa', async () => {
    const dialog = await openCodexSettings();
    await userEvent.selectOptions(within(dialog).getByLabelText(/Provedor usado pelo Codex/i), 'openrouter');

    await waitFor(() => expect(bridge.callsTo('settings:update')).toHaveLength(1));
    expect(bridge.callsTo('settings:update')[0]).toMatchObject({ codexModelProvider: 'openrouter' });
    // Nada de trocar o motor padrão do aplicativo por baixo dos panos.
    expect(bridge.callsTo('settings:update')[0]).not.toHaveProperty('defaultEngineId');
  });

  it('mostra o config.toml equivalente sem a chave e com o nome da variável', async () => {
    const dialog = await openCodexSettings({ settings: { codexModelProvider: 'openrouter' } });
    const snippet = await within(dialog).findByText(/\[model_providers\.openrouter\]/);
    const text = snippet.textContent ?? '';
    expect(text).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(text).toContain('base_url = "https://openrouter.ai/api/v1"');
    // A chave conectada no fake é sk-or-v1-…4f2a; nada disso pode aparecer.
    expect(text).not.toContain('sk-or');
  });

  it('avisa que a chave vai por variável de ambiente, não pelo login da OpenAI', async () => {
    const dialog = await openCodexSettings({ settings: { codexModelProvider: 'openrouter' } });
    expect(
      await within(dialog).findByText(/variável de ambiente, nunca por argumento de linha de comando/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/nunca pelo fluxo de chave da OpenAI/i)).toBeInTheDocument();
  });

  it('diz o que fazer quando não há credencial do OpenRouter conectada', async () => {
    const dialog = await openCodexSettings({
      settings: { codexModelProvider: 'openrouter' },
      connections: [{ providerId: 'openrouter', state: 'disconnected', message: 'Nenhuma credencial.' }],
    });
    expect(
      await within(dialog).findByText(/Conecte o OpenRouter em Configurações › Provedores/i),
    ).toBeInTheDocument();
  });

  it('apresenta o estado vindo do runtime sem chamar de validado', async () => {
    const dialog = await openCodexSettings({ settings: { codexModelProvider: 'openrouter' } });

    bridge.emitApp({
      type: 'codex/runtime',
      at: new Date().toISOString(),
      runtime: {
        found: true,
        initialized: true,
        generatedTypesAreProvisional: true,
        restartCount: 0,
        modelProvider: {
          mode: 'openrouter',
          wireApi: 'chat',
          state: 'accepted',
          note: 'O processo do Codex iniciou com esta configuração. Isso não é uma validação do provedor: confirme com um turno real.',
        },
      },
    });

    expect(await within(dialog).findByText(/aceito pelo processo — não validado/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/não é uma validação do provedor/i)).toBeInTheDocument();
  });

  it('explica quando a versão instalada recusa a configuração por linha de comando', async () => {
    const dialog = await openCodexSettings({ settings: { codexModelProvider: 'openrouter' } });

    bridge.emitApp({
      type: 'codex/runtime',
      at: new Date().toISOString(),
      runtime: {
        found: true,
        initialized: true,
        generatedTypesAreProvisional: true,
        restartCount: 1,
        modelProvider: {
          mode: 'openrouter',
          wireApi: 'chat',
          state: 'overridesRejected',
          note: 'Esta versão do Codex recusou a configuração enviada pela linha de comando. O processo está usando o provedor padrão. Configure o provedor no config.toml do Codex.',
        },
      },
    });

    expect(await within(dialog).findByText(/recusado por esta versão do Codex/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/Configure o provedor no config\.toml/i)).toBeInTheDocument();
  });
});
