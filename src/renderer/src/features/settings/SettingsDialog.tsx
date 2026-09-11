/**
 * Configurações.
 *
 * Separa preferências gerais, padrões por provedor e parâmetros de conversa.
 * O repositório de configurações guarda apenas dados NÃO sensíveis.
 */

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AppSettings } from '@shared/domain';
import { codexProviderConfigToml, CODEX_OPENROUTER_PROVIDER_ID } from '@shared/codexProvider';
import { t } from '../../i18n';
import { errorOf, invoke } from '../../lib/api';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useUiStore } from '../../stores/uiStore';
import {
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Kbd,
  SectionTitle,
  Select,
  Spinner,
  Switch,
  Textarea,
} from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { IconAlert, IconExternal, IconKey, IconRefresh, IconTrash } from '../../components/ui/icons';

type SectionId =
  | 'appearance'
  | 'chat'
  | 'defaults'
  | 'providers'
  | 'codex'
  | 'permissions'
  | 'tools'
  | 'attachments'
  | 'shortcuts'
  | 'diagnostics';

const SECTIONS: Array<{ id: SectionId; label: string }> = [
  { id: 'appearance', label: t('settings.sections.appearance') },
  { id: 'chat', label: t('settings.sections.chat') },
  { id: 'defaults', label: t('settings.sections.defaults') },
  { id: 'providers', label: t('settings.sections.providers') },
  { id: 'codex', label: t('settings.sections.codex') },
  { id: 'permissions', label: t('settings.sections.permissions') },
  { id: 'tools', label: t('settings.sections.tools') },
  { id: 'attachments', label: t('settings.sections.attachments') },
  { id: 'shortcuts', label: t('settings.sections.shortcuts') },
  { id: 'diagnostics', label: t('settings.sections.diagnostics') },
];

const SECTION_IDS = new Set<string>(SECTIONS.map((entry) => entry.id));

export function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const requestedSection = useUiStore((state) => state.settingsSection);
  const [section, setSection] = useState<SectionId>('appearance');

  // O diálogo fica montado o tempo todo: a seção pedida por `openDialog`
  // (ex.: "Configurações › Codex" em um aviso) é aplicada a cada abertura.
  useEffect(() => {
    if (open && SECTION_IDS.has(requestedSection)) setSection(requestedSection as SectionId);
  }, [open, requestedSection]);

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.title')} width={880}>
      <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
        <nav aria-label={t('settings.title')} className="flex flex-col gap-0.5">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setSection(entry.id)}
              aria-current={section === entry.id ? 'true' : undefined}
              className={clsx(
                'rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px] transition-colors',
                section === entry.id
                  ? 'font-medium text-[var(--text)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-3)] hover:text-[var(--text)]',
              )}
              style={section === entry.id ? { background: 'var(--accent-soft)' } : undefined}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          {section === 'appearance' ? <AppearanceSection /> : null}
          {section === 'chat' ? <ChatSection /> : null}
          {section === 'defaults' ? <DefaultsSection /> : null}
          {section === 'shortcuts' ? <ShortcutsSection /> : null}
          {section === 'providers' ? <ProvidersSection /> : null}
          {section === 'codex' ? <CodexSection /> : null}
          {section === 'permissions' ? <PermissionsSection /> : null}
          {section === 'tools' ? <ToolsSection /> : null}
          {section === 'attachments' ? <AttachmentsSection /> : null}
          {section === 'diagnostics' ? <DiagnosticsSection /> : null}
        </div>
      </div>
    </Dialog>
  );
}

function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const settings = useAppStore((state) => state.settings);
  const applySettings = useAppStore((state) => state.applySettings);
  return [settings, (patch) => void applySettings(patch)];
}

/* -------------------- Aparência -------------------- */

