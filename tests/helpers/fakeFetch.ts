/**
 * `fetch` falso para exercitar o transporte HTTP e o SSE sem rede.
 */

import { vi } from 'vitest';

export interface FakeRoute {
  /** Trecho que precisa aparecer na URL. */
  match: string;
  status?: number;
  headers?: Record<string, string>;
  /** Corpo JSON (resposta simples). */
  json?: unknown;
  /** Corpo de texto. */
  text?: string;
  /** Pedaços SSE entregues em sequência. */
  sseChunks?: string[];
  /** Atraso entre pedaços SSE. */
  chunkDelayMs?: number;
  /** Erro de rede. */
  networkError?: Error;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function installFakeFetch(routes: FakeRoute[]): {
  requests: RecordedRequest[];
  restore(): void;
} {
  const requests: RecordedRequest[] = [];
  const encoder = new TextEncoder();

  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method: init?.method ?? 'GET', headers, body });

    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      return new Response(JSON.stringify({ error: { message: `rota não simulada: ${url}` } }), {
        status: 501,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.networkError) throw route.networkError;

    if (route.sseChunks) {
      const signal = init?.signal;
      const chunks = [...route.sseChunks];
      const delay = route.chunkDelayMs ?? 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          const next = chunks.shift();
          if (next === undefined) {
            controller.close();
            return;
          }
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          controller.enqueue(encoder.encode(next));
        },
      });
      return new Response(stream, {
        status: route.status ?? 200,
        headers: { 'content-type': 'text/event-stream', ...(route.headers ?? {}) },
      });
    }

    const payload = route.text ?? (route.json !== undefined ? JSON.stringify(route.json) : '');
    return new Response(payload, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  });

  vi.stubGlobal('fetch', fake);
  return {
    requests,
    restore: () => vi.unstubAllGlobals(),
  };
}

/** Monta um chunk SSE bem formado. */
export function sse(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}
