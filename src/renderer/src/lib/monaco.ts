/**
 * Configuração do Monaco Editor.
 *
 * Carregamento SOB DEMANDA: este módulo só é importado quando o painel de
 * arquivos abre um arquivo. O bundle fica em um chunk separado
 * (ver `manualChunks` em electron.vite.config.ts).
 *
 * Montagem enxuta e deliberada:
 *  - `editor/editor.api` em vez de `editor.main`, para não arrastar as ~80
 *    linguagens nem os serviços de linguagem (TS/JSON/CSS/HTML), que trariam
 *    quatro workers pesados sem utilidade em um visualizador somente leitura;
 *  - contribuições escolhidas: busca, dobra, casamento de parênteses, links,
 *    realce de ocorrências e rolagem fixa;
 *  - registros de linguagem apenas para realce (Monarch), sem worker;
 *  - um único worker (`editor.worker`), resolvido localmente por `?worker` —
 *    nada é buscado de CDN, o que é obrigatório sob a CSP do aplicativo.
 */

import * as monaco from 'monaco-editor/editor/editor.api';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// Contribuições úteis para leitura de código.
import 'monaco-editor/editor/contrib/find/browser/findController';
import 'monaco-editor/editor/contrib/folding/browser/folding';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching';
import 'monaco-editor/editor/contrib/links/browser/links';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect';

// Realce de sintaxe (apenas tokenizadores Monarch, sem serviço de linguagem).
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/css/register';
import 'monaco-editor/languages/definitions/scss/register';
import 'monaco-editor/languages/definitions/less/register';
import 'monaco-editor/languages/definitions/html/register';
import 'monaco-editor/languages/definitions/markdown/register';
import 'monaco-editor/languages/definitions/python/register';
import 'monaco-editor/languages/definitions/ruby/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/rust/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/kotlin/register';
import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/shell/register';
import 'monaco-editor/languages/definitions/powershell/register';
import 'monaco-editor/languages/definitions/yaml/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/languages/definitions/xml/register';
import 'monaco-editor/languages/definitions/dockerfile/register';
import 'monaco-editor/languages/definitions/swift/register';

let configured = false;

export function configureMonaco(theme: 'dark' | 'light'): typeof monaco {
  if (!configured) {
    configured = true;

    self.MonacoEnvironment = {
      // Um único worker: nenhum serviço de linguagem é ativado.
      getWorker: (): Worker => new EditorWorker(),
    };

    registerJsonHighlighting();

    monaco.editor.defineTheme('codex-hub-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#0a0c0e',
        'editor.foreground': '#e7ebef',
        'editorLineNumber.foreground': '#6c7783',
        'editorLineNumber.activeForeground': '#9aa5b1',
        'editor.selectionBackground': '#1f4a52',
        'editorCursor.foreground': '#2fb2c2',
        'editorGutter.background': '#0a0c0e',
        'editorWidget.background': '#1b1f24',
        'editorWidget.border': '#38414a',
        'editorBracketMatch.background': '#1f4a52',
        'editorBracketMatch.border': '#2fb2c2',
      },
    });

    monaco.editor.defineTheme('codex-hub-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#fafbfc',
        'editor.foreground': '#171b1f',
        'editorLineNumber.foreground': '#838d97',
        'editorGutter.background': '#fafbfc',
      },
    });
  }

  monaco.editor.setTheme(theme === 'light' ? 'codex-hub-light' : 'codex-hub-dark');
  return monaco;
}

/**
 * O monaco 0.56 não traz um tokenizador Monarch para JSON (o realce viria do
 * serviço de linguagem, que não carregamos). Como JSON é comum em projetos,
 * registramos aqui uma gramática mínima e própria — suficiente para leitura.
 */
function registerJsonHighlighting(): void {
  if (monaco.languages.getLanguages().some((language) => language.id === 'json')) return;
  monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc'], aliases: ['JSON', 'json'] });
  monaco.languages.setLanguageConfiguration('json', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider('json', {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"\s*(?=:)/, 'type.identifier'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[,:]/, 'delimiter'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });
}

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  c: 'cpp',
  h: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  php: 'php',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  xml: 'xml',
  svg: 'xml',
  swift: 'swift',
  dockerfile: 'dockerfile',
};

export function languageForPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  if (/^dockerfile/i.test(base)) return 'dockerfile';
  const extension = base.includes('.') ? (base.split('.').pop() ?? '').toLowerCase() : '';
  return EXTENSION_LANGUAGE[extension] ?? 'plaintext';
}
