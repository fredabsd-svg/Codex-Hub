import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnParameters } from '../../src/shared/domain';
import { openDatabase } from '../../src/main/persistence/database';
import { CURRENT_SCHEMA_VERSION } from '../../src/main/persistence/migrations';

const parameters: TurnParameters = { modelId: 'vendor/m', providerId: 'openrouter', engineId: 'direct' };

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'codex-hub-db-'));
}

describe('openDatabase', () => {
  it('aplica as migrações do aplicativo', () => {
    const db = openDatabase(newDir());
    expect(db.store.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prefs.getSettings().theme).toBe('dark');
    expect(db.prefs.isOnboardingCompleted()).toBe(false);
  });
});

describe('ConversationRepository e ItemRepository', () => {
  it('cria conversa com parâmetros e sequência inicial', () => {
    const db = openDatabase(newDir());
    const conversation = db.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    expect(conversation.lastSeq).toBe(0);
    expect(conversation.status).toBe('idle');
    expect(db.conversations.list()).toHaveLength(1);
  });

  it('atribui seq monotônico aos itens e ordena por ele', () => {
    const db = openDatabase(newDir());
    const conversation = db.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    for (const text of ['um', 'dois', 'três']) {
      db.items.append({
        conversationId: conversation.id,
        role: 'user',
        kind: 'userMessage',
        status: 'completed',
        text,
      });
    }
    const items = db.items.list(conversation.id);
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(items.map((item) => item.text)).toEqual(['um', 'dois', 'três']);
    expect(db.conversations.read(conversation.id)?.messageCount).toBe(3);
  });

  it('acumula texto por delta', () => {
    const db = openDatabase(newDir());
    const conversation = db.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    const item = db.items.append({
      conversationId: conversation.id,
      role: 'assistant',
      kind: 'agentMessage',
      status: 'streaming',
      text: '',
    });
    db.items.appendText(item.id, 'Olá');
    db.items.appendText(item.id, ', mundo');
    expect(db.items.get(item.id)?.text).toBe('Olá, mundo');
    expect(db.items.get(item.id)?.status).toBe('streaming');
  });

  it('recupera histórico após reiniciar e marca operações incompletas SEM reexecutar', () => {
    const dir = newDir();
    const first = openDatabase(dir);
    const conversation = first.conversations.create({
      engineId: 'codex',
      providerId: 'codex',
      modelId: 'gpt-x',
      mode: 'execute',
      parameters: { ...parameters, engineId: 'codex', providerId: 'codex' },
    });
    first.items.append({
      conversationId: conversation.id,
      role: 'user',
      kind: 'userMessage',
      status: 'completed',
      text: 'rode os testes',
    });
    first.items.append({
      conversationId: conversation.id,
      role: 'tool',
      kind: 'commandExecution',
      status: 'streaming',
      command: { command: 'npm test', output: 'parcial…', outputTruncated: false, totalOutputBytes: 8 },
    });
    first.conversations.update(conversation.id, { status: 'running' });

    // Reabre: simula reinício do aplicativo.
    const second = openDatabase(dir);
    const items = second.items.list(conversation.id);
    expect(items).toHaveLength(2);
    const command = items.find((item) => item.kind === 'commandExecution');
    expect(command?.status).toBe('cancelled');
    expect(command?.errorDetail?.code).toBe('cancelled');
    expect(command?.errorDetail?.action).toContain('Nada foi executado novamente');
    // A saída parcial é preservada, não apagada.
    expect(command?.command?.output).toBe('parcial…');
    expect(second.conversations.read(conversation.id)?.status).toBe('idle');
  });

  it('exclui conversa junto com itens e rascunho', () => {
    const db = openDatabase(newDir());
    const conversation = db.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    db.items.append({ conversationId: conversation.id, role: 'user', kind: 'userMessage', status: 'completed', text: 'x' });
    db.drafts.save(conversation.id, 'rascunho', []);
    expect(db.conversations.delete(conversation.id)).toBe(true);
    expect(db.items.list(conversation.id)).toHaveLength(0);
    expect(db.drafts.read(conversation.id).text).toBe('');
  });

  it('busca por conteúdo devolve trecho com contexto', () => {
    const db = openDatabase(newDir());
    const conversation = db.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    db.items.append({
      conversationId: conversation.id,
      role: 'assistant',
      kind: 'agentMessage',
      status: 'completed',
      text: 'A configuração do webpack precisa de um loader específico para SVG.',
    });
    const matches = db.items.search('webpack');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.snippet).toContain('webpack');
  });
});

