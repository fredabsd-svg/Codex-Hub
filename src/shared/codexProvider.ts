/**
 * Configuração do provedor de modelos usado PELO processo do Codex.
 *
 * Fica em `shared` porque o processo principal monta os argumentos com estes
 * valores e a interface mostra o trecho equivalente do `config.toml` — os dois
 * precisam dizer exatamente a mesma coisa.
 *
 * O que NUNCA aparece aqui: a chave. O `config.toml` guarda só o nome da
 * variável de ambiente que o Codex deve ler.
 */

import type { CodexModelProviderMode, CodexWireApi } from './domain';

/** Identificador do provedor dentro do `config.toml` do Codex. */
export const CODEX_OPENROUTER_PROVIDER_ID = 'openrouter';

/** Variável de ambiente lida pelo Codex quando o provedor está declarado. */
export const CODEX_OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY';

export const CODEX_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface CodexModelProviderConfig {
  mode: CodexModelProviderMode;
  wireApi: CodexWireApi;
  /** Segredo do OpenRouter. Só existe no processo principal. */
  apiKey?: string;
}

/** Valor TOML entre aspas. Os argumentos vão como array, sem shell. */
export function tomlString(value: string): string {
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/**
 * Trecho equivalente do `config.toml`, para quem preferir configurar à mão —
 * ou para versões do Codex que não aceitem sobrescrita por linha de comando.
 */
export function codexProviderConfigToml(config: Pick<CodexModelProviderConfig, 'mode' | 'wireApi'>): string {
  if (config.mode !== 'openrouter') return '';
  return [
    `model_provider = ${tomlString(CODEX_OPENROUTER_PROVIDER_ID)}`,
    '',
    `[model_providers.${CODEX_OPENROUTER_PROVIDER_ID}]`,
    `name = ${tomlString('OpenRouter')}`,
    `base_url = ${tomlString(CODEX_OPENROUTER_BASE_URL)}`,
    `env_key = ${tomlString(CODEX_OPENROUTER_ENV_KEY)}`,
    `wire_api = ${tomlString(config.wireApi)}`,
  ].join('\n');
}
