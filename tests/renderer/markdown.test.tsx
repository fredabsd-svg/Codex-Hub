// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isSafeUrl, parseMarkdown, renderMarkdown } from '../../src/renderer/src/lib/markdown';

afterEach(cleanup);

function show(source: string, onOpenLink = vi.fn()): { onOpenLink: ReturnType<typeof vi.fn> } {
  render(
    <div>
      {renderMarkdown(source, {
        onOpenLink,
        renderCodeBlock: (code, language, index) => (
          <pre key={index} data-language={language ?? 'texto'}>
            <code>{code}</code>
          </pre>
        ),
      })}
    </div>,
  );
  return { onOpenLink };
}

describe('parseMarkdown', () => {
  it('separa parágrafos, títulos e listas', () => {
    const blocks = parseMarkdown('# Título\n\nUm parágrafo.\n\n- a\n- b\n');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list']);
  });

  it('captura bloco de código cercado com linguagem', () => {
    const blocks = parseMarkdown('```ts\nconst a = 1;\n```\n');
    expect(blocks[0]).toMatchObject({ kind: 'code', language: 'ts', code: 'const a = 1;' });
  });

  it('captura bloco de código não fechado até o fim', () => {
    const blocks = parseMarkdown('```\nsem fechamento\n');
    expect(blocks[0]).toMatchObject({ kind: 'code', code: 'sem fechamento' });
  });

  it('reconhece tabela com separador', () => {
    const blocks = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    expect(blocks[0]).toMatchObject({ kind: 'table', header: ['a', 'b'], rows: [['1', '2']] });
  });

  it('reconhece citação e regra horizontal', () => {
    const blocks = parseMarkdown('> citado\n\n---\n');
    expect(blocks.map((block) => block.kind)).toEqual(['quote', 'hr']);
  });

  it('lista ordenada é reconhecida separadamente', () => {
    const blocks = parseMarkdown('1. um\n2. dois\n');
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
  });
});

describe('renderização segura', () => {
  it('NÃO interpreta HTML embutido — mostra como texto', () => {
    show('Veja <img src=x onerror="alert(1)"> e <script>alert(2)</script> aqui.');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument();
  });

  it('não executa HTML dentro de bloco de código', () => {
    show('```html\n<script>alert(1)</script>\n```');
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
  });

  it('renderiza ênfase, negrito e código inline como elementos', () => {
    show('Isso é **forte**, *ênfase* e `codigo()`.');
    expect(screen.getByText('forte').tagName).toBe('STRONG');
    expect(screen.getByText('ênfase').tagName).toBe('EM');
    expect(screen.getByText('codigo()').tagName).toBe('CODE');
  });

  it('abre links https pelo processo principal, sem navegar', async () => {
    const { onOpenLink } = show('Veja [a documentação](https://openrouter.ai/docs).');
    const link = screen.getByRole('link', { name: 'a documentação' });
    await userEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledWith('https://openrouter.ai/docs');
  });

  it('bloqueia protocolos não permitidos, mantendo o texto visível', () => {
    show('[clique](javascript:alert(1)) e [arquivo](file:///etc/passwd)');
    expect(screen.queryByRole('link', { name: 'clique' })).toBeNull();
    expect(screen.getByText('clique')).toBeInTheDocument();
    expect(screen.getAllByTitle(/Link bloqueado/)).toHaveLength(2);
  });

  it('reconhece URL solta como link', () => {
    show('acesse https://exemplo.com/pagina agora');
    expect(screen.getByRole('link', { name: 'https://exemplo.com/pagina' })).toBeInTheDocument();
  });

  it('renderiza tabela com cabeçalho', () => {
    show('| modelo | preço |\n| --- | --- |\n| x | 1 |\n');
    expect(screen.getByRole('columnheader', { name: 'modelo' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'x' })).toBeInTheDocument();
  });

  it('usa o renderizador de bloco de código informado', () => {
    show('```python\nprint(1)\n```');
    const block = document.querySelector('pre[data-language="python"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toBe('print(1)');
  });

  it('texto vazio não quebra', () => {
    expect(() => show('')).not.toThrow();
  });
});

describe('isSafeUrl', () => {
  it('aceita http, https e mailto', () => {
    expect(isSafeUrl('https://a.com')).toBe(true);
    expect(isSafeUrl('http://127.0.0.1:1234')).toBe(true);
    expect(isSafeUrl('mailto:a@b.com')).toBe(true);
  });

  it('recusa javascript, data, file e vbscript', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('vbscript:msgbox')).toBe(false);
  });

  it('recusa texto que não é URL', () => {
    expect(isSafeUrl('não é url')).toBe(false);
  });
});
