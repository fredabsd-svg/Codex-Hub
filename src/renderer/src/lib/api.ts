/**
 * Cliente tipado sobre a API exposta pelo preload.
 *
 * O renderer NÃO tem acesso a `ipcRenderer`, `fs` ou `child_process`.
 * Todo erro chega com `detail` já em pt-BR e sem segredos.
 */

import type { ErrorDetail } from '@shared/domain';
import type { AppEvent, DomainEvent } from '@shared/events';
import type { IpcInput, IpcInvokeChannel, IpcOutput } from '@shared/ipc';

export interface ApiError extends Error {
  detail: ErrorDetail;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && 'detail' in err && typeof (err as ApiError).detail?.code === 'string';
}

export function errorOf(err: unknown): ErrorDetail {
  if (isApiError(err)) return err.detail;
  return {
    code: 'internal',
    message: err instanceof Error ? err.message : 'Falha inesperada na interface.',
    action: 'Se o problema persistir, exporte o diagnóstico em Configurações › Diagnóstico.',
    retryable: false,
  };
}

function bridge(): Window['codexHub'] {
  const api = window.codexHub;
  if (!api) {
    throw new Error('A ponte segura do aplicativo não está disponível nesta janela.');
  }
  return api;
}

export async function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcInput<C> extends void ? [] : [IpcInput<C>]
): Promise<IpcOutput<C>> {
  return bridge().invoke(channel, ...args);
}

const noopUnsubscribe = (): void => undefined;

export function onDomainEvent(listener: (event: DomainEvent) => void): () => void {
  // Sem ponte não há eventos: devolvemos um cancelamento vazio em vez de lançar,
  // para que a interface consiga mostrar o aviso de ponte indisponível.
  if (!isBridgeAvailable()) return noopUnsubscribe;
  return bridge().onDomainEvent(listener);
}

export function onAppEvent(listener: (event: AppEvent) => void): () => void {
  if (!isBridgeAvailable()) return noopUnsubscribe;
  return bridge().onAppEvent(listener);
}

/** Caminho real de um `File` arrastado. A autorização é decidida no main. */
export function pathForFile(file: File): string {
  return bridge().getPathForFile(file);
}

export function isBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.codexHub?.invoke === 'function';
}
