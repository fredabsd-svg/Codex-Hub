import { describe, expect, it } from 'vitest';
import {
  classify,
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeResponse,
} from '../../src/main/codex/protocol';

describe('classify (JSON-RPC sem o campo jsonrpc no fio)', () => {
  it('classifica resposta de sucesso', () => {
    const message = classify('{"id":1,"result":{"ok":true}}');
    expect(message).toEqual({ kind: 'response', id: 1, result: { ok: true } });
  });

  it('classifica resposta de erro', () => {
    const message = classify('{"id":"a","error":{"code":-32601,"message":"method not found"}}');
    expect(message?.kind).toBe('error');
    if (message?.kind === 'error') {
      expect(message.error.code).toBe(-32601);
      expect(message.id).toBe('a');
    }
  });

  it('classifica notificação (sem id)', () => {
    const message = classify('{"method":"turn/started","params":{"turnId":"t1"}}');
    expect(message).toEqual({ kind: 'notification', method: 'turn/started', params: { turnId: 't1' } });
  });

  it('classifica requisição INICIADA PELO SERVIDOR (id + method)', () => {
    const message = classify('{"id":7,"method":"execCommandApproval","params":{"command":"ls"}}');
    expect(message?.kind).toBe('serverRequest');
    if (message?.kind === 'serverRequest') {
      expect(message.id).toBe(7);
      expect(message.method).toBe('execCommandApproval');
    }
  });

  it('não confunde requisição do servidor com notificação', () => {
    const asNotification = classify('{"method":"execCommandApproval","params":{}}');
    expect(asNotification?.kind).toBe('notification');
  });

  it('marca linha inválida sem lançar', () => {
    expect(classify('{isso não é json}')?.kind).toBe('invalid');
    expect(classify('[]')?.kind).toBe('invalid');
    expect(classify('{"sem":"id nem method"}')?.kind).toBe('invalid');
  });

  it('ignora linha vazia', () => {
    expect(classify('')).toBeNull();
    expect(classify('   ')).toBeNull();
  });

  it('trata id nulo como notificação malformada, não como resposta', () => {
    const message = classify('{"id":null,"method":"x"}');
    expect(message?.kind).toBe('notification');
  });
});

describe('codificação', () => {
  it('não inclui o campo jsonrpc e termina com \\n', () => {
    const line = encodeRequest(1, 'initialize', { clientInfo: { name: 'x' } });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.jsonrpc).toBeUndefined();
    expect(parsed.id).toBe(1);
    expect(parsed.method).toBe('initialize');
  });

  it('omite params quando não informado', () => {
    const parsed = JSON.parse(encodeNotification('initialized')) as Record<string, unknown>;
    expect('params' in parsed).toBe(false);
  });

  it('codifica resposta e erro correlacionados ao id', () => {
    expect(JSON.parse(encodeResponse('abc', { decision: 'approved' }))).toEqual({
      id: 'abc',
      result: { decision: 'approved' },
    });
    expect(JSON.parse(encodeErrorResponse(3, -32001, 'recusado'))).toEqual({
      id: 3,
      error: { code: -32001, message: 'recusado' },
    });
  });

  it('faz ida e volta com o classificador', () => {
    const line = encodeResponse(9, { a: 1 });
    expect(classify(line)).toEqual({ kind: 'response', id: 9, result: { a: 1 } });
  });
});
