/**
 * Conversa de ponta a ponta contra um endpoint compatível LOCAL E FALSO.
 *
 * O servidor abaixo é do próprio teste: implementa `GET /models` e
 * `POST /chat/completions` com SSE. Nenhuma credencial real é usada e nenhuma
 * requisição sai da máquina — é o "transporte mockado" exigido para rodar sem
 * conta. Testes com credencial real ficam em `tests/live/`.
 *
 * O objetivo é evidência visual do caminho que mais importa: escolher provedor
 * e modelo, enviar, ver o streaming chegando e a conversa concluída.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

const SCREENSHOT_DIR = join(process.cwd(), 'test-results', 'capturas');
const MODEL_ID = 'fake/redator-1';
const CHUNKS = [
  'Recebi a tarefa. ',
  'Vou responder em partes para exercitar o streaming: ',
  'primeira parte, ',
  'segunda parte ',
  'e conclusão.',
];

let app: ElectronApplication;
let page: Page;
let server: Server;
let baseUrl: string;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test.beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: MODEL_ID,
              object: 'model',
              owned_by: 'testes',
              context_length: 32_000,
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      // Consome o corpo antes de responder: o parser precisa do fluxo completo.
      req.resume();
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Comentário SSE: o parser precisa ignorar sem quebrar.
      res.write(': aquecendo\n\n');
      let index = 0;
      const timer = setInterval(() => {
        const chunk = CHUNKS[index];
        index += 1;
        if (chunk === undefined) {
          clearInterval(timer);
          res.write(
            sse({
              id: 'chatcmpl-teste',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
            }),
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write(sse({ id: 'chatcmpl-teste', choices: [{ index: 0, delta: { content: chunk } }] }));
      }, 120);
      // `res` e não `req`: o 'close' de `req` dispara assim que o CORPO da
      // requisição termina, o que mataria o stream antes de começar.
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rota não implementada neste servidor de teste' } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const userData = mkdtempSync(join(tmpdir(), 'codex-hub-conv-'));
  app = await electron.launch({
    args: ['out/main/main.js', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CODEX_HUB_LOG_STDOUT: 'false',
      CODEX_HUB_CODEX_PATH: join(userData, 'codex-inexistente'),
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 900 });
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('cadastra o endpoint compatível pelo onboarding', async () => {
  const dialog = page.getByRole('dialog', { name: /Escolha por onde começar/i });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: /^Endpoint compatível/ }).click();
  await dialog.getByLabel(/URL base/i).fill(baseUrl);
  await dialog.getByLabel(/Nome de exibição/i).fill('Endpoint de teste');
  await dialog.getByRole('button', { name: /^Continuar$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
});

test('escolhe o modelo descoberto no endpoint', async () => {
  await page.getByRole('button', { name: /Nova conversa/i }).click();

  // O seletor de modelo fica no cabeçalho da conversa.
  const trigger = page.getByRole('button', { name: /^Modelo: / }).first();
  await expect(trigger).toBeEnabled({ timeout: 15_000 });
  await trigger.click();

  const picker = page.getByRole('dialog', { name: /^Modelo$/ });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: /Endpoint de teste/ }).first().click();

  const row = picker.locator('[role="option"]', { hasText: MODEL_ID }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(picker).toBeHidden();

  // O cabeçalho passa a mostrar o modelo escolhido.
  await expect(page.locator('header')).toContainText(MODEL_ID);
});

test('envia uma mensagem e vê o streaming até a conclusão', async () => {
  const composer = page.getByRole('textbox', { name: /Descreva a tarefa/i }).first();
  await composer.click();
  await composer.fill('Escreva uma resposta em partes.');
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'composer-preenchido.png') });

  await page.keyboard.press('Control+Enter');

  // Enquanto chega texto parcial, capturamos o estado de streaming.
  const assistantText = page.getByText(/Vou responder em partes/i).first();
  await expect(assistantText).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'streaming.png') });

  // E a conclusão precisa conter todo o texto emitido pelo servidor.
  await expect(page.getByText(/e conclusão\./i).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Interrompendo…/)).toHaveCount(0);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'conversa-concluida.png') });
});

test('a conversa persiste e é reaberta pela barra lateral após recarregar', async () => {
  const nav = page.getByRole('navigation', { name: /Navegação principal/i });
  await expect(nav).toContainText(/Escreva uma resposta/);

  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  // Depois de recarregar, o histórico é lido do disco, não da memória.
  const entry = nav.getByRole('button', { name: /Escreva uma resposta/ }).first();
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(page.getByText(/e conclusão\./i).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'conversa-apos-recarga.png') });
});
