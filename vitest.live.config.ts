import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const r = (...p: string[]) => resolve(__dirname, ...p);

/**
 * Suíte separada que só roda com credenciais reais.
 * Nada aqui é executado por `npm test`. Ver TESTING.md.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      '@generated': r('src/generated'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/live/**/*.live.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
