/**
 * Diálogo modal acessível.
 *
 * - `role="dialog"` + `aria-modal`, título associado por `aria-labelledby`;
 * - foco movido para dentro ao abrir e devolvido ao elemento anterior ao fechar;
 * - Tab e Shift+Tab circulam apenas dentro do diálogo;
 * - Esc fecha ESTE diálogo (o atalho global de interromper turno só age quando
 *   nenhum diálogo ou menu está aberto — ver `useOverlayStack`).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { IconButton } from './primitives';
import { IconClose } from './icons';
import { pushOverlay, removeOverlay } from '../../lib/overlayStack';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Largura máxima em px. */
  width?: number;
  /** Impede fechar clicando no fundo (usado em fluxos que exigem decisão). */
  disableBackdropClose?: boolean;
  className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 640,
  disableBackdropClose,
  className,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const id = pushOverlay('dialog');
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => {
      removeOverlay(id);
      previousFocus.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="ch-anim-fade fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6"
      style={{ background: 'rgba(4, 6, 8, 0.6)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(event) => {
        if (!disableBackdropClose && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className={clsx('ch-anim-rise ch-popover my-auto flex max-h-[calc(100vh-4rem)] w-full flex-col', className)}
        style={{ maxWidth: width }}
      >
        <header className="flex items-start justify-between gap-4 border-b px-5 py-3.5">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-[var(--text)]">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-[12.5px] leading-snug text-[var(--text-muted)]">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Fechar" onClick={onClose}>
            <IconClose />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3">{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
