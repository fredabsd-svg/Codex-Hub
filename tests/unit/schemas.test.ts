import { describe, expect, it } from 'vitest';
import { IPC_INVOKE_CHANNELS } from '../../src/shared/ipc';
import { IPC_RATE_LIMITS, IPC_SCHEMAS, missingSchemas } from '../../src/shared/schemas';

describe('cobertura de schemas', () => {
  it('todo canal de invoke tem schema declarado', () => {
    expect(missingSchemas()).toEqual([]);
  });

  it('não há schema órfão sem canal correspondente', () => {
    const channels = new Set<string>(IPC_INVOKE_CHANNELS);
    for (const key of Object.keys(IPC_SCHEMAS)) {
      expect(channels.has(key)).toBe(true);
    }
  });

  it('operações sensíveis têm limite de frequência', () => {
    for (const channel of ['turn:send', 'providers:connect', 'codex:start', 'shell:openExternal'] as const) {
      expect(IPC_RATE_LIMITS[channel]).toBeDefined();
    }
  });
});

describe('validações que protegem o processo principal', () => {
  it('recusa campo desconhecido (objetos são strict)', () => {
    const result = IPC_SCHEMAS['conversations:rename'].safeParse({
      conversationId: 'c1',
      title: 'x',
      extra: 'não permitido',
    });
    expect(result.success).toBe(false);
  });

  it('recusa título vazio ao renomear', () => {
    expect(IPC_SCHEMAS['conversations:rename'].safeParse({ conversationId: 'c1', title: '' }).success).toBe(false);
  });

  it('aceita payload correto de turno', () => {
    const result = IPC_SCHEMAS['turn:send'].safeParse({
      conversationId: 'c1',
      text: 'olá',
      attachmentIds: ['a1'],
      parameters: { modelId: 'm', reasoningEffort: 'high' },
    });
    expect(result.success).toBe(true);
  });

  it('recusa esforço de raciocínio inválido', () => {
    const result = IPC_SCHEMAS['turn:send'].safeParse({
      conversationId: 'c1',
      text: 'olá',
      parameters: { reasoningEffort: 'altíssimo' },
    });
    expect(result.success).toBe(false);
  });

  it('recusa cabeçalho controlado pelo aplicativo em endpoint compatível', () => {
    const bad = IPC_SCHEMAS['providers:registerCompatible'].safeParse({
      label: 'x',
      baseUrl: 'https://api.exemplo/v1',
      persist: true,
      headers: { Authorization: 'Bearer abc' },
    });
    expect(bad.success).toBe(false);

    const ok = IPC_SCHEMAS['providers:registerCompatible'].safeParse({
      label: 'x',
      baseUrl: 'https://api.exemplo/v1',
      persist: true,
      headers: { 'X-Org': 'time-a' },
    });
    expect(ok.success).toBe(true);
  });

  it('limita o tamanho da imagem colada', () => {
    const tooBig = 'a'.repeat(64 * 1024 * 1024 + 10);
    expect(
      IPC_SCHEMAS['attachments:prepareFromClipboardImage'].safeParse({ conversationId: 'c', base64: tooBig }).success,
    ).toBe(false);
  });

  it('limita a quantidade de anexos por chamada', () => {
    const paths = Array.from({ length: 201 }, (_, i) => `/tmp/a${i}.txt`);
    expect(IPC_SCHEMAS['attachments:prepare'].safeParse({ conversationId: 'c', paths }).success).toBe(false);
  });

  it('aceita void para canais sem entrada', () => {
    expect(IPC_SCHEMAS['app:getBootstrap'].safeParse(undefined).success).toBe(true);
    expect(IPC_SCHEMAS['app:getBootstrap'].safeParse(null).success).toBe(true);
  });

  it('recusa patch de configurações com chave desconhecida', () => {
    expect(IPC_SCHEMAS['settings:update'].safeParse({ apiKey: 'segredo' }).success).toBe(false);
  });

  it('aceita patch parcial de layout', () => {
    expect(IPC_SCHEMAS['settings:update'].safeParse({ layout: { sidebarWidth: 300 } }).success).toBe(true);
  });

  it('recusa escala de fonte fora da faixa', () => {
    expect(IPC_SCHEMAS['settings:update'].safeParse({ fontScale: 4 }).success).toBe(false);
  });

  it('aceita workspacePath nulo para desvincular', () => {
    expect(
      IPC_SCHEMAS['conversations:setWorkspace'].safeParse({ conversationId: 'c1', workspacePath: null }).success,
    ).toBe(true);
  });

  it('recusa decisão de aprovação desconhecida', () => {
    expect(IPC_SCHEMAS['approvals:resolve'].safeParse({ approvalId: 'a', decision: 'talvez' }).success).toBe(false);
  });
});
