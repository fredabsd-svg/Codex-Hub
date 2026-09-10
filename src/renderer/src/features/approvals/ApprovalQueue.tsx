/**
 * Fila de aprovações, exibida em contexto na conversa.
 *
 * Mostra comando/ação, diretório, motivo, arquivos e destinos de rede quando
 * esses dados existem. Risco é apresentado como HEURÍSTICA, com a base
 * explicada. Só as decisões realmente aceitas pela solicitação aparecem.
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ApprovalDecision, ApprovalRequest } from '@shared/domain';
import { t } from '../../i18n';
import { formatRelative } from '../../lib/format';
import { useConversationStore } from '../../stores/conversationStore';
import { Badge, Button, Spinner } from '../../components/ui/primitives';
import { DiffView } from '../diff/DiffView';
import { IconAlert, IconShield, IconStop } from '../../components/ui/icons';

const DECISION_LABEL: Record<ApprovalDecision, string> = {
  allowOnce: t('approvals.allowOnce'),
  allowForSession: t('approvals.allowSession'),
  deny: t('approvals.deny'),
  cancel: t('approvals.cancelRequest'),
};

const RISK_LABEL = {
  low: t('approvals.riskLow'),
  medium: t('approvals.riskMedium'),
  high: t('approvals.riskHigh'),
} as const;

export function ApprovalQueue({ conversationId }: { conversationId: string }) {
  // O seletor devolve a referência guardada; o filtro acontece aqui.
  // Um seletor que cria um array novo a cada chamada faria o store notificar
  // mudança em todo render (zustand v5 compara por identidade).
  const allApprovals = useConversationStore((state) => state.approvals);
  const approvals = useMemo(
    () => allApprovals.filter((approval) => approval.conversationId === conversationId),
    [allApprovals, conversationId],
  );
  if (approvals.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
    </div>
  );
}

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const resolve = useConversationStore((state) => state.resolveApproval);
  const interrupt = useConversationStore((state) => state.interrupt);
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [showDiff, setShowDiff] = useState(true);

  const risk = approval.risk;
  const riskTone = risk?.level === 'high' ? 'danger' : risk?.level === 'medium' ? 'warning' : 'neutral';

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    setBusy(decision);
    try {
      await resolve(approval.id, decision);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      className="ch-anim-rise ch-prose-wide rounded-[var(--radius-lg)] border"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--warning)' }}
      role="alertdialog"
      aria-label={t('chat.awaitingApproval')}
    >
      <header
        className="flex items-start gap-2 border-b px-3.5 py-2.5"
        style={{ background: 'var(--warning-soft)' }}
      >
        <IconShield size={16} className="mt-[2px] flex-none text-[var(--warning)]" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-[var(--text)]">
            {t(`approvals.kind.${approval.kind}` as never)} · {approval.title}
          </p>
          <p className="mt-0.5 text-[11.5px] text-[var(--text-faint)]">
            {approval.engineId === 'codex' ? 'Solicitado pelo Codex App Server' : 'Solicitado pelo motor direto'} ·{' '}
            {formatRelative(approval.createdAt)}
          </p>
        </div>
        {risk ? <Badge tone={riskTone}>{`risco ${RISK_LABEL[risk.level]}`}</Badge> : null}
      </header>

      <div className="space-y-2.5 px-3.5 py-3 text-[12.5px]">
        {approval.reason ? (
          <div>
            <p className="mb-0.5 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
              {t('approvals.reason')}
            </p>
            <p className="leading-snug text-[var(--text-muted)]">{approval.reason}</p>
          </div>
        ) : null}

        {approval.command ? (
          <div>
            <p className="mb-0.5 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">Comando</p>
            <pre
              className="ch-mono ch-inset overflow-x-auto px-2.5 py-2 text-[12.5px]"
              style={{ margin: 0, whiteSpace: 'pre-wrap' }}
            >
              <code>{approval.command.display}</code>
            </pre>
            {approval.command.cwd ? (
              <p className="ch-mono mt-1 truncate text-[11.5px] text-[var(--text-faint)]">
                {t('approvals.directory')}: {approval.command.cwd}
              </p>
            ) : null}
          </div>
        ) : null}

        {approval.files && approval.files.length > 0 ? (
          <div>
            <p className="mb-0.5 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
              {t('approvals.files')} ({approval.files.length})
            </p>
            <ul className="ch-mono space-y-0.5 text-[11.5px] text-[var(--text-muted)]">
              {approval.files.slice(0, 12).map((file) => (
                <li key={file} className="truncate" title={file}>
                  {file}
                </li>
              ))}
              {approval.files.length > 12 ? (
                <li className="text-[var(--text-faint)]">… e {approval.files.length - 12} outro(s)</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        {approval.networkTargets && approval.networkTargets.length > 0 ? (
          <div>
            <p className="mb-0.5 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
              {t('approvals.network')}
            </p>
            <ul className="ch-mono space-y-0.5 text-[11.5px] text-[var(--text-muted)]">
              {approval.networkTargets.map((target) => (
                <li key={target}>{target}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {approval.diffs && approval.diffs.length > 0 ? (
          <div>
            <button
              type="button"
              onClick={() => setShowDiff((value) => !value)}
              aria-expanded={showDiff}
              className="mb-1 text-[11.5px] text-[var(--accent)] underline underline-offset-2"
            >
              {showDiff ? 'Ocultar diff proposto' : 'Ver diff proposto'}
            </button>
            {showDiff ? (
              <div className="max-h-[340px] overflow-hidden rounded-[var(--radius-sm)] border">
                <DiffView files={approval.diffs} />
              </div>
            ) : null}
          </div>
        ) : null}

        {risk ? (
          <details className="rounded-[var(--radius-sm)] border px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
            <summary className="cursor-pointer text-[11.5px] text-[var(--text-muted)]">
              {t('approvals.riskTitle')}
            </summary>
            <p className="mt-1 text-[11.5px] leading-snug text-[var(--text-faint)]">{t('approvals.riskExplain')}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] text-[var(--text-muted)]">
              {risk.signals.map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {approval.sessionScopeDescription ? (
          <p className="rounded-[var(--radius-sm)] border px-2.5 py-2 text-[11.5px] leading-snug text-[var(--text-muted)]" style={{ borderColor: 'var(--border)' }}>
            <strong className="font-medium text-[var(--text)]">{t('approvals.sessionScope')}:</strong>{' '}
            {approval.sessionScopeDescription}
          </p>
        ) : null}

        {!approval.allowedDecisions.includes('allowForSession') && approval.command ? (
          <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--warning)]">
            <IconAlert size={13} className="mt-[2px] flex-none" />
            {t('approvals.destructiveNote')}
          </p>
        ) : null}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t px-3.5 py-2.5">
        {approval.allowedDecisions.map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={
              decision === 'allowOnce'
                ? 'primary'
                : decision === 'allowForSession'
                  ? 'secondary'
                  : decision === 'deny'
                    ? 'danger'
                    : 'ghost'
            }
            loading={busy === decision}
            disabled={busy !== null}
            onClick={() => void decide(decision)}
          >
            {DECISION_LABEL[decision]}
          </Button>
        ))}
        <div className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<IconStop />}
            onClick={() => void interrupt(approval.conversationId)}
            title="Cancelar a solicitação afeta apenas esta operação. Interromper o turno encerra tudo que está em andamento."
          >
            {t('approvals.interruptTurn')}
          </Button>
        </div>
      </footer>
      {busy ? (
        <div className={clsx('flex items-center gap-2 border-t px-3.5 py-2 text-[12px] text-[var(--text-muted)]')}>
          <Spinner size={12} /> Registrando decisão…
        </div>
      ) : null}
    </section>
  );
}
