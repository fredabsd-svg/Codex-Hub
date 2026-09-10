/**
 * Autoscroll durante o streaming.
 *
 * A rolagem acompanha a resposta APENAS se a pessoa estiver perto do final.
 * Caso contrário, o botão "Ir para a resposta" aparece e nada se move sozinho.
 *
 * Um `ResizeObserver` no conteúdo cobre mudanças de altura sem evento de
 * rolagem (bloco de código expandido, diff carregado, editor montado): sem
 * ele, o botão aparecia com a pessoa já no final da conversa.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const NEAR_BOTTOM_PX = 120;

export function useStickyScroll<T>(
  dependency: T,
  conversationId?: string,
): {
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
    stick.current = true;
    element.scrollTop = element.scrollHeight;
    element.addEventListener('scroll', measure, { passive: true });
    measure();

    // Conteúdo que cresce sem rolagem: mantém o final visível se a pessoa
    // estava no final; caso contrário, apenas atualiza o estado do botão.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(() => {
        if (stick.current) element.scrollTop = element.scrollHeight;
        else measure();
      });
      observer.observe(element);
      if (element.firstElementChild) observer.observe(element.firstElementChild);
    }
    return () => {
      element.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, conversationId]);

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
