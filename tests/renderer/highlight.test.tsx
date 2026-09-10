// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { highlight, isHighlightedLanguage, tokenize } from '../../src/renderer/src/lib/highlight';

const kinds = (code: string, language: string): string[] =>
  tokenize(code, language)
    .filter((token) => token.kind !== 'plain')
    .map((token) => `${token.kind}:${token.text}`);

describe('highlight — tokenizador', () => {
  it('reconhece comentários, strings, números e palavras-chave em TypeScript', () => {
    const out = kinds('const x = "a\\"b"; // fim\nreturn 42;', 'ts');
    expect(out).toContain('keyword:const');
    expect(out).toContain('string:"a\\"b"');
    expect(out).toContain('comment:// fim');
    expect(out).toContain('keyword:return');
    expect(out).toContain('number:42');
  });

  it('marca chamadas de função, tipos e propriedades', () => {
    const out = kinds('const s: Map<string, Foo> = build(a.length)', 'ts');
    expect(out).toContain('type:Map');
    expect(out).toContain('type:Foo');
    expect(out).toContain('function:build');
    expect(out).toContain('property:length');
  });

  it('nunca perde texto: a concatenação dos tokens é o código original', () => {
    const samples: Array<[string, string]> = [
      ['def f(x):\n    return x * 2  # dobra', 'python'],
      ['echo "$HOME" # casa\nls -la', 'bash'],
      ['{"a": 1, "b": [true, null]}', 'json'],
      ['<div class="x" data-a=\'1\'>oi</div><!-- c -->', 'html'],
      ['SELECT id FROM t WHERE x = \'a\' -- c', 'sql'],
      ['a {\n  color: red; /* x */\n}', 'css'],
      ['+add\n-del\n@@ -1 +1 @@\n ctx', 'diff'],
      ['fn main() { let s = "x"; }', 'rust'],
      ['texto "sem fechar', 'js'],
    ];
    for (const [code, language] of samples) {
      const joined = tokenize(code, language)
        .map((token) => token.text)
        .join('');
      expect(joined).toBe(code);
    }
  });

  it('strings simples não atravessam linhas, crases em JS sim', () => {
    const js = tokenize('`a\nb`', 'js');
    expect(js[0]).toEqual({ kind: 'string', text: '`a\nb`' });
    const py = tokenize("'a\nb'", 'python');
    expect(py[0]?.text).toBe("'a");
  });

  it('em shell, # após uma letra não é comentário (C#)', () => {
    const out = kinds('echo C# x', 'bash');
    expect(out.some((entry) => entry.startsWith('comment:'))).toBe(false);
  });

  it('diff colore linhas adicionadas e removidas', () => {
    const out = kinds('+novo\n-velho\n@@ -1 +1 @@', 'diff');
    expect(out).toEqual(['string:+novo', 'keyword:-velho', 'number:@@ -1 +1 @@']);
  });

  it('devolve texto puro para linguagem desconhecida', () => {
    expect(tokenize('qualquer coisa', 'brainfuck')).toEqual([{ kind: 'plain', text: 'qualquer coisa' }]);
    expect(isHighlightedLanguage('brainfuck')).toBe(false);
    expect(isHighlightedLanguage('tsx')).toBe(true);
  });

  it('renderiza spans com classes e sem HTML interpretado', () => {
    const { container } = render(<pre>{highlight('const a = "<b>x</b>";', 'js')}</pre>);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('.ch-hl-keyword')?.textContent).toBe('const');
    expect(container.querySelector('.ch-hl-string')?.textContent).toBe('"<b>x</b>"');
  });
});
