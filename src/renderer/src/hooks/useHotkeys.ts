/**
 * Atalhos de teclado.
 *
 * Regras específicas implementadas:
 *  - `Esc` fecha primeiro menus e diálogos; só interrompe o turno ativo quando
 *    nenhuma sobreposição está aberta;
 *  - com um diálogo ou menu aberto, os atalhos globais ficam inativos (exceto
 *    a paleta, que alterna): sem isto, Ctrl+Enter enviava a mensagem por trás
 *    das configurações e Ctrl+O abria o seletor nativo sobre um modal;
 *  - nada é enviado durante composição de texto por IME (`isComposing`);
 *  - atalhos com Ctrl não disparam quando o alvo é um campo de texto e o atalho
 *    conflitaria com a edição (por exemplo, Ctrl+B e Ctrl+J no editor).
 *
 * Os handlers ficam em uma ref: o ouvinte é registrado UMA vez, e não a cada
 * render do App.
 */

import { useEffect, useRef } from 'react';
import { blockingDepth } from '../lib/overlayStack';

export interface HotkeyHandlers {
  newConversation(): void;
  commandPalette(): void;
  chooseWorkspace(): void;
  attachFiles(): void;
  send(): void;
  openSettings(): void;
  escape(): void;
  toggleRightPanel?(): void;
  toggleSidebar?(): void;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export function useHotkeys(handlers: HotkeyHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const current = ref.current;
      // Nunca agir durante composição por IME.
      if (event.isComposing || event.keyCode === 229) return;

      if (event.key === 'Escape') {
        // Sobreposições tratam o próprio Esc (stopPropagation). Se chegou aqui
        // e nada está aberto, a ação é interromper o turno ativo.
        if (blockingDepth() === 0) {
          event.preventDefault();
          current.escape();
        }
        return;
      }

      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;

      const key = event.key.toLowerCase();

      if (key === 'k') {
        event.preventDefault();
        current.commandPalette();
        return;
      }

      // Com um diálogo ou menu aberto, os demais atalhos globais não agem.
      if (blockingDepth() > 0) return;

      if (key === 'enter') {
        event.preventDefault();
        current.send();
        return;
      }
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        current.newConversation();
        return;
      }
      if (key === 'o' && !event.shiftKey) {
        event.preventDefault();
        current.chooseWorkspace();
        return;
      }
      if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        current.attachFiles();
        return;
      }
      if (key === ',') {
        event.preventDefault();
        current.openSettings();
        return;
      }
      if (key === 'b' && current.toggleSidebar && !isTextEntry(event.target)) {
        event.preventDefault();
        current.toggleSidebar();
        return;
      }
      // Ctrl+J não edita texto em campo algum: vale também com o composer focado.
      if (key === 'j' && current.toggleRightPanel) {
        event.preventDefault();
        current.toggleRightPanel();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
