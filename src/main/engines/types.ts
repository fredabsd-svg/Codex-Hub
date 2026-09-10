/**
 * Contrato de motor de execução.
 *
 * "Provedor" fornece inferência. "Motor" administra conversas, ferramentas,
 * permissões e execução. A interface separa os dois de propósito: a interface
 * nunca fica acoplada a uma marca ou a um único protocolo.
 */

import type {
  ApprovalRequest,
  AttachmentRef,
  CapabilityMap,
  ConversationItem,
  EffectivePolicy,
  EngineId,
  ErrorDetail,
  FileDiff,
  OperationMode,
  PlanStep,
  SkillDescriptor,
  TokenUsage,
  TurnParameters,
} from '../../shared/domain';
import type { ConversationRow } from '../persistence/repositories';

/** Canal por onde o motor publica o que realmente aconteceu. */
export interface TurnSink {
  newItemId(): string;
  status(status: StatusValue, detail?: string): void;
  itemStarted(item: NewItem): ConversationItem;
  textDelta(itemId: string, delta: string): void;
  reasoningDelta(itemId: string, delta: string): void;
  planUpdated(itemId: string, steps: PlanStep[]): void;
  outputDelta(itemId: string, chunk: string, stream: 'stdout' | 'stderr'): void;
  itemCompleted(itemId: string, patch?: Partial<ConversationItem>): void;
  itemFailed(itemId: string, error: ErrorDetail): void;
  diffUpdated(files: FileDiff[]): void;
  usage(usage: TokenUsage): void;
  approvalRequested(request: ApprovalRequest): void;
  policy(policy: EffectivePolicy): void;
  turnCompleted(usage?: TokenUsage, effectiveUpstream?: string): void;
  turnFailed(error: ErrorDetail): void;
  turnCancelled(reason?: string): void;
  nativeThread(threadId: string): void;
  titleSuggested(title: string, isLocal: boolean): void;
  error(error: ErrorDetail): void;
}

export type StatusValue =
  | 'connecting'
  | 'ready'
  | 'running'
  | 'awaitingApproval'
  | 'interrupting'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'idle';

export type NewItem = Omit<ConversationItem, 'id' | 'createdAt' | 'updatedAt' | 'conversationId'> & {
  id?: string;
};

export interface EngineTurnRequest {
  conversation: ConversationRow;
  turnId: string;
  text: string;
  attachments: AttachmentRef[];
  parameters: TurnParameters;
  policy: EffectivePolicy;
  mode: OperationMode;
  /** Histórico persistido (usado pelo motor direto para montar o contexto). */
  history: ConversationItem[];
  signal: AbortSignal;
  sink: TurnSink;
  skills: SkillDescriptor[];
}

export interface ExecutionEngine {
  readonly id: EngineId;
  readonly capabilities: CapabilityMap;

  /** Garante que o motor está utilizável; lança com erro de domínio se não. */
  ensureReady(): Promise<void>;

  /** Cria a conversa no motor. Devolve o ID nativo quando existir. */
  openConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }>;

  /** Retoma uma conversa existente após reinício do app ou do motor. */
  resumeConversation(conversation: ConversationRow, sink: TurnSink): Promise<{ nativeThreadId?: string }>;

  /** Executa um turno. Só retorna quando o turno termina, falha ou é cancelado. */
  runTurn(request: EngineTurnRequest): Promise<void>;

  /** Orientação para o turno EM ANDAMENTO. `false` se não houver suporte. */
  steer(conversation: ConversationRow, text: string): Promise<boolean>;

  /** Pedido de interrupção do turno ativo. */
  interrupt(conversation: ConversationRow): Promise<boolean>;

  /** Libera recursos associados à conversa. */
  closeConversation(conversation: ConversationRow): Promise<void>;

  /** Política efetivamente aplicável, do ponto de vista do motor. */
  effectivePolicy(conversation: ConversationRow, mode: OperationMode): EffectivePolicy;

  /** Skills conhecidas pelo motor. */
  listSkills(workspacePath?: string): Promise<SkillDescriptor[]>;
}
