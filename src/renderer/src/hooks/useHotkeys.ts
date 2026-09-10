/**
 * Atalhos de teclado.
 *
 * Regras específicas implementadas:
 *  - `Esc` fecha primeiro menus e diálogos; só interrompe o turno ativo quando
 *    nenhuma sobreposição está aberta;
 *  - nada é enviado durante composição de texto por IME (`isComposing`);
 *  - atalhos com Ctrl não disparam quando o alvo é um campo de texto e o atalho
 *    conflitaria com a edição (por exemplo, Ctrl+A).
 */

import { useEffect } from 'react';
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Nunca agir durante composição por IME.
      if (event.isComposing || event.keyCode === 229) return;

      if (event.key === 'Escape') {
        // Sobreposições tratam o próprio Esc (stopPropagation). Se chegou aqui
        // e nada está aberto, a ação é interromper o turno ativo.
        if (blockingDepth() === 0) {
          event.preventDefault();
          handlers.escape();
        }
        return;
      }

      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;

      const key = event.key.toLowerCase();

      if (key === 'enter') {
        event.preventDefault();
        handlers.send();
        return;
      }
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        handlers.newConversation();
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        handlers.commandPalette();
        return;
      }
      if (key === 'o' && !event.shiftKey) {
        event.preventDefault();
        handlers.chooseWorkspace();
        return;
      }
      if (key === 'o' && event.shiftKey) {
        event.preventDefault();
        handlers.attachFiles();
        return;
      }
      if (key === ',') {
        event.preventDefault();
        handlers.openSettings();
        return;
      }
      if (key === 'b' && handlers.toggleSidebar && !isTextEntry(event.target)) {
        event.preventDefault();
        handlers.toggleSidebar();
        return;
      }
      if (key === 'j' && handlers.toggleRightPanel) {
        event.preventDefault();
        handlers.toggleRightPanel();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
