/**
 * Verificação do aplicativo EMPACOTADO (ASAR), e não da árvore `out/`.
 *
 * O que importa aqui é o que muda ao empacotar: caminho do preload, dos
 * assets do renderer, do worker do editor e do diretório de dados do usuário
 * — que precisa ficar FORA do diretório de instalação e fora do ASAR.
 *
 * Requer `npm run dist:dir` antes. Sem o pacote, o teste é IGNORADO
 * explicitamente (nunca considerado aprovado).
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import { testElectronArgs } from './launch';

const { version } = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string;
};
const platformPath =
  process.platform === 'win32' ? ['win-unpacked', 'Codex Hub.exe'] : ['linux-unpacked', 'codex-hub'];
const PACKAGED =
  process.env.CODEX_HUB_PACKAGED_EXECUTABLE ?? join(process.cwd(), 'release', version, ...platformPath);
const available = existsSync(PACKAGED);

test.skip(!available, `Pacote não encontrado em ${PACKAGED}. Rode "npm run dist:dir" antes.`);

test('o aplicativo empacotado abre, monta a interface e grava fora do ASAR', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'codex-hub-pkg-'));
  const app = await electron.launch({
    executablePath: PACKAGED,
    args: [...testElectronArgs, `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      CODEX_HUB_LOG_STDOUT: 'false',
      CODEX_HUB_CODEX_PATH: join(userData, 'codex-inexistente'),
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // A interface monta: preload e assets do renderer foram resolvidos no ASAR.
    await expect(page.getByRole('navigation', { name: /Navegação principal/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('button', { name: /Nova conversa/i })).toBeVisible();

    // Dados do usuário: fora do diretório de instalação e fora do ASAR.
    const paths = await app.evaluate(async ({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      logs: electronApp.getPath('logs'),
      appPath: electronApp.getAppPath(),
    }));
    expect(paths.appPath).toContain('app.asar');
    expect(paths.userData).not.toContain('app.asar');
    expect(paths.userData).not.toContain('linux-unpacked');
    expect(paths.userData).not.toContain('win-unpacked');
    expect(paths.logs).not.toContain('app.asar');

    // A ponte segura existe e o renderer não recebe `require` nem `ipcRenderer`.
    const bridge = await page.evaluate(() => ({
      hasApi: typeof (window as unknown as { codexHub?: unknown }).codexHub === 'object',
      hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
      hasIpc: typeof (window as unknown as { ipcRenderer?: unknown }).ipcRenderer !== 'undefined',
    }));
    expect(bridge).toEqual({ hasApi: true, hasRequire: false, hasIpc: false });
  } finally {
    await app.close();
  }
});
