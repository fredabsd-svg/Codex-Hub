/**
 * Redimensionamento de painéis por mouse e por teclado.
 *
 * O tamanho é persistido nas configurações (debounce) para sobreviver ao
 * reinício do aplicativo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResizablePanelOptions {
  value: number;
  min: number;
  max: number;
  /** `left` cresce para a direita; `right` cresce para a esquerda. */
  edge: 'left' | 'right';
  onChange(value: number): void;
  onCommit(value: number): void;
}

export interface ResizableHandleProps {
  role: 'separator';
  tabIndex: 0;
  'aria-orientation': 'vertical';
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-label': string;
  'data-dragging': 'true' | 'false';
  onMouseDown(event: React.MouseEvent): void;
  onKeyDown(event: React.KeyboardEvent): void;
  onDoubleClick(): void;
}

export function useResizablePanel(options: ResizablePanelOptions): {
  dragging: boolean;
  handleProps: (label: string) => ResizableHandleProps;
} {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);
  const startValue = useRef(options.value);
  const latest = useRef(options.value);

  useEffect(() => {
    latest.current = options.value;
  }, [options.value]);

  const clamp = useCallback(
    (value: number) => Math.min(options.max, Math.max(options.min, Math.round(value))),
    [options.min, options.max],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: MouseEvent): void => {
      const delta = event.clientX - startX.current;
      const next = clamp(options.edge === 'left' ? startValue.current + delta : startValue.current - delta);
      latest.current = next;
      options.onChange(next);
    };
    const onUp = (): void => {
      setDragging(false);
      options.onCommit(latest.current);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, clamp, options]);

  const handleProps = useCallback(
    (label: string): ResizableHandleProps => ({
      role: 'separator',
      tabIndex: 0,
      'aria-orientation': 'vertical',
      'aria-valuenow': options.value,
      'aria-valuemin': options.min,
      'aria-valuemax': options.max,
      'aria-label': label,
      'data-dragging': dragging ? 'true' : 'false',
      onMouseDown: (event) => {
        event.preventDefault();
        startX.current = event.clientX;
        startValue.current = options.value;
        setDragging(true);
      },
      onKeyDown: (event) => {
        const step = event.shiftKey ? 48 : 16;
        let next: number | null = null;
        if (event.key === 'ArrowLeft') next = clamp(options.value + (options.edge === 'left' ? -step : step));
        if (event.key === 'ArrowRight') next = clamp(options.value + (options.edge === 'left' ? step : -step));
        if (event.key === 'Home') next = options.min;
        if (event.key === 'End') next = options.max;
        if (next === null) return;
        event.preventDefault();
        latest.current = next;
        options.onChange(next);
        options.onCommit(next);
      },
      onDoubleClick: () => {
        const midpoint = clamp((options.min + options.max) / 2);
        options.onChange(midpoint);
        options.onCommit(midpoint);
      },
    }),
    [clamp, dragging, options],
  );

  return { dragging, handleProps };
}
