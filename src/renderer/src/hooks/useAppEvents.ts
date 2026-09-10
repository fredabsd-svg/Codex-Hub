/**
 * Assinatura dos eventos vindos do processo principal.
 *
 * Eventos de domínio vão para o store de conversas; eventos globais atualizam
 * provedores, Codex, workspaces e avisos.
 */

import { useEffect } from 'react';
import { onAppEvent, onDomainEvent } from '../lib/api';
import { useAppStore } from '../stores/appStore';
import { useCatalogStore } from '../stores/catalogStore';
import { useConversationStore } from '../stores/conversationStore';
import { useUiStore } from '../stores/uiStore';

export function useAppEvents(): void {
  useEffect(() => {
    const offDomain = onDomainEvent((event) => {
      useConversationStore.getState().applyEvent(event);
    });

    const offApp = onAppEvent((event) => {
      const app = useAppStore.getState();
      switch (event.type) {
        case 'provider/connection':
          app.setConnection(event.connection);
          break;
        case 'codex/runtime':
          app.setCodexRuntime(event.runtime);
          break;
        case 'codex/account':
          app.setCodexAccount(event.account);
          break;
        case 'codex/login':
          app.setCodexLogin(event.progress);
          if (event.progress.state === 'completed') {
            useUiStore.getState().pushToast({
              tone: 'success',
              title: 'Login no Codex concluído',
            });
          }
          if (event.progress.state === 'expired' || event.progress.state === 'error') {
            useUiStore.getState().pushToast({
              tone: 'warning',
              title: 'O login no Codex não foi concluído',
              body: event.progress.message ?? 'Tente novamente em Configurações › Codex.',
            });
          }
          break;
        case 'catalog/invalidated':
          void useCatalogStore.getState().load(event.providerId, true);
          break;
        case 'workspaces/updated':
          void app.refreshWorkspaces();
          break;
        case 'conversations/updated':
          void useConversationStore.getState().refresh(true);
          break;
        case 'usage/updated':
          break;
        case 'settings/updated':
          break;
        case 'diagnostics/notice':
          useUiStore.getState().pushToast({
            tone: event.level === 'error' ? 'error' : event.level === 'warn' ? 'warning' : 'info',
            title: event.message,
            sticky: event.level !== 'info',
          });
          break;
        default:
          break;
      }
    });

    return () => {
      offDomain();
      offApp();
    };
  }, []);
}
