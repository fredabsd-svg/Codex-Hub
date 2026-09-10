import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const r = (...p: string[]) => resolve(__dirname, ...p);

export default defineConfig({
  // Necessário para o JSX dos testes de interface.
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('src/shared'),
      '@main': r('src/main'),
      '@generated': r('src/generated'),
      '@renderer': r('src/renderer/src'),
    },
  },
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/renderer/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'tests/live/**', 'node_modules/**'],
    setupFiles: ['tests/setup/vitest.setup.ts'],
    // O ambiente padrão é node; os testes de interface declaram jsdom no topo
    // do arquivo com `// @vitest-environment jsdom`.
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts', 'src/renderer/src/**/*.ts'],
    },
  },
});
