// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '../../src/renderer/src/features/chat/Composer';
import { useAppStore } from '../../src/renderer/src/stores/appStore';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { conversationFixture, installFakeBridge, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;

beforeEach(() => {
  useConversationStore.setState({
    conversations: [conversationFixture()],
    activeId: 'c1',
    items: { c1: [] },
    runtime: {},
    drafts: { c1: { text: '', attachments: [] } },
    approvals: [],
    loadingItems: false,
  });
  useAppStore.setState({ skills: [] });
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  bridge?.restore();
  vi.useRealTimers();
});

function renderComposer(conversation = conversationFixture()) {
  return render(<Composer conversation={conversation} registerHandle={() => undefined} />);
}

describe('Composer', () => {
  it('envia com Ctrl+Enter', async () => {
    bridge = installFakeBridge();
    renderComposer();
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'olá modelo');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bridge.callsTo('turn:send')).toHaveLength(1));
    expect(bridge.callsTo('turn:send')[0]).toMatchObject({ conversationId: 'c1', text: 'olá modelo' });
  });

  it('NÃO envia durante composição por IME', async () => {
    bridge = installFakeBridge();
    renderComposer();
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'にほんご');
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(bridge.callsTo('turn:send')).toHaveLength(0);

    // Terminada a composição, o envio funciona.
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(bridge.callsTo('turn:send')).toHaveLength(1));
  });

  it('ignora o evento com isComposing verdadeiro', async () => {
    bridge = installFakeBridge();
    renderComposer();
    const textarea = screen.getByRole('textbox');
    await userEvent.type(textarea, 'texto');
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(bridge.callsTo('turn:send')).toHaveLength(0);
  });

  it('não envia mensagem vazia', async () => {
    bridge = installFakeBridge();
    renderComposer();
    const send = screen.getByRole('button', { name: /Enviar/i });
    expect(send).toBeDisabled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(bridge.callsTo('turn:send')).toHaveLength(0);
  });

  it('grava o rascunho com atraso curto', async () => {
    bridge = installFakeBridge();
    renderComposer();
    await userEvent.type(screen.getByRole('textbox'), 'rascunho pendente');
    await waitFor(() => expect(bridge.callsTo('conversations:saveDraft').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
    const last = bridge.callsTo('conversations:saveDraft').at(-1) as { text: string };
    expect(last.text).toBe('rascunho pendente');
  });

  it('mostra a escolha entre novo turno e orientação quando há turno em andamento', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      runtime: { c1: { status: 'running', diffs: [], lastSeq: 0, gapDetected: false } },
    });
    renderComposer(conversationFixture({ engineId: 'codex', providerId: 'codex' }));
    expect(screen.getByRole('radiogroup', { name: /Destino da mensagem/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Nova mensagem/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Orientar turno atual/i })).toBeEnabled();
  });

  it('no motor direto a orientação aparece desabilitada com o motivo', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      runtime: { c1: { status: 'running', diffs: [], lastSeq: 0, gapDetected: false } },
    });
    renderComposer(conversationFixture({ engineId: 'direct' }));
    const steer = screen.getByRole('radio', { name: /Orientar turno atual/i });
    expect(steer).toBeDisabled();
    expect(screen.getByText(/não aceita orientação no meio do turno/i)).toBeInTheDocument();
  });

  it('envia como orientação quando escolhido e suportado', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      runtime: { c1: { status: 'running', diffs: [], lastSeq: 0, gapDetected: false } },
    });
    renderComposer(conversationFixture({ engineId: 'codex', providerId: 'codex' }));
    await userEvent.click(screen.getByRole('radio', { name: /Orientar turno atual/i }));
    await userEvent.type(screen.getByRole('textbox'), 'foque nos testes');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(bridge.callsTo('turn:send')).toHaveLength(1));
    expect(bridge.callsTo('turn:send')[0]).toMatchObject({ asSteer: true });
  });

  it('mostra o botão de interromper durante o turno', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      runtime: { c1: { status: 'running', diffs: [], lastSeq: 0, gapDetected: false } },
    });
    renderComposer();
    expect(screen.getByRole('button', { name: /Interromper/i })).toBeInTheDocument();
  });

  it('anexa arquivos pelo diálogo nativo', async () => {
    bridge = installFakeBridge({
      overrides: {
        'attachments:choose': () => [
          { id: 'a1', kind: 'code', fileName: 'app.ts', absolutePath: '/ws/.codex-hub/anexos/app.ts', sizeBytes: 120 },
        ],
      },
    });
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: /Anexar arquivos/i }));
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    expect(screen.getByText(/Anexos desta mensagem/i)).toBeInTheDocument();
  });

  it('mostra o motivo quando um anexo falha na preparação', async () => {
    bridge = installFakeBridge({
      overrides: {
        'attachments:choose': () => [
          {
            id: 'a2',
            kind: 'document',
            fileName: 'digitalizado.pdf',
            error: 'Este PDF não expõe texto extraível. É necessário OCR.',
            delivery: { type: 'failed', reason: 'Este PDF não expõe texto extraível. É necessário OCR.' },
          },
        ],
      },
    });
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: /Anexar arquivos/i }));
    await waitFor(() => expect(screen.getByText('digitalizado.pdf')).toBeInTheDocument());
    expect(screen.getByText('falhou')).toBeInTheDocument();
    // O motivo concreto vai para a região de avisos.
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((toast) => toast.body?.includes('necessário OCR'))).toBe(true),
    );
  });

  it('remove anexo antes do envio', async () => {
    bridge = installFakeBridge({
      overrides: {
        'attachments:choose': () => [{ id: 'a1', kind: 'code', fileName: 'app.ts', absolutePath: '/ws/app.ts' }],
      },
    });
    renderComposer();
    await userEvent.click(screen.getByRole('button', { name: /Anexar arquivos/i }));
    await waitFor(() => expect(screen.getByText('app.ts')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Remover anexo/i }));
    await waitFor(() => expect(screen.queryByText('app.ts')).not.toBeInTheDocument());
    expect(bridge.callsTo('attachments:discard')).toHaveLength(1);
  });

  it('avisa quando o arrastar/soltar não resolve caminho', async () => {
    bridge = installFakeBridge();
    const original = (window as unknown as { codexHub: { getPathForFile: unknown } }).codexHub.getPathForFile;
    (window as unknown as { codexHub: { getPathForFile: () => string } }).codexHub.getPathForFile = () => '';
    renderComposer();
    const dropZone = screen.getByRole('textbox').closest('div')?.parentElement as HTMLElement;
    fireEvent.drop(dropZone, {
      dataTransfer: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })], items: [] },
    });
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((toast) => toast.title.includes('Nada foi anexado'))).toBe(true),
    );
    (window as unknown as { codexHub: { getPathForFile: unknown } }).codexHub.getPathForFile = original;
  });

  it('mostra a dica do modo atual', () => {
    bridge = installFakeBridge();
    renderComposer(conversationFixture({ mode: 'plan' }));
    expect(screen.getByText(/ferramentas de leitura autorizadas/i)).toBeInTheDocument();
  });

  it('desabilita tudo sem conversa selecionada', () => {
    bridge = installFakeBridge();
    render(<Composer conversation={null} registerHandle={() => undefined} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Enviar/i })).toBeDisabled();
  });
});
