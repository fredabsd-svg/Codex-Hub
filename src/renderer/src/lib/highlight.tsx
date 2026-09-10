/**
 * Realce de sintaxe leve, sem dependências e sem HTML.
 *
 * O código vem de modelos e arquivos — conteúdo NÃO confiável — e por isso é
 * convertido em nós React (`<span>` com classes), nunca em HTML. O tokenizador
 * é propositalmente simples: comentários, strings, números, palavras-chave,
 * tipos, chamadas de função e pontuação cobrem a leitura de 90% dos trechos
 * mostrados em uma conversa. Quando a linguagem não é reconhecida, o texto é
 * devolvido sem realce.
 */

import type { ReactNode } from 'react';

export type TokenKind =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'type'
  | 'function'
  | 'property'
  | 'punctuation'
  | 'operator'
  | 'tag'
  | 'attribute'
  | 'variable'
  | 'plain';

export interface Token {
  kind: TokenKind;
  text: string;
}

interface LanguageSpec {
  /** Marcadores de comentário de linha. */
  lineComment: string[];
  /** Pares abre/fecha de comentário de bloco. */
  blockComment: Array<[string, string]>;
  /** Delimitadores de string. */
  stringDelimiters: string[];
  /** Strings com crase aceitam múltiplas linhas (JS). */
  keywords: Set<string>;
  /** Literais e constantes (true, null…). */
  literals: Set<string>;
  /** Identificadores iniciados por maiúscula são tipos. */
  capitalizedTypes: boolean;
  /** Modo de marcação (HTML/XML). */
  markup?: boolean;
  /** Variáveis com prefixo ($ em shell/PHP). */
  variablePrefix?: string;
  /** Aceita `#` como comentário de linha, mas não `#!`-shebang diferente. */
}

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

const C_LIKE_LITERALS = words('true false null undefined NaN Infinity nil None True False');

const JS: LanguageSpec = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"', "'", '`'],
  keywords: words(
    'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of package private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
  ),
  literals: C_LIKE_LITERALS,
  capitalizedTypes: true,
};

const PYTHON: LanguageSpec = {
  lineComment: ['#'],
  blockComment: [
    ['"""', '"""'],
    ["'''", "'''"],
  ],
  stringDelimiters: ['"', "'"],
  keywords: words(
    'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self',
  ),
  literals: words('True False None'),
  capitalizedTypes: true,
};

const SHELL: LanguageSpec = {
  lineComment: ['#'],
  blockComment: [],
  stringDelimiters: ['"', "'"],
  keywords: words(
    'if then else elif fi for while until do done case esac in function select return exit export local readonly set unset source alias echo cd ls cat grep sed awk npm npx node git curl sudo rm mkdir cp mv chmod chown docker pip python',
  ),
  literals: words('true false'),
  capitalizedTypes: false,
  variablePrefix: '$',
};

const GO: LanguageSpec = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"', '`', "'"],
  keywords: words(
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  ),
  literals: words('true false nil iota'),
  capitalizedTypes: true,
};

const RUST: LanguageSpec = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"'],
  keywords: words(
    'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  ),
  literals: words('true false None Some Ok Err'),
  capitalizedTypes: true,
};

