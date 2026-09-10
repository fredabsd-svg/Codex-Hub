/**
 * Popover e Tooltip acessíveis, sem dependências externas.
 *
 * Popover: `aria-expanded` no gatilho, foco movido para o painel, Esc fecha
 * apenas o popover, clique fora fecha, posicionamento com ajuste de borda.
 * Tooltip: `role="tooltip"` associado por `aria-describedby`, aparece com
 * atraso curto no hover e imediatamente no foco por teclado.
 */

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import { pushOverlay, removeOverlay } from '../../lib/overlayStack';
import { focusInitial } from './Dialog';

type Align = 'start' | 'center' | 'end';
type Side = 'bottom' | 'top';

export interface PopoverProps {
  /** Gatilho: recebe `ref`, `onClick`, `aria-expanded`. */
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: Align;
  side?: Side;
  width?: number;
  label: string;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  className?: string;
}

export function Popover({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  width,
  label,
  open: controlledOpen,
  onOpenChange,
  className,
}: PopoverProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      // Em modo controlado, quem decide é o pai (via onOpenChange).
      if (!controlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const panelId = useId();

  const reposition = useCallback(() => {
    const anchor = triggerRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const gap = 6;
    const margin = 8;

    let left = rect.left;
    if (align === 'center') left = rect.left + rect.width / 2 - panelRect.width / 2;
    if (align === 'end') left = rect.right - panelRect.width;
    left = Math.min(Math.max(margin, left), window.innerWidth - panelRect.width - margin);

    const belowSpace = window.innerHeight - rect.bottom - gap - margin;
    const aboveSpace = rect.top - gap - margin;
    const preferBelow = side === 'bottom' ? belowSpace >= Math.min(panelRect.height, 240) || belowSpace >= aboveSpace : aboveSpace < Math.min(panelRect.height, 240) && belowSpace > aboveSpace;

    const top = preferBelow ? rect.bottom + gap : Math.max(margin, rect.top - gap - panelRect.height);
    const maxHeight = preferBelow ? belowSpace : aboveSpace;

    setPosition({ top, left, maxHeight: Math.max(160, maxHeight) });
  }, [align, side]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const id = pushOverlay('popover');
    reposition();
    focusInitial(panelRef.current);

    const onScroll = (): void => reposition();
    window.addEventListener('resize', onScroll);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      removeOverlay(id);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open, setOpen]);

  const triggerProps: Record<string, unknown> = {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
    },
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    'aria-controls': open ? panelId : undefined,
    onClick: (event: React.MouseEvent) => {
      (trigger.props.onClick as ((e: React.MouseEvent) => void) | undefined)?.(event);
      setOpen(!open);
    },
  };

  return (
    <>
      {cloneElement(trigger, triggerProps)}
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus?.();
            }
          }}
          className={clsx('ch-anim-rise ch-popover fixed z-40 overflow-hidden', className)}
          style={{
            top: position?.top ?? -9999,
            left: position?.left ?? -9999,
            width,
            maxHeight: position?.maxHeight,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Tooltip
 * ------------------------------------------------------------------ */

export function Tooltip({
  content,
  children,
  delayMs = 220,
}: {
  content: string;
  children: ReactElement<Record<string, unknown>>;
  delayMs?: number;
}) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);
  const id = useId();

  const show = useCallback(
    (immediate: boolean) => {
      const run = (): void => {
        const rect = anchorRef.current?.getBoundingClientRect();
        if (!rect) return;
        setCoords({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
        setVisible(true);
      };
      if (immediate) {
        run();
        return;
      }
      timer.current = window.setTimeout(run, delayMs);
    },
    [delayMs],
  );

  const hide = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setVisible(false);
  }, []);

  useEffect(() => () => hide(), [hide]);

  const props: Record<string, unknown> = {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
    },
    'aria-describedby': visible ? id : undefined,
    onMouseEnter: () => show(false),
    onMouseLeave: hide,
    onFocus: () => show(true),
    onBlur: hide,
  };

  return (
    <>
      {cloneElement(children, props)}
      {visible && coords ? (
        <div
          id={id}
          role="tooltip"
          className="ch-anim-fade pointer-events-none fixed z-[60] max-w-[280px] rounded-[var(--radius-sm)] border px-2 py-1 text-[12px] leading-snug"
          style={{
            top: coords.top,
            left: coords.left,
            transform: 'translateX(-50%)',
            background: 'var(--surface-3)',
            borderColor: 'var(--border-strong)',
            color: 'var(--text)',
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          {content}
        </div>
      ) : null}
    </>
  );
}
