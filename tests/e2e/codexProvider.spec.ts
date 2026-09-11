/**
 * Configurações › Codex — provedor de modelos do processo do Codex.
 *
 * Verifica no aplicativo real (não em jsdom) que a opção aparece, que o trecho
 * de `config.toml` mostrado traz o NOME da variável de ambiente e não um
 * segredo, e produz a captura usada na revisão visual.
 *
 * Requer `npm run build` antes. Em ambiente sem display, use xvfb-run.
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';

const SCREENSHOT_DIR = join(process.cwd(), 'test-results', 'capturas');

test('a opção de provedor do Codex aparece e mostra o config.toml sem segredo', async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), 'codex-hub-prov-'));
  const app = await electron.launch({
    args: ['out/main/main.js', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CODEX_HUB_LOG_STDOUT: 'false',
      CODEX_HUB_CODEX_PATH: join(userData, 'codex-inexistente'),
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1440, height: 900 });

    const onboarding = page.getByRole('dialog', { name: /Escolha por onde começar/i });
    if (await onboarding.isVisible().catch(() => false)) {
      await onboarding.getByRole('button', { name: /^Configurar depois$/ }).click();
      await expect(onboarding).toBeHidden();
    }

    await page.keyboard.press('Control+Comma');
    const settings = page.getByRole('dialog', { name: /^Configurações$/ });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: /^Codex$/i }).click();

    // O padrão é o provedor do próprio Codex.
    const select = settings.getByLabel(/Provedor usado pelo Codex/i);
    await expect(select).toHaveValue('default');
    await expect(settings.getByText(/\[model_providers\.openrouter\]/)).toHaveCount(0);

    await select.selectOption('openrouter');

    const snippet = settings.getByText(/\[model_providers\.openrouter\]/);
    await snippet.scrollIntoViewIfNeeded();
    await expect(snippet).toBeVisible();

    const text = (await snippet.textContent()) ?? '';
    expect(text).toContain('env_key = "OPENROUTER_API_KEY"');
    expect(text).toContain('base_url = "https://openrouter.ai/api/v1"');
    // Nome da variável, nunca o valor dela.
    expect(text).not.toContain('sk-');

    // Sem credencial conectada, a tela diz o que fazer.
    await expect(settings.getByText(/Conecte o OpenRouter em Configurações › Provedores/i)).toBeVisible();

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'codex-provedor.png') });
  } finally {
    await app.close();
  }
});
