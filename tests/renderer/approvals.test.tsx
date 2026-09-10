// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalRequest } from '../../src/shared/domain';
import { ApprovalQueue } from '../../src/renderer/src/features/approvals/ApprovalQueue';
import { useConversationStore } from '../../src/renderer/src/stores/conversationStore';
import { useUiStore } from '../../src/renderer/src/stores/uiStore';
import { conversationFixture, installFakeBridge, type FakeBridge } from '../helpers/fakeBridge';

let bridge: FakeBridge;

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'ap1',
    conversationId: 'c1',
    engineId: 'codex',
    kind: 'commandExecution',
    createdAt: new Date().toISOString(),
    title: 'Executar: npm test',
    reason: 'Rodar a suíte de testes do projeto.',
    command: { argv: ['npm', 'test'], cwd: '/projetos/app', display: 'npm test' },
    allowedDecisions: ['allowOnce', 'allowForSession', 'deny', 'cancel'],
    risk: {
      level: 'low',
      method: 'heuristic',
      signals: ['Nenhum padrão de risco conhecido foi identificado nesta solicitação.'],
    },
    sessionScopeDescription: 'Aprova automaticamente apenas o comando exatamente igual a "npm test".',
    ...overrides,
  };
}

beforeEach(() => {
  useConversationStore.setState({
    conversations: [conversationFixture()],
    activeId: 'c1',
    items: {},
    runtime: {},
    drafts: {},
    approvals: [],
    loadingItems: false,
  });
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  cleanup();
  bridge?.restore();
});

describe('ApprovalQueue', () => {
  it('não renderiza nada quando não há aprovação pendente', () => {
    bridge = installFakeBridge();
    const { container } = render(<ApprovalQueue conversationId="c1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('mostra comando, diretório e motivo', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText(/\/projetos\/app/)).toBeInTheDocument();
    expect(screen.getByText(/Rodar a suíte de testes/)).toBeInTheDocument();
    expect(screen.getByText(/Solicitado pelo Codex App Server/)).toBeInTheDocument();
  });

  it('mostra somente as decisões aceitas pela solicitação', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval({ allowedDecisions: ['allowOnce', 'deny'] })] });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByRole('button', { name: /Permitir uma vez/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Recusar$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Permitir na sessão/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar solicitação/i })).toBeNull();
  });

  it('identifica o risco como heurística e explica a base', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      approvals: [
        approval({
          risk: { level: 'high', method: 'heuristic', signals: ['Remoção recursiva ou forçada de arquivos (rm -rf).'] },
          command: { argv: ['rm', '-rf', 'build'], display: 'rm -rf build' },
          allowedDecisions: ['allowOnce', 'deny', 'cancel'],
        }),
      ],
    });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText(/risco Alto/)).toBeInTheDocument();
    await userEvent.click(screen.getByText(/Risco estimado \(heurística\)/i));
    expect(screen.getByText(/estimativa local por regras, não uma garantia/i)).toBeInTheDocument();
    expect(screen.getByText(/Remoção recursiva/)).toBeInTheDocument();
    // Comando destrutivo não recebe escopo de sessão.
    expect(screen.queryByRole('button', { name: /Permitir na sessão/i })).toBeNull();
    expect(screen.getByText(/padrão destrutivo conhecido/i)).toBeInTheDocument();
  });

  it('explica o que "permitir na sessão" concede', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText(/O que "permitir na sessão" concede/)).toBeInTheDocument();
    expect(screen.getByText(/exatamente igual a "npm test"/)).toBeInTheDocument();
  });

  it('registra a decisão escolhida no processo principal', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    await userEvent.click(screen.getByRole('button', { name: /Permitir uma vez/i }));
    await waitFor(() => expect(bridge.callsTo('approvals:resolve')).toHaveLength(1));
    expect(bridge.callsTo('approvals:resolve')[0]).toMatchObject({ approvalId: 'ap1', decision: 'allowOnce' });
  });

  it('recusar envia deny', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    await userEvent.click(screen.getByRole('button', { name: /^Recusar$/i }));
    await waitFor(() => expect(bridge.callsTo('approvals:resolve')[0]).toMatchObject({ decision: 'deny' }));
  });

  it('cancelar a solicitação NÃO interrompe o turno', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    await userEvent.click(screen.getByRole('button', { name: /Cancelar solicitação/i }));
    await waitFor(() => expect(bridge.callsTo('approvals:resolve')[0]).toMatchObject({ decision: 'cancel' }));
    // Cancelar afeta apenas a solicitação.
    expect(bridge.callsTo('turn:interrupt')).toHaveLength(0);
  });

  it('interromper o turno é uma ação separada', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({ approvals: [approval()] });
    render(<ApprovalQueue conversationId="c1" />);
    await userEvent.click(screen.getByRole('button', { name: /Interromper o turno/i }));
    await waitFor(() => expect(bridge.callsTo('turn:interrupt')).toHaveLength(1));
    expect(bridge.callsTo('approvals:resolve')).toHaveLength(0);
  });

  it('mostra arquivos afetados em aprovação de alteração', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      approvals: [
        approval({
          kind: 'filePatch',
          title: 'Aplicar alterações em 2 arquivo(s)',
          command: undefined,
          files: ['src/a.ts', 'src/b.ts'],
          allowedDecisions: ['allowOnce', 'deny', 'cancel'],
          sessionScopeDescription: undefined,
        }),
      ],
    });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText(/Aplicar alteração de arquivo/)).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
    expect(screen.getByText('src/b.ts')).toBeInTheDocument();
  });

  it('mostra o diff proposto e permite ocultar', async () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      approvals: [
        approval({
          kind: 'filePatch',
          command: undefined,
          files: ['src/a.ts'],
          diffs: [
            {
              path: 'src/a.ts',
              changeKind: 'modify',
              binary: false,
              additions: 1,
              deletions: 1,
              unifiedDiff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-antigo\n+novo\n',
            },
          ],
        }),
      ],
    });
    render(<ApprovalQueue conversationId="c1" />);
    // As linhas do diff trazem o marcador junto do texto no mesmo nó.
    expect(screen.getByText(/^−antigo$/)).toBeInTheDocument();
    expect(screen.getByText(/^\+novo$/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ocultar diff proposto/i }));
    expect(screen.queryByText(/^−antigo$/)).toBeNull();
  });

  it('mostra destinos de rede quando informados', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      approvals: [
        approval({
          kind: 'networkAccess',
          command: undefined,
          networkTargets: ['https://registry.npmjs.org'],
        }),
      ],
    });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText('https://registry.npmjs.org')).toBeInTheDocument();
  });

  it('só mostra aprovações da conversa atual', () => {
    bridge = installFakeBridge();
    useConversationStore.setState({
      approvals: [approval(), approval({ id: 'ap2', conversationId: 'outra', title: 'Executar: rm x' })],
    });
    render(<ApprovalQueue conversationId="c1" />);
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.queryByText('rm x')).toBeNull();
  });
});
