/**
 * Autoscroll durante o streaming.
 *
 * A rolagem acompanha a resposta APENAS se a pessoa estiver perto do final.
 * Caso contrário, o botão "Ir para a resposta" aparece e nada se move sozinho.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_PX = 120;

export function useStickyScroll<T>(dependency: T): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  scrollToBottom(behavior?: ScrollBehavior): void;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);

  const measure = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance <= NEAR_BOTTOM_PX;
    stick.current = near;
    setAtBottom(near);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    element.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => element.removeEventListener('scroll', measure);
  }, [measure]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  }, [dependency]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    stick.current = true;
    setAtBottom(true);
  }, []);

  return { containerRef, atBottom, scrollToBottom };
}
