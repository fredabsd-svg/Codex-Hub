/**
 * Configurações do aplicativo.
 *
 * O repositório de configurações guarda APENAS dados não sensíveis.
 * Chaves de API vivem no `CredentialStore`, nunca aqui.
 */

import type { AppSettings, SettingsPatch } from '../../shared/domain';
import type { PreferencesRepository } from '../persistence/repositories';
import type { EventBus } from './EventBus';
import { logger } from './logger';

/** Campos que nunca podem chegar às configurações. */
const FORBIDDEN_KEYS = new Set(['apiKey', 'apikey', 'token', 'secret', 'password', 'authorization']);

export class SettingsService {
  constructor(
    private readonly prefs: PreferencesRepository,
    private readonly bus: EventBus,
    private readonly onChange?: (settings: AppSettings, previous: AppSettings) => void,
  ) {}

  get(): AppSettings {
    return this.prefs.getSettings();
  }

  update(patch: SettingsPatch): AppSettings {
    for (const key of Object.keys(patch)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        logger.error('settings', 'Tentativa de gravar campo sensível nas configurações foi bloqueada', { key });
        delete (patch as Record<string, unknown>)[key];
      }
    }
    const previous = this.get();
    const next = this.prefs.updateSettings(patch);
    if (next.diagnosticsLogLevel !== previous.diagnosticsLogLevel || next.diagnosticsEnabled !== previous.diagnosticsEnabled) {
      logger.configure({ level: next.diagnosticsLogLevel, enabled: next.diagnosticsEnabled });
    }
    this.onChange?.(next, previous);
    this.bus.emitApp({ type: 'settings/updated', at: new Date().toISOString() });
    return next;
  }

  isOnboardingCompleted(): boolean {
    return this.prefs.isOnboardingCompleted();
  }

  completeOnboarding(): void {
    this.prefs.setOnboardingCompleted(true);
  }
}
