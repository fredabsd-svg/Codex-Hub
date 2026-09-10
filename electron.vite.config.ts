import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (...p: string[]) => resolve(__dirname, ...p);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@main': r('src/main'),
        '@generated': r('src/generated'),
      },
    },
    build: {
      outDir: 'out/main',
      sourcemap: true,
      minify: 'esbuild',
      rollupOptions: {
        input: { main: r('src/main/main.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': r('src/shared') },
    },
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      minify: 'esbuild',
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        output: { entryFileNames: '[name].js', format: 'cjs' },
      },
    },
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@renderer': r('src/renderer/src'),
      },
    },
    build: {
      outDir: 'out/renderer',
      sourcemap: true,
      minify: 'esbuild',
      // O chunk do Monaco é grande por natureza e carregado sob demanda.
      chunkSizeWarningLimit: 7000,
      rollupOptions: {
        input: { index: r('src/renderer/index.html') },
        output: {
          manualChunks(id) {
            if (id.includes('monaco-editor')) return 'monaco';
            if (id.includes('node_modules/react')) return 'react';
            return undefined;
          },
        },
      },
    },
    worker: { format: 'es' },
  },
});
