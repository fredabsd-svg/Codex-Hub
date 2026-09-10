/**
 * Registro de ferramentas do motor direto.
 *
 * Execução de shell arbitrário NÃO está registrada aqui — de propósito.
 * Enquanto não houver um mecanismo de isolamento implementado e verificado
 * compatível com as restrições prometidas, comandos arbitrários ficam
 * indisponíveis neste motor. As ferramentas estruturadas seguem funcionando.
 * O modo Codex mantém a execução pelo runtime oficial.
 */

import type { OperationMode } from '../../shared/domain';
import { appError } from '../../shared/errors';
import type { ProviderToolSchema } from '../providers/types';
import { FS_TOOLS } from './fsTools';
import { GIT_TOOLS } from './gitTools';
import type { ToolContext, ToolDefinition, ToolResult } from './types';

const ALL_TOOLS: ToolDefinition[] = [...FS_TOOLS, ...GIT_TOOLS];

export function toolsForMode(mode: OperationMode): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => tool.allowedModes.includes(mode));
}

export function allTools(): ToolDefinition[] {
  return [...ALL_TOOLS];
}

export function findTool(name: string): ToolDefinition | null {
  return ALL_TOOLS.find((t) => t.name === name) ?? null;
}

export function toolSchemasForMode(mode: OperationMode): ProviderToolSchema[] {
  return toolsForMode(mode).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export interface ToolExecutionOutcome {
  result?: ToolResult;
  error?: { message: string; action?: string; code: string };
}

/**
 * Executa uma ferramenta com validação de argumentos e checagem de modo.
 * A restrição de modo é aplicada AQUI, no processo principal — não depende do
 * que foi escrito no prompt.
 */
export async function executeTool(name: string, rawArguments: string, ctx: ToolContext): Promise<ToolExecutionOutcome> {
  const tool = findTool(name);
  if (!tool) {
    return {
      error: {
        code: 'validation',
        message: `A ferramenta "${name}" não existe neste aplicativo.`,
        action: 'Use apenas as ferramentas declaradas na requisição.',
      },
    };
  }
  if (!tool.allowedModes.includes(ctx.mode)) {
    return {
      error: {
        code: 'approvalDenied',
        message: `A ferramenta "${name}" não está disponível no modo ${modeLabel(ctx.mode)}.`,
        action: `Mude para o modo ${tool.allowedModes.map(modeLabel).join(' ou ')} para usá-la.`,
      },
    };
  }

  let parsedArguments: unknown;
  try {
    parsedArguments = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch {
    return {
      error: {
        code: 'validation',
        message: `Os argumentos de "${name}" não são um JSON válido.`,
        action: 'Reenvie a chamada com um objeto JSON completo.',
      },
    };
  }

  const validation = tool.schema.safeParse(parsedArguments);
  if (!validation.success) {
    const issues = validation.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    return {
      error: {
        code: 'validation',
        message: `Argumentos inválidos para "${name}": ${issues}`,
        action: 'Corrija os campos indicados e chame a ferramenta novamente.',
      },
    };
  }

  try {
    const result = await tool.execute(validation.data, ctx);
    return { result };
  } catch (err) {
    const detail =
      err && typeof err === 'object' && 'detail' in err
        ? (err as { detail: { code: string; message: string; action?: string } }).detail
        : { code: 'internal', message: err instanceof Error ? err.message : String(err) };
    return { error: { code: detail.code, message: detail.message, action: detail.action } };
  }
}

export function modeLabel(mode: OperationMode): string {
  return mode === 'chat' ? 'Conversar' : mode === 'plan' ? 'Planejar' : 'Executar';
}

/**
 * A execução de comandos arbitrários no motor direto é rejeitada de forma
 * explícita, com motivo concreto.
 */
export function rejectArbitraryShell(): never {
  throw appError('toolLimit', {
    message:
      'A execução de comandos arbitrários está indisponível no motor direto: este aplicativo não implementa um isolamento verificado para ela.',
    action:
      'Use o motor Codex, que executa comandos pelo runtime oficial com sandbox e aprovações, ou use as ferramentas estruturadas de arquivo e Git.',
  });
}