describe('DraftRepository', () => {
  it('grava e limpa rascunho, sobrevivendo ao reinício', () => {
    const dir = newDir();
    const first = openDatabase(dir);
    const conversation = first.conversations.create({
      engineId: 'direct',
      providerId: 'openrouter',
      modelId: 'vendor/m',
      mode: 'chat',
      parameters,
    });
    first.drafts.save(conversation.id, 'texto pendente', [
      { id: 'a1', kind: 'code', fileName: 'a.ts', absolutePath: '/tmp/a.ts' },
    ]);

    const second = openDatabase(dir);
    const draft = second.drafts.read(conversation.id);
    expect(draft.text).toBe('texto pendente');
    expect(draft.attachments).toHaveLength(1);

    second.drafts.save(conversation.id, '', []);
    expect(openDatabase(dir).drafts.read(conversation.id).text).toBe('');
  });
});

describe('WorkspaceRepository', () => {
  it('registra por caminho e atualiza o último uso', () => {
    const db = openDatabase(newDir());
    const first = db.workspaces.upsertByPath('/projetos/app', 'app');
    const again = db.workspaces.upsertByPath('/projetos/app', 'app');
    expect(again.id).toBe(first.id);
    expect(db.workspaces.list()).toHaveLength(1);
    expect(db.workspaces.findByPath('/projetos/app')?.id).toBe(first.id);
  });

  it('guarda raízes extras autorizadas', () => {
    const db = openDatabase(newDir());
    const workspace = db.workspaces.upsertByPath('/projetos/app', 'app');
    const updated = db.workspaces.update(workspace.id, { extraRoots: ['/dados/compartilhado'] });
    expect(updated.extraRoots).toEqual(['/dados/compartilhado']);
  });
});

describe('PreferencesRepository', () => {
  it('mescla configurações parciais preservando o layout', () => {
    const db = openDatabase(newDir());
    db.prefs.updateSettings({ theme: 'light' });
    db.prefs.updateSettings({ layout: { sidebarWidth: 320 } });
    const settings = db.prefs.getSettings();
    expect(settings.theme).toBe('light');
    expect(settings.layout.sidebarWidth).toBe(320);
    expect(settings.layout.rightPanelTab).toBe('diff');
  });

  it('limita a lista de recentes', () => {
    const db = openDatabase(newDir());
    for (let i = 0; i < 30; i += 1) db.prefs.pushRecentModel('p', `m${i}`);
    expect(db.prefs.getRecentModels()).toHaveLength(20);
    expect(db.prefs.getRecentModels()[0]).toBe('p::m29');
  });

  it('substitui observação de capacidade do mesmo modelo', () => {
    const db = openDatabase(newDir());
    db.prefs.recordCapabilityObservation({
      providerId: 'p',
      modelId: 'm',
      capability: 'toolCalling',
      capabilityValue: { state: 'supported', source: 'tested' },
    });
    db.prefs.recordCapabilityObservation({
      providerId: 'p',
      modelId: 'm',
      capability: 'toolCalling',
      capabilityValue: { state: 'unsupported', source: 'tested' },
    });
    const observations = db.prefs.getCapabilityObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.capabilityValue.state).toBe('unsupported');
  });
});