const C_FAMILY: LanguageSpec = {
  lineComment: ['//'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"', "'"],
  keywords: words(
    'auto break case catch char class const constexpr continue default delete do double else enum explicit export extern final finally float for friend goto if inline int long namespace new operator override private protected public register return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while abstract boolean byte extends implements import instanceof interface native package strictfp super synchronized throws transient var string bool internal object readonly sealed out ref params foreach in is as base checked unchecked fixed lock stackalloc',
  ),
  literals: C_LIKE_LITERALS,
  capitalizedTypes: true,
};

const RUBY: LanguageSpec = {
  lineComment: ['#'],
  blockComment: [['=begin', '=end']],
  stringDelimiters: ['"', "'"],
  keywords: words(
    'alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative attr_accessor attr_reader puts',
  ),
  literals: words('true false nil'),
  capitalizedTypes: true,
  variablePrefix: '@',
};

const PHP: LanguageSpec = {
  lineComment: ['//', '#'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"', "'"],
  keywords: words(
    'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while xor yield',
  ),
  literals: words('true false null TRUE FALSE NULL'),
  capitalizedTypes: true,
  variablePrefix: '$',
};

const SQL: LanguageSpec = {
  lineComment: ['--'],
  blockComment: [['/*', '*/']],
  stringDelimiters: ["'", '"'],
  keywords: words(
    'select from where insert into values update set delete create table drop alter add index view join left right inner outer full on as and or not in is null distinct group by order having limit offset union all exists between like case when then else end primary key foreign references unique default begin commit rollback with returning SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER ADD INDEX VIEW JOIN LEFT RIGHT INNER OUTER FULL ON AS AND OR NOT IN IS NULL DISTINCT GROUP BY ORDER HAVING LIMIT OFFSET UNION ALL EXISTS BETWEEN LIKE CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN REFERENCES UNIQUE DEFAULT BEGIN COMMIT ROLLBACK WITH RETURNING',
  ),
  literals: words('TRUE FALSE NULL true false null'),
  capitalizedTypes: false,
};

const CSS: LanguageSpec = {
  lineComment: [],
  blockComment: [['/*', '*/']],
  stringDelimiters: ['"', "'"],
  keywords: words('important @media @import @keyframes @font-face @supports @layer @theme @apply from to'),
  literals: words('inherit initial unset none auto'),
  capitalizedTypes: false,
};

const YAML: LanguageSpec = {
  lineComment: ['#'],
  blockComment: [],
  stringDelimiters: ['"', "'"],
  keywords: new Set(),
  literals: words('true false null yes no on off ~'),
  capitalizedTypes: false,
};

const JSON_SPEC: LanguageSpec = {
  lineComment: [],
  blockComment: [],
  stringDelimiters: ['"'],
  keywords: new Set(),
  literals: words('true false null'),
  capitalizedTypes: false,
};

const MARKUP: LanguageSpec = {
  lineComment: [],
  blockComment: [['<!--', '-->']],
  stringDelimiters: ['"', "'"],
  keywords: new Set(),
  literals: new Set(),
  capitalizedTypes: false,
  markup: true,
};

const DIFF_LANGUAGE = 'diff';

const LANGUAGES: Record<string, LanguageSpec> = {
  js: JS,
  javascript: JS,
  jsx: JS,
  ts: JS,
  typescript: JS,
  tsx: JS,
  mjs: JS,
  cjs: JS,
  json: JSON_SPEC,
  jsonc: JS,
  py: PYTHON,
  python: PYTHON,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  shell: SHELL,
  console: SHELL,
  powershell: SHELL,
  ps1: SHELL,
  go: GO,
  golang: GO,
  rs: RUST,
  rust: RUST,
  c: C_FAMILY,
  h: C_FAMILY,
  cpp: C_FAMILY,
  cc: C_FAMILY,
  hpp: C_FAMILY,
  java: C_FAMILY,
  kotlin: C_FAMILY,
  kt: C_FAMILY,
  swift: C_FAMILY,
  cs: C_FAMILY,
  csharp: C_FAMILY,
  scala: C_FAMILY,
  dart: C_FAMILY,
  rb: RUBY,
  ruby: RUBY,
  php: PHP,
  sql: SQL,
  css: CSS,
  scss: CSS,
  less: CSS,
  yaml: YAML,
  yml: YAML,
  toml: YAML,
  ini: YAML,
  html: MARKUP,
  xml: MARKUP,
  svg: MARKUP,
  vue: MARKUP,
};

export function isHighlightedLanguage(language: string | undefined): boolean {
  if (!language) return false;
  const key = language.toLowerCase();
  return key === DIFF_LANGUAGE || key in LANGUAGES;
}

/* ------------------------------------------------------------------ *
 * Tokenização
 * ------------------------------------------------------------------ */

const IDENT_START = /[A-Za-z_$@#]/;
const IDENT_PART = /[A-Za-z0-9_$?-]/;
const NUMBER = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?[a-zA-Z]*)/;
const OPERATOR_CHARS = new Set('+-*/%=<>!&|^~?:'.split(''));
const PUNCT_CHARS = new Set('()[]{},;.'.split(''));

function tokenizeDiff(code: string): Token[] {
  return code.split('\n').flatMap((line, index, all) => {
    const kind: TokenKind =
      line.startsWith('+++') || line.startsWith('---')
        ? 'comment'
        : line.startsWith('+')
          ? 'string'
          : line.startsWith('-')
            ? 'keyword'
            : line.startsWith('@@')
              ? 'number'
              : 'plain';
    const tokens: Token[] = [{ kind, text: line }];
    if (index < all.length - 1) tokens.push({ kind: 'plain', text: '\n' });
    return tokens;
  });
}

function tokenizeMarkup(code: string, spec: LanguageSpec): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: TokenKind, text: string): void => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && kind === 'plain') last.text += text;
    else tokens.push({ kind, text });
  };

  while (index < code.length) {
    // Comentário
    const [open, close] = spec.blockComment[0] ?? ['<!--', '-->'];
    if (code.startsWith(open, index)) {
      const end = code.indexOf(close, index + open.length);
      const stop = end < 0 ? code.length : end + close.length;
      push('comment', code.slice(index, stop));
      index = stop;
      continue;
    }
    if (code[index] === '<') {
      // Tag: <name attr="value" ...> ou </name>
      const tagMatch = /^<\/?[A-Za-z][\w:.-]*/.exec(code.slice(index));
      if (tagMatch) {
        push('punctuation', tagMatch[0].startsWith('</') ? '</' : '<');
        push('tag', tagMatch[0].replace(/^<\/?/, ''));
        index += tagMatch[0].length;
        // Atributos até '>'
        while (index < code.length && code[index] !== '>') {
          const char = code[index] as string;
          if (/\s/.test(char)) {
            push('plain', char);
            index += 1;
            continue;
          }
          if (char === '/' ) {
            push('punctuation', char);
            index += 1;
            continue;
          }
          if (char === '"' || char === "'") {
            const end = code.indexOf(char, index + 1);
            const stop = end < 0 ? code.length : end + 1;
            push('string', code.slice(index, stop));
            index = stop;
            continue;
          }
          if (char === '=') {
            push('operator', char);
            index += 1;
            continue;
          }
          const attr = /^[^\s=/>]+/.exec(code.slice(index));
          if (attr) {
            push('attribute', attr[0]);
            index += attr[0].length;
            continue;
          }
          push('plain', char);
          index += 1;
        }
        if (code[index] === '>') {
          push('punctuation', '>');
          index += 1;
        }
        continue;
      }
    }
    push('plain', code[index] as string);
    index += 1;
  }
  return tokens;
}