function AppearanceSection() {
  const [settings, update] = useSettings();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.appearance')}</SectionTitle>
      <Field label={t('settings.theme')} htmlFor="settings-theme">
        <Select
          id="settings-theme"
          value={settings.theme}
          onChange={(event) => update({ theme: event.target.value as AppSettings['theme'] })}
        >
          <option value="dark">{t('settings.themeDark')}</option>
          <option value="light">{t('settings.themeLight')}</option>
          <option value="system">{t('settings.themeSystem')}</option>
        </Select>
      </Field>
      <Field
        label={`${t('settings.fontScale')} (${Math.round(settings.fontScale * 100)}%)`}
        hint={t('settings.fontScaleHint')}
        htmlFor="settings-font"
      >
        <input
          id="settings-font"
          type="range"
          min={0.85}
          max={1.5}
          step={0.05}
          value={settings.fontScale}
          onChange={(event) => update({ fontScale: Number(event.target.value) })}
          className="w-full"
        />
      </Field>
      <Field label={t('settings.density')} htmlFor="settings-density">
        <Select
          id="settings-density"
          value={settings.density}
          onChange={(event) => update({ density: event.target.value as AppSettings['density'] })}
        >
          <option value="comfortable">{t('settings.densityComfortable')}</option>
          <option value="compact">{t('settings.densityCompact')}</option>
        </Select>
      </Field>
      <Field label={t('settings.reduceMotion')} htmlFor="settings-motion">
        <Select
          id="settings-motion"
          value={settings.reduceMotion}
          onChange={(event) => update({ reduceMotion: event.target.value as AppSettings['reduceMotion'] })}
        >
          <option value="system">{t('settings.reduceMotionSystem')}</option>
          <option value="always">{t('settings.reduceMotionAlways')}</option>
          <option value="never">{t('settings.reduceMotionNever')}</option>
        </Select>
      </Field>
    </section>
  );
}

/* -------------------- Conversa -------------------- */

function ChatSection() {
  const [settings, update] = useSettings();
  const [instructions, setInstructions] = useState(settings.customInstructions ?? '');
  useEffect(() => setInstructions(settings.customInstructions ?? ''), [settings.customInstructions]);
  const dirty = instructions !== (settings.customInstructions ?? '');

  return (
    <section className="space-y-4">
      <SectionTitle>{t('settings.sections.chat')}</SectionTitle>
      <Switch
        checked={settings.sendWithEnter}
        onChange={(value) => update({ sendWithEnter: value })}
        label={t('settings.sendWithEnter')}
        hint={t('settings.sendWithEnterHint')}
      />
      <Switch
        checked={settings.showReasoningSummaries}
        onChange={(value) => update({ showReasoningSummaries: value })}
        label={t('settings.showReasoning')}
        hint={t('settings.showReasoningHint')}
      />
      <Field label={t('settings.chatWidth')} htmlFor="settings-chat-width">
        <Select
          id="settings-chat-width"
          value={settings.chatWidth}
          onChange={(event) => update({ chatWidth: event.target.value as AppSettings['chatWidth'] })}
        >
          <option value="comfortable">{t('settings.chatWidthComfortable')}</option>
          <option value="wide">{t('settings.chatWidthWide')}</option>
        </Select>
      </Field>
      <Field
        label={t('settings.customInstructions')}
        hint={t('settings.customInstructionsHint')}
        htmlFor="settings-instructions"
      >
        <Textarea
          id="settings-instructions"
          rows={5}
          maxLength={4000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t('settings.customInstructionsPlaceholder')}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-faint)]">{instructions.length} / 4000</span>
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            disabledReason="Nada a salvar."
            onClick={() => update({ customInstructions: instructions.trim() })}
          >
            {t('common.save')}
          </Button>
        </div>
      </Field>
    </section>
  );
}

/* -------------------- Atalhos -------------------- */

const SHORTCUTS: Array<{
  keys: string[];
  label:
    | 'newConversation'
    | 'palette'
    | 'find'
    | 'workspace'
    | 'attach'
    | 'send'
    | 'settings'
    | 'sidebar'
    | 'rightPanel'
    | 'escape';
}> = [
  { keys: ['Ctrl', 'N'], label: 'newConversation' },
  { keys: ['Ctrl', 'K'], label: 'palette' },
  { keys: ['Ctrl', 'F'], label: 'find' },
  { keys: ['Ctrl', 'O'], label: 'workspace' },
  { keys: ['Ctrl', 'Shift', 'O'], label: 'attach' },
  { keys: ['Ctrl', 'Enter'], label: 'send' },
  { keys: ['Ctrl', ','], label: 'settings' },
  { keys: ['Ctrl', 'B'], label: 'sidebar' },
  { keys: ['Ctrl', 'J'], label: 'rightPanel' },
  { keys: ['Esc'], label: 'escape' },
];

function ShortcutsSection() {
  const [settings] = useSettings();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('shortcuts.title')}</SectionTitle>
      <dl className="ch-raised divide-y" style={{ borderColor: 'var(--border)' }}>
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.label}
            className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px]"
          >
            <dt className="text-[var(--text)]">
              {shortcut.label === 'send' && settings.sendWithEnter
                ? t('shortcuts.sendEnter')
                : t(`shortcuts.${shortcut.label}`)}
            </dt>
            <dd className="flex flex-none items-center gap-0.5">
              {(shortcut.label === 'send' && settings.sendWithEnter ? ['Enter'] : shortcut.keys).map(
                (key, index) => (
                  <span key={`${shortcut.label}-${index}`} className="flex items-center gap-0.5">
                    {index > 0 ? <span className="text-[var(--text-faint)]">+</span> : null}
                    <Kbd>{key}</Kbd>
                  </span>
                ),
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">{t('shortcuts.note')}</p>
    </section>
  );
}

