/**
 * Barra de status: identidade do workspace, caminho completo com copiar, estado
 * Git, motor ativo e política efetiva de execução/rede.
 *
 * Uma política só aparece como "aplicada" quando o runtime confirma. Enquanto
 * isso, é apresentada como "solicitada".
 */

import { useEffect, useMemo, useState } from 'react';
import type { ConversationSummary, GitSummary } from '@shared/domain';
import { summarizeUsage } from '@shared/conversationExport';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { formatTokens, truncateMiddle } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, IconButton } from '../ui/primitives';
import { Popover, Tooltip } from '../ui/Popover';
import { IconCheck, IconCopy, IconGit, IconShield, IconTerminal } from '../ui/icons';

const SANDBOX_LABEL: Record<string, string> = {
  readOnly: 'somente leitura',
  workspaceWrite: 'escrita no workspace',
  dangerFullAccess: 'acesso total',
};

const NETWORK_LABEL: Record<string, string> = {
  blocked: 'bloqueada',
  workspaceAllowed: 'só local',
  allowed: 'liberada',
};

export function StatusBar({ conversation }: { conversation: ConversationSummary | null }) {
  const runtime = useConversationStore((state) => (conversation ? state.runtime[conversation.id] : undefined));
  const items = useConversationStore((state) => (conversation ? state.items[conversation.id] : undefined));
  const totals = useMemo(() => summarizeUsage(items ?? []), [items]);
  const settings = useAppStore((state) => state.settings);
  const pushToast = useUiStore((state) => state.pushToast);
  const [git, setGit] = useState<GitSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const workspacePath = conversation?.workspacePath;

  useEffect(() => {
    let cancelled = false;
    if (!workspacePath) {
      setGit(null);
      return;
    }
    void invoke('workspaces:git', { path: workspacePath })
      .then((summary) => {
        if (!cancelled) setGit(summary);
      })
      .catch(() => {
        if (!cancelled) setGit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, runtime?.status]);

  const policy = runtime?.policy;

  const copyPath = async (): Promise<void> => {
    if (!workspacePath) return;
    await invoke('clipboard:writeText', { text: workspacePath });
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <footer
      className="flex h-7 flex-none items-center gap-3 border-t px-3 text-[11.5px]"
      style={{ background: 'var(--surface-1)', color: 'var(--text-faint)' }}
    >
      {settings.demoMode ? <Badge tone="warning">{t('demo.badge')}</Badge> : null}

      <div className="flex min-w-0 items-center gap-1.5">
        <span className="flex-none">{t('statusBar.workspace')}:</span>
        {workspacePath ? (
          <>
            <Tooltip content={workspacePath}>
              <span tabIndex={0} className="ch-mono min-w-0 truncate text-[var(--text-muted)]">
                {truncateMiddle(workspacePath, 46)}
              </span>
            </Tooltip>
            <IconButton size="sm" label={t('common.copyPath')} onClick={() => void copyPath()}>
              {copied ? <IconCheck size={12} className="text-[var(--success)]" /> : <IconCopy size={12} />}
            </IconButton>
          </>
        ) : (
          <span className="text-[var(--text-faint)]">nenhum (Ctrl+O)</span>
        )}
      </div>

      <span className="h-3.5 w-px flex-none" style={{ background: 'var(--border)' }} />

      <div className="flex flex-none items-center gap-1.5">
        <IconGit size={12} />
        {git === null ? (
          <span>{t('statusBar.gitUnavailable')}</span>
        ) : !git.available ? (
          <Tooltip content={git.unavailableReason ?? t('statusBar.gitUnavailable')}>
            <span tabIndex={0}>{t('statusBar.gitUnavailable')}</span>
          </Tooltip>
        ) : !git.isRepository ? (
          <span>{t('statusBar.noRepository')}</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="ch-mono text-[var(--text-muted)]">{git.branch ?? '—'}</span>
            {git.changedFiles !== undefined && git.changedFiles > 0 ? (
              <Badge tone="warning">{git.changedFiles} alterado(s)</Badge>
            ) : (
              <Badge tone="neutral">limpo</Badge>
            )}
            {git.ahead ? <span title="commits à frente do upstream">↑{git.ahead}</span> : null}
            {git.behind ? <span title="commits atrás do upstream">↓{git.behind}</span> : null}
          </span>
        )}
      </div>

      <span className="h-3.5 w-px flex-none" style={{ background: 'var(--border)' }} />

      <div className="flex flex-none items-center gap-1.5">
        <IconTerminal size={12} />
        <span>{t('statusBar.engine')}:</span>
        <span className="text-[var(--text-muted)]">
          {conversation?.engineId === 'codex' ? 'Codex App Server' : 'Motor direto'}
        </span>
      </div>

      <div className="ml-auto flex flex-none items-center gap-2">
        {totals.totalTokens !== undefined ? (
          <Tooltip
            content={`${t('rightPanel.totalsAll')}: ${totals.totalTokens}${
              totals.reportedCost !== undefined
                ? ` · ${t('rightPanel.totalsReported')}: ${totals.currency} ${totals.reportedCost.toFixed(4)}`
                : totals.estimatedCost !== undefined
                  ? ` · ${t('rightPanel.totalsEstimated')}: ${totals.currency} ${totals.estimatedCost.toFixed(4)}`
                  : ''
            }`}
          >
            <span tabIndex={0} className="text-[var(--text-muted)]">
              {t('chat.tokens', { count: formatTokens(totals.totalTokens) })}
              {totals.reportedCost !== undefined
                ? ` · ${totals.currency} ${totals.reportedCost.toFixed(4)}`
                : totals.estimatedCost !== undefined
                  ? ` · ≈ ${totals.currency} ${totals.estimatedCost.toFixed(4)}`
                  : ''}
            </span>
          </Tooltip>
        ) : null}
        <Popover
          label={t('statusBar.policy')}
          align="end"
          width={380}
          trigger={
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-[var(--radius-xs)] px-1.5 py-0.5 transition-colors hover:bg-[var(--surface-3)]"
            >
              <IconShield size={12} />
              <span>
                {policy
                  ? policy.confirmedByRuntime
                    ? `${t('statusBar.policy')}: ${SANDBOX_LABEL[policy.sandbox] ?? policy.sandbox}`
                    : `${t('statusBar.policyRequested')}`
                  : t('common.unknown')}
              </span>
            </button>
          }
        >
          <div className="p-3 text-[12.5px] leading-relaxed">
            <h3 className="mb-1.5 text-[13px] font-semibold text-[var(--text)]">
              {policy?.confirmedByRuntime ? t('statusBar.policy') : t('statusBar.policyRequested')}
            </h3>
            {policy ? (
              <>
                <dl className="space-y-1">
                  <PolicyRow label="Modo" value={policy.mode} />
                  <PolicyRow label="Aprovações" value={policy.approvals} />
                  <PolicyRow label="Sandbox" value={SANDBOX_LABEL[policy.sandbox] ?? policy.sandbox} />
                  <PolicyRow
                    label={t('statusBar.toolNetwork')}
                    value={NETWORK_LABEL[policy.toolNetwork] ?? policy.toolNetwork}
                  />
                  <PolicyRow
                    label={t('statusBar.inferenceNetwork')}
                    value={NETWORK_LABEL[policy.inferenceNetwork] ?? policy.inferenceNetwork}
                  />
                </dl>
                {policy.note ? (
                  <p className="mt-2 border-t pt-2 text-[11.5px] leading-snug text-[var(--text-muted)]">
                    {policy.note}
                  </p>
                ) : null}
                {!policy.confirmedByRuntime ? (
                  <p className="mt-2 text-[11.5px] leading-snug text-[var(--warning)]">
                    Esta é a política SOLICITADA ao motor. O aplicativo não afirma que ela foi aplicada sem
                    confirmação do runtime.
                  </p>
                ) : null}
                <p className="mt-2 text-[11.5px] leading-snug text-[var(--text-faint)]">
                  A rede da inferência (falar com o provedor) é distinta da rede das ferramentas executadas pelo
                  agente. Os dois estados aparecem separadamente acima.
                </p>
              </>
            ) : (
              <p className="text-[var(--text-muted)]">
                Nenhuma política foi lida ainda para esta conversa. Ela é consultada ao abrir a conversa e no
                início de cada turno.
              </p>
            )}
          </div>
        </Popover>

        {runtime?.lastError ? (
          <button
            type="button"
            onClick={() =>
              pushToast({
                tone: 'error',
                title: runtime.lastError?.message ?? 'Falha',
                body: runtime.lastError?.action,
                technical: runtime.lastError?.technical,
              })
            }
            className="text-[var(--danger)] underline underline-offset-2"
          >
            último erro
          </button>
        ) : null}
      </div>
    </footer>
  );
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd className="text-right text-[var(--text)]">{value}</dd>
    </div>
  );
}
