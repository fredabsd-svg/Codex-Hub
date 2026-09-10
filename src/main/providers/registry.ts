/**
 * Registro de provedores.
 *
 * Mantém: OpenRouter (primeira classe), o pseudo-provedor Codex (cuja
 * inferência é administrada pelo próprio App Server) e os endpoints
 * compatíveis cadastrados pela pessoa.
 *
 * Credenciais são resolvidas por provedor. Nunca há reaproveitamento entre
 * provedores nem ao testar uma URL diferente.
 */

import { randomUUID } from 'node:crypto';
import type { ProviderConnection, ProviderDescriptor } from '../../shared/domain';
import { appError } from '../../shared/errors';
import type { CompatibleProviderRepository } from '../persistence/repositories';
import type { CredentialStore } from '../services/CredentialStore';
import { CompatibleProvider } from './CompatibleProvider';
import { validateEndpointUrl, isLocalHost } from './http';
import { OPENROUTER_DESCRIPTOR, OPENROUTER_PROVIDER_ID, OpenRouterProvider } from './OpenRouterProvider';
import type { ModelProvider } from './types';

export const CODEX_PROVIDER_ID = 'codex';

/**
 * Provedor "Codex": a inferência é feita pelo runtime oficial, com a conta e a
 * configuração do próprio Codex. Não expõe catálogo HTTP nem streaming aqui —
 * isso é responsabilidade do `CodexEngine`.
 */
export const CODEX_DESCRIPTOR: ProviderDescriptor = {
  id: CODEX_PROVIDER_ID,
  kind: 'codex',
  label: 'Codex (conta ChatGPT ou chave OpenAI)',
  description:
    'Usa o Codex App Server instalado na máquina, com a autenticação e os provedores suportados pela versão presente.',
  engines: ['codex'],
  authKinds: ['chatgptOAuth', 'deviceCode', 'apiKey'],
  userDefined: false,
  docsUrl: 'https://learn.chatgpt.com/docs/app-server',
};

export class ProviderRegistry {
  private readonly cache = new Map<string, ModelProvider>();
  private readonly connections = new Map<string, ProviderConnection>();

  constructor(
    private readonly credentials: CredentialStore,
    private readonly compatibleRepo: CompatibleProviderRepository,
    private readonly appTitle: string,
  ) {}

  descriptors(): ProviderDescriptor[] {
    return [OPENROUTER_DESCRIPTOR, CODEX_DESCRIPTOR, ...this.compatibleRepo.list()];
  }

  descriptor(providerId: string): ProviderDescriptor | null {
    return this.descriptors().find((d) => d.id === providerId) ?? null;
  }

  /** Provedores com adaptador HTTP próprio (exclui o pseudo-provedor Codex). */
  get(providerId: string): ModelProvider | null {
    if (providerId === CODEX_PROVIDER_ID) return null;
    const cached = this.cache.get(providerId);
    if (cached) return cached;

    if (providerId === OPENROUTER_PROVIDER_ID) {
      const provider = new OpenRouterProvider({
        getSecret: () => this.credentials.getSecret(OPENROUTER_PROVIDER_ID),
        appTitle: this.appTitle,
      });
      this.cache.set(providerId, provider);
      return provider;
    }

    const row = this.compatibleRepo.get(providerId);
    if (!row) return null;
    const provider = new CompatibleProvider({
      descriptor: row,
      getSecret: () => this.credentials.getSecret(providerId),
      extraHeaders: row.headers,
    });
    this.cache.set(providerId, provider);
    return provider;
  }

  require(providerId: string): ModelProvider {
    const provider = this.get(providerId);
    if (!provider) {
      throw appError('validation', {
        message: `Provedor não encontrado: ${providerId}.`,
        action: 'Selecione um provedor disponível na lista.',
      });
    }
    return provider;
  }

  /* -------------------- Estado de conexão -------------------- */

  connectionOf(providerId: string): ProviderConnection {
    const existing = this.connections.get(providerId);
    if (existing) return existing;
    const meta = this.credentials.getMeta(providerId);
    const descriptor = this.descriptor(providerId);
    const initial: ProviderConnection = {
      providerId,
      state: meta ? 'connected' : 'disconnected',
      credentialId: meta?.credentialId,
      maskedCredential: meta?.masked,
      message: meta
        ? 'Credencial disponível nesta sessão.'
        : descriptor?.kind === 'codex'
          ? 'A autenticação deste provedor é feita pelo Codex.'
          : 'Nenhuma credencial configurada.',
    };
    this.connections.set(providerId, initial);
    return initial;
  }

  allConnections(): ProviderConnection[] {
    return this.descriptors().map((d) => this.connectionOf(d.id));
  }

  setConnection(connection: ProviderConnection): ProviderConnection {
    const meta = this.credentials.getMeta(connection.providerId);
    const merged: ProviderConnection = {
      ...connection,
      credentialId: meta?.credentialId,
      maskedCredential: meta?.masked,
    };
    this.connections.set(connection.providerId, merged);
    return merged;
  }

  /* -------------------- Endpoints compatíveis -------------------- */

  registerCompatible(input: {
    label: string;
    baseUrl: string;
    headers?: Record<string, string>;
  }): ProviderDescriptor {
    const { url, isLocal } = validateEndpointUrl(input.baseUrl, { allowInsecureLocal: false });
    const normalized = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    const duplicate = this.compatibleRepo.list().find((p) => p.baseUrl === normalized);
    if (duplicate) return duplicate;

    const descriptor = this.compatibleRepo.put({
      id: `compatible:${randomUUID()}`,
      kind: 'compatible',
      label: input.label.trim(),
      description: isLocal
        ? 'Endpoint local compatível com o protocolo Chat Completions.'
        : 'Endpoint remoto compatível com o protocolo Chat Completions.',
      engines: ['direct'],
      authKinds: ['apiKey', 'none'],
      baseUrl: normalized,
      userDefined: true,
      headers: input.headers,
      createdAt: new Date().toISOString(),
    });
    this.cache.delete(descriptor.id);
    return descriptor;
  }

  removeCompatible(providerId: string): boolean {
    const removed = this.compatibleRepo.remove(providerId);
    if (removed) {
      this.cache.delete(providerId);
      this.connections.delete(providerId);
      this.credentials.remove(providerId);
    }
    return removed;
  }

  /** Invalida o adaptador em cache (após trocar credencial ou cabeçalhos). */
  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  isLocalProvider(providerId: string): boolean {
    const descriptor = this.descriptor(providerId);
    if (!descriptor?.baseUrl) return false;
    try {
      return isLocalHost(new URL(descriptor.baseUrl).hostname);
    } catch {
      return false;
    }
  }
}
