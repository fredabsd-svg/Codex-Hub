import { describe, expect, it, vi } from 'vitest';
import { SseParser, Utf8LineDecoder } from '../../src/main/util/streams';

const encoder = new TextEncoder();

describe('Utf8LineDecoder', () => {
  it('junta linhas fragmentadas em vários chunks', () => {
    const decoder = new Utf8LineDecoder();
    expect(decoder.push('{"a":')).toEqual([]);
    expect(decoder.push('1}')).toEqual([]);
    expect(decoder.push('\n')).toEqual(['{"a":1}']);
  });

  it('entrega várias linhas presentes no mesmo chunk', () => {
    const decoder = new Utf8LineDecoder();
    expect(decoder.push('um\ndois\ntres\n')).toEqual(['um', 'dois', 'tres']);
  });

  it('aceita LF e CRLF misturados', () => {
    const decoder = new Utf8LineDecoder();
    expect(decoder.push('um\r\ndois\ntres\r\n')).toEqual(['um', 'dois', 'tres']);
  });

  it('reconstrói caractere UTF-8 dividido entre dois chunks', () => {
    const decoder = new Utf8LineDecoder();
    const bytes = encoder.encode('ação — ok\n');
    // Divide no meio do "ç" (2 bytes) para forçar o caso.
    const first = bytes.subarray(0, 2);
    const rest = bytes.subarray(2);
    expect(decoder.push(first)).toEqual([]);
    expect(decoder.push(rest)).toEqual(['ação — ok']);
  });

  it('reconstrói emoji (4 bytes) dividido byte a byte', () => {
    const decoder = new Utf8LineDecoder();
    const bytes = encoder.encode('🚀 pronto\n');
    let lines: string[] = [];
    for (const byte of bytes) {
      lines = lines.concat(decoder.push(Uint8Array.of(byte)));
    }
    expect(lines).toEqual(['🚀 pronto']);
  });

  it('devolve o resto sem quebra de linha no flush', () => {
    const decoder = new Utf8LineDecoder();
    expect(decoder.push('parcial')).toEqual([]);
    expect(decoder.flush()).toEqual(['parcial']);
  });

  it('descarta linha que excede o limite e volta a sincronizar', () => {
    const onOverflow = vi.fn();
    const decoder = new Utf8LineDecoder({ maxLineLength: 16, onOverflow });
    expect(decoder.push('x'.repeat(64))).toEqual([]);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    // A linha corrompida é descartada; a próxima é entregue normalmente.
    expect(decoder.push('resto-da-linha-gigante\nboa\n')).toEqual(['boa']);
  });

  it('ignora linhas vazias como linhas legítimas (JSONL não usa vazio)', () => {
    const decoder = new Utf8LineDecoder();
    expect(decoder.push('\n\na\n')).toEqual(['', '', 'a']);
  });
});

describe('SseParser', () => {
  it('entrega eventos separados por linha em branco', () => {
    const parser = new SseParser();
    const events = parser.push('data: {"a":1}\n\ndata: {"a":2}\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe('{"a":1}');
    expect(events[1]?.data).toBe('{"a":2}');
  });

  it('trata comentários de keep-alive sem confundir com dados', () => {
    const parser = new SseParser();
    const events = parser.push(': OPENROUTER PROCESSING\n\ndata: ok\n\n');
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe('');
    expect(events[0]?.comments).toEqual(['OPENROUTER PROCESSING']);
    expect(events[1]?.data).toBe('ok');
  });

  it('une múltiplas linhas data do mesmo evento com \\n', () => {
    const parser = new SseParser();
    const events = parser.push('data: linha1\ndata: linha2\n\n');
    expect(events[0]?.data).toBe('linha1\nlinha2');
  });

  it('lê campos event e id', () => {
    const parser = new SseParser();
    const events = parser.push('event: delta\nid: 42\ndata: x\n\n');
    expect(events[0]?.event).toBe('delta');
    expect(events[0]?.id).toBe('42');
  });

  it('reconhece [DONE] como dado do evento', () => {
    const parser = new SseParser();
    const events = parser.push('data: [DONE]\n\n');
    expect(events[0]?.data).toBe('[DONE]');
  });

  it('funciona com fragmentação arbitrária', () => {
    const parser = new SseParser();
    const payload = 'data: {"choices":[{"delta":{"content":"olá"}}]}\n\n';
    let events: ReturnType<SseParser['push']> = [];
    for (const char of payload) {
      events = events.concat(parser.push(char));
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toContain('olá');
  });

  it('entrega o último evento no flush quando falta a linha em branco final', () => {
    const parser = new SseParser();
    expect(parser.push('data: fim')).toEqual([]);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.data).toBe('fim');
  });

  it('ignora campos desconhecidos', () => {
    const parser = new SseParser();
    const events = parser.push('foo: bar\ndata: x\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('x');
  });
});
