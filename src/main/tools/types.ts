import type { z } from 'zod';
import type { EffectivePolicy, FileDiff, OperationMode } from '../../shared/domain';
import type { PathGuard } from '../services/pathSafety';
import type { GitService } from '../services/GitService';
import type { ApprovalBroker } from './ApprovalBroker';

export interface ToolContext {
  conversationId: string;
  turnId: string;
  workspacePath: string;
  guard: PathGuard;
  policy: EffectivePolicy;
  mode: OperationMode;
  approvals: ApprovalBroker;
  git: GitService;
  signal: AbortSignal;
  maxResultBytes: number;
}

export interface ToolResult {
  /** Texto devolvido ao modelo. Truncado conforme `maxResultBytes`. */
  content: string;
  /** Dados estruturados para a interface (não vão para o modelo). */
  data?: unknown;
  diffs?: FileDiff[];
  truncated?: boolean;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Descrição enviada ao modelo (em pt-BR; o modelo entende). */
  description: string;
  schema: S;
  /** JSON Schema equivalente, enviado ao provedor. */
  parameters: Record<string, unknown>;
  /** Modos em que a ferramenta pode ser usada — restrição do BACKEND. */
  allowedModes: OperationMode[];
  /** true quando a execução altera o disco. */
  mutating: boolean;
  /**
   * Ferramentas com efeito colateral NUNCA são repetidas automaticamente
   * depois de falha de rede ou reinício.
   */
  retryableAfterFailure: boolean;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function truncateResult(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.byteLength <= maxBytes) return { content, truncated: false };
  const slice = buffer.subarray(0, maxBytes).toString('utf8');
  return {
    content: `${slice}\n\n[Resultado truncado em ${maxBytes} bytes pelo Codex Hub. Refine a consulta para ver o restante.]`,
    truncated: true,
  };
}
