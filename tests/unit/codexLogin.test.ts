/**
 * Parâmetros de `account/login/start` e o campo `params` obrigatório.
 *
 * Origem: o Codex 0.154.0 (Windows) respondeu
 *   - `Invalid request: missing field \`params\`` em `account/read`;
 *   - `Invalid request: missing field \`type\`` em `account/login/start`.
 */

import { describe, expect, it } from 'vitest';
import { encodeNotification, encodeRequest } from '../../src/main/codex/protocol';
import { loginParams, matchVariant, parseExpectedVariants, preferredVariant } from '../../src/main/codex/loginParams';

describe('campo params na linha do protocolo', () => {
  it('envia params mesmo quando o método não recebe argumento', () => {
    const line = JSON.parse(encodeRequest(1, 'account/read')) as Record<string, unknown>;
    expect(line).toEqual({ id: 1, method: 'account/read', params: {} });
    expect(Object.prototype.hasOwnProperty.call(line, 'params')).toBe(true);
  });

  it('preserva os params quando existem', () => {
    const line = JSON.parse(encodeRequest('a', 'thread/start', { model: 'x' })) as Record<string, unknown>;
    expect(line).toEqual({ id: 'a', method: 'thread/start', params: { model: 'x' } });
  });

  it('vale também para notificações', () => {
    expect(JSON.parse(encodeNotification('initialized'))).toEqual({ method: 'initialized', params: {} });
  });

  it('nunca escreve o campo jsonrpc', () => {
    expect(encodeRequest(1, 'initialize', {})).not.toContain('jsonrpc');
    expect(encodeNotification('initialized')).not.toContain('jsonrpc');
  });
});

describe('discriminador do login', () => {
  it('usa `type`, não `method`', () => {
    const params = loginParams('chatgpt', preferredVariant('chatgpt'));
    expect(params).toHaveProperty('type');
    expect(params).not.toHaveProperty('method');
  });

  it('só o fluxo de chave recebe a chave', () => {
    expect(loginParams('apiKey', 'apiKey', 'sk-teste')).toEqual({ type: 'apiKey', apiKey: 'sk-teste' });
    expect(loginParams('chatgpt', 'chatGpt', 'sk-teste')).toEqual({ type: 'chatGpt' });
    expect(loginParams('deviceCode', 'deviceCode', 'sk-teste')).toEqual({ type: 'deviceCode' });
  });
});

describe('variantes aceitas pelo servidor', () => {
  it('lê a lista que o próprio servidor informa', () => {
    const options = parseExpectedVariants(
      'unknown variant `chatGpt`, expected one of `chatgpt`, `apikey`, `devicecode`',
    );
    expect(options).toEqual(['chatgpt', 'apikey', 'devicecode']);
  });

  it('não trata um erro qualquer como lista de variantes', () => {
    expect(parseExpectedVariants('Invalid request: missing field `type`')).toEqual([]);
    expect(parseExpectedVariants('internal error')).toEqual([]);
    expect(parseExpectedVariants('')).toEqual([]);
  });

  it('escolhe a variante equivalente ignorando caixa e separadores', () => {
    expect(matchVariant('chatgpt', ['chatgpt', 'apikey'])).toBe('chatgpt');
    expect(matchVariant('chatgpt', ['chat_gpt', 'api_key'])).toBe('chat_gpt');
    expect(matchVariant('apiKey', ['ChatGPT', 'ApiKey'])).toBe('ApiKey');
    expect(matchVariant('deviceCode', ['device-code'])).toBe('device-code');
  });

  it('devolve null quando nenhuma variante corresponde', () => {
    expect(matchVariant('deviceCode', ['chatgpt', 'apikey'])).toBeNull();
    expect(matchVariant('chatgpt', [])).toBeNull();
  });
});