function tokenizeGeneric(code: string, spec: LanguageSpec): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: TokenKind, text: string): void => {
    if (text === '') return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind && (kind === 'plain' || kind === 'operator')) last.text += text;
    else tokens.push({ kind, text });
  };

  while (index < code.length) {
    const rest = code.slice(index);
    const char = code[index] as string;

    // Comentários de bloco
    let matched = false;
    for (const [open, close] of spec.blockComment) {
      if (rest.startsWith(open)) {
        const end = code.indexOf(close, index + open.length);
        const stop = end < 0 ? code.length : end + close.length;
        push('comment', code.slice(index, stop));
        index = stop;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Comentários de linha
    for (const marker of spec.lineComment) {
      if (rest.startsWith(marker)) {
        // Em shell, `$#` e `#!` no início contam como comentário mesmo assim;
        // já `#` dentro de uma palavra (ex.: C#) não é comentário.
        const previous = code[index - 1];
        if (marker === '#' && previous !== undefined && /[A-Za-z0-9]/.test(previous)) break;
        const end = code.indexOf('\n', index);
        const stop = end < 0 ? code.length : end;
        push('comment', code.slice(index, stop));
        index = stop;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Strings
    if (spec.stringDelimiters.includes(char)) {
      let cursor = index + 1;
      while (cursor < code.length) {
        const current = code[cursor];
        if (current === '\\') {
          cursor += 2;
          continue;
        }
        if (current === char) {
          cursor += 1;
          break;
        }
        // Strings simples não atravessam linhas (exceto crase em JS).
        if (current === '\n' && char !== '`') break;
        cursor += 1;
      }
      push('string', code.slice(index, cursor));
      index = cursor;
      continue;
    }

    // Números
    if (/\d/.test(char) || (char === '.' && /\d/.test(code[index + 1] ?? ''))) {
      const number = NUMBER.exec(rest);
      if (number) {
        push('number', number[0]);
        index += number[0].length;
        continue;
      }
    }

    // Variáveis com prefixo ($var, @ivar)
    if (spec.variablePrefix && char === spec.variablePrefix) {
      const variable = /^[$@][A-Za-z_{][\w}]*/.exec(rest);
      if (variable) {
        push('variable', variable[0]);
        index += variable[0].length;
        continue;
      }
    }

    // Identificadores
    if (IDENT_START.test(char)) {
      let cursor = index + 1;
      while (cursor < code.length && IDENT_PART.test(code[cursor] as string)) cursor += 1;
      const word = code.slice(index, cursor);
      const next = code.slice(cursor).match(/^\s*(\S)/)?.[1];
      const previous = code.slice(0, index).match(/(\S)\s*$/)?.[1];

      if (spec.keywords.has(word)) push('keyword', word);
      else if (spec.literals.has(word)) push('number', word);
      else if (next === '(' && !spec.markup) push('function', word);
      else if (previous === '.' && spec !== CSS) push('property', word);
      else if (next === ':' && (spec === JSON_SPEC || spec === YAML || spec === CSS)) push('property', word);
      else if (spec.capitalizedTypes && /^[A-Z]/.test(word) && /[a-z]/.test(word)) push('type', word);
      else push('plain', word);
      index = cursor;
      continue;
    }

    if (OPERATOR_CHARS.has(char)) {
      push('operator', char);
      index += 1;
      continue;
    }
    if (PUNCT_CHARS.has(char)) {
      push('punctuation', char);
      index += 1;
      continue;
    }
    push('plain', char);
    index += 1;
  }
  return tokens;
}

export function tokenize(code: string, language: string | undefined): Token[] {
  if (!language) return [{ kind: 'plain', text: code }];
  const key = language.toLowerCase();
  if (key === DIFF_LANGUAGE) return tokenizeDiff(code);
  const spec = LANGUAGES[key];
  if (!spec) return [{ kind: 'plain', text: code }];
  if (spec.markup) return tokenizeMarkup(code, spec);
  return tokenizeGeneric(code, spec);
}

/** Converte os tokens em nós React. Tokens `plain` viram texto puro. */
export function highlight(code: string, language: string | undefined): ReactNode[] {
  return tokenize(code, language).map((token, index) =>
    token.kind === 'plain' ? token.text : (
      <span key={index} className={`ch-hl-${token.kind}`}>
        {token.text}
      </span>
    ),
  );
}
