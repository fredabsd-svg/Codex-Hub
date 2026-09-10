/**
 * Lista virtualizada simples (altura fixa por item).
 *
 * Usada no catálogo de modelos, que pode ter centenas de entradas.
 * Mantém acessibilidade de listbox: o container é `role="listbox"` e os itens
 * `role="option"`, com `aria-setsize`/`aria-posinset` reais.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface VirtualListProps<T> {
  items: T[];
  itemHeight: number;
  height: number;
  overscan?: number;
  renderItem(item: T, index: number): ReactNode;
  ariaLabel: string;
  /** Índice que deve permanecer visível (navegação por teclado). */
  activeIndex?: number;
  className?: string;
}

export function VirtualList<T>({
  items,
  itemHeight,
  height,
  overscan = 6,
  renderItem,
  ariaLabel,
  activeIndex,
  className,
}: VirtualListProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (element) setScrollTop(element.scrollTop);
  }, []);

  useEffect(() => {
    if (activeIndex === undefined) return;
    const element = containerRef.current;
    if (!element) return;
    const top = activeIndex * itemHeight;
    const bottom = top + itemHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + height) element.scrollTop = bottom - height;
  }, [activeIndex, itemHeight, height]);

  const total = items.length * itemHeight;
  const start = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(height / itemHeight) + overscan * 2;
  const end = Math.min(items.length, start + visibleCount);
  const slice = items.slice(start, end);

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={-1}
      className={className}
      style={{ height, overflowY: 'auto', position: 'relative' }}
    >
      <div style={{ height: total, position: 'relative' }}>
        {slice.map((item, index) => {
          const realIndex = start + index;
          return (
            <div
              key={realIndex}
              style={{
                position: 'absolute',
                top: realIndex * itemHeight,
                left: 0,
                right: 0,
                height: itemHeight,
              }}
            >
              {renderItem(item, realIndex)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
