/**
 * Ferramentas de leitura do Git para o motor direto.
 * Somente leitura: nenhuma ferramenta faz commit, reset, checkout ou clean.
 */

import { z } from 'zod';
import { parseGitUnifiedDiff } from './diff';
import { truncateResult, type ToolDefinition, type ToolResult } from './types';

const statusSchema = z.object({}).strict();

export const gitStatusTool: ToolDefinition<typeof statusSchema> = {
  name: 'git_status',
  description:
    'Mostra o estado do repositório Git do workspace: branch, arquivos alterados e contagem de mudanças. Somente leitura.',
  schema: statusSchema,
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  allowedModes: ['chat', 'plan', 'execute'],
  mutating: false,
  retryableAfterFailure: true,
  async execute(_args, ctx): Promise<ToolResult> {
    const summary = await ctx.git.summary(ctx.workspacePath);
    if (!summary.available || !summary.isRepository) {
      return {
        content: summary.unavailableReason ?? 'Estado do Git indisponível.',
        data: summary,
      };
    }
    const changes = await ctx.git.changes(ctx.workspacePath);
    const lines = [
      `Branch: ${summary.branch ?? 'não informado'}`,
      summary.ahead !== undefined || summary.behind !== undefined
        ? `Comparado ao upstream: ${summary.ahead ?? 0} à frente, ${summary.behind ?? 0} atrás`
        : 'Sem upstream configurado.',
      `Arquivos alterados: ${summary.changedFiles ?? 0}`,
      '',
      ...changes.map((c) => `${c.status.padEnd(10)} ${c.path}${c.binary ? ' (binário)' : ''}`),
    ];
    const result = truncateResult(lines.join('\n'), ctx.maxResultBytes);
    return { content: result.content, data: { summary, changes }, truncated: result.truncated };
  },
};

const diffSchema = z
  .object({
    path: z.string().max(4096).optional().describe('Caminho relativo. Omita para o diff completo.'),
    staged: z.boolean().default(false),
  })
  .strict();

export const gitDiffTool: ToolDefinition<typeof diffSchema> = {
  name: 'git_diff',
  description: 'Mostra o diff unificado do repositório Git do workspace. Somente leitura.',
  schema: diffSchema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      staged: { type: 'boolean' },
    },
    required: [],
    additionalProperties: false,
  },
  allowedModes: ['chat', 'plan', 'execute'],
  mutating: false,
  retryableAfterFailure: true,
  async execute(args, ctx): Promise<ToolResult> {
    // Valida o caminho mesmo em leitura: nada fora do workspace.
    const relativePath = args.path ? ctx.guard.resolve(args.path).relativePath : undefined;
    const raw = await ctx.git.diff(ctx.workspacePath, relativePath, { staged: args.staged });
    if (raw.trim() === '') {
      return { content: 'Nenhuma diferença encontrada para o escopo solicitado.', data: { files: [] } };
    }
    const files = parseGitUnifiedDiff(raw);
    const result = truncateResult(raw, ctx.maxResultBytes);
    return { content: result.content, data: { files }, diffs: files, truncated: result.truncated };
  },
};

export const GIT_TOOLS = [gitStatusTool, gitDiffTool];
