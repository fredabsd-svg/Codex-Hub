/**
 * Diálogo de confirmação do sistema de design.
 *
 * Substitui `window.confirm`: respeita o tema, a pilha de sobreposições (Esc
 * fecha só ele, sem interromper o turno) e devolve o foco ao elemento anterior.
 */

import { t } from '../../i18n';
import { useUiStore } from '../../stores/uiStore';
import { Dialog } from './Dialog';
import { Button } from './primitives';

export function ConfirmDialog() {
  const request = useUiStore((state) => state.confirmRequest);
  const resolve = useUiStore((state) => state.resolveConfirm);
  if (!request) return null;

  return (
    <Dialog
      open
      onClose={() => resolve(false)}
      title={request.title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => resolve(false)}>
            {request.cancelLabel ?? t('confirm.cancel')}
          </Button>
          <Button
            variant={request.tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => resolve(true)}
            data-autofocus
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      {request.body ? <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">{request.body}</p> : null}
    </Dialog>
  );
}
