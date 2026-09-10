import { describe, expect, it } from 'vitest';
import type { ConversationItem, ConversationSummary } from '../../src/shared/domain';
import {
  exportFileName,
  renderConversationJson,
  renderConversationMarkdown,
  summarizeUsage,
} from '../../src/shared/conversationExport';
import { deriveTitle } from '../../src/main/services/ConversationService';

const at = '2026-09-10T12:00:00.000Z';

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c1',
    title: 'Ajustar o build: revisão',
    titleIsLocal: true,
    engineId: 'direct',
    providerId: 'openrouter',
    modelId: 'vendor/modelo',
    mode: 'chat',
    archived: false,
    favorite: false,
    createdAt: at,
    updatedAt: at,
    status: 'idle',
    messageCount: 2,
    parameters: { modelId: 'vendor/modelo', providerId: 'openrouter', engineId: 'direct' },
    ...overrides,
  };
}

function item(overrides: Partial<ConversationItem>): ConversationItem {
  return {
    id: 'i',
    conversationId: 'c1',
    role: 'assistant',
    kind: 'agentMessage',
    status: 'completed',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

describe('renderConversationMarkdown', () => {
  it('inclui cabeçalho, mensagens, uso e rodapé', () => {
    const out = renderConversationMarkdown({
      conversation: conversation(),
      items: [
        item({ id: 'u', role: 'user', kind: 'userMessage', text: 'Olá' }),
        item({
          id: 'a',
          text: 'Resposta **forte**',
          modelId: 'vendor/modelo',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, reportedCost: 0.001, currency: 'USD' },
        }),
      ],
      app: { name: 'Codex Hub', version: '0.1.0' },
      generatedAt: at,
    });
    expect(out.startsWith('# Ajustar o build: revisão\n')).toBe(true);
    expect(out).toContain('- Modelo: `vendor/modelo`');
    expect(out).toContain('### Você');
    expect(out).toContain('Olá');
    expect(out).toContain('### Assistente');
    expect(out).toContain('Resposta **forte**');
    expect(out).toContain('_Uso: entrada 10 · saída 5 · total 15 · custo informado USD 0.001000 tokens_');
    expect(out).toContain('Custo informado pelo provedor: USD 0.001000.');
    expect(out).toContain('Codex Hub 0.1.0');
  });

  it('rotula estimativas como estimativas e nunca inventa custo', () => {
    const out = renderConversationMarkdown({
      conversation: conversation(),
      items: [item({ id: 'a', text: 'x', usage: { totalTokens: 3, estimatedCost: 0.5 } })],
    });
    expect(out).toContain('custo ESTIMADO USD 0.500000');
    expect(out).toContain('Custo ESTIMADO localmente (não confirmado)');
    expect(out).not.toContain('Custo informado pelo provedor');
  });

  it('fecha blocos de código com cerca maior do que a interna', () => {
    const out = renderConversationMarkdown({
      conversation: conversation(),
      items: [
        item({
          id: 'c',
          role: 'tool',
          kind: 'commandExecution',
          command: { command: 'cat x.md', output: 'texto\n```js\n1\n```\n', outputTruncated: false, totalOutputBytes: 20 },
        }),
      ],
    });
    expect(out).toContain('````text\ntexto\n```js\n1\n```\n\n````');
  });

  it('representa planos, alterações de arquivo e erros', () => {
    const out = renderConversationMarkdown({
      conversation: conversation(),
      items: [
        item({
          id: 'p',
          kind: 'plan',
          plan: [
            { id: '1', text: 'Ler', status: 'completed' },
            { id: '2', text: 'Escrever', status: 'pending' },
          ],
        }),
        item({
          id: 'f',
          kind: 'fileChange',
          fileChange: {
            files: [{ path: 'a.ts', changeKind: 'modify', binary: false, additions: 1, deletions: 0, unifiedDiff: '+x' }],
          },
        }),
        item({
          id: 'e',
          role: 'system',
          kind: 'error',
          status: 'failed',
          errorDetail: { code: 'network', message: 'Sem rede.', action: 'Verifique a conexão.', retryable: true },
        }),
      ],
    });
    expect(out).toContain('- [x] Ler');
    expect(out).toContain('- [ ] Escrever');
    expect(out).toContain('- modify `a.ts` (+1 −0)');
    expect(out).toContain('```diff\n+x\n```');
    expect(out).toContain('Sem rede.');
    expect(out).toContain('Verifique a conexão.');
  });
});

describe('renderConversationJson', () => {
  it('produz JSON válido com formato declarado', () => {
    const parsed = JSON.parse(
      renderConversationJson({ conversation: conversation(), items: [item({ id: 'a', text: 'x' })], generatedAt: at }),
    ) as { format: string; version: number; items: unknown[] };
    expect(parsed.format).toBe('codex-hub/conversation');
    expect(parsed.version).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });
});

describe('summarizeUsage', () => {
  it('soma tokens, separa custo informado de estimado e marca totais parciais', () => {
    const totals = summarizeUsage([
      item({ id: 'u', role: 'user', kind: 'userMessage', text: 'a' }),
      item({ id: '1', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, reportedCost: 0.1 } }),
      item({ id: '2', usage: { promptTokens: 5, totalTokens: 5, estimatedCost: 0.02 } }),
      item({ id: '3', usage: { totalTokens: 1 } }),
      item({ id: 'n', role: 'system', kind: 'notice', text: 'aviso' }),
    ]);
    expect(totals.messages).toBe(4);
    expect(totals.turnsWithUsage).toBe(3);
    expect(totals.promptTokens).toBe(15);
    expect(totals.completionTokens).toBe(2);
    expect(totals.totalTokens).toBe(18);
    expect(totals.reportedCost).toBeCloseTo(0.1);
    expect(totals.estimatedCost).toBeCloseTo(0.02);
    expect(totals.costIncomplete).toBe(true);
  });

  it('sem uso informado, não inventa zero', () => {
    const totals = summarizeUsage([item({ id: 'a', text: 'x' })]);
    expect(totals.totalTokens).toBeUndefined();
    expect(totals.reportedCost).toBeUndefined();
    expect(totals.costIncomplete).toBe(false);
  });
});

describe('exportFileName', () => {
  it('gera nome seguro com data e extensão', () => {
    expect(exportFileName(conversation({ title: 'Revisão do módulo: ISS/2026?' }), 'markdown')).toBe(
      'revisao-do-modulo-iss-2026-2026-09-10.md',
    );
    expect(exportFileName(conversation({ title: '???' }), 'json')).toBe('conversa-2026-09-10.json');
  });
});

describe('deriveTitle', () => {
  it('usa a primeira frase sem marcação Markdown', () => {
    expect(deriveTitle('## Analise o **projeto**. Depois liste melhorias.')).toBe('Analise o projeto');
    expect(deriveTitle('- corrija o `build` do app')).toBe('Corrija o build do app');
  });

  it('ignora blocos de código no início', () => {
    expect(deriveTitle('```ts\nconst x = 1;\n```\nexplique este trecho')).toBe('Explique este trecho');
  });

  it('corta em limite de palavra com reticências', () => {
    const title = deriveTitle('preciso de uma análise completa e detalhada de todos os módulos do sistema financeiro');
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it('cai no padrão quando não há texto útil', () => {
    expect(deriveTitle('```\nx\n```')).toBe('Nova conversa');
    expect(deriveTitle('   ')).toBe('Nova conversa');
  });
});