/* -------------------- Padrões -------------------- */

function DefaultsSection() {
  const [settings, update] = useSettings();
  const providers = useAppStore((state) => state.providers);
  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.defaults')}</SectionTitle>
      <Field label={t('settings.defaultProvider')} htmlFor="settings-provider">
        <Select
          id="settings-provider"
          value={settings.defaultProviderId ?? ''}
          onChange={(event) => update({ defaultProviderId: event.target.value || undefined })}
        >
          <option value="">Nenhum</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t('settings.defaultModel')}
        hint="ID exato do modelo. Ele é validado no primeiro uso."
        htmlFor="settings-model"
      >
        <Input
          id="settings-model"
          value={settings.defaultModelId ?? ''}
          onChange={(event) => update({ defaultModelId: event.target.value || undefined })}
          spellCheck={false}
        />
      </Field>
      <Field label={t('settings.defaultEngine')} htmlFor="settings-engine">
        <Select
          id="settings-engine"
          value={settings.defaultEngineId}
          onChange={(event) =>
            update({ defaultEngineId: event.target.value as AppSettings['defaultEngineId'] })
          }
        >
          <option value="direct">Motor direto</option>
          <option value="codex">Codex App Server</option>
        </Select>
      </Field>
      <Field label={t('settings.defaultEffort')} htmlFor="settings-effort">
        <Select
          id="settings-effort"
          value={settings.defaultReasoningEffort ?? ''}
          onChange={(event) =>
            update({
              defaultReasoningEffort: (event.target.value ||
                undefined) as AppSettings['defaultReasoningEffort'],
            })
          }
        >
          <option value="">Padrão do modelo</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </Select>
      </Field>
      <Field label={t('settings.defaultMode')} htmlFor="settings-mode">
        <Select
          id="settings-mode"
          value={settings.defaultMode}
          onChange={(event) => update({ defaultMode: event.target.value as AppSettings['defaultMode'] })}
        >
          <option value="chat">{t('header.modes.chat')}</option>
          <option value="plan">{t('header.modes.plan')}</option>
          <option value="execute">{t('header.modes.execute')}</option>
        </Select>
      </Field>
      <Field label={t('settings.startup')} htmlFor="settings-startup">
        <Select
          id="settings-startup"
          value={settings.startupBehavior}
          onChange={(event) =>
            update({ startupBehavior: event.target.value as AppSettings['startupBehavior'] })
          }
        >
          <option value="newConversation">{t('settings.startupNew')}</option>
          <option value="lastConversation">{t('settings.startupLast')}</option>
          <option value="home">{t('settings.startupHome')}</option>
        </Select>
      </Field>
      <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
        Estes são apenas padrões para novas conversas. Cada conversa mantém os próprios parâmetros, alteráveis
        a qualquer momento para o próximo turno.
      </p>
    </section>
  );
}

/* -------------------- Provedores -------------------- */

