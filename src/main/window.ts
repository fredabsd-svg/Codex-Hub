/**
 * Criação da janela com as configurações de segurança do Electron.
 *
 * - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
 * - preload restrito, sem `ipcRenderer` exposto;
 * - CSP aplicada por cabeçalho em produção;
 * - navegação e novas janelas bloqueadas; URLs permitidas abrem no navegador
 *   do sistema;
 * - nenhum conteúdo remoto recebe privilégios do Electron.
 */

import { BrowserWindow, shell, session, nativeTheme } from 'electron';
import { join } from 'node:path';
import { logger } from './services/logger';

const PRODUCTION_CSP = [
  "default-src 'self'",
  // Estilos precisam de 'unsafe-inline' por causa do CSS-in-JS de componentes.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Nenhuma conexão do renderer para fora: todo tráfego passa pelo main.
  "connect-src 'self'",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface CreateWindowOptions {
  devServerUrl?: string;
  rendererFile: string;
  preloadFile: string;
  isDev: boolean;
}

export function applySecurityPolicies(options: { isDev: boolean }): void {
  const target = session.defaultSession;

  if (!options.isDev) {
    target.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PRODUCTION_CSP],
          'X-Content-Type-Options': ['nosniff'],
        },
      });
    });
  }

  // Nenhuma permissão de dispositivo é concedida ao renderer.
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    logger.warn('security', 'Permissão de renderer recusada', { permission });
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0f12' : '#f6f7f9',
    autoHideMenuBar: true,
    title: 'Codex Hub',
    webPreferences: {
      preload: options.preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: true,
      devTools: options.isDev,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Bloqueia navegação para fora da própria aplicação.
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = options.devServerUrl ? url.startsWith(options.devServerUrl) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      logger.warn('security', 'Navegação bloqueada', { url });
      void openExternalIfAllowed(url);
    }
  });

  // Bloqueia a criação de janelas; links externos vão para o navegador.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalIfAllowed(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  if (options.devServerUrl) {
    void window.loadURL(options.devServerUrl);
  } else {
    void window.loadFile(options.rendererFile);
  }

  return window;
}

async function openExternalIfAllowed(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      await shell.openExternal(parsed.toString());
    }
  } catch {
    /* URL inválida: nada a abrir */
  }
}

export function resolvePreloadPath(appPath: string, isDev: boolean): string {
  return isDev ? join(appPath, 'out', 'preload', 'index.js') : join(__dirname, '..', 'preload', 'index.js');
}
