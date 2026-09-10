import type {
  CapabilityMap,
  ErrorDetail,
  ModelCatalogPage,
  ModelDescriptor,
  ProviderConnection,
  ProviderDescriptor,
  TokenUsage,
  TurnParameters,
  UsageSnapshot,
} from '../../shared/domain';

/* ------------------------------------------------------------------ *
 * Mensagens normalizadas enviadas a um provedor
 * ------------------------------------------------------------------ */

export type ProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'imageUrl'; url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'file'; fileName: string; dataUrl: string };

export interface ProviderToolCall {
  id: string;
  name: string;
  /** Argumentos JSON completos — nunca parciais. */
  argumentsJson: string;
}

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ProviderContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ProviderToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ProviderToolSchema {
  name: string;
  description: string;
  /** JSON Schema dos parâmetros. */
  parameters: Record<string, unknown>;
}

export interface ProviderChatRequest {
  modelId: string;
  messages: ProviderMessage[];
  tools?: ProviderToolSchema[];
  /** Parâmetros pedidos; o adaptador filtra pelos suportados pelo modelo. */
  parameters: TurnParameters;
  /** Lista de parâmetros suportados vinda do catálogo (pode estar vazia). */
  supportedParameters: string[];
  signal: AbortSignal;
  /**
   * Chave estável por tentativa. Usada para evitar geração duplicada em
   * reconexão — nunca reaproveitada após um turno concluído.
   */
  idempotencyKey: string;
}

/* ------------------------------------------------------------------ *
 * Eventos de stream normalizados
 * ------------------------------------------------------------------ */

export type ProviderStreamEvent =
  | { type: 'meta'; responseId?: string; effectiveUpstream?: string; modelId?: string }
  | { type: 'textDelta'; delta: string }
  | { type: 'reasoningDelta'; delta: string }
  | { type: 'toolCallDelta'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'toolCalls'; calls: ProviderToolCall[] }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }
  | { type: 'error'; error: ErrorDetail };

export type FinishReason = 'stop' | 'length' | 'toolCalls' | 'contentFilter' | 'cancelled' | 'error' | 'unknown';

/* ------------------------------------------------------------------ *
 * Contrato do provedor de modelos
 * ------------------------------------------------------------------ */

export interface ModelProvider {
  readonly descriptor: ProviderDescriptor;

  /** Testa a credencial atual. Nunca lança por credencial inválida. */
  testConnection(signal?: AbortSignal): Promise<ProviderConnection>;

  /** Catálogo dinâmico. `cursor` só é usado quando o provedor pagina. */
  listModels(options: { cursor?: string; signal?: AbortSignal }): Promise<ModelCatalogPage>;

  /** Uso/saldo — só com dados oficialmente acessíveis à credencial. */
  readUsage(signal?: AbortSignal): Promise<UsageSnapshot>;

  /** Conversa com streaming. */
  streamChat(request: ProviderChatRequest): AsyncIterable<ProviderStreamEvent>;

  /** Capacidades declaradas para um modelo do catálogo. */
  capabilitiesFor(model: ModelDescriptor): CapabilityMap;

  /** true quando há credencial disponível para o provedor. */
  hasCredential(): boolean;
}

export interface ProviderRuntimeDeps {
  getSecret(providerId: string): string | undefined;
  /** Observações de capacidade testadas, para enriquecer o catálogo. */
  recordCapability(providerId: string, modelId: string, capability: string, value: CapabilityMap[keyof CapabilityMap]): void;
}
