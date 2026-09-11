/**
 * Parâmetros de `account/login/start`.
 *
 * O que foi VERIFICADO contra o Codex 0.154.0 (Windows):
 *   - o servidor exige um campo discriminador chamado `type`; enviar `method`
 *     resulta em `Invalid request: missing field \`type\``.
 *
 * O que NÃO foi verificado: os nomes exatos das variantes aceitas. Em vez de
 * inventar, o cliente envia o nome mais provável e, se o servidor recusar com
 * `unknown variant ..., expected one of ...`, usa A LISTA DO PRÓPRIO SERVIDOR
 * para escolher a variante equivalente e tenta UMA vez. Nada é executado nessa
 * primeira tentativa: uma requisição recusada não inicia login nenhum.
 *
 * Rode `npm run codex:types` (ou `codex app-server generate-json-schema`) em
 * uma máquina com o Codex para substituir isto pelos tipos reais.
 */

import type { CodexAuthMethod } from '../../shared/domain';

/** Primeira tentativa para cada método, na nomenclatura camelCase do protocolo. */
const PREFERRED_VARIANT: Record<CodexAuthMethod, string> = {
  chatgpt: 'chatGpt',
  apiKey: 'apiKey',
  deviceCode: 'deviceCode',
};

export function loginParams(method: CodexAuthMethod, variant: string, apiKey?: string): Record<string, unknown> {
  // A chave só acompanha o método de chave: nenhum outro fluxo a recebe.
  return method === 'apiKey' ? { type: variant, apiKey } : { type: variant };
}

export function preferredVariant(method: CodexAuthMethod): string {
  return PREFERRED_VARIANT[method];
}

/** Normaliza para comparar `chatGpt`, `chat_gpt`, `chatgpt` e `ChatGPT`. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Lê `unknown variant \`x\`, expected one of \`a\`, \`b\`` e devolve as opções.
 * Devolve lista vazia quando a mensagem não tem esse formato — assim um erro
 * qualquer nunca vira "tente outra variante".
 */
export function parseExpectedVariants(message: string): string[] {
  if (!/unknown variant/i.test(message)) return [];
  const expected = /expected one of (.+)$/i.exec(message)?.[1];
  if (!expected) return [];
  return [...expected.matchAll(/[`'"]([A-Za-z0-9_-]+)[`'"]/g)].map((match) => match[1] as string);
}

/**
 * Escolhe, entre as variantes que o servidor aceita, a equivalente ao método
 * pedido. Devolve `null` quando nenhuma corresponde — nesse caso o erro
 * original é reportado como veio, sem nova tentativa.
 */
export function matchVariant(method: CodexAuthMethod, options: string[]): string | null {
  const wanted = normalize(PREFERRED_VARIANT[method]);
  const exact = options.find((option) => normalize(option) === wanted);
  if (exact) return exact;
  // `chatgpt` também casa com variantes como `chatGptLogin`.
  const partial = options.find(
    (option) => normalize(option).includes(wanted) || wanted.includes(normalize(option)),
  );
  return partial ?? null;
}
