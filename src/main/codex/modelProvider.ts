/**
 * Provedor de modelos usado PELO processo do Codex.
 *
 * Por padrão o Codex usa o provedor dele (conta ChatGPT ou chave da OpenAI).
 * Quem já tem uma chave do OpenRouter pode pedir que o processo do Codex use o
 * OpenRouter como provedor — recurso do próprio Codex CLI, declarado em
 * `model_providers` no `config.toml` e sobrescritível por `-c chave=valor`.
 *
 * Limites que este módulo respeita, e que a interface repete para a pessoa:
 *
 *  - a chave é entregue ao processo filho por VARIÁVEL DE AMBIENTE, nunca por
 *    argumento de linha de comando (argumentos aparecem na lista de processos);
 *  - a chave do OpenRouter NUNCA é enviada ao fluxo de login por chave da
 *    OpenAI do Codex (`account/login/start`): são credenciais de serviços
 *    diferentes. Aqui ela vai apenas para a variável que o próprio Codex lê
 *    quando o provedor OpenRouter está declarado;
 *  - nada aqui foi verificado contra um Codex real neste repositório. O
 *    aplicativo reporta o estado como SOLICITADO enquanto o processo não
 *    aceitar a configuração, e nunca como "validado".
 */

import {
  CODEX_OPENROUTER_BASE_URL,
  CODEX_OPENROUTER_ENV_KEY,
  CODEX_OPENROUTER_PROVIDER_ID,
  tomlString,
  type CodexModelProviderConfig,
} from '../../shared/codexProvider';

export {
  CODEX_OPENROUTER_BASE_URL,
  CODEX_OPENROUTER_ENV_KEY,
  CODEX_OPENROUTER_PROVIDER_ID,
  codexProviderConfigToml,
  type CodexModelProviderConfig,
} from '../../shared/codexProvider';

/**
 * Sobrescritas de configuração passadas ao `codex app-server`.
 *
 * Devolve lista vazia no modo padrão: sem o recurso ligado, o Codex é iniciado
 * exatamente como antes.
 */
export function buildCodexProviderArgs(config: CodexModelProviderConfig): string[] {
  if (config.mode !== 'openrouter') return [];
  const p = `model_providers.${CODEX_OPENROUTER_PROVIDER_ID}`;
  return [
    '-c',
    `model_provider=${tomlString(CODEX_OPENROUTER_PROVIDER_ID)}`,
    '-c',
    `${p}.name=${tomlString('OpenRouter')}`,
    '-c',
    `${p}.base_url=${tomlString(CODEX_OPENROUTER_BASE_URL)}`,
    '-c',
    `${p}.env_key=${tomlString(CODEX_OPENROUTER_ENV_KEY)}`,
    '-c',
    `${p}.wire_api=${tomlString(config.wireApi)}`,
  ];
}

/**
 * Variáveis de ambiente do processo filho.
 *
 * A chave só entra quando a pessoa ligou o recurso E existe credencial do
 * OpenRouter conectada. Nunca é colocada em argumento.
 */
export function buildCodexProviderEnv(config: CodexModelProviderConfig): Record<string, string> {
  if (config.mode !== 'openrouter') return {};
  const key = config.apiKey?.trim();
  if (!key) return {};
  return { [CODEX_OPENROUTER_ENV_KEY]: key };
}

/**
 * Reconhece a recusa das sobrescritas `-c` por versões que não as aceitam.
 *
 * Só olha para sinais textuais claros; na dúvida devolve `false`, para não
 * transformar uma falha qualquer em "sua versão não suporta".
 */
export function looksLikeConfigOverrideRejection(stderr: string): boolean {
  const text = stderr.toLowerCase();
  if (text.length === 0) return false;
  const mentionsOption =
    text.includes('unexpected argument') ||
    text.includes('unrecognized option') ||
    text.includes('unknown option') ||
    text.includes('unknown flag') ||
    text.includes('invalid option') ||
    text.includes("found argument '-c'") ||
    text.includes('unexpected value');
  const mentionsConfig = text.includes('-c') || text.includes('--config') || text.includes('model_provider');
  return mentionsOption && mentionsConfig;
}
