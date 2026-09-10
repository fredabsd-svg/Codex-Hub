/**
 * Guarda de IPC.
 *
 * Cada handler registrado passa por:
 *  1. verificação do remetente — apenas a janela principal do próprio app,
 *     no frame principal, com URL de origem esperada;
 *  2. validação do payload por schema em runtime;
 *  3. limite de frequência para operações sensíveis;
 *  4. serialização segura do erro (mensagem em pt-BR, sem segredos).
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { IPC_RATE_LIMITS, IPC_SCHEMAS } from '../../shared/schemas';
import type { IpcInvokeChannel } from '../../shared/ipc';
import { AppError, appError, toErrorDetail } from '../../shared/errors';
import type { ErrorDetail } from '../../shared/domain';
import { logger } from '../services/logger';

export interface SenderPolicy {
  /** WebContents autorizado (janela principal). */
  isAuthorized(contents: WebContents): boolean;
}

interface RateState {
  windowStart: number;
  count: number;
}

const rateStates = new Map<string, RateState>();

export interface IpcFailure {
  ok: false;
  error: ErrorDetail;
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure;

function checkRate(channel: IpcInvokeChannel): void {
  const limit = IPC_RATE_LIMITS[channel];
  if (!limit) return;
  const now = Date.now();
  const state = rateStates.get(channel);
  if (!state || now - state.windowStart > limit.windowMs) {
    rateStates.set(channel, { windowStart: now, count: 1 });
    return;
  }
  state.count += 1;
  if (state.count > limit.max) {
    throw appError('validation', {
      message: 'Muitas requisições em pouco tempo para esta operação.',
      action: 'Aguarde alguns segundos e tente novamente.',
      technical: `limite ${limit.max}/${limit.windowMs}ms no canal ${channel}`,
    });
  }
}

export function resetRateLimits(): void {
  rateStates.clear();
}

export type Handler = (input: unknown, event: IpcMainInvokeEvent) => Promise<unknown> | unknown;

export function registerHandler<C extends IpcInvokeChannel>(
  channel: C,
  policy: SenderPolicy,
  handler: Handler,
): void {
  const schema = IPC_SCHEMAS[channel];
  if (!schema) {
    throw new Error(`Canal de IPC sem schema declarado: ${channel}`);
  }
  ipcMain.handle(channel, async (event, rawInput): Promise<IpcResult<unknown>> => {
    try {
      if (!policy.isAuthorized(event.sender)) {
        logger.error('ipc', 'Chamada recusada: remetente não autorizado', { channel });
        throw appError('forbidden', {
          message: 'A origem desta chamada não é autorizada.',
          action: 'Reinicie o aplicativo. Se o problema persistir, exporte o diagnóstico.',
        });
      }
      // Somente o frame principal pode chamar o IPC.
      if (event.senderFrame && event.senderFrame.parent !== null) {
        throw appError('forbidden', { message: 'Chamadas de IPC a partir de subframes não são permitidas.' });
      }
      checkRate(channel);
      const parsed = schema.safeParse(rawInput);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
          .join('; ');
        throw appError('validation', {
          message: `Dados inválidos para "${channel}".`,
          action: 'Reveja os campos e tente novamente.',
          technical: issues,
        });
      }
      const data = await handler(parsed.data, event);
      return { ok: true, data };
    } catch (err) {
      const detail = err instanceof AppError ? err.detail : toErrorDetail(err);
      if (detail.code === 'internal' || detail.code === 'persistence') {
        logger.error('ipc', `Falha em ${channel}`, err);
      } else {
        logger.debug('ipc', `Erro tratado em ${channel}`, { code: detail.code });
      }
      return { ok: false, error: detail };
    }
  });
}
