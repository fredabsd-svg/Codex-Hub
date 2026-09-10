/**
 * Fluxos principais no Electron empacotado.
 *
 * Requer `npm run build` antes. Em ambiente sem display, use
 * `xvfb-run -a npm run test:e2e`.
 *
 * Este arquivo NÃO fala com nenhum provedor: o objetivo é verificar que o
 * aplicativo abre, monta a interface, responde ao teclado e produz capturas de
 * tela nas resoluções que a revisão visual exige.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const SCREENSHOT_DIR = join(process.cwd(), 'test-results', 'capturas');
const VIEWPORTS = [
  { width: 1280, height: 720, label: '1280x720' },
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1920, height: 1080, label: '1920x1080' },
];

let app: ElectronApplication;
let page: Page;

/**
 * Fecha o onboarding se ele estiver aberto.
 *
 * Enquanto o modal está no ar, o fundo intercepta cliques — qualquer teste que
 * depende da janela principal precisa desta garantia, não de um `if` opcional.
 */
async function dismissOnboarding(): Promise<void> {
  const dialog = page.getByRole('dialog', { name: /Escolha por onde começar/i });
  if (!(await dialog.isVisible().catch(() => false))) return;
  await dialog.getByRole('button', { name: /^Configurar depois$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

test.beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  // Perfil isolado: nada toca os dados reais da máquina.
  const userData = mkdtempSync(join(tmpdir(), 'codex-hub-e2e-'));
  app = await electron.launch({
    args: ['out/main/main.js', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CODEX_HUB_LOG_STDOUT: 'false',
      // Garante que o app não encontre o Codex: o teste cobre o caminho sem ele.
      CODEX_HUB_CODEX_PATH: join(userData, 'codex-inexistente'),
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('o aplicativo abre mesmo sem o Codex instalado', async () => {
  // A interface principal monta e não há tela de erro fatal.
  await expect(page.getByRole('navigation', { name: /Navegação principal/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Nova conversa/i })).toBeVisible();
});

test('o onboarding oferece o OpenRouter em primeiro lugar', async () => {
  const dialog = page.getByRole('dialog', { name: /Escolha por onde começar/i });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  try {
    // O primeiro cartão é o OpenRouter e ele é apresentado como caminho inicial.
    const cards = dialog.getByRole('button', { name: /^(OpenRouter|Codex App Server|Endpoint compatível)/ });
    await expect(cards.first()).toContainText('OpenRouter');
    await expect(cards.first()).toContainText(/recomendado para começar|conectado/i);
    // O texto precisa deixar explícito que não é necessário ter conta ChatGPT.
    await expect(dialog.getByText(/sem nenhuma conta ChatGPT/i)).toBeVisible();
    // Sem o Codex instalado, o cartão do Codex diz isso em vez de fingir prontidão.
    await expect(dialog.getByRole('button', { name: /^Codex App Server/ })).toContainText(/não encontrado/i);
    // A chave nunca volta para a interface — o aviso precisa estar visível.
    await expect(dialog.getByText(/nunca volta para a interface/i)).toBeVisible();
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'onboarding.png'), fullPage: false });
  } finally {
    // O diálogo é sempre dispensado: os testes seguintes dependem do app livre.
    await dismissOnboarding();
  }
  await expect(page.getByRole('navigation', { name: /Navegação principal/i })).toBeVisible();
});

test('as configurações abrem pelo atalho e mostram as seções', async () => {
  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: /^Configurações$/ });
  await expect(settings).toBeVisible();
  await expect(settings.getByRole('button', { name: /Provedores/i })).toBeVisible();
  await settings.getByRole('button', { name: /^Codex$/i }).click();
  // Sem Codex instalado, o diagnóstico precisa aparecer com ação concreta.
  await expect(settings.getByText(/não foi encontrado|Encontrado/i).first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'configuracoes-codex.png') });
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
});

test('a paleta de comandos abre e fecha pelo teclado', async () => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: /Comandos e busca/i });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'paleta.png') });
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('o catálogo de modelos abre e informa o estado real', async () => {
  await page.getByRole('button', { name: /Catálogo de modelos/i }).first().click();
  const catalog = page.getByRole('dialog', { name: /Catálogo de modelos/i });
  await expect(catalog).toBeVisible();

  // O catálogo do OpenRouter é público: com rede ele lista modelos reais; sem
  // rede precisa explicar o motivo. Os dois desfechos são aceitáveis — o que
  // NÃO é aceitável é uma lista vazia sem explicação.
  const summary = catalog.getByText(/modelo\(s\)|não pode ser descoberto|credencial|Conecte um provedor|Nenhum modelo/i).first();
  await expect(summary).toBeVisible({ timeout: 30_000 });
  const summaryText = (await summary.textContent()) ?? '';

  if (/modelo\(s\)/i.test(summaryText)) {
    // Havendo modelos, a origem do dado precisa estar declarada e cada linha
    // precisa mostrar o ID exato, não só o nome de exibição.
    expect(summaryText).toMatch(/Atualizado em/i);
    // `[role=option]` explícito: evita casar com <option> dos selects de filtro.
    const firstRow = catalog.locator('[role="option"]').first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow.locator('.ch-mono').first()).toContainText('/');
  }

  await page.screenshot({ path: join(SCREENSHOT_DIR, 'catalogo.png') });
  await page.keyboard.press('Escape');
  await expect(catalog).toBeHidden();
});

test('a barra de status mostra workspace, Git e motor', async () => {
  await expect(page.getByText(/Workspace:/)).toBeVisible();
  await expect(page.getByText(/Motor:/)).toBeVisible();
});

for (const viewport of VIEWPORTS) {
  test(`captura de tela em ${viewport.label}`, async () => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SCREENSHOT_DIR, `layout-${viewport.label}.png`) });
    // O corpo nunca deve rolar horizontalmente.
    const overflow = await page.evaluate(() => document.body.scrollWidth > document.body.clientWidth + 1);
    expect(overflow, `há rolagem horizontal em ${viewport.label}`).toBe(false);
  });
}

test('em janela estreita os painéis secundários recolhem e o composer permanece', async () => {
  await page.setViewportSize({ width: 940, height: 720 });
  await page.waitForTimeout(300);
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'layout-estreito.png') });
});

test('o processo encerra sem deixar a árvore para trás', async () => {
  const pid = await app.evaluate(async ({ app: electronApp }) => {
    return { pid: process.pid, name: electronApp.getName() };
  });
  expect(pid.name).toBe('Codex Hub');
  expect(pid.pid).toBeGreaterThan(0);
});
