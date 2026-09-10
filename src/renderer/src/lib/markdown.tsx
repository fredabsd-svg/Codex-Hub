/**
 * Renderizador de Markdown seguro.
 *
 * Não usa `dangerouslySetInnerHTML` nem avalia HTML embutido: o texto é
 * convertido em elementos React. Conteúdo de modelos, arquivos e ferramentas é
 * tratado como NÃO CONFIÁVEL.
 *
 * Links são filtrados por protocolo (http, https, mailto) e abertos no
 * navegador do sistema pelo processo principal.
 */

import { Fragment, type ReactNode } from 'react';

export interface MarkdownOptions {
  /** Chamado ao clicar em um link permitido. */
  onOpenLink(url: string): void;
  /** Renderizador de bloco de código (permite copiar/expandir). */
  renderCodeBlock(code: string, language: string | undefined, index: number): ReactNode;
}

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language?: string; code: string }
  | { kind: 'list'; ordered: boolean; items: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

const FENCE = /^```+\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Bloco de código cercado
    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1] || undefined;
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        if (/^```+\s*$/.test(lines[index] ?? '')) {
          closed = true;
          break;
        }
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1; // consome o fechamento (ou o fim do texto)
      if (!closed) {
        // Bloco não fechado: descarta as linhas vazias artificiais do fim.
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
      }
      blocks.push({ kind: 'code', language, code: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' });
      index += 1;
      continue;
    }

    // Tabela: linha com | seguida de separador
    if (line.includes('|') && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [quote[1] ?? ''];
      index += 1;
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index] ?? '');
        if (!next) break;
        body.push(next[1] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = ordered ? ORDERED.exec(current) : UNORDERED.exec(current);
        if (!match) {
          // Continuação indentada do item anterior
          if (/^\s{2,}\S/.test(current) && items.length > 0) {
            items[items.length - 1]?.push(current.trim());
            index += 1;
            continue;
          }
          break;
        }
        items.push([match[1] ?? '']);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        FENCE.test(current) ||
        HEADING.test(current) ||
        UNORDERED.test(current) ||
        ORDERED.test(current) ||
        QUOTE.test(current) ||
        HR.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }

  return blocks;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function isSafeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return SAFE_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

/** Converte trechos inline em nós React, sem HTML. */
export function renderInline(text: string, options: MarkdownOptions, keyPrefix = ''): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Ordem importa: código antes de ênfase, para não formatar dentro do código.
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let counter = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}i${counter++}`;

    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), options, `${key}-`)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<s key={key}>{renderInline(token.slice(2, -2), options, `${key}-`)}</s>);
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch?.[2] ?? '';
      nodes.push(renderLink(key, label === '' ? href : label, href, options));
    } else if (/^https?:\/\//.test(token)) {
      nodes.push(renderLink(key, token, token, options));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), options, `${key}-`)}</em>);
    } else {
      nodes.push(token);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderLink(key: string, label: string, href: string, options: MarkdownOptions): ReactNode {
  if (!isSafeUrl(href)) {
    // Protocolo não permitido: mostra o texto, sem link ativo.
    return (
      <span key={key} title={`Link bloqueado: protocolo não permitido (${href})`} style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
    );
  }
  return (
    <a
      key={key}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        options.onOpenLink(href);
      }}
    >
      {label}
    </a>
  );
}

/* ------------------------------------------------------------------ *
 * Blocos
 * ------------------------------------------------------------------ */

export function renderMarkdown(source: string, options: MarkdownOptions): ReactNode {
  const blocks = parseMarkdown(source);
  let codeIndex = 0;

  return (
    <div className="ch-md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = (`h${Math.min(block.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4');
            return <Tag key={key}>{renderInline(block.text, options, `${key}-`)}</Tag>;
          }
          case 'code':
            return <Fragment key={key}>{options.renderCodeBlock(block.code, block.language, codeIndex++)}</Fragment>;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item.join(' '), options, `${key}-${itemIndex}-`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={key}>{renderInline(block.lines.join('\n'), options, `${key}-`)}</blockquote>
            );
          case 'table':
            return (
              <div key={key} style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={`${key}-h${cellIndex}`}>{renderInline(cell, options, `${key}-h${cellIndex}-`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td key={`${key}-r${rowIndex}c${cellIndex}`}>
                            {renderInline(cell, options, `${key}-r${rowIndex}c${cellIndex}-`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={key} />;
          case 'paragraph':
          default:
            return <p key={key}>{renderInline(block.lines.join('\n'), options, `${key}-`)}</p>;
        }
      })}
    </div>
  );
}
