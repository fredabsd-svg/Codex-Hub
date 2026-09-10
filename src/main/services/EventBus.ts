/**
 * Barramento de eventos para o renderer.
 *
 * O renderer recebe apenas dados de apresentação já normalizados.
 * A sequência (`seq`) é atribuída aqui, por conversa, permitindo à interface
 * ordenar e detectar lacunas.
 */

import type { AppEvent, DomainEvent } from '../../shared/events';

export type EventSender = (channel: 'event:domain' | 'event:app', payload: unknown) => void;

/** Omit distributivo: preserva a união discriminada de `DomainEvent`. */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq' | 'at'> & { at?: string } : never;

export type DomainEventInput = WithoutSeq<DomainEvent>;

export class EventBus {
  private readonly sequences = new Map<string, number>();
  private sender: EventSender | null = null;

  setSender(sender: EventSender | null): void {
    this.sender = sender;
  }

  nextSeq(conversationId: string): number {
    const next = (this.sequences.get(conversationId) ?? 0) + 1;
    this.sequences.set(conversationId, next);
    return next;
  }

  /** Alinha o contador após carregar histórico do disco. */
  primeSeq(conversationId: string, seq: number): void {
    const current = this.sequences.get(conversationId) ?? 0;
    if (seq > current) this.sequences.set(conversationId, seq);
  }

  emitDomain(input: DomainEventInput): DomainEvent {
    const event = {
      ...input,
      seq: this.nextSeq(input.conversationId),
      at: input.at ?? new Date().toISOString(),
    } as DomainEvent;
    this.sender?.('event:domain', event);
    return event;
  }

  emitApp(event: AppEvent): void {
    this.sender?.('event:app', event);
  }

  forget(conversationId: string): void {
    this.sequences.delete(conversationId);
  }
}
