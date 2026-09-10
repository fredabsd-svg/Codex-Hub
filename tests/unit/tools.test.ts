import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EffectivePolicy, OperationMode } from '../../src/shared/domain';
import { ApprovalBroker } from '../../src/main/tools/ApprovalBroker';
import { PathGuard } from '../../src/main/services/pathSafety';
import { GitService } from '../../src/main/services/GitService';
import { executeTool, findTool, rejectArbitraryShell, toolSchemasForMode, toolsForMode } from '../../src/main/tools/registry';
import type { ToolContext } from '../../src/main/tools/types';

const policy: EffectivePolicy = {
  mode: 'execute',
  approvals: 'onRequest',
  sandbox: 'workspaceWrite',
  toolNetwork: 'blocked',
  inferenceNetwork: 'allowed',
  confirmedByRuntime: true,
};

let workspace: string;
let broker: ApprovalBroker;
let autoDecision: 'allowOnce' | 'deny' | 'cancel' | null = 'allowOnce';

function makeContext(mode: OperationMode = 'execute', overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'c1',
    turnId: 't1',
    workspacePath: workspace,
    guard: new PathGuard(workspace),
    policy: { ...policy, mode, sandbox: mode === 'execute' ? 'workspaceWrite' : 'readOnly' },
    mode,
    approvals: broker,
    git: new GitService(),
    signal: new AbortController().signal,
    maxResultBytes: 64 * 1024,
    ...overrides,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'codex-hub-tools-'));
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'app.ts'), 'export const nome = "antigo";\nconsole.log(nome);\n');
  writeFileSync(join(workspace, 'README.md'), '# Projeto\n\nDescrição.\n');
  autoDecision = 'allowOnce';
  broker = new ApprovalBroker({
    onRequested: (request) => {
      if (autoDecision) setTimeout(() => broker.resolve(request.id, autoDecision as 'allowOnce'), 0);
    },
    onResolved: () => undefined,
  });
});

describe('registro de ferramentas', () => {
  it('expõe leitura em todos os modos e escrita só em Executar', () => {
    expect(toolsForMode('chat').map((tool) => tool.name)).toContain('read_file');
    expect(toolsForMode('plan').map((tool) => tool.name)).toContain('search_content');
    expect(toolsForMode('plan').map((tool) => tool.name)).not.toContain('apply_file_changes');
    expect(toolsForMode('execute').map((tool) => tool.name)).toContain('apply_file_changes');
  });

  it('não registra nenhuma ferramenta de shell arbitrário', () => {
    const names = toolsForMode('execute').map((tool) => tool.name);
    expect(names.some((name) => /shell|exec|bash|command|run/i.test(name))).toBe(false);
    expect(() => rejectArbitraryShell()).toThrowError(/indisponível no motor direto/);
  });

  it('gera schemas JSON para o provedor', () => {
    const schemas = toolSchemasForMode('execute');
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema.parameters).toMatchObject({ type: 'object' });
      expect(typeof schema.description).toBe('string');
    }
  });

  it('marca ferramentas mutáveis como não repetíveis automaticamente', () => {
    expect(findTool('apply_file_changes')?.retryableAfterFailure).toBe(false);
    expect(findTool('read_file')?.retryableAfterFailure).toBe(true);
  });
});

describe('executeTool — validação e modos', () => {
  it('recusa ferramenta desconhecida', async () => {
    const outcome = await executeTool('rodar_qualquer_coisa', '{}', makeContext());
    expect(outcome.error?.code).toBe('validation');
    expect(outcome.error?.message).toContain('não existe');
  });

  it('recusa ferramenta indisponível no modo atual — restrição do BACKEND', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: 'novo.txt', content: 'a' }] }),
      makeContext('plan'),
    );
    expect(outcome.error?.code).toBe('approvalDenied');
    expect(outcome.error?.message).toContain('modo Planejar');
    expect(existsSync(join(workspace, 'novo.txt'))).toBe(false);
  });

  it('recusa argumentos que não são JSON válido', async () => {
    const outcome = await executeTool('read_file', '{"path": ', makeContext());
    expect(outcome.error?.code).toBe('validation');
  });

  it('recusa argumentos que não passam no schema', async () => {
    const outcome = await executeTool('read_file', JSON.stringify({ caminho: 'x' }), makeContext());
    expect(outcome.error?.code).toBe('validation');
    expect(outcome.error?.message).toContain('Argumentos inválidos');
  });
});

