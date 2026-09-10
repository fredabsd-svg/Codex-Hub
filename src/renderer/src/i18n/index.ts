/**
 * Internacionalização.
 *
 * A interface é entregue em português do Brasil. A estrutura está preparada
 * para tradução: os textos ficam em dicionários por locale e `t()` resolve por
 * chave com interpolação simples. Nenhum texto novo deve ser escrito inline em
 * componentes de página.
 */

import { ptBR } from './pt-BR';

export type Locale = 'pt-BR';

export type Dictionary = typeof ptBR;

const DICTIONARIES: Record<Locale, Dictionary> = { 'pt-BR': ptBR };

let currentLocale: Locale = 'pt-BR';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? Leaves<T[K], `${Prefix}${K}.`>
      : never;
}[keyof T & string];

export type MessageKey = Leaves<Dictionary>;

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (node && typeof node === 'object' && segment in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return typeof node === 'string' ? node : undefined;
}

/** Interpola `{nome}` com os valores informados. */
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  const dictionary = DICTIONARIES[currentLocale];
  const template = lookup(dictionary, key) ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in values ? String(values[name]) : `{${name}}`,
  );
}
