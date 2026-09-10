/**
 * Diagnóstico exportável.
 *
 * O relatório é REVISÁVEL: contém versões, falhas e estado técnico, com
 * segredos redigidos. Nenhuma credencial, nem mascarada, entra no arquivo.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { release } from 'node:os';
import type { DiagnosticsReport, ProviderDescriptor } from '../../shared/domain';
import type { CodexRuntime } from '../codex/CodexRuntime';
import type { Database } from '../persistence/database';
import { redactValue } from './redact';
import { logger } from './logger';
import type { CredentialStore } from './CredentialStore';
import type { ProviderRegistry } from '../providers/registry';
import type { SettingsService } from './SettingsService';

export interface DiagnosticsDeps {
  appName: string;
  appVersion: string;
  isPackaged: boolean;
  versions: { electron: string; chrome: string; node: string };
  db: Database;
  codex: CodexRuntime;
  providers: ProviderRegistry;
  credentials: CredentialStore;
  settings: SettingsService;
  exportDir: string;
  extraNotes(): string[];
}

export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  report(): DiagnosticsReport {
    const settings = this.deps.settings.get();
    const { layout: _layout, ...settingsWithoutLayout } = settings;
    const stats = this.deps.db.store.stats();

    return {
      generatedAt: new Date().toISOString(),
      app: { name: this.deps.appName, version: this.deps.appVersion },
      runtime: {
        electron: this.deps.versions.electron,
        chrome: this.deps.versions.chrome,
        node: this.deps.versions.node,
        platform: process.platform,
        arch: process.arch,
        osRelease: release(),
      },
      codex: this.deps.codex.info(),
      providers: this.deps.providers.descriptors().map((descriptor: ProviderDescriptor) => ({
        providerId: descriptor.id,
        kind: descriptor.kind,
        state: this.deps.providers.connectionOf(descriptor.id).state,
        // Apenas se EXISTE credencial. Nem o valor, nem a máscara.
        hasCredential: this.deps.credentials.has(descriptor.id),
        baseUrl: descriptor.baseUrl,
      })),
      persistence: {
        schemaVersion: stats.schemaVersion,
        conversations: stats.tables.conversations ?? 0,
        items: stats.tables.items ?? 0,
        location: stats.location,
      },
      recentErrors: logger.getRecentErrors(),
      settings: settingsWithoutLayout,
      notes: [
        this.deps.isPackaged ? 'Executando a partir de um pacote.' : 'Executando em modo de desenvolvimento.',
        this.deps.credentials.protectionAvailable
          ? 'Armazenamento protegido do sistema disponível: credenciais podem ser salvas cifradas.'
          : 'Armazenamento protegido do sistema INDISPONÍVEL: credenciais não são gravadas em disco.',
        `Log em: ${logger.directory ?? 'não configurado'}`,
        ...this.deps.extraNotes(),
      ],
    };
  }

  /** Grava o relatório redigido em `<userData>/diagnostico-<timestamp>.json`. */
  async export(): Promise<string> {
    const report = this.report();
    const safe = redactValue(report);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(this.deps.exportDir, `codex-hub-diagnostico-${stamp}.json`);
    await writeFile(target, JSON.stringify(safe, null, 2), 'utf8');
    logger.info('diagnostics', 'Relatório de diagnóstico exportado', { target });
    return target;
  }
}
