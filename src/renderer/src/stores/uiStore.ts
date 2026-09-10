/**
 * Estado de interface: layout, sobreposições e avisos.
 *
 * Nada sensível aqui. Chaves de API nunca chegam a nenhum store — elas vão do
 * campo do formulário direto para o IPC e são limpas do campo em seguida.
 */

import { create } from 'zustand';
import type { ErrorDetail, LayoutPreferences } from '@shared/domain';

export interface ToastItem {
  id: string;
  tone: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  technical?: string;
  sticky?: boolean;
  action?: { label: string; run(): void };
}

export type RightPanelTab = LayoutPreferences['rightPanelTab'];

export type DialogName =
  'onboarding' | 'catalog' | 'settings' | 'palette' | 'skills' | 'workspaces' | 'conversationSearch' | null;

/** Pedido de confirmação exibido pelo `ConfirmDialog` (substitui `window.confirm`). */
export interface ConfirmRequest {
  id: number;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  resolve(accepted: boolean): void;
}

interface UiState {
  layout: LayoutPreferences;
  dialog: DialogName;
  settingsSection: string;
  toasts: ToastItem[];
  confirmRequest: ConfirmRequest | null;
  /** Conversa cujo painel de aprovação está expandido. */
  approvalsExpanded: boolean;
  autoScroll: boolean;
  windowWidth: number;

  setLayout(patch: Partial<LayoutPreferences>): void;
  openDialog(dialog: Exclude<DialogName, null>, section?: string): void;
  closeDialog(): void;
  toggleDialog(dialog: Exclude<DialogName, null>): void;
  pushToast(toast: Omit<ToastItem, 'id'>): string;
  pushError(detail: ErrorDetail, fallbackTitle?: string): string;
  dismissToast(id: string): void;
  clearToasts(): void;
  /** Abre um diálogo de confirmação e resolve com a decisão. */
  confirm(options: Omit<ConfirmRequest, 'id' | 'resolve'>): Promise<boolean>;
  resolveConfirm(accepted: boolean): void;
  setAutoScroll(value: boolean): void;
  setApprovalsExpanded(value: boolean): void;
  setWindowWidth(width: number): void;
}

const DEFAULT_LAYOUT: LayoutPreferences = {
  sidebarWidth: 288,
  sidebarCollapsed: false,
  rightPanelWidth: 420,
  rightPanelCollapsed: true,
  rightPanelTab: 'diff',
};

let toastCounter = 0;
let confirmCounter = 0;

export const useUiStore = create<UiState>((set, get) => ({
  layout: DEFAULT_LAYOUT,
  dialog: null,
  settingsSection: 'appearance',
  toasts: [],
  confirmRequest: null,
  approvalsExpanded: true,
  autoScroll: true,
  windowWidth: typeof window === 'undefined' ? 1440 : window.innerWidth,

  setLayout(patch) {
    set((state) => ({ layout: { ...state.layout, ...patch } }));
  },

  openDialog(dialog, section) {
    set({ dialog, settingsSection: section ?? get().settingsSection });
  },

  closeDialog() {
    set({ dialog: null });
  },

  toggleDialog(dialog) {
    set((state) => ({ dialog: state.dialog === dialog ? null : dialog }));
  },

  pushToast(toast) {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    set((state) => ({ toasts: [...state.toasts.slice(-4), { ...toast, id }] }));
    return id;
  },

  pushError(detail, fallbackTitle) {
    return get().pushToast({
      tone: detail.code === 'cancelled' ? 'info' : 'error',
      title: fallbackTitle ?? detail.message,
      body: fallbackTitle ? `${detail.message}${detail.action ? ` ${detail.action}` : ''}` : detail.action,
      technical: detail.technical,
    });
  },

  dismissToast(id) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
  },

  clearToasts() {
    set({ toasts: [] });
  },

  confirm(options) {
    // Um pedido por vez: um novo pedido cancela o anterior.
    get().confirmRequest?.resolve(false);
    confirmCounter += 1;
    return new Promise<boolean>((resolve) => {
      set({ confirmRequest: { ...options, id: confirmCounter, resolve } });
    });
  },

  resolveConfirm(accepted) {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    request?.resolve(accepted);
  },

  setAutoScroll(value) {
    set({ autoScroll: value });
  },

  setApprovalsExpanded(value) {
    set({ approvalsExpanded: value });
  },

  setWindowWidth(width) {
    set({ windowWidth: width });
  },
}));

/** Larguras em que painéis secundários são recolhidos automaticamente. */
export const NARROW_BREAKPOINT = 1180;
export const VERY_NARROW_BREAKPOINT = 940;
