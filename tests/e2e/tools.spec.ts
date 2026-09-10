/**
 * Ciclo completo de ferramentas com endpoint compatível LOCAL E FALSO.
 *
 * Cobre, com evidência visual: anexo, modo Executar, chamada de ferramenta,
 * fila de aprovação, aplicação da alteração e diff. Nada sai da máquina e
 * nenhuma credencial real é usada.
 *
 * O servidor de teste responde em dois passos:
 *   1. uma chamada de `apply_file_changes` (streaming de argumentos em pedaços);
 *   2. depois do resultado da ferramenta, um texto final.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { testElectronArgs } from './launch';

const SCREENSHOT_DIR = join(process.cwd(), 'test-results', 'capturas');
const MODEL_ID = 'fake/ferramenteiro-1';

let app: ElectronApplication;
let page: Page;
let server: Server;
let baseUrl: string;
let workspaceDir: string;
let anexoPath: string;
let chatCalls = 0;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Argumentos da ferramenta, emitidos em pedaços como um provedor real faz. */
function toolArgumentChunks(): string[] {
  const args = JSON.stringify({
    summary: 'Adiciona uma linha ao arquivo de exemplo.',
    changes: [
      {
        operation: 'replace',
        path: 'exemplo.txt',
        find: 'linha original',
        replace: 'linha alterada pela ferramenta',
      },
    ],
  });
  const size = Math.ceil(args.length / 4);
  const out: string[] = [];
  for (let i = 0; i < args.length; i += size) out.push(args.slice(i, i + size));
  return out;
}

test.beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  workspaceDir = mkdtempSync(join(tmpdir(), 'codex-hub-ws-'));
  writeFileSync(join(workspaceDir, 'exemplo.txt'), 'linha original\noutra linha\n', 'utf8');
  anexoPath = join(workspaceDir, 'notas.txt');
  writeFileSync(anexoPath, 'conteúdo de apoio para o anexo\n', 'utf8');

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [{ id: MODEL_ID, object: 'model', owned_by: 'testes', context_length: 32_000 }],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      req.resume();
      chatCalls += 1;
      const step = chatCalls;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

      if (step === 1) {
        // Passo 1: chamada de ferramenta com argumentos fragmentados.
        res.write(
          sse({
            id: 'chatcmpl-tool',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'apply_file_changes', arguments: '' },
                    },
                  ],
                },
              },
            ],
          }),
        );
        const chunks = toolArgumentChunks();
        let i = 0;
        const timer = setInterval(() => {
          const chunk = chunks[i];
          i += 1;
          if (chunk === undefined) {
            clearInterval(timer);
            res.write(
              sse({ id: 'chatcmpl-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
            );
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(
            sse({
              id: 'chatcmpl-tool',
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: chunk } }] } }],
            }),
          );
        }, 60);
        res.on('close', () => clearInterval(timer));
        return;
      }

      // Passo 2 em diante: resposta final em texto.
      res.write(
        sse({
          id: 'chatcmpl-final',
          choices: [{ index: 0, delta: { content: 'Alteração aplicada com sucesso.' } }],
        }),
      );
      res.write(sse({ id: 'chatcmpl-final', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rota não implementada' } }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const userData = mkdtempSync(join(tmpdir(), 'codex-hub-tools-'));
  app = await electron.launch({
    args: [...testElectronArgs, 'out/main/main.js', `--user-data-dir=${userData}`],
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

  // Substitui o seletor nativo de arquivos: o teste escolhe os caminhos.
  await app.evaluate(
    async ({ dialog }, paths) => {
      const stub = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: false,
        filePaths: [paths.next ?? ''],
      });
      (dialog as unknown as { showOpenDialog: typeof stub }).showOpenDialog = stub;
    },
    { next: workspaceDir },
  );
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Aponta o seletor de arquivos falso para outro caminho. */
async function nextDialogPath(target: string): Promise<void> {
  await app.evaluate(async ({ dialog }, path) => {
    const stub = async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
      canceled: false,
      filePaths: [path],
    });
    (dialog as unknown as { showOpenDialog: typeof stub }).showOpenDialog = stub;
  }, target);
}

test('prepara provedor, workspace e modo Executar', async () => {
  const onboarding = page.getByRole('dialog', { name: /Escolha por onde começar/i });
  await expect(onboarding).toBeVisible({ timeout: 30_000 });
  await onboarding.getByRole('button', { name: /^Endpoint compatível/ }).click();
  await onboarding.getByLabel(/URL base/i).fill(baseUrl);
  await onboarding.getByLabel(/Nome de exibição/i).fill('Endpoint de teste');
  await onboarding.getByRole('button', { name: /^Continuar$/ }).click();
  await expect(onboarding).toBeHidden({ timeout: 30_000 });

  await page.getByRole('button', { name: /Nova conversa/i }).click();
  await page
    .getByRole('button', { name: /^Modelo: / })
    .first()
    .click();
  const picker = page.getByRole('dialog', { name: /^Modelo$/ });
  await picker
    .getByRole('button', { name: /Endpoint de teste/ })
    .first()
    .click();
  await picker.locator('[role="option"]', { hasText: MODEL_ID }).first().click();
  await expect(picker).toBeHidden();

  // Workspace pelo seletor (substituído acima).
  await nextDialogPath(workspaceDir);
  await page.getByRole('button', { name: /Escolher workspace/i }).click();
  // A barra de status passa a mostrar o caminho real do workspace.
  await expect(page.locator('footer').first()).toContainText(workspaceDir, { timeout: 20_000 });

  // Modo Executar só fica disponível com workspace: é a regra do backend.
  const executar = page.getByRole('radio', { name: /Executar/ }).first();
  await executar.click();
  await expect(executar).toHaveAttribute('aria-checked', 'true');
});

test('anexa um arquivo e mostra o anexo no composer', async () => {
  await nextDialogPath(anexoPath);
  await page.keyboard.press('Control+Shift+O');
  await expect(page.getByText(/notas\.txt/).first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'anexos.png') });
});

test('a ferramenta pede aprovação antes de tocar no disco', async () => {
  const composer = page.getByRole('textbox', { name: /Descreva a tarefa/i }).first();
  await composer.click();
  await composer.fill('Altere a linha do arquivo de exemplo.');
  await page.keyboard.press('Control+Enter');

  // Aprovação aparece com o que será feito e onde.
  await expect(page.getByText(/Aplicar alteração de arquivo|apply_file_changes/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Permitir uma vez/).first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'aprovacao.png') });

  // Nada foi gravado ainda: o arquivo continua como estava.
  expect(readFileSync(join(workspaceDir, 'exemplo.txt'), 'utf8')).toContain('linha original');
});

test('ao aprovar, a alteração é aplicada e o diff aparece', async () => {
  await page
    .getByRole('button', { name: /Permitir uma vez/ })
    .first()
    .click();

  await expect(page.getByText(/Alteração aplicada com sucesso/).first()).toBeVisible({ timeout: 30_000 });
  expect(readFileSync(join(workspaceDir, 'exemplo.txt'), 'utf8')).toContain('linha alterada pela ferramenta');

  // O diff da alteração fica disponível no painel direito, com as duas linhas.
  await expect(page.getByText(/linha alterada pela ferramenta/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/1 arquivo\(s\)/).first()).toBeVisible();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'diff.png') });
});
