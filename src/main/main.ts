/**
 * Ponto de entrada do processo principal.
 *
 * Nada aqui derruba o aplicativo por falta de Codex CLI, git, rede, chave ou
 * saldo: cada indisponibilidade é reportada com motivo e ação.
 */

import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { createAppContext, type AppContext } from './context';
import { registerIpc } from './ipc/register';
import { logger } from './services/logger';
import { applySecurityPolicies, createMainWindow } from './window';

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let context: AppContext | null = null;
let shuttingDown = false;

// Uma única instância: evita dois processos disputando o banco local.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  app.setName('Codex Hub');
  if (process.platform === 'win32') app.setAppUserModelId('com.codexhub.app');

  process.on('uncaughtException', (err) => {
    logger.error('process', 'Exceção não tratada no processo principal', err);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('process', 'Promise rejeitada sem tratamento', reason);
  });

  await app.whenReady();
  applySecurityPolicies({ isDev });
  Menu.setApplicationMenu(null);

  try {
    context = createAppContext();
  } catch (err) {
    logger.error('boot', 'Falha ao montar o contexto da aplicação', err);
    // Sem contexto não há aplicativo útil; ainda assim, sai de forma limpa.
    app.quit();
    return;
  }

  registerIpc({
    context,
    getMainWindow: () => mainWindow,
    appName: 'Codex Hub',
    appVersion: app.getVersion(),
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  mainWindow = createMainWindow({
    devServerUrl: isDev ? devServerUrl : undefined,
    rendererFile: join(__dirname, '..', 'renderer', 'index.html'),
    preloadFile: join(__dirname, '..', 'preload', 'index.js'),
    isDev,
  });

  context.bus.setSender((channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    context?.bus.setSender(null);
  });

  // Localiza o Codex em segundo plano: a interface abre mesmo sem ele.
  void context.codexRuntime.locate().catch((err) => {
    logger.debug('boot', 'Localização inicial do Codex falhou', err);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && context) {
      mainWindow = createMainWindow({
        devServerUrl: isDev ? devServerUrl : undefined,
        rendererFile: join(__dirname, '..', 'renderer', 'index.html'),
        preloadFile: join(__dirname, '..', 'preload', 'index.js'),
        isDev,
      });
      context.bus.setSender((channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      });
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown || !context) return;
  shuttingDown = true;
  event.preventDefault();
  void context
    .dispose()
    .catch((err) => logger.error('shutdown', 'Falha ao encerrar recursos', err))
    .finally(() => {
      context = null;
      app.quit();
    });
});

// Nunca conceder privilégios a conteúdo remoto.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
