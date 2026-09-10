/**
 * Visualizador de arquivo com Monaco, carregado sob demanda.
 *
 * Somente leitura: o painel de arquivos é para inspeção. Alterações passam pelo
 * fluxo de ferramentas com aprovação.
 */

import { useEffect, useRef, useState } from 'react';
import type * as MonacoNS from 'monaco-editor';
import { Spinner } from '../../components/ui/primitives';

export function MonacoViewer({
  value,
  path,
  theme,
}: {
  value: string;
  path: string;
  theme: 'dark' | 'light';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoNS.editor.IStandaloneCodeEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let editor: MonacoNS.editor.IStandaloneCodeEditor | null = null;

    void (async () => {
      try {
        const { configureMonaco, languageForPath } = await import('../../lib/monaco');
        if (disposed || !containerRef.current) return;
        const monaco = configureMonaco(theme);
        editor = monaco.editor.create(containerRef.current, {
          value,
          language: languageForPath(path),
          readOnly: true,
          domReadOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12.5,
          lineHeight: 20,
          fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
          renderLineHighlight: 'none',
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
          padding: { top: 8, bottom: 8 },
        });
        editorRef.current = editor;
        setLoading(false);
      } catch (err) {
        if (!disposed) {
          setError(
            `O editor de código não pôde ser carregado (${err instanceof Error ? err.message : String(err)}). O conteúdo é mostrado como texto simples.`,
          );
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      editor?.dispose();
      editorRef.current = null;
    };
    // Recriar o editor ao trocar de arquivo mantém o realce correto.
  }, [path, theme, value]);

  if (error) {
    return (
      <div className="flex h-full flex-col">
        <p className="px-3 py-2 text-[12px] text-[var(--warning)]">{error}</p>
        <pre className="ch-mono min-h-0 flex-1 overflow-auto px-3 pb-3 text-[12.5px]" style={{ margin: 0 }}>
          <code>{value}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="relative h-full">
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-[12.5px] text-[var(--text-muted)]">
          <Spinner /> Carregando o editor…
        </div>
      ) : null}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
