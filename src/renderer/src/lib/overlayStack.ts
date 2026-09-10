/**
 * Pilha de sobreposições (diálogos, popovers, menus, paleta de comandos).
 *
 * Serve para uma regra específica de teclado: `Esc` fecha primeiro menus e
 * diálogos; somente quando NADA está aberto é que ele interrompe o turno ativo.
 */

export type OverlayKind = 'dialog' | 'popover' | 'menu' | 'palette' | 'tooltip';

interface Entry {
  id: number;
  kind: OverlayKind;
}

let counter = 0;
const stack: Entry[] = [];
const listeners = new Set<(depth: number) => void>();

export function pushOverlay(kind: OverlayKind): number {
  counter += 1;
  stack.push({ id: counter, kind });
  notify();
  return counter;
}

export function removeOverlay(id: number): void {
  const index = stack.findIndex((entry) => entry.id === id);
  if (index >= 0) {
    stack.splice(index, 1);
    notify();
  }
}

/** Sobreposições que capturam `Esc` (tooltip não captura). */
export function blockingDepth(): number {
  return stack.filter((entry) => entry.kind !== 'tooltip').length;
}

export function topOverlay(): OverlayKind | null {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry && entry.kind !== 'tooltip') return entry.kind;
  }
  return null;
}

export function subscribeOverlay(listener: (depth: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  const depth = blockingDepth();
  for (const listener of listeners) listener(depth);
}

/** Usado em testes. */
export function resetOverlayStack(): void {
  stack.length = 0;
  notify();
}
