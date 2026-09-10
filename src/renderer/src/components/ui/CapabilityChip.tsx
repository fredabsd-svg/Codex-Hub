/**
 * Exibição de capacidade com os três estados e a PROCEDÊNCIA da informação.
 * "Declarado pelo catálogo" nunca é apresentado como "verificado em uso".
 */

import type { Capability, CapabilityKey } from '@shared/domain';
import { CAPABILITY_LABELS, CAPABILITY_SOURCE_LABELS, CAPABILITY_STATE_LABELS } from '@shared/capabilities';
import { Badge, type BadgeTone } from './primitives';
import { Tooltip } from './Popover';

const TONE: Record<Capability['state'], BadgeTone> = {
  supported: 'success',
  unsupported: 'danger',
  unknown: 'neutral',
};

const SYMBOL: Record<Capability['state'], string> = {
  supported: '✓',
  unsupported: '✕',
  unknown: '?',
};

export function CapabilityChip({
  capability,
  capabilityKey,
  compact,
}: {
  capability: Capability | undefined;
  capabilityKey: CapabilityKey;
  compact?: boolean;
}) {
  const value: Capability = capability ?? { state: 'unknown', source: 'inferred' };
  const label = CAPABILITY_LABELS[capabilityKey];
  const stateLabel = CAPABILITY_STATE_LABELS[value.state];
  const sourceLabel = CAPABILITY_SOURCE_LABELS[value.source];
  const tooltip = [`${label}: ${stateLabel}`, `Procedência: ${sourceLabel}`, value.reason]
    .filter(Boolean)
    .join(' · ');

  return (
    <Tooltip content={tooltip}>
      <span tabIndex={0} className="inline-flex">
        <Badge tone={TONE[value.state]} title={tooltip}>
          <span aria-hidden="true">{SYMBOL[value.state]}</span>
          {compact ? null : <span>{label}</span>}
          {value.source === 'tested' ? (
            <span aria-hidden="true" title="Verificado em uso">
              ★
            </span>
          ) : null}
        </Badge>
      </span>
    </Tooltip>
  );
}
