/**
 * Eventos de domínio normalizados.
 *
 * Os motores (Codex App Server, motor direto) traduzem seus formatos brutos
 * para estes eventos. O renderer nunca vê payload cru de fornecedor.
 * Todo evento carrega os identificadores necessários para roteamento.
 */

import type {
  ApprovalRequest,
  CodexAccountState,
  CodexLoginProgress,
  CodexRuntimeInfo,
  ConversationId,
  ConversationItem,
  ConversationStatus,
  EffectivePolicy,
  EngineId,
  ErrorDetail,
  FileDiff,
  ItemId,
  PlanStep,
  ProviderConnection,
  ProviderId,
  TokenUsage,
  TurnId,
  UsageSnapshot,
} from './domain';

export interface EventEnvelope {
  /** Sequência monotônica por conversa; usada para ordenar e detectar lacunas. */
  seq: number;
  at: string;
  engineId: EngineId;
  providerId: ProviderId;
  conversationId: ConversationId;
  turnId?: TurnId;
  itemId?: ItemId;
}

export type DomainEvent =
  | ({ type: 'conversation/status'; status: ConversationStatus; detail?: string } & EventEnvelope)
  | ({ type: 'conversation/native'; nativeThreadId: string } & EventEnvelope)
  | ({ type: 'conversation/title'; title: string; titleIsLocal: boolean } & EventEnvelope)
  | ({ type: 'turn/started'; turnId: TurnId } & EventEnvelope)
  | ({
      type: 'turn/completed';
      turnId: TurnId;
      usage?: TokenUsage;
      effectiveUpstream?: string;
    } & EventEnvelope)
  | ({ type: 'turn/failed'; turnId: TurnId; error: ErrorDetail } & EventEnvelope)
  | ({ type: 'turn/cancelled'; turnId: TurnId; reason?: string } & EventEnvelope)
  | ({ type: 'item/started'; item: ConversationItem } & EventEnvelope)
  | ({ type: 'item/textDelta'; itemId: ItemId; delta: string } & EventEnvelope)
  | ({ type: 'item/reasoningDelta'; itemId: ItemId; delta: string } & EventEnvelope)
  | ({ type: 'item/planUpdated'; itemId: ItemId; steps: PlanStep[] } & EventEnvelope)
  | ({ type: 'item/outputDelta'; itemId: ItemId; chunk: string; stream: 'stdout' | 'stderr' } & EventEnvelope)
  | ({ type: 'item/completed'; item: ConversationItem } & EventEnvelope)
  | ({ type: 'item/failed'; itemId: ItemId; error: ErrorDetail } & EventEnvelope)
  | ({ type: 'diff/updated'; files: FileDiff[] } & EventEnvelope)
  | ({ type: 'approval/requested'; request: ApprovalRequest } & EventEnvelope)
  | ({ type: 'approval/resolved'; approvalId: string; decision: string } & EventEnvelope)
  | ({ type: 'policy/effective'; policy: EffectivePolicy } & EventEnvelope)
  | ({ type: 'usage/updated'; usage: UsageSnapshot } & EventEnvelope)
  | ({ type: 'error'; error: ErrorDetail } & EventEnvelope);

/** Eventos globais (não pertencem a uma conversa). */
export type AppEvent =
  | { type: 'provider/connection'; connection: ProviderConnection; at: string }
  | { type: 'codex/runtime'; runtime: CodexRuntimeInfo; at: string }
  | { type: 'codex/account'; account: CodexAccountState; at: string }
  | { type: 'codex/login'; progress: CodexLoginProgress; at: string }
  | { type: 'catalog/invalidated'; providerId: ProviderId; at: string }
  | { type: 'usage/updated'; usage: UsageSnapshot; at: string }
  | { type: 'settings/updated'; at: string }
  | { type: 'workspaces/updated'; at: string }
  | { type: 'conversations/updated'; at: string }
  | { type: 'diagnostics/notice'; level: 'info' | 'warn' | 'error'; message: string; at: string };
