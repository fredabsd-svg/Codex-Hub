/**
 * Avisos temporários.
 *
 * Região `aria-live="polite"` para que leitores de tela anunciem sem roubar o
 * foco. Erros trazem a mensagem e a AÇÃO concreta; nunca só "algo deu errado".
 */

import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { IconButton } from './primitives';
import { IconAlert, IconCheck, IconClose, IconInfo } from './icons';
import { useUiStore, type ToastItem } from '../../stores/uiStore';

const TONE: Record<ToastItem['tone'], { color: string; background: string; icon: React.ReactNode }> = {
  info: { color: 'var(--info)', background: 'var(--info-soft)', icon: <IconInfo /> },
  success: { color: 'var(--success)', background: 'var(--success-soft)', icon: <IconCheck /> },
  warning: { color: 'var(--warning)', background: 'var(--warning-soft)', icon: <IconAlert /> },
  error: { color: 'var(--danger)', background: 'var(--danger-soft)', icon: <IconAlert /> },
};

export function ToastRegion() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      // No canto superior direito: não cobre o composer nem o botão de enviar.
      className="pointer-events-none fixed right-4 top-14 z-[70] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss(): void }) {
  // A função de dispensa muda de identidade a cada render do pai (streaming,
  // por exemplo). Guardá-la em ref evita reiniciar o cronômetro sem parar.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (toast.tone === 'error' || toast.sticky) return;
    const timer = window.setTimeout(() => dismissRef.current(), toast.tone === 'warning' ? 8000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, toast.sticky]);

  const tone = TONE[toast.tone];

  return (
    <div
      className={clsx('ch-anim-rise ch-popover pointer-events-auto flex gap-2.5 p-3')}
      role={toast.tone === 'error' ? 'alert' : undefined}
    >
      <span className="mt-[2px] flex-none" style={{ color: tone.color }} aria-hidden="true">
        {tone.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium leading-snug text-[var(--text)]">{toast.title}</p>
        {toast.body ? (
          <p className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-muted)]">{toast.body}</p>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              toast.action?.run();
              onDismiss();
            }}
            className="mt-1.5 text-[12.5px] font-medium underline underline-offset-2"
            style={{ color: 'var(--accent)' }}
          >
            {toast.action.label}
          </button>
        ) : null}
        {toast.technical ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[11.5px] text-[var(--text-faint)]">Detalhe técnico</summary>
            <pre className="ch-mono mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--text-faint)]">
              {toast.technical}
            </pre>
          </details>
        ) : null}
      </div>
      <IconButton label="Dispensar" size="sm" onClick={onDismiss}>
        <IconClose size={14} />
      </IconButton>
    </div>
  );
}
