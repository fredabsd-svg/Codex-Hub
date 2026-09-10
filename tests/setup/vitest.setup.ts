/**
 * Setup comum dos testes.
 *
 * Nenhum teste desta suíte fala com a rede ou com um provedor real: o
 * transporte é sempre mockado. Testes com credenciais reais ficam em
 * `tests/live` e só rodam por `npm run test:live`.
 */

import { afterEach, beforeEach, vi } from 'vitest';

// Silencia o log do processo principal por padrão; testes que precisam
// verificar log configuram o logger explicitamente.
process.env.CODEX_HUB_LOG_STDOUT = 'false';

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// `@testing-library/jest-dom` só é útil no ambiente jsdom.
if (typeof document !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
}
