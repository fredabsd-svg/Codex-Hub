/**
 * Fluxo inicial.
 *
 * O OpenRouter aparece PRIMEIRO e não exige conta ChatGPT. Preferências
 * avançadas não bloqueiam a primeira conversa: é possível conectar e começar,
 * ou pular e configurar depois.
 */

import { useState } from 'react';
import clsx from 'clsx';
import { t } from '../../i18n';
import { errorOf, invoke } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, Field, Input, Switch } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { IconAlert, IconKey, IconPlug, IconSpark, IconTerminal } from '../../components/ui/icons';

type Path = 'openrouter' | 'codex' | 'compatible';

export function OnboardingDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const codex = useAppStore((state) => state.codex);
  const connections = useAppStore((state) => state.connections);
  const notices = useAppStore((state) => state.notices);
  const connectProvider = useAppStore((state) => state.connectProvider);
  const registerCompatible = useAppStore((state) => state.registerCompatible);
  const pushError = useUiStore((state) => state.pushError);
  const pushToast = useUiStore((state) => state.pushToast);

  const [path, setPath] = useState<Path>('openrouter');
  const [apiKey, setApiKey] = useState('');
  const [persist, setPersist] = useState(true);
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [label, setLabel] = useState('Serviço local');
  const [busy, setBusy] = useState(false);

  const protectionUnavailable = notices.some((notice) => notice.message.includes('armazenamento protegido'));

  const connectOpenRouter = async (): Promise<void> => {
    setBusy(true);
    try {
      const connection = await connectProvider('openrouter', apiKey.trim() || undefined, persist);
      // A chave é limpa do campo imediatamente após o envio.
      setApiKey('');
      if (connection.state === 'connected') {
        pushToast({ tone: 'success', title: t('onboarding.successTitle'), body: connection.message });
        onClose();
      } else {
        pushToast({
          tone: 'warning',
          title: connection.message ?? 'A credencial não foi aceita',
          body: connection.actionHint,
        });
      }
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível conectar ao OpenRouter');
    } finally {
      setBusy(false);
    }
  };

  const connectCodex = async (): Promise<void> => {
    setBusy(true);
    try {
      const info = await invoke('codex:start');
      if (!info.found) {
        pushToast({
          tone: 'warning',
          title: t('onboarding.codexMissing'),
          body: t('onboarding.codexMissingAction'),
          sticky: true,
        });
        return;
      }
      if (!info.initialized) {
        pushToast({
          tone: 'warning',
          title: info.diagnostic?.message ?? 'O Codex não inicializou',
          body: info.diagnostic?.action,
          sticky: true,
        });
        return;
      }
      const account = await invoke('codex:account');
      pushToast({
        tone: account.authenticated ? 'success' : 'info',
        title: account.authenticated ? 'Codex conectado' : 'Codex iniciado, sem conta autenticada',
        body: account.authenticated
          ? `${account.accountLabel ?? ''} ${account.planLabel ?? ''}`.trim() || undefined
          : 'Use Configurações › Codex › Autenticação para entrar.',
      });
      onClose();
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível iniciar o Codex');
    } finally {
      setBusy(false);
    }
  };

  const connectCompatible = async (): Promise<void> => {
    setBusy(true);
    try {
      const descriptor = await registerCompatible({
        label: label.trim() || 'Endpoint compatível',
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        persist,
      });
      setApiKey('');
      if (descriptor) {
        pushToast({ tone: 'success', title: `Endpoint "${descriptor.label}" cadastrado` });
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('onboarding.title')}
      description={t('onboarding.subtitle')}
      width={760}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('onboarding.skip')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => {
              if (path === 'openrouter') void connectOpenRouter();
              else if (path === 'codex') void connectCodex();
              else void connectCompatible();
            }}
            disabled={path === 'openrouter' && apiKey.trim() === '' && connections.openrouter?.state !== 'connected'}
            disabledReason="Informe a chave do OpenRouter para continuar por este caminho."
          >
            {t('onboarding.continue')}
          </Button>
        </>
      }
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <PathCard
          active={path === 'openrouter'}
          icon={<IconSpark size={18} />}
          title={t('onboarding.openrouterTitle')}
          body={t('onboarding.openrouterBody')}
          badge={connections.openrouter?.state === 'connected' ? 'conectado' : 'recomendado para começar'}
          badgeTone={connections.openrouter?.state === 'connected' ? 'success' : 'accent'}
          onClick={() => setPath('openrouter')}
        />
        <PathCard
          active={path === 'codex'}
          icon={<IconTerminal size={18} />}
          title={t('onboarding.codexTitle')}
          body={t('onboarding.codexBody')}
          badge={codex?.found ? (codex.initialized ? 'inicializado' : 'encontrado') : 'não encontrado'}
          badgeTone={codex?.initialized ? 'success' : codex?.found ? 'warning' : 'neutral'}
          onClick={() => setPath('codex')}
        />
        <PathCard
          active={path === 'compatible'}
          icon={<IconPlug size={18} />}
          title={t('onboarding.compatibleTitle')}
          body={t('onboarding.compatibleBody')}
          onClick={() => setPath('compatible')}
        />
      </div>

      <div className="mt-4 space-y-3">
        {path === 'openrouter' ? (
          <>
            <Field
              label={t('onboarding.apiKeyLabel')}
              hint={t('onboarding.apiKeyHelp')}
              htmlFor="onboarding-openrouter-key"
            >
              <Input
                id="onboarding-openrouter-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={t('onboarding.apiKeyPlaceholder')}
              />
            </Field>
            {connections.openrouter?.maskedCredential ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('settings.credentialStored', { masked: connections.openrouter.maskedCredential })}
              </p>
            ) : null}
          </>
        ) : null}

        {path === 'compatible' ? (
          <>
            <Field label={t('onboarding.labelLabel')} htmlFor="onboarding-label">
              <Input id="onboarding-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <Field
              label={t('onboarding.baseUrlLabel')}
              hint="HTTPS é exigido para serviços remotos. HTTP é aceito para endereços locais."
              htmlFor="onboarding-baseurl"
            >
              <Input
                id="onboarding-baseurl"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={t('onboarding.baseUrlPlaceholder')}
                spellCheck={false}
              />
            </Field>
            <Field
              label={`${t('onboarding.apiKeyLabel')} (${t('common.optional')})`}
              hint="Alguns serviços locais não exigem chave."
              htmlFor="onboarding-compat-key"
            >
              <Input
                id="onboarding-compat-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
          </>
        ) : null}

        {path === 'codex' ? (
          <div className="ch-raised space-y-2 p-3 text-[12.5px] leading-relaxed">
            <p className="text-[var(--text-muted)]">
              O aplicativo procura o executável no caminho configurado, no PATH e nos locais de instalação
              conhecidos do sistema.
            </p>
            <dl className="space-y-1">
              <InfoRow label="Encontrado" value={codex?.found ? 'sim' : 'não'} />
              {codex?.executablePath ? <InfoRow label="Caminho" value={codex.executablePath} mono /> : null}
              {codex?.version ? <InfoRow label="Versão" value={codex.version} mono /> : null}
              <InfoRow label="Handshake concluído" value={codex?.initialized ? 'sim' : 'não'} />
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
              <p className="text-[11.5px] leading-snug text-[var(--text-faint)]">
                {t('settings.codexTypesProvisional')}
              </p>
            ) : null}
          </div>
        ) : null}

        {path !== 'codex' ? (
          <>
            <Switch
              checked={persist && !protectionUnavailable}
              disabled={protectionUnavailable}
              disabledReason={t('onboarding.persistUnavailable')}
              onChange={setPersist}
              label={t('onboarding.persistLabel')}
              hint={
                protectionUnavailable
                  ? t('onboarding.persistUnavailable')
                  : 'No Windows o segredo é cifrado com a proteção do sistema (DPAPI) e nunca gravado em texto puro.'
              }
            />
            <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--text-faint)]">
              <IconKey size={13} className="mt-[2px] flex-none" />
              Credenciais pertencem ao provedor que você escolheu. Uma chave do OpenRouter nunca é enviada ao fluxo
              de chave da OpenAI usado pelo Codex, e vice-versa.
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

function PathCard({
  active,
  icon,
  title,
  body,
  badge,
  badgeTone = 'neutral',
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
  badgeTone?: 'neutral' | 'accent' | 'success' | 'warning';
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex h-full flex-col gap-1.5 rounded-[var(--radius-md)] border p-3 text-left transition-colors',
        active ? 'text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)]',
      )}
      style={{
        background: active ? 'var(--accent-soft)' : 'var(--surface-1)',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
      }}
    >
      <span className="flex items-center gap-2">
        <span className="text-[var(--accent)]">{icon}</span>
        <span className="text-[13.5px] font-semibold text-[var(--text)]">{title}</span>
      </span>
      <span className="text-[12px] leading-snug">{body}</span>
      {badge ? (
        <span className="mt-auto pt-1">
          <Badge tone={badgeTone}>{badge}</Badge>
        </span>
      ) : null}
    </button>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd className={clsx('min-w-0 truncate text-right text-[var(--text)]', mono && 'ch-mono')} title={value}>
        {value}
      </dd>
    </div>
  );
}
