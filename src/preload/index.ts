/**
 * Preload — superfície MÍNIMA e tipada.
 *
 * O renderer recebe:
 *   - `invoke` restrito a uma lista fechada de canais;
 *   - dois assinantes de eventos somente-leitura;
 *   - `getPathForFile` para arrastar/soltar (a autorização real é decidida no main).
 *
 * O renderer NÃO recebe `ipcRenderer`, `require`, `fs`, `child_process`
 * nem encaminhamento genérico de métodos do App Server.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_INVOKE_CHANNELS, type IPC_EVENT_CHANNELS, type IpcInvokeChannel } from '../shared/ipc';
import type { AppEvent, DomainEvent } from '../shared/events';

const allowedInvoke = new Set<string>(IPC_INVOKE_CHANNELS);

interface IpcEnvelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; action?: string; technical?: string; retryable?: boolean };
}

/**
 * O processo principal sempre responde com `{ ok, data | error }`.
 * Aqui o envelope é desembrulhado: sucesso devolve `data`, falha rejeita com um
 * `Error` que carrega o detalhe já em pt-BR (sem segredos).
 */
async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  if (!allowedInvoke.has(channel)) {
    throw new Error(`Canal de IPC não permitido: ${String(channel)}`);
  }
  const envelope = (await ipcRenderer.invoke(channel as IpcInvokeChannel, payload)) as IpcEnvelope | undefined;
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Resposta inesperada do processo principal.');
  }
  if (envelope.ok) return envelope.data;
  const detail = envelope.error ?? { code: 'internal', message: 'Falha desconhecida.' };
  const error = new Error(detail.message) as Error & { detail?: unknown };
  error.name = 'CodexHubError';
  error.detail = detail;
  throw error;
}

function subscribe<T>(channel: (typeof IPC_EVENT_CHANNELS)[number], listener: (value: T) => void): () => void {
  const handler = (_e: unknown, value: T): void => {
    try {
      listener(value);
    } catch (err) {
      console.error('[preload] listener falhou', err);
    }
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api = {
  invoke,
  onDomainEvent: (listener: (event: DomainEvent) => void) => subscribe<DomainEvent>('event:domain', listener),
  onAppEvent: (listener: (event: AppEvent) => void) => subscribe<AppEvent>('event:app', listener),
  /**
   * Resolve o caminho de um `File` obtido por arrastar/soltar ou seletor.
   * Devolver o caminho NÃO concede leitura: o processo principal revalida
   * o caminho contra as raízes autorizadas antes de qualquer acesso.
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
};

contextBridge.exposeInMainWorld('codexHub', api);

export type PreloadApi = typeof api;
