/**
 * Decodificação incremental de streams de bytes em linhas.
 *
 * Resolve, de forma explícita, os problemas que aparecem tanto no JSONL do
 * Codex App Server quanto no SSE de provedores HTTP:
 *
 *  - caracteres UTF-8 divididos entre dois chunks;
 *  - linhas fragmentadas em vários chunks;
 *  - várias linhas no mesmo chunk;
 *  - terminadores LF e CRLF misturados;
 *  - limite de tamanho por linha (proteção contra crescimento sem fim).
 */

export interface LineDecoderOptions {
  /** Tamanho máximo de UMA linha, em code units. Excedido → erro reportado. */
  maxLineLength?: number;
  /** Chamado quando uma linha excede o limite; a linha é descartada. */
  onOverflow?: (droppedBytes: number) => void;
}

export class Utf8LineDecoder {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private overflowing = false;
  private overflowDropped = 0;
  private readonly maxLineLength: number;
  private readonly onOverflow?: (droppedBytes: number) => void;

  constructor(options: LineDecoderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 8 * 1024 * 1024;
    this.onOverflow = options.onOverflow;
  }

  /** Aceita bytes (ou texto já decodificado) e devolve as linhas completas. */
  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (text === '') return [];
    this.buffer += text;
    return this.drain();
  }

  private drain(): string[] {
    const lines: string[] = [];
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) {
        if (this.buffer.length > this.maxLineLength) {
          // Descarta o excesso até encontrar a próxima quebra de linha.
          this.overflowDropped += this.buffer.length;
          this.buffer = '';
          if (!this.overflowing) {
            this.overflowing = true;
            this.onOverflow?.(this.overflowDropped);
          }
        }
        return lines;
      }
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (this.overflowing) {
        // Sincroniza no próximo delimitador e descarta a linha corrompida.
        this.overflowing = false;
        this.overflowDropped = 0;
        continue;
      }
      lines.push(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  /** Encerra o stream, devolvendo o resto (sem quebra de linha final). */
  flush(): string[] {
    const tail = this.decoder.decode();
    if (tail) this.buffer += tail;
    const lines = this.drain();
    if (this.buffer.length > 0 && !this.overflowing) {
      const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      if (rest !== '') lines.push(rest);
    }
    this.buffer = '';
    return lines;
  }

  get pendingLength(): number {
    return this.buffer.length;
  }
}

/* ------------------------------------------------------------------ *
 * SSE
 * ------------------------------------------------------------------ */

export interface SseEvent {
  /** Nome do evento (`event:`); ausente quando não informado. */
  event?: string;
  /** Corpo (`data:`) com as linhas unidas por `\n`. */
  data: string;
  id?: string;
  retry?: number;
  /** Comentários (`:`) recebidos antes deste evento — usados como keep-alive. */
  comments: string[];
}

export class SseParser {
  private readonly lines: Utf8LineDecoder;
  private dataLines: string[] = [];
  private eventName: string | undefined;
  private lastId: string | undefined;
  private retry: number | undefined;
  private comments: string[] = [];
  private sawAnyField = false;

  constructor(options: LineDecoderOptions = {}) {
    this.lines = new Utf8LineDecoder(options);
  }

  push(chunk: Uint8Array | string): SseEvent[] {
    return this.consume(this.lines.push(chunk));
  }

  flush(): SseEvent[] {
    const events = this.consume(this.lines.flush());
    // Um evento sem linha em branco final ainda deve ser entregue no fim do stream.
    const tail = this.emit();
    if (tail) events.push(tail);
    return events;
  }

  private consume(rawLines: string[]): SseEvent[] {
    const out: SseEvent[] = [];
    for (const line of rawLines) {
      if (line === '') {
        const event = this.emit();
        if (event) out.push(event);
        continue;
      }
      if (line.startsWith(':')) {
        this.comments.push(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      switch (field) {
        case 'data':
          this.dataLines.push(value);
          this.sawAnyField = true;
          break;
        case 'event':
          this.eventName = value;
          this.sawAnyField = true;
          break;
        case 'id':
          if (!value.includes('\0')) this.lastId = value;
          this.sawAnyField = true;
          break;
        case 'retry': {
          const parsed = Number.parseInt(value, 10);
          if (Number.isFinite(parsed)) this.retry = parsed;
          this.sawAnyField = true;
          break;
        }
        default:
          // Campo desconhecido: ignorado, conforme a especificação.
          break;
      }
    }
    return out;
  }

  private emit(): SseEvent | null {
    if (!this.sawAnyField) {
      if (this.comments.length > 0) {
        // Keep-alive puro: entrega os comentários com data vazio para que o
        // chamador possa reiniciar temporizadores de inatividade.
        const event: SseEvent = { data: '', comments: this.comments };
        this.comments = [];
        return event;
      }
      return null;
    }
    const event: SseEvent = {
      event: this.eventName,
      data: this.dataLines.join('\n'),
      id: this.lastId,
      retry: this.retry,
      comments: this.comments,
    };
    this.dataLines = [];
    this.eventName = undefined;
    this.retry = undefined;
    this.comments = [];
    this.sawAnyField = false;
    return event;
  }
}