function ProvidersSection() {
  const providers = useAppStore((state) => state.providers);
  const connections = useAppStore((state) => state.connections);
  const connectProvider = useAppStore((state) => state.connectProvider);
  const disconnectProvider = useAppStore((state) => state.disconnectProvider);
  const registerCompatible = useAppStore((state) => state.registerCompatible);
  const pushError = useUiStore((state) => state.pushError);
  const pushToast = useUiStore((state) => state.pushToast);

  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [newEndpoint, setNewEndpoint] = useState({ label: '', baseUrl: '', apiKey: '' });

  const connect = async (providerId: string): Promise<void> => {
    setBusy(providerId);
    try {
      const connection = await connectProvider(providerId, keys[providerId]?.trim() || undefined, true);
      // Limpa o campo imediatamente depois do envio.
      setKeys((current) => ({ ...current, [providerId]: '' }));
      pushToast({
        tone: connection.state === 'connected' ? 'success' : 'warning',
        title: connection.message ?? 'Estado atualizado',
        body: connection.actionHint,
      });
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível conectar');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-4">
      <SectionTitle>{t('settings.sections.providers')}</SectionTitle>

      {providers
        .filter((provider) => provider.kind !== 'codex')
        .map((provider) => {
          const connection = connections[provider.id];
          return (
            <div key={provider.id} className="ch-raised space-y-2 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[var(--text)]">{provider.label}</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">
                    {provider.description}
                  </p>
                  {provider.baseUrl ? (
                    <p className="ch-mono mt-1 truncate text-[11.5px] text-[var(--text-faint)]">
                      {provider.baseUrl}
                    </p>
                  ) : null}
                </div>
                <Badge
                  tone={
                    connection?.state === 'connected'
                      ? 'success'
                      : connection?.state === 'unauthorized'
                        ? 'danger'
                        : connection?.state === 'unavailable'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {connection?.state ?? 'desconhecido'}
                </Badge>
              </div>

              {connection?.maskedCredential ? (
                <p className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
                  <IconKey size={13} />
                  {t('settings.credentialStored', { masked: connection.maskedCredential })}
                </p>
              ) : (
                <p className="text-[12px] text-[var(--text-faint)]">{t('settings.noCredential')}</p>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1">
                  <label
                    htmlFor={`key-${provider.id}`}
                    className="mb-1 block text-[12px] text-[var(--text-muted)]"
                  >
                    {t('onboarding.apiKeyLabel')}
                  </label>
                  <Input
                    id={`key-${provider.id}`}
                    type="password"
                    autoComplete="off"
                    value={keys[provider.id] ?? ''}
                    onChange={(event) =>
                      setKeys((current) => ({ ...current, [provider.id]: event.target.value }))
                    }
                    className="h-8"
                  />
                </div>
                <Button size="sm" loading={busy === provider.id} onClick={() => void connect(provider.id)}>
                  {t('common.connect')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void invoke('providers:test', { providerId: provider.id })}
                >
                  {t('common.test')}
                </Button>
                {connection?.maskedCredential ? (
                  <Button size="sm" variant="ghost" onClick={() => void disconnectProvider(provider.id)}>
                    {t('common.disconnect')}
                  </Button>
                ) : null}
                {provider.userDefined ? (
                  <IconButton
                    label={t('settings.removeProvider')}
                    tone="danger"
                    onClick={() => void invoke('providers:removeCompatible', { providerId: provider.id })}
                  >
                    <IconTrash size={14} />
                  </IconButton>
                ) : null}
                {provider.docsUrl ? (
                  <IconButton
                    label={t('common.openInBrowser')}
                    onClick={() => void invoke('shell:openExternal', { url: provider.docsUrl as string })}
                  >
                    <IconExternal size={14} />
                  </IconButton>
                ) : null}
              </div>
            </div>
          );
        })}

      <div className="ch-raised space-y-2 p-3">
        <p className="text-[13.5px] font-semibold text-[var(--text)]">{t('settings.addCompatible')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('onboarding.labelLabel')} htmlFor="new-endpoint-label">
            <Input
              id="new-endpoint-label"
              value={newEndpoint.label}
              onChange={(event) => setNewEndpoint((current) => ({ ...current, label: event.target.value }))}
              className="h-8"
            />
          </Field>
          <Field label={t('onboarding.baseUrlLabel')} htmlFor="new-endpoint-url">
            <Input
              id="new-endpoint-url"
              value={newEndpoint.baseUrl}
              onChange={(event) => setNewEndpoint((current) => ({ ...current, baseUrl: event.target.value }))}
              placeholder={t('onboarding.baseUrlPlaceholder')}
              className="h-8"
              spellCheck={false}
            />
          </Field>
          <Field
            label={`${t('onboarding.apiKeyLabel')} (${t('common.optional')})`}
            htmlFor="new-endpoint-key"
          >
            <Input
              id="new-endpoint-key"
              type="password"
              autoComplete="off"
              value={newEndpoint.apiKey}
              onChange={(event) => setNewEndpoint((current) => ({ ...current, apiKey: event.target.value }))}
              className="h-8"
            />
          </Field>
        </div>
        <Button
          size="sm"
          onClick={() => {
            void registerCompatible({
              label: newEndpoint.label,
              baseUrl: newEndpoint.baseUrl,
              apiKey: newEndpoint.apiKey || undefined,
              persist: true,
            });
            setNewEndpoint({ label: '', baseUrl: '', apiKey: '' });
          }}
          disabled={newEndpoint.baseUrl.trim() === ''}
          disabledReason="Informe a URL base do endpoint."
        >
          {t('common.add')}
        </Button>
        <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
          HTTPS é exigido para hosts remotos. HTTP é aceito para endereços locais (127.0.0.1, localhost,
          faixas privadas). Credenciais nunca são reaproveitadas entre provedores nem encaminhadas em
          redirecionamentos para outro host.
        </p>
      </div>
    </section>
  );
}

/* -------------------- Codex -------------------- */

function CodexSection() {
  const [settings, update] = useSettings();
  const codex = useAppStore((state) => state.codex);
  const account = useAppStore((state) => state.codexAccount);
  const login = useAppStore((state) => state.codexLogin);
  const pushError = useUiStore((state) => state.pushError);
  const [path, setPath] = useState(settings.codexExecutablePath ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    try {
      await action();
    } catch (err) {
      pushError(errorOf(err), `Falha em ${label}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.codex')}</SectionTitle>

      <div className="ch-raised space-y-2 p-3 text-[12.5px]">
        <dl className="space-y-1">
          <Row label="Encontrado" value={codex?.found ? 'sim' : 'não'} />
          {codex?.executablePath ? <Row label="Caminho" value={codex.executablePath} mono /> : null}
          {codex?.discoveredVia ? <Row label="Descoberto por" value={codex.discoveredVia} /> : null}
          {codex?.version ? <Row label="Versão" value={codex.version} mono /> : null}
          <Row label="Handshake concluído" value={codex?.initialized ? 'sim' : 'não'} />
          {codex?.protocolVersionReported ? (
            <Row label="Versão do protocolo" value={codex.protocolVersionReported} mono />
          ) : null}
          <Row label="Reinícios nesta sessão" value={String(codex?.restartCount ?? 0)} />
        </dl>
        {codex?.diagnostic ? (
          <p className="flex items-start gap-1.5 text-[var(--warning)]">
            <IconAlert size={14} className="mt-[2px] flex-none" />
            <span>
              {codex.diagnostic.message}
              {codex.diagnostic.action ? (
                <span className="mt-0.5 block text-[var(--text-muted)]">{codex.diagnostic.action}</span>
              ) : null}
            </span>
          </p>
        ) : null}
        {codex?.generatedTypesAreProvisional ? (
          <p className="text-[11.5px] leading-snug text-[var(--warning)]">
            {t('settings.codexTypesProvisional')}
          </p>
        ) : (
          <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
            Tipos gerados a partir da versão {codex?.generatedTypesVersion ?? '—'}.
          </p>
        )}
      </div>

      <Field
        label={t('settings.codexPath')}
        htmlFor="codex-path"
        hint="Deixe vazio para usar o PATH do sistema."
      >
        <div className="flex gap-2">
          <Input
            id="codex-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('settings.codexPathPlaceholder')}
            spellCheck={false}
          />
          <Button
            size="md"
            loading={busy === 'locate'}
            onClick={() =>
              void run('locate', async () => {
                update({ codexExecutablePath: path.trim() || undefined });
                await invoke('codex:locate', { executablePath: path.trim() || undefined });
              })
            }
          >
            {t('settings.codexLocate')}
          </Button>
        </div>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy === 'start'}
          onClick={() => void run('start', () => invoke('codex:start'))}
        >
          {t('settings.codexConnect')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === 'stop'}
          onClick={() => void run('stop', () => invoke('codex:stop'))}
        >
          {t('settings.codexDisconnect')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          loading={busy === 'account'}
          onClick={() => void run('account', () => invoke('codex:account'))}
          iconLeft={<IconRefresh />}
        >
          Ler conta
        </Button>
      </div>

      <CodexModelProviderBlock />

      <div className="ch-raised space-y-2 p-3">
        <p className="text-[13px] font-semibold text-[var(--text)]">{t('settings.codexAuth')}</p>
        {account ? (
          <dl className="space-y-1 text-[12.5px]">
            <Row label="Autenticado" value={account.authenticated ? 'sim' : 'não'} />
            {account.method ? <Row label="Método" value={account.method} /> : null}
            {account.accountLabel ? <Row label="Conta" value={account.accountLabel} /> : null}
            {account.planLabel ? <Row label="Plano" value={account.planLabel} /> : null}
            {account.message ? <Row label="Mensagem" value={account.message} /> : null}
          </dl>
        ) : (
          <p className="text-[12.5px] text-[var(--text-muted)]">
            A conta ainda não foi lida. Conecte o Codex e use "Ler conta".
          </p>
        )}

        {account?.rateLimits?.length ? (
          <dl className="space-y-1 text-[12.5px]">
            {account.rateLimits.map((limit) => (
              <Row
                key={limit.label}
                label={limit.label}
                value={
                  limit.usedPercent !== undefined
                    ? `${limit.usedPercent.toFixed(0)}% usado${limit.resetsAt ? ` · renova ${formatDateTime(limit.resetsAt)}` : ''}`
                    : limit.limit !== undefined
                      ? `limite ${limit.limit}`
                      : '—'
                }
              />
            ))}
          </dl>
        ) : null}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            loading={busy === 'chatgpt'}
            onClick={() => void run('chatgpt', () => invoke('codex:loginStart', { method: 'chatgpt' }))}
          >
            {t('settings.codexLoginChatgpt')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            loading={busy === 'device'}
            onClick={() => void run('device', () => invoke('codex:loginStart', { method: 'deviceCode' }))}
          >
            {t('settings.codexLoginDevice')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'logout'}
            onClick={() => void run('logout', () => invoke('codex:logout'))}
          >
            {t('settings.codexLogout')}
          </Button>
        </div>

        {login && (login.state === 'pendingDeviceCode' || login.state === 'pendingBrowser') ? (
          <div className="ch-inset space-y-1.5 p-2.5 text-[12.5px]">
            <p className="flex items-center gap-2 text-[var(--text)]">
              <Spinner size={12} />
              {login.state === 'pendingDeviceCode'
                ? 'Aguardando a confirmação do código de dispositivo…'
                : 'Aguardando a conclusão do login no navegador…'}
            </p>
            {login.userCode ? (
              <p>
                {t('settings.codexDeviceCode')}: <strong className="ch-mono">{login.userCode}</strong>
              </p>
            ) : null}
            {login.verificationUri ? (
              <p className="flex items-center gap-2">
                {t('settings.codexDeviceUri')}:
                <button
                  type="button"
                  className="text-[var(--accent)] underline underline-offset-2"
                  onClick={() =>
                    void invoke('shell:openExternal', {
                      url: login.verificationUriComplete ?? (login.verificationUri as string),
                    })
                  }
                >
                  {login.verificationUri}
                </button>
              </p>
            ) : null}
            {login.expiresAt ? (
              <p className="text-[var(--text-faint)]">Expira em {formatDateTime(login.expiresAt)}</p>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void invoke('codex:loginCancel', { loginId: login.loginId })}
            >
              {t('common.cancel')}
            </Button>
          </div>
        ) : null}

        <div className="border-t pt-2">
          <Field
            label={t('settings.codexLoginApiKey')}
            hint={t('settings.codexApiKeyWarning')}
            htmlFor="codex-api-key"
          >
            <div className="flex gap-2">
              <Input
                id="codex-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <Button
                size="md"
                loading={busy === 'apiKey'}
                disabled={apiKey.trim() === ''}
                disabledReason="Informe a chave da OpenAI usada pelo Codex."
                onClick={() =>
                  void run('apiKey', async () => {
                    await invoke('codex:loginStart', { method: 'apiKey', apiKey: apiKey.trim() });
                    setApiKey('');
                  })
                }
              >
                {t('common.apply')}
              </Button>
            </div>
          </Field>
        </div>
      </div>
    </section>
  );
}

/* -------------------- Provedor de modelos do Codex -------------------- */

const PROVIDER_STATE_TONE: Record<string, 'neutral' | 'success' | 'warning'> = {
  default: 'neutral',
  requested: 'warning',
  accepted: 'success',
  missingCredential: 'warning',
  overridesRejected: 'warning',
};

/**
 * Escolha do provedor que o PROCESSO DO CODEX usa.
 *
 * É diferente de escolher o modelo da conversa: aqui se decide de onde o Codex
 * tira a inferência. O padrão continua sendo o provedor do próprio Codex, e o
 * motor direto do aplicativo não é afetado por esta opção.
 */
function CodexModelProviderBlock() {
  const [settings, update] = useSettings();
  const codex = useAppStore((state) => state.codex);
  const connections = useAppStore((state) => state.connections);
  const pushToast = useUiStore((state) => state.pushToast);

  const mode = settings.codexModelProvider;
  const info = codex?.modelProvider;
  // Mesmo identificador do provedor OpenRouter registrado no processo principal.
  const openRouter = connections[CODEX_OPENROUTER_PROVIDER_ID];
  const hasCredential = Boolean(openRouter?.maskedCredential);
  const snippet = codexProviderConfigToml({ mode, wireApi: settings.codexWireApi });

  return (
    <div className="ch-raised space-y-2 p-3">
      <p className="text-[13px] font-semibold text-[var(--text)]">{t('settings.codexProviderTitle')}</p>
      <p className="text-[12px] leading-snug text-[var(--text-muted)]">{t('settings.codexProviderIntro')}</p>

      <Field label={t('settings.codexProviderLabel')} htmlFor="codex-model-provider">
        <Select
          id="codex-model-provider"
          value={mode}
          onChange={(event) => update({ codexModelProvider: event.target.value as AppSettings['codexModelProvider'] })}
        >
          <option value="default">{t('settings.codexProviderDefault')}</option>
          <option value="openrouter">{t('settings.codexProviderOpenRouter')}</option>
        </Select>
      </Field>

      {mode === 'openrouter' ? (
        <div className="space-y-2">
          <Field label={t('settings.codexWireApi')} hint={t('settings.codexWireApiHint')} htmlFor="codex-wire-api">
            <Select
              id="codex-wire-api"
              value={settings.codexWireApi}
              onChange={(event) => update({ codexWireApi: event.target.value as AppSettings['codexWireApi'] })}
            >
              <option value="chat">chat</option>
              <option value="responses">responses</option>
            </Select>
          </Field>

          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <Badge tone={PROVIDER_STATE_TONE[info?.state ?? 'requested'] ?? 'neutral'}>
              {t(`settings.codexProviderState.${info?.state ?? 'requested'}` as 'settings.codexProviderState.requested')}
            </Badge>
            {hasCredential ? (
              <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
                <IconKey size={13} />
                {t('settings.credentialStored', { masked: openRouter?.maskedCredential ?? '' })}
              </span>
            ) : (
              <span className="text-[var(--warning)]">{t('settings.codexProviderNoCredential')}</span>
            )}
          </div>

          {/* A falta de credencial já é dita na linha acima: não repetimos. */}
          {info?.note && info.state !== 'missingCredential' ? (
            <p className="text-[11.5px] leading-snug text-[var(--text-muted)]">{info.note}</p>
          ) : null}

          <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--text-faint)]">
            <IconKey size={13} className="mt-[2px] flex-none" />
            <span>{t('settings.codexProviderSecurity')}</span>
          </p>

          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
                {t('settings.codexProviderToml')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  void invoke('clipboard:writeText', { text: snippet });
                  pushToast({ tone: 'success', title: t('settings.codexProviderTomlCopied') });
                }}
              >
                {t('common.copy')}
              </Button>
            </div>
            <pre className="ch-mono overflow-x-auto rounded-[var(--radius-sm)] border p-2 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
              {snippet}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------- Permissões -------------------- */

function PermissionsSection() {
  const [settings, update] = useSettings();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.permissions')}</SectionTitle>
      <Field label={t('settings.approvalPolicy')} htmlFor="settings-approval">
        <Select
          id="settings-approval"
          value={settings.approvalPolicy}
          onChange={(event) =>
            update({ approvalPolicy: event.target.value as AppSettings['approvalPolicy'] })
          }
        >
          <option value="always">{t('settings.approvalAlways')}</option>
          <option value="onRequest">{t('settings.approvalOnRequest')}</option>
          <option value="onFailure">{t('settings.approvalOnFailure')}</option>
          <option value="never">{t('settings.approvalNever')}</option>
        </Select>
      </Field>
      <Field label={t('settings.sandbox')} htmlFor="settings-sandbox">
        <Select
          id="settings-sandbox"
          value={settings.sandboxPolicy}
          onChange={(event) => update({ sandboxPolicy: event.target.value as AppSettings['sandboxPolicy'] })}
        >
          <option value="readOnly">{t('settings.sandboxReadOnly')}</option>
          <option value="workspaceWrite">{t('settings.sandboxWorkspace')}</option>
          <option value="dangerFullAccess">{t('settings.sandboxFull')}</option>
        </Select>
      </Field>
      <Field
        label={t('settings.toolNetwork')}
        hint="Isto se refere à rede usada pelas FERRAMENTAS do agente. A rede da API de inferência é separada e sempre necessária para provedores remotos."
        htmlFor="settings-network"
      >
        <Select
          id="settings-network"
          value={settings.toolNetworkPolicy}
          onChange={(event) =>
            update({ toolNetworkPolicy: event.target.value as AppSettings['toolNetworkPolicy'] })
          }
        >
          <option value="blocked">{t('settings.networkBlocked')}</option>
          <option value="workspaceAllowed">{t('settings.networkWorkspace')}</option>
          <option value="allowed">{t('settings.networkAllowed')}</option>
        </Select>
      </Field>
      <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
        A política escolhida aqui é a SOLICITADA. No motor Codex, quem aplica sandbox e rede das ferramentas é
        o runtime oficial — a barra de status mostra se houve confirmação. No motor direto, as ferramentas
        estruturadas não acessam a rede.
      </p>
    </section>
  );
}

/* -------------------- Ferramentas -------------------- */

function ToolsSection() {
  const [settings, update] = useSettings();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.tools')}</SectionTitle>
      <Field label={t('settings.toolMaxSteps')} htmlFor="tool-steps">
        <Input
          id="tool-steps"
          type="number"
          min={1}
          max={200}
          value={settings.toolMaxSteps}
          onChange={(event) => update({ toolMaxSteps: Number(event.target.value) })}
        />
      </Field>
      <Field label={t('settings.toolMaxDuration')} htmlFor="tool-duration">
        <Input
          id="tool-duration"
          type="number"
          min={10}
          max={3600}
          value={Math.round(settings.toolMaxDurationMs / 1000)}
          onChange={(event) => update({ toolMaxDurationMs: Number(event.target.value) * 1000 })}
        />
      </Field>
      <Field label={t('settings.toolMaxResult')} htmlFor="tool-result">
        <Input
          id="tool-result"
          type="number"
          min={1}
          max={8192}
          value={Math.round(settings.toolMaxResultBytes / 1024)}
          onChange={(event) => update({ toolMaxResultBytes: Number(event.target.value) * 1024 })}
        />
      </Field>
      <p
        className="rounded-[var(--radius-sm)] border px-2.5 py-2 text-[11.5px] leading-snug"
        style={{ background: 'var(--warning-soft)', borderColor: 'var(--warning)', color: 'var(--text)' }}
      >
        {t('settings.toolShellNote')}
      </p>
    </section>
  );
}

/* -------------------- Anexos -------------------- */

function AttachmentsSection() {
  const [settings, update] = useSettings();
  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.attachments')}</SectionTitle>
      <Field label={t('settings.attachmentMaxCount')} htmlFor="attach-count">
        <Input
          id="attach-count"
          type="number"
          min={1}
          max={200}
          value={settings.attachmentMaxCount}
          onChange={(event) => update({ attachmentMaxCount: Number(event.target.value) })}
        />
      </Field>
      <Field
        label={t('settings.attachmentMaxBytes')}
        hint={`Atual: ${formatBytes(settings.attachmentMaxBytes)}`}
        htmlFor="attach-bytes"
      >
        <Input
          id="attach-bytes"
          type="number"
          min={1}
          max={512}
          value={Math.round(settings.attachmentMaxBytes / (1024 * 1024))}
          onChange={(event) => update({ attachmentMaxBytes: Number(event.target.value) * 1024 * 1024 })}
        />
      </Field>
      <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
        Anexos são copiados para <code className="ch-mono">.codex-hub/anexos</code> dentro do workspace, com
        nome seguro e sem conflito. Nada é executado, e o workspace inteiro nunca é enviado automaticamente.
        Antes do primeiro envio, a interface indica qual serviço vai receber o conteúdo.
      </p>
    </section>
  );
}

/* -------------------- Diagnóstico -------------------- */

function DiagnosticsSection() {
  const [settings, update] = useSettings();
  const pushToast = useUiStore((state) => state.pushToast);
  const pushError = useUiStore((state) => state.pushError);
  const [busy, setBusy] = useState(false);

  return (
    <section className="space-y-3">
      <SectionTitle>{t('settings.sections.diagnostics')}</SectionTitle>
      <Switch
        checked={settings.diagnosticsEnabled}
        onChange={(value) => update({ diagnosticsEnabled: value })}
        label={t('settings.diagnosticsEnabled')}
        hint="Os logs ficam na pasta de logs do usuário, com rotação e segredos redigidos."
      />
      <Field label={t('settings.diagnosticsLevel')} htmlFor="log-level">
        <Select
          id="log-level"
          value={settings.diagnosticsLogLevel}
          onChange={(event) =>
            update({ diagnosticsLogLevel: event.target.value as AppSettings['diagnosticsLogLevel'] })
          }
        >
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </Select>
      </Field>
      <Switch
        checked={settings.developerMode}
        onChange={(value) => update({ developerMode: value })}
        label={t('settings.developerMode')}
        hint={t('settings.developerModeHelp')}
      />
      <Switch
        checked={settings.demoMode}
        onChange={(value) => update({ demoMode: value })}
        label={t('settings.demoMode')}
        hint={t('settings.demoModeHelp')}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void invoke('diagnostics:export')
              .then((result) => {
                if (result.path) {
                  pushToast({
                    tone: 'success',
                    title: t('settings.diagnosticsExported', { path: result.path }),
                    body: 'O arquivo é revisável e tem os segredos redigidos.',
                  });
                }
              })
              .catch((err) => pushError(errorOf(err), 'Não foi possível exportar o diagnóstico'))
              .finally(() => setBusy(false));
          }}
        >
          {t('settings.exportDiagnostics')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('diagnostics:openLogFolder')}>
          {t('settings.openLogFolder')}
        </Button>
      </div>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd
        className={clsx('min-w-0 break-all text-right text-[var(--text)]', mono && 'ch-mono')}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
