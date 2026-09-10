/**
 * Guarda de credenciais.
 *
 * Regras aplicadas aqui:
 *  - Segredos só são persistidos quando o armazenamento protegido do sistema
 *    está disponível (no Windows, `safeStorage` usa DPAPI). Sem proteção,
 *    a credencial fica APENAS em memória, pelo tempo da sessão.
 *  - Nada de segredo em texto puro em disco, em preferências ou em log.
 *  - Para fora deste módulo saem somente: `credentialId` e uma máscara.
 *  - Cada provedor tem seu próprio espaço: credencial de um provedor nunca é
 *    reutilizada em outro nem ao testar uma URL diferente.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from './logger';
import { maskCredential, registerSecret, forgetSecret } from './redact';

export interface SecretEncryptor {
  isAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export interface CredentialMeta {
  credentialId: string;
  providerId: string;
  masked: string;
  persisted: boolean;
  createdAt: string;
  /** Hash estável (não reversível) para comparar credenciais sem expô-las. */
  fingerprint: string;
}

interface PersistedFile {
  version: 1;
  entries: Array<{
    credentialId: string;
    providerId: string;
    masked: string;
    createdAt: string;
    fingerprint: string;
    ciphertextBase64: string;
  }>;
}

function fingerprintOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 16);
}

export class CredentialStore {
  private readonly filePath: string;
  private readonly memory = new Map<string, { secret: string; meta: CredentialMeta }>();
  private available: boolean;

  constructor(
    userDataDir: string,
    private readonly encryptor: SecretEncryptor,
  ) {
    mkdirSync(userDataDir, { recursive: true });
    this.filePath = join(userDataDir, 'credentials.json');
    this.available = safeIsAvailable(encryptor);
    this.load();
  }

  get protectionAvailable(): boolean {
    return this.available;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    if (!this.available) {
      logger.warn(
        'credentials',
        'Armazenamento protegido indisponível: credenciais salvas não podem ser lidas nesta sessão.',
      );
      return;
    }
    let parsed: PersistedFile;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedFile;
    } catch {
      logger.error('credentials', 'Arquivo de credenciais ilegível; será ignorado.');
      return;
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return;
    for (const entry of parsed.entries) {
      try {
        const secret = this.encryptor.decryptString(Buffer.from(entry.ciphertextBase64, 'base64'));
        registerSecret(secret);
        this.memory.set(entry.providerId, {
          secret,
          meta: {
            credentialId: entry.credentialId,
            providerId: entry.providerId,
            masked: entry.masked,
            persisted: true,
            createdAt: entry.createdAt,
            fingerprint: entry.fingerprint,
          },
        });
      } catch {
        logger.warn('credentials', 'Não foi possível decifrar uma credencial salva', {
          providerId: entry.providerId,
        });
      }
    }
    logger.info('credentials', 'Credenciais carregadas', { count: this.memory.size });
  }

  private persist(): void {
    const entries: PersistedFile['entries'] = [];
    for (const { secret, meta } of this.memory.values()) {
      if (!meta.persisted) continue;
      try {
        entries.push({
          credentialId: meta.credentialId,
          providerId: meta.providerId,
          masked: meta.masked,
          createdAt: meta.createdAt,
          fingerprint: meta.fingerprint,
          ciphertextBase64: this.encryptor.encryptString(secret).toString('base64'),
        });
      } catch (err) {
        logger.error('credentials', 'Falha ao cifrar credencial; ela não será salva', err);
      }
    }
    const payload: PersistedFile = { version: 1, entries };
    const tmp = `${this.filePath}.tmp`;
    try {
      if (entries.length === 0) {
        if (existsSync(this.filePath)) unlinkSync(this.filePath);
        return;
      }
      writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      logger.error('credentials', 'Falha ao gravar credenciais', err);
    }
  }

  /**
   * Guarda a credencial. `persist: true` só grava em disco se houver proteção
   * do sistema; caso contrário mantém em memória e informa isso.
   */
  set(providerId: string, secret: string, persist: boolean): { meta: CredentialMeta; warning?: string } {
    const trimmed = secret.trim();
    if (trimmed.length === 0) throw new Error('Credencial vazia');
    const previous = this.memory.get(providerId);
    if (previous) forgetSecret(previous.secret);

    let warning: string | undefined;
    let effectivePersist = persist;
    if (persist && !this.available) {
      effectivePersist = false;
      warning =
        'O armazenamento protegido do sistema não está disponível. A chave ficará apenas nesta sessão e não será gravada em disco.';
    }

    const meta: CredentialMeta = {
      credentialId: randomUUID(),
      providerId,
      masked: maskCredential(trimmed),
      persisted: effectivePersist,
      createdAt: new Date().toISOString(),
      fingerprint: fingerprintOf(trimmed),
    };
    registerSecret(trimmed);
    this.memory.set(providerId, { secret: trimmed, meta });
    this.persist();
    return { meta, warning };
  }

  /** Devolve o segredo. Só o processo principal chama isto. */
  getSecret(providerId: string): string | undefined {
    return this.memory.get(providerId)?.secret;
  }

  getMeta(providerId: string): CredentialMeta | undefined {
    return this.memory.get(providerId)?.meta;
  }

  has(providerId: string): boolean {
    return this.memory.has(providerId);
  }

  list(): CredentialMeta[] {
    return [...this.memory.values()].map((v) => v.meta);
  }

  remove(providerId: string): boolean {
    const entry = this.memory.get(providerId);
    if (!entry) return false;
    forgetSecret(entry.secret);
    this.memory.delete(providerId);
    this.persist();
    return true;
  }

  clearAll(): void {
    for (const entry of this.memory.values()) forgetSecret(entry.secret);
    this.memory.clear();
    this.persist();
  }
}

function safeIsAvailable(encryptor: SecretEncryptor): boolean {
  try {
    return encryptor.isAvailable();
  } catch {
    return false;
  }
}

/** Encryptor de teste: NÃO oferece proteção e por isso nunca persiste. */
export const UNAVAILABLE_ENCRYPTOR: SecretEncryptor = {
  isAvailable: () => false,
  encryptString: () => {
    throw new Error('Armazenamento protegido indisponível');
  },
  decryptString: () => {
    throw new Error('Armazenamento protegido indisponível');
  },
};
