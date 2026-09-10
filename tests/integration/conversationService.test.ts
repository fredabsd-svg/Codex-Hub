/**
 * ConversationService: o que a pessoa vê ao enviar uma mensagem.
 *
 * Motor falso, sem rede e sem provedor real. O foco é o contrato do serviço:
 * persistir e ANUNCIAR a mensagem enviada antes de qualquer chamada externa,
 * recusar dois turnos simultâneos e não deixar o turno preso quando o motor
 * falha.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../src/main/persistence/database';
import { EventBus } from '../../src/main/services/EventBus';
import { GitService } from '../../src/main/services/GitService';
import { WorkspaceService } from '../../src/main/services/WorkspaceService';
import { AttachmentService } from '../../src/main/services/AttachmentService';
import { ConversationService } from '../../src/main/services/ConversationService';
import { ENGINE_CAPABILITIES } from '../../src/shared/capabilities';
import type { ExecutionEngine, EngineTurnRequest } from '../../src/main/engines/types';
import type { ConversationRow } from '../../src/main/persistence/repositories';
import type { DomainEvent } from '../../src/shared/events';
import type { EffectivePolicy, OperationMode } from '../../src/shared/domain';

let dir: string;
let db: Database;
let bus: EventBus;
let service: ConversationService;
let events: DomainEvent[];
let engine: FakeEngine;

class FakeEngine implements ExecutionEngine {
  readonly id = 'direct' as const;
  readonly capabilities = ENGINE_CAPABILITIES.direct;
  /** Resolvido manualmente pelo teste para controlar a duração do turno. */
  release: (() => void) | null = null;
  lastRequest: EngineTurnRequest | null = null;
  failWith: Error | null = null;

  async ensureReady(): Promise<void> {}
  async openConversation(): Promise<{ nativeThreadId?: string }> {
    return {};
  }
  async resumeConversation(): Promise<{ nativeThreadId?: string }> {
    return {};
  }
  async runTurn(request: EngineTurnRequest): Promise<void> {
    this.lastRequest = request;
    if (this.failWith) throw this.failWith;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    request.sink.turnCompleted();
  }
  async steer(): Promise<boolean> {
    return false;
  }
  async interrupt(): Promise<boolean> {
    return true;
  }
  async closeConversation(): Promise<void> {}
  effectivePolicy(_conversation: ConversationRow, mode: OperationMode): EffectivePolicy {
    return {
      mode,
      approvals: 'always',
      sandbox: 'readOnly',
      inferenceNetwork: 'allowed',
      toolNetwork: 'blocked',
      confirmedByRuntime: false,
    };
  }
  async listSkills(): Promise<[]> {
    return [];
  }
}

function domainOf(type: DomainEvent['type']): DomainEvent[] {
  return events.filter((event) => event.type === type);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-hub-conv-svc-'));
  db = openDatabase(dir);
  bus = new EventBus();
  events = [];
  bus.setSender((channel, payload) => {
    if (channel === 'event:domain') events.push(payload as DomainEvent);
  });
  const workspaces = new WorkspaceService(db.workspaces, new GitService());
  engine = new FakeEngine();
  service = new ConversationService({
    db,
    bus,
    attachments: new AttachmentService(workspaces, () => ({ maxCount: 5, maxBytes: 4 * 1024 * 1024 })),
    workspaces,
    engineFor: () => engine,
    skillsFor: async () => [],
    onCatalogUse: () => undefined,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newConversation() {
  return service.create({
    engineId: 'direct',
    providerId: 'openrouter',
    modelId: 'vendor/modelo',
    mode: 'chat',
  });
}

describe('ConversationService.send', () => {
  it('anuncia a mensagem enviada como item antes de qualquer resposta', async () => {
    const conversation = newConversation();
    await service.send({ conversationId: conversation.id, text: 'olá, motor' });

    const started = domainOf('item/started');
    expect(started.length).toBeGreaterThanOrEqual(1);
    const first = started[0] as Extract<DomainEvent, { type: 'item/started' }>;
    expect(first.item.role).toBe('user');
    expect(first.item.kind).toBe('userMessage');
    expect(first.item.text).toBe('olá, motor');

    // E o item também está no histórico persistido.
    const items = db.items.list(conversation.id);
    expect(items.some((item) => item.role === 'user' && item.text === 'olá, motor')).toBe(true);

    engine.release?.();
  });

  it('recusa um segundo turno enquanto o primeiro está em andamento', async () => {
    const conversation = newConversation();
    await service.send({ conversationId: conversation.id, text: 'primeiro' });
    await expect(service.send({ conversationId: conversation.id, text: 'segundo' })).rejects.toMatchObject({
      detail: { code: 'validation' },
    });
    engine.release?.();
  });

  it('exige um modelo selecionado e explica o que fazer', async () => {
    const conversation = newConversation();
    db.conversations.update(conversation.id, { parameters: { modelId: '', providerId: 'openrouter', engineId: 'direct' } });
    await expect(service.send({ conversationId: conversation.id, text: 'oi' })).rejects.toMatchObject({
      detail: { code: 'validation' },
    });
  });

  it('libera o turno e reporta falha quando o motor lança', async () => {
    const conversation = newConversation();
    engine.failWith = new Error('motor quebrou');
    await service.send({ conversationId: conversation.id, text: 'vai falhar' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(domainOf('turn/failed')).toHaveLength(1);
    // Sem turno preso: um novo envio é aceito.
    await expect(service.send({ conversationId: conversation.id, text: 'de novo' })).resolves.toMatchObject({
      accepted: true,
    });
    engine.release?.();
  });

  it('não repassa o texto do turno atual como histórico duplicado', async () => {
    const conversation = newConversation();
    await service.send({ conversationId: conversation.id, text: 'mensagem única' });
    const history = engine.lastRequest?.history ?? [];
    expect(history.some((item) => item.text === 'mensagem única')).toBe(false);
    engine.release?.();
  });
});
