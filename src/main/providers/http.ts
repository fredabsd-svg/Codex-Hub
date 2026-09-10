/**
 * Camada HTTP dos provedores.
 *
 * Decisões de segurança implementadas aqui:
 *  - HTTPS obrigatório para hosts remotos; HTTP só para loopback/`.local`
 *    ou quando a pessoa marcou explicitamente o endpoint como local.
 *  - Redirecionamentos são seguidos MANUALMENTE. Se o destino muda de origem,
 *    a credencial NÃO é reenviada: a requisição é abortada com erro claro.
 *  - Timeout por requisição e por inatividade de stream.
 *  - Nenhum segredo entra em URL, log ou mensagem de erro.
 */

import { appError } from '../../shared/errors';
import { logger } from '../services/logger';

const MAX_REDIRECTS = 3;

export interface EndpointValidation {
  url: URL;
  isLocal: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOCAL_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  // Faixas privadas comuns em ambientes de desenvolvimento.
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export function validateEndpointUrl(raw: string, options: { allowInsecureLocal?: boolean } = {}): EndpointValidation {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw appError('validation', {
      message: 'A URL informada não é válida.',
      action: 'Use o formato https://host/caminho — por exemplo https://openrouter.ai/api/v1.',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw appError('validation', {
      message: `Protocolo não suportado: ${url.protocol.replace(':', '')}.`,
      action: 'Informe um endereço http:// local ou https:// remoto.',
    });
  }
  if (url.username !== '' || url.password !== '') {
    throw appError('validation', {
      message: 'A URL não pode conter usuário ou senha embutidos.',
      action: 'Remova as credenciais da URL e informe a chave no campo próprio.',
    });
  }
  if (url.search !== '' || url.hash !== '') {
    throw appError('validation', {
      message: 'A URL base não pode conter parâmetros de consulta nem fragmento.',
      action: 'Informe apenas o endereço base, por exemplo http://127.0.0.1:11434/v1.',
    });
  }
  const local = isLocalHost(url.hostname);
  if (url.protocol === 'http:' && !local && options.allowInsecureLocal !== true) {
    throw appError('validation', {
      message: 'HTTP em texto claro só é permitido para serviços locais.',
      action: 'Use https:// para serviços remotos ou aponte para um endereço local.',
    });
  }
  return { url, isLocal: local };
}

export interface HttpRequestOptions {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  /** Credencial enviada em `Authorization: Bearer …`. Nunca sai desta camada. */
  bearer?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Marca o endpoint como local, permitindo http:// */
  allowInsecureLocal?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  url: string;
  body: Response['body'];
  text(): Promise<string>;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/** Executa a requisição seguindo redirects manualmente. */
export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  let current = validateEndpointUrlLoose(options.url, options.allowInsecureLocal);
  const initialOrigin = current;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const crossOrigin = !sameOrigin(initialOrigin, current);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(options.headers ?? {}),
      };
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      if (options.bearer && !crossOrigin) headers.Authorization = `Bearer ${options.bearer}`;

      const response = await fetch(current.toString(), {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw appError('protocol', {
            message: 'O servidor respondeu com redirecionamento sem destino.',
            technical: `status ${response.status} sem cabeçalho Location`,
          });
        }
        const next = new URL(location, current);
        if (!sameOrigin(initialOrigin, next) && options.bearer) {
          throw appError('forbidden', {
            message: `O servidor redirecionou a requisição para outra origem (${next.host}).`,
            action:
              'A credencial não é encaminhada para outro host. Verifique a URL base configurada para este provedor.',
            retryable: false,
          });
        }
        current = validateEndpointUrlLoose(next.toString(), options.allowInsecureLocal);
        continue;
      }

      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        url: current.toString(),
        body: response.body,
        text: () => response.text(),
      };
    }
    throw appError('protocol', {
      message: 'Número máximo de redirecionamentos excedido.',
      action: 'Revise a URL base configurada para este provedor.',
    });
  } catch (err) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw appError('timeout', { technical: `timeout de ${timeoutMs} ms` });
    }
    if (options.signal?.aborted) throw appError('cancelled');
    if (err && typeof err === 'object' && 'detail' in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('http', 'Falha de rede', { message });
    throw appError('network', { technical: message });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function validateEndpointUrlLoose(raw: string, allowInsecureLocal?: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw appError('validation', { message: `Endereço inválido: ${raw}` });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw appError('validation', { message: `Protocolo não suportado: ${url.protocol}` });
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname) && allowInsecureLocal !== true) {
    throw appError('validation', {
      message: 'HTTP em texto claro só é permitido para serviços locais.',
      action: 'Use https:// para serviços remotos.',
    });
  }
  return url;
}

export async function httpJson<T>(options: HttpRequestOptions): Promise<T> {
  const response = await httpRequest(options);
  const raw = await response.text();
  if (!response.ok) {
    throw httpErrorFrom(response.status, raw);
  }
  if (raw.trim() === '') return undefined as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw appError('protocol', {
      message: 'A resposta do provedor não é um JSON válido.',
      technical: raw.slice(0, 400),
    });
  }
}

/** Traduz status HTTP + corpo em um erro de domínio com mensagem específica. */
export function httpErrorFrom(status: number, rawBody: string): ReturnType<typeof appError> {
  const parsed = safeParse(rawBody);
  const providerMessage = extractMessage(parsed) ?? rawBody.slice(0, 300);
  const technical = `HTTP ${status}: ${providerMessage}`.slice(0, 1000);

  if (status === 401) {
    return appError('unauthorized', { technical });
  }
  if (status === 403) {
    return appError('forbidden', { technical });
  }
  if (status === 402) {
    return appError('insufficientCredit', {
      message: 'O provedor recusou a requisição por crédito insuficiente.',
      technical,
    });
  }
  if (status === 404) {
    return appError('modelUnavailable', {
      message: 'O recurso solicitado não existe neste endpoint.',
      action: 'Confirme o ID do modelo e a URL base do provedor.',
      technical,
    });
  }
  if (status === 408 || status === 504) {
    return appError('timeout', { technical });
  }
  if (status === 413) {
    return appError('contextExceeded', {
      message: 'O provedor recusou a requisição por tamanho excessivo.',
      technical,
    });
  }
  if (status === 429) {
    return appError('rateLimited', { technical });
  }
  if (status === 400 || status === 422) {
    if (/context|token|too many tokens|maximum context/i.test(providerMessage)) {
      return appError('contextExceeded', { technical });
    }
    if (/parameter|unsupported|unrecognized|not supported/i.test(providerMessage)) {
      return appError('unsupportedParameter', {
        message: `O provedor recusou um parâmetro: ${providerMessage.slice(0, 160)}`,
        technical,
      });
    }
    return appError('validation', {
      message: `O provedor recusou a requisição: ${providerMessage.slice(0, 200)}`,
      technical,
    });
  }
  if (status >= 500) {
    return appError('providerUnavailable', { technical });
  }
  return appError('providerUnavailable', { technical });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractMessage(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const error = obj.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.message === 'string') return e.message;
    const metadata = e.metadata;
    if (metadata && typeof metadata === 'object') {
      const m = metadata as Record<string, unknown>;
      if (typeof m.raw === 'string') return m.raw;
    }
  }
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.detail === 'string') return obj.detail;
  return null;
}