describe('ferramentas de leitura', () => {
  it('list_files lista o workspace', async () => {
    const outcome = await executeTool('list_files', JSON.stringify({ path: '.', recursive: true }), makeContext());
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.content).toContain('README.md');
    expect(outcome.result?.content).toContain('src/app.ts');
  });

  it('read_file devolve o conteúdo com o caminho relativo no cabeçalho', async () => {
    const outcome = await executeTool('read_file', JSON.stringify({ path: 'src/app.ts' }), makeContext());
    expect(outcome.result?.content).toContain('# src/app.ts');
    expect(outcome.result?.content).toContain('antigo');
  });

  it('read_file recusa caminho fora do workspace', async () => {
    const outcome = await executeTool('read_file', JSON.stringify({ path: '../../etc/passwd' }), makeContext());
    expect(outcome.error?.code).toBe('workspaceDenied');
  });

  it('read_file identifica binário em vez de fingir leitura', async () => {
    writeFileSync(join(workspace, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
    const outcome = await executeTool('read_file', JSON.stringify({ path: 'bin.dat' }), makeContext());
    expect(outcome.result?.content).toContain('binário');
  });

  it('search_content encontra ocorrências com caminho e linha', async () => {
    const outcome = await executeTool('search_content', JSON.stringify({ query: 'antigo' }), makeContext());
    expect(outcome.result?.content).toMatch(/src\/app\.ts:1/);
  });

  it('search_content reporta regex inválida', async () => {
    const outcome = await executeTool(
      'search_content',
      JSON.stringify({ query: '([a-z', isRegex: true }),
      makeContext(),
    );
    expect(outcome.error?.code).toBe('validation');
  });

  it('truncа resultados grandes informando o limite', async () => {
    writeFileSync(join(workspace, 'grande.txt'), 'linha\n'.repeat(20_000));
    const outcome = await executeTool(
      'read_file',
      JSON.stringify({ path: 'grande.txt' }),
      makeContext('execute', { maxResultBytes: 1024 }),
    );
    expect(outcome.result?.truncated).toBe(true);
    expect(outcome.result?.content).toContain('Resultado truncado');
  });
});

describe('apply_file_changes — ciclo com aprovação', () => {
  it('aplica criação depois de aprovada e devolve o diff', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({
        summary: 'Cria arquivo de configuração',
        changes: [{ operation: 'create', path: 'config/app.json', content: '{\n  "a": 1\n}\n' }],
      }),
      makeContext(),
    );
    expect(outcome.error).toBeUndefined();
    expect(readFileSync(join(workspace, 'config', 'app.json'), 'utf8')).toContain('"a": 1');
    expect(outcome.result?.diffs?.[0]).toMatchObject({ path: 'config/app.json', changeKind: 'add' });
  });

  it('NÃO grava nada quando a aprovação é recusada', async () => {
    autoDecision = 'deny';
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: 'nao-criar.txt', content: 'a' }] }),
      makeContext(),
    );
    expect(outcome.error?.code).toBe('approvalDenied');
    expect(existsSync(join(workspace, 'nao-criar.txt'))).toBe(false);
  });

  it('NÃO grava nada quando a solicitação é cancelada', async () => {
    autoDecision = 'cancel';
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'overwrite', path: 'README.md', content: 'novo' }] }),
      makeContext(),
    );
    expect(outcome.error?.code).toBe('approvalDenied');
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toContain('# Projeto');
  });

  it('recusa substituição quando o trecho não é único', async () => {
    writeFileSync(join(workspace, 'dup.txt'), 'alvo\nalvo\n');
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'replace', path: 'dup.txt', find: 'alvo', replace: 'novo' }] }),
      makeContext(),
    );
    expect(outcome.error?.message).toContain('aparece 2 vezes');
    expect(readFileSync(join(workspace, 'dup.txt'), 'utf8')).toBe('alvo\nalvo\n');
  });

  it('recusa substituição quando o trecho não existe', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({
        summary: 'x',
        changes: [{ operation: 'replace', path: 'README.md', find: 'inexistente', replace: 'y' }],
      }),
      makeContext(),
    );
    expect(outcome.error?.message).toContain('não foi encontrado');
  });

  it('recusa criar arquivo que já existe', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: 'README.md', content: 'a' }] }),
      makeContext(),
    );
    expect(outcome.error?.message).toContain('já existe');
  });

  it('recusa alteração fora do workspace, sem pedir aprovação', async () => {
    let asked = false;
    const localBroker = new ApprovalBroker({
      onRequested: () => {
        asked = true;
      },
      onResolved: () => undefined,
    });
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: '../fora.txt', content: 'a' }] }),
      makeContext('execute', { approvals: localBroker }),
    );
    expect(outcome.error?.code).toBe('workspaceDenied');
    expect(asked).toBe(false);
  });

  it('recusa qualquer escrita quando a política é somente leitura', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: 'a.txt', content: 'a' }] }),
      makeContext('execute', { policy: { ...policy, sandbox: 'readOnly' } }),
    );
    expect(outcome.error?.code).toBe('workspaceDenied');
    expect(outcome.error?.message).toContain('somente leitura');
  });

  it('aplica um lote de várias alterações em ordem', async () => {
    const outcome = await executeTool(
      'apply_file_changes',
      JSON.stringify({
        summary: 'Renomeia e ajusta',
        changes: [
          { operation: 'replace', path: 'src/app.ts', find: '"antigo"', replace: '"novo"' },
          { operation: 'create', path: 'src/extra.ts', content: 'export const extra = true;\n' },
        ],
      }),
      makeContext(),
    );
    expect(outcome.error).toBeUndefined();
    expect(readFileSync(join(workspace, 'src', 'app.ts'), 'utf8')).toContain('"novo"');
    expect(existsSync(join(workspace, 'src', 'extra.ts'))).toBe(true);
    expect(outcome.result?.diffs).toHaveLength(2);
  });

  it('remove e renomeia arquivos', async () => {
    writeFileSync(join(workspace, 'apagar.txt'), 'x');
    const removal = await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'remove', changes: [{ operation: 'delete', path: 'apagar.txt' }] }),
      makeContext(),
    );
    expect(removal.error).toBeUndefined();
    expect(existsSync(join(workspace, 'apagar.txt'))).toBe(false);

    const rename = await executeTool(
      'apply_file_changes',
      JSON.stringify({
        summary: 'renomeia',
        changes: [{ operation: 'rename', path: 'README.md', newPath: 'docs/README.md' }],
      }),
      makeContext(),
    );
    expect(rename.error).toBeUndefined();
    expect(existsSync(join(workspace, 'docs', 'README.md'))).toBe(true);
  });

  it('não pede aprovação em lote para escrita: sem opção de sessão', async () => {
    const seen: string[][] = [];
    const localBroker = new ApprovalBroker({
      onRequested: (request) => {
        seen.push(request.allowedDecisions);
        setTimeout(() => localBroker.resolve(request.id, 'allowOnce'), 0);
      },
      onResolved: () => undefined,
    });
    await executeTool(
      'apply_file_changes',
      JSON.stringify({ summary: 'x', changes: [{ operation: 'create', path: 'a.txt', content: 'a' }] }),
      makeContext('execute', { approvals: localBroker }),
    );
    expect(seen[0]).toEqual(['allowOnce', 'deny', 'cancel']);
  });
});

describe('ferramentas Git', () => {
  it('degrada com motivo quando a pasta não é um repositório', async () => {
    const outcome = await executeTool('git_status', '{}', makeContext());
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.content).toMatch(/repositório|PATH/i);
  });
});
