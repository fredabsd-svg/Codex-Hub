/**
 * Cabeçalho: workspace, seletor de provedor/modelo, esforço, modos, estado da
 * conexão e uso resumido. Detalhes avançados ficam em popovers.
 */

import { useMemo } from 'react';
import clsx from 'clsx';
import type { ConversationSummary, OperationMode } from '@shared/domain';
import { t } from '../../i18n';
import { formatDateTime, formatRelative, truncateMiddle } from '../../lib/format';
import { errorOf, invoke } from '../../lib/api';
import { useAppStore } from '../../stores/appStore';
import { useCatalogStore } from '../../stores/catalogStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, IconButton, Segmented } from '../ui/primitives';
import { Popover, Tooltip } from '../ui/Popover';
import { EffortPicker, ModelPicker } from '../../features/catalog/ModelPicker';
import { ConversationMenu } from './Sidebar';
import { IconCoins, IconFolder, IconPanelRight, IconRefresh, IconSearch, IconSpark } from '../ui/icons';

export function Header({ conversation }: { conversation: ConversationSummary | null }) {
  const workspaces = useAppStore((state) => state.workspaces);
  const connections = useAppStore((state) => state.connections);
  const usage = useAppStore((state) => state.usage);
  const refreshUsage = useAppStore((state) => state.refreshUsage);
  const refreshWorkspaces = useAppStore((state) => state.refreshWorkspaces);
  const codex = useAppStore((state) => state.codex);

  const setMode = useConversationStore((state) => state.setMode);
  const runtime = useConversationStore((state) =>
    conversation ? state.runtime[conversation.id] : undefined,
  );

  const openDialog = useUiStore((state) => state.openDialog);
  const layout = useUiStore((state) => state.layout);
  const setLayout = useUiStore((state) => state.setLayout);
  const pushError = useUiStore((state) => state.pushError);
  const applySettings = useAppStore((state) => state.applySettings);

  const pages = useCatalogStore((state) => state.pages);
  const model = conversation
    ? pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId)
    : undefined;

  const connection = conversation ? connections[conversation.providerId] : undefined;
  const providerUsage = conversation ? usage[conversation.providerId] : undefined;

  const workspaceLabel = useMemo(() => {
    // O atalho fica na dica, não no rótulo: assim o nome não é cortado.
    if (!conversation?.workspacePath) return t('header.chooseWorkspaceShort');
    const known = workspaces.find((w) => w.path === conversation.workspacePath);
    return known?.name ?? truncateMiddle(conversation.workspacePath, 28);
  }, [conversation?.workspacePath, workspaces]);

  const chooseWorkspace = async (): Promise<void> => {
    if (!conversation) return;
    try {
      const workspace = await invoke('workspaces:choose');
      if (!workspace) return;
      // Canal dedicado: o processo principal revalida o caminho e grava a raiz
      // autorizada. Um turno em andamento não é redirecionado.
      await invoke('conversations:setWorkspace', {
        conversationId: conversation.id,
        workspacePath: workspace.path,
      });
      await useConversationStore.getState().refresh(true);
      await refreshWorkspaces();
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível escolher o workspace');
    }
  };

  const modeOptions: Array<{
    value: OperationMode;
    label: string;
    hint: string;
    disabled?: boolean;
    disabledReason?: string;
  }> = [
    { value: 'chat', label: t('header.modes.chat'), hint: t('header.modes.chatHint') },
    {
      value: 'plan',
      label: t('header.modes.plan'),
      hint: t('header.modes.planHint'),
      disabled: !conversation?.workspacePath,
      disabledReason: 'Selecione um workspace para usar as ferramentas de leitura.',
    },
    {
      value: 'execute',
      label: t('header.modes.execute'),
      hint: t('header.modes.executeHint'),
      disabled: !conversation?.workspacePath,
      disabledReason: 'Selecione um workspace para permitir alterações.',
    },
  ];

  return (
    <header className="ch-workbench-header" style={{ background: 'var(--surface-1)' }}>
      <div className="ch-conversation-heading">
        <div className="min-w-0">
          <h1 title={conversation?.title}>{conversation?.title ?? t('workspaceExperience.home')}</h1>
          <p>{conversation ? conversation.modelId : t('workspaceExperience.ready')}</p>
        </div>
        <div className="flex flex-none items-center gap-1">
          {conversation ? (
            <>
              <Tooltip content={`${t('workspaceExperience.searchTitle')} (Ctrl+F)`}>
                <IconButton
                  label={t('workspaceExperience.searchTitle')}
                  onClick={() => openDialog('conversationSearch')}
                >
                  <IconSearch />
                </IconButton>
              </Tooltip>
              <ConversationMenu conversation={conversation} />
            </>
          ) : null}
        </div>
      </div>
      <div className="ch-conversation-toolbar">
        {/* Grupo esquerdo: comprime primeiro, para que o estado da conexão e o
          uso nunca sejam cortados quando o painel direito está aberto. */}
        <div className="ch-toolbar-controls">
          <Tooltip
            content={conversation?.workspacePath ?? 'Nenhum workspace vinculado. Escolher com Ctrl+O.'}
          >
            <Button
              size="sm"
              variant="subtle"
              iconLeft={<IconFolder />}
              onClick={() => void chooseWorkspace()}
              disabled={!conversation}
              disabledReason="Crie uma conversa primeiro."
              className="min-w-0 max-w-[220px]"
            >
              {workspaceLabel}
            </Button>
          </Tooltip>

          <div className="ch-divider h-5 w-px flex-none" style={{ background: 'var(--border)' }} />

          <ModelPicker conversation={conversation} />
          <EffortPicker conversation={conversation} />

          <div className="ml-1 flex-none">
            {conversation ? (
              <Segmented
                ariaLabel="Modo de operação"
                size="sm"
                value={conversation.mode}
                options={modeOptions}
                onChange={(mode) => void setMode(conversation.id, mode)}
              />
            ) : null}
          </div>
        </div>

        <div className="ch-toolbar-status">
          {model?.codex?.upgradeAvailable ? (
            <Tooltip content={model.codex.upgradeNotice ?? t('catalog.codexUpgrade')}>
              <span tabIndex={0} className="inline-flex">
                <Badge tone="info">
                  <IconSpark size={11} /> {t('catalog.codexUpgrade')}
                </Badge>
              </span>
            </Tooltip>
          ) : null}

          {runtime?.gapDetected ? (
            <Tooltip content="Alguns eventos podem não ter chegado nesta sessão. Recarregue o histórico para ver o estado real.">
              <span tabIndex={0} className="inline-flex">
                <Badge tone="warning">eventos incompletos</Badge>
              </span>
            </Tooltip>
          ) : null}

          <Popover
            label={t('header.connection')}
            align="end"
            width={340}
            trigger={
              <button
                type="button"
                className="flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2 text-[12px] transition-colors hover:bg-[var(--surface-3)]"
                style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
              >
                <ConnectionDot state={connection?.state} />
                <span className="whitespace-nowrap text-[var(--text-muted)]">
                  {connection?.state === 'connected'
                    ? 'conectado'
                    : connection?.state === 'unauthorized'
                      ? 'credencial inválida'
                      : connection?.state === 'unavailable'
                        ? 'indisponível'
                        : connection?.state === 'error'
                          ? 'erro'
                          : 'sem credencial'}
                </span>
              </button>
            }
          >
            <div className="p-3 text-[12.5px] leading-relaxed">
              <h3 className="mb-1.5 text-[13px] font-semibold text-[var(--text)]">
                {t('header.connection')}
              </h3>
              {connection ? (
                <>
                  <p className="text-[var(--text-muted)]">{connection.message ?? '—'}</p>
                  {connection.actionHint ? (
                    <p className="mt-1 text-[var(--text-faint)]">{connection.actionHint}</p>
                  ) : null}
                  <dl className="mt-2 space-y-1">
                    <Row label="Provedor" value={conversation?.providerId ?? '—'} />
                    <Row label="Motor" value={conversation?.engineId ?? '—'} />
                    {connection.accountLabel ? <Row label="Conta" value={connection.accountLabel} /> : null}
                    {connection.planLabel ? <Row label="Plano" value={connection.planLabel} /> : null}
                    {connection.maskedCredential ? (
                      <Row label="Credencial" value={connection.maskedCredential} mono />
                    ) : null}
                    {connection.lastCheckedAt ? (
                      <Row label="Verificada" value={formatRelative(connection.lastCheckedAt)} />
                    ) : null}
                  </dl>
                </>
              ) : (
                <p className="text-[var(--text-muted)]">Nenhum provedor selecionado.</p>
              )}
              {conversation?.engineId === 'codex' ? (
                <div className="mt-2 border-t pt-2">
                  <Row label="Codex" value={codex?.initialized ? 'inicializado' : 'não inicializado'} />
                  {codex?.version ? <Row label="Versão" value={codex.version} mono /> : null}
                  {codex?.generatedTypesAreProvisional ? (
                    <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--warning)]">
                      {t('settings.codexTypesProvisional')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Popover>

          <Popover
            label={t('header.usage')}
            align="end"
            width={340}
            trigger={
              <button
                type="button"
                className="flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border px-2 text-[12px] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-3)]"
                style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
                title={t('header.usage')}
              >
                <IconCoins size={13} className="text-[var(--text-faint)]" />
                {providerUsage?.balance
                  ? `${providerUsage.balance.currency} ${providerUsage.balance.amount.toFixed(2)}`
                  : t('header.usage')}
              </button>
            }
          >
            <div className="p-3 text-[12.5px] leading-relaxed">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-[var(--text)]">{t('header.usage')}</h3>
                <IconButton
                  size="sm"
                  label={t('common.refresh')}
                  onClick={() => conversation && void refreshUsage(conversation.providerId)}
                >
                  <IconRefresh size={14} />
                </IconButton>
              </div>
              {providerUsage ? (
                <dl className="space-y-1">
                  {providerUsage.balance ? (
                    <Row
                      label={providerUsage.balance.label}
                      value={`${providerUsage.balance.currency} ${providerUsage.balance.amount.toFixed(4)}`}
                    />
                  ) : null}
                  {providerUsage.spend ? (
                    <Row
                      label={providerUsage.spend.windowLabel}
                      value={`${providerUsage.spend.currency} ${providerUsage.spend.amount.toFixed(4)}`}
                    />
                  ) : null}
                  {providerUsage.rateLimits?.map((limit) => (
                    <Row
                      key={limit.label}
                      label={limit.label}
                      value={
                        limit.usedPercent !== undefined
                          ? `${limit.usedPercent.toFixed(0)}% usado`
                          : limit.limit !== undefined
                            ? `limite ${limit.limit}`
                            : '—'
                      }
                    />
                  ))}
                  <Row label="Coletado" value={formatDateTime(providerUsage.fetchedAt)} />
                  {providerUsage.unavailable?.map((reason) => (
                    <p key={reason} className="mt-1 text-[11.5px] leading-snug text-[var(--text-faint)]">
                      {reason}
                    </p>
                  ))}
                </dl>
              ) : (
                <p className="text-[var(--text-muted)]">
                  Nenhum dado de uso foi consultado ainda. Use o botão atualizar. Dados indisponíveis não são
                  exibidos como zero.
                </p>
              )}
            </div>
          </Popover>

          <Tooltip
            content={`${layout.rightPanelCollapsed ? t('rightPanel.open') : t('rightPanel.close')} (Ctrl+J)`}
          >
            <IconButton
              label={layout.rightPanelCollapsed ? t('rightPanel.open') : t('rightPanel.close')}
              active={!layout.rightPanelCollapsed}
              onClick={() => {
                const next = !layout.rightPanelCollapsed;
                setLayout({ rightPanelCollapsed: next });
                void applySettings({ layout: { rightPanelCollapsed: next } });
              }}
            >
              <IconPanelRight />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}

function ConnectionDot({ state }: { state: string | undefined }) {
  const color =
    state === 'connected'
      ? 'var(--success)'
      : state === 'connecting'
        ? 'var(--warning)'
        : state === 'unauthorized' || state === 'error'
          ? 'var(--danger)'
          : state === 'unavailable'
            ? 'var(--warning)'
            : 'var(--text-faint)';
  return (
    <span
      aria-hidden="true"
      className={clsx('inline-block h-2 w-2 flex-none rounded-full', state === 'connecting' && 'ch-pulse')}
      style={{ background: color }}
    />
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd className={clsx('min-w-0 truncate text-right text-[var(--text)]', mono && 'ch-mono')} title={value}>
        {value}
      </dd>
    </div>
  );
}
