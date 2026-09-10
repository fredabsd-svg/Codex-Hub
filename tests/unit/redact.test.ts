import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredSecrets,
  forgetSecret,
  maskCredential,
  redactText,
  redactValue,
  registerSecret,
} from '../../src/main/services/redact';

afterEach(() => clearRegisteredSecrets());

describe('redactText', () => {
  it('redige chaves com prefixos conhecidos', () => {
    expect(redactText('use sk-or-v1-abcdefghijklmnop no header')).toContain('sk-or-v1-[REDIGIDO]');
    expect(redactText('sk-ant-abcdefghijklmnop')).toContain('sk-ant-[REDIGIDO]');
    expect(redactText('token AIzaSyA1234567890abcdefghijk')).toContain('AIza[REDIGIDO]');
    expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz')).toContain('gh*_[REDIGIDO]');
  });

  it('redige cabeçalhos de autorização', () => {
    expect(redactText('authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redactText('x-api-key: minhachave')).not.toContain('minhachave');
  });

  it('redige campos nomeados em JSON', () => {
    const raw = '{"apiKey":"muito-secreto","modelo":"gpt"}';
    const redacted = redactText(raw);
    expect(redacted).not.toContain('muito-secreto');
    expect(redacted).toContain('gpt');
  });

  it('redige segredo em query string', () => {
    expect(redactText('https://api/x?api_key=abc123&model=y')).not.toContain('abc123');
  });

  it('redige JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH';
    expect(redactText(`token=${jwt}`)).not.toContain('eyJzdWIi');
  });

  it('redige segredo registrado em runtime, mesmo sem formato conhecido', () => {
    registerSecret('formato-totalmente-inesperado-1234');
    expect(redactText('a chave é formato-totalmente-inesperado-1234')).toBe('a chave é [REDIGIDO]');
    forgetSecret('formato-totalmente-inesperado-1234');
    expect(redactText('a chave é formato-totalmente-inesperado-1234')).toContain('formato-totalmente');
  });

  it('não altera texto sem segredos', () => {
    expect(redactText('mensagem comum sobre código')).toBe('mensagem comum sobre código');
  });
});

describe('redactValue', () => {
  it('redige recursivamente chaves sensíveis', () => {
    const value = redactValue({
      provider: 'openrouter',
      headers: { Authorization: 'Bearer segredo', 'X-Title': 'Codex Hub' },
      nested: { apiKey: 'abc', ok: true },
    }) as Record<string, unknown>;
    expect(JSON.stringify(value)).not.toContain('segredo');
    expect(JSON.stringify(value)).not.toContain('"abc"');
    expect(JSON.stringify(value)).toContain('Codex Hub');
  });

  it('redige mensagens e stack de Error (payloads de erro incluídos)', () => {
    registerSecret('sk-or-v1-chavedeexemplo123');
    const error = new Error('falhou com sk-or-v1-chavedeexemplo123');
    const value = redactValue(error) as { message: string; stack: string };
    expect(value.message).not.toContain('chavedeexemplo');
    expect(value.stack).not.toContain('chavedeexemplo');
  });

  it('limita profundidade sem lançar', () => {
    type Deep = { next?: Deep };
    const deep: Deep = {};
    let cursor = deep;
    for (let i = 0; i < 30; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(() => JSON.stringify(redactValue(deep))).not.toThrow();
  });
});

describe('maskCredential', () => {
  it('mantém o prefixo e os quatro últimos caracteres', () => {
    expect(maskCredential('sk-or-v1-abcdefghijklmnop4f2a')).toBe('sk-or-v1-…4f2a');
    expect(maskCredential('sk-ant-xxxxxxxxxxxx9999')).toBe('sk-ant-…9999');
  });

  it('mascara integralmente valores curtos', () => {
    expect(maskCredential('curto')).toMatch(/^•+$/);
  });

  it('nunca devolve o segredo inteiro', () => {
    const secret = 'sk-proj-segredointeiromuitolongo';
    expect(maskCredential(secret)).not.toContain('segredointeiro');
  });
});
