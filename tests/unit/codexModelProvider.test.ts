/**
 * Provedor de modelos do processo do Codex.
 *
 * O que estes testes protegem:
 *  - modo padrão não muda nada na partida do Codex;
 *  - a chave vai por VARIÁVEL DE AMBIENTE e nunca aparece em argumento;
 *  - sem credencial, nenhuma variável é criada (o Codex cai no provedor dele);
 *  - o trecho do config.toml mostrado na interface nunca contém a chave;
 *  - a heurística que reconhece "esta versão não aceita -c" não dispara à toa.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCodexProviderArgs,
  buildCodexProviderEnv,
  codexProviderConfigToml,
  looksLikeConfigOverrideRejection,
  CODEX_OPENROUTER_ENV_KEY,
} from '../../src/main/codex/modelProvider';

const SECRET = 'sk-or-v1-chave-de-teste-0123456789';

describe('argumentos do processo', () => {
  it('não muda nada no modo padrão', () => {
    expect(buildCodexProviderArgs({ mode: 'default', wireApi: 'chat', apiKey: SECRET })).toEqual([]);
    expect(buildCodexProviderEnv({ mode: 'default', wireApi: 'chat', apiKey: SECRET })).toEqual({});
  });

  it('declara o provedor OpenRouter com valores TOML entre aspas', () => {
    const args = buildCodexProviderArgs({ mode: 'openrouter', wireApi: 'chat' });
    expect(args.filter((arg) => arg === '-c')).toHaveLength(5);
    expect(args).toContain('model_provider="openrouter"');
    expect(args).toContain('model_providers.openrouter.base_url="https://openrouter.ai/api/v1"');
    expect(args).toContain(`model_providers.openrouter.env_key="${CODEX_OPENROUTER_ENV_KEY}"`);
    expect(args).toContain('model_providers.openrouter.wire_api="chat"');
  });

  it('reflete o formato de requisição escolhido', () => {
    const args = buildCodexProviderArgs({ mode: 'openrouter', wireApi: 'responses' });
    expect(args).toContain('model_providers.openrouter.wire_api="responses"');
  });

  it('NUNCA coloca a chave em argumento', () => {
    const args = buildCodexProviderArgs({ mode: 'openrouter', wireApi: 'chat', apiKey: SECRET });
    expect(args.join(' ')).not.toContain(SECRET);
    expect(args.join(' ')).not.toContain('sk-or');
  });
});

describe('ambiente do processo', () => {
  it('entrega a chave apenas na variável que o Codex lê', () => {
    const env = buildCodexProviderEnv({ mode: 'openrouter', wireApi: 'chat', apiKey: SECRET });
    expect(env).toEqual({ [CODEX_OPENROUTER_ENV_KEY]: SECRET });
  });

  it('não cria variável quando não há credencial conectada', () => {
    expect(buildCodexProviderEnv({ mode: 'openrouter', wireApi: 'chat' })).toEqual({});
    expect(buildCodexProviderEnv({ mode: 'openrouter', wireApi: 'chat', apiKey: '   ' })).toEqual({});
  });
});

describe('trecho do config.toml', () => {
  it('guarda o NOME da variável, nunca o segredo', () => {
    const toml = codexProviderConfigToml({ mode: 'openrouter', wireApi: 'chat' });
    expect(toml).toContain('[model_providers.openrouter]');
    expect(toml).toContain(`env_key = "${CODEX_OPENROUTER_ENV_KEY}"`);
    expect(toml).not.toContain(SECRET);
  });

  it('é vazio no modo padrão', () => {
    expect(codexProviderConfigToml({ mode: 'default', wireApi: 'chat' })).toBe('');
  });
});

describe('recusa das sobrescritas pela versão instalada', () => {
  it('reconhece a recusa explícita do argumento', () => {
    expect(looksLikeConfigOverrideRejection("error: unexpected argument '-c' found")).toBe(true);
    expect(looksLikeConfigOverrideRejection('unrecognized option --config')).toBe(true);
  });

  it('não confunde outras falhas com falta de suporte', () => {
    expect(looksLikeConfigOverrideRejection('')).toBe(false);
    expect(looksLikeConfigOverrideRejection('failed to connect to the sandbox')).toBe(false);
    expect(looksLikeConfigOverrideRejection('error: authentication required')).toBe(false);
    expect(looksLikeConfigOverrideRejection('panic: something went very wrong')).toBe(false);
  });
});
