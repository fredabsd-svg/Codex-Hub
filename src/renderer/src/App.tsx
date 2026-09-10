/**
 * Composição da interface.
 *
 * Layout: barra lateral · cabeçalho · conversa · painel direito · barra de
 * status. Painéis secundários recolhem em janelas menores e o composer é
 * sempre preservado.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from './i18n';
import { isBridgeAvailable } from './lib/api';
import { useAppEvents } from './hooks/useAppEvents';
import { useHotkeys } from './hooks/useHotkeys';
import { useResizablePanel } from './hooks/useResizablePanel';
import { applyThemeToDocument, useAppStore } from './stores/appStore';
import { useCatalogStore } from './stores/catalogStore';
import { useConversationStore } from './stores/conversationStore';
import { NARROW_BREAKPOINT, useUiStore, VERY_NARROW_BREAKPOINT } from './stores/uiStore';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { RightPanel } from './components/layout/RightPanel';
import { StatusBar } from './components/layout/StatusBar';
import { ToastRegion } from './components/ui/Toast';
import { Button, Spinner } from './components/ui/primitives';
import { MessageList } from './features/chat/MessageList';
import { Composer, type ComposerHandle } from './features/chat/Composer';
import { OnboardingDialog } from './features/onboarding/OnboardingDialog';
import { CatalogDialog } from './features/catalog/CatalogDialog';
import { SettingsDialog } from './features/settings/SettingsDialog';
import { CommandPalette } from './features/palette/CommandPalette';
import { SkillsDialog } from './features/skills/SkillsDialog';
import { WorkspacesDialog } from './features/workspace/WorkspacesDialog';
import { IconAlert } from './components/ui/icons';

export function App() {
  const ready = useAppStore((state) => state.ready);
  const bootError = useAppStore((state) => state.bootError);
  const bootstrap = useAppStore((state) => state.bootstrap);
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const onboardingCompleted = useAppStore((state) => state.onboardingCompleted);
  const notices = useAppStore((state) => state.notices);
  const dismissNotice = useAppStore((state) => state.dismissNotice);
  const applySettings = useAppStore((state) => state.applySettings);
  const refreshSkills = useAppStore((state) => state.refreshSkills);

  const conversations = useConversationStore((state) => state.conversations);
  const activeId = useConversationStore((state) => state.activeId);
  const setActive = useConversationStore((state) => state.setActive);
  const createConversation = useConversationStore((state) => state.create);
  const refreshConversations = useConversationStore((state) => state.refresh);
  const refreshApprovals = useConversationStore((state) => state.refreshApprovals);
  const interrupt = useConversationStore((state) => state.interrupt);

  const loadCatalog = useCatalogStore((state) => state.load);

  const dialog = useUiStore((state) => state.dialog);
  const openDialog = useUiStore((state) => state.openDialog);
  const closeDialog = useUiStore((state) => state.closeDialog);
  const layout = useUiStore((state) => state.layout);
  const setLayout = useUiStore((state) => state.setLayout);
  const setWindowWidth = useUiStore((state) => state.setWindowWidth);
  const windowWidth = useUiStore((state) => state.windowWidth);

  const composerRef = useRef<ComposerHandle | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);

  useAppEvents();

  useEffect(() => {
    // Sem a ponte segura não há o que carregar; a tela de aviso é mostrada.
    if (!isBridgeAvailable()) return;
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!ready || bootstrapped) return;
    setBootstrapped(true);
    void (async () => {
      await refreshConversations(true);
      await refreshApprovals();
      const defaultProvider = settings.defaultProviderId ?? 'openrouter';
      void loadCatalog(defaultProvider);

      const stored = useConversationStore.getState().conversations;
      if (settings.startupBehavior === 'lastConversation' && stored[0]) {
        await setActive(stored[0].id);
      } else if (settings.startupBehavior === 'newConversation' && onboardingCompleted) {
        // Reaproveita a conversa vazia mais recente em vez de acumular uma
        // conversa em branco a cada abertura do aplicativo.
        const emptyOne = stored.find((entry) => !entry.archived && entry.messageCount === 0);
        if (emptyOne) await setActive(emptyOne.id);
        else await handleNewConversation();
      }
      if (!onboardingCompleted) openDialog('onboarding');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bootstrapped]);

  // Tema do sistema muda em tempo real quando a preferência é "do sistema".
  useEffect(() => {
    if (settings.theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const listener = (): void => applyThemeToDocument(settings);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [settings]);

  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setWindowWidth]);

  const conversation = useMemo(
    () => conversations.find((entry) => entry.id === activeId) ?? null,
    [conversations, activeId],
  );

  useEffect(() => {
    if (conversation) void refreshSkills(conversation.engineId, conversation.workspacePath);
  }, [conversation, refreshSkills]);

  const handleNewConversation = useCallback(async () => {
    const providerId =
      settings.defaultProviderId ??
      providers.find((provider) => provider.id === 'openrouter')?.id ??
      providers[0]?.id;
    if (!providerId) {
      openDialog('onboarding');
      return;
    }
    const engineId = providerId === 'codex' ? 'codex' : settings.defaultEngineId;
    const pickModel = (): string | undefined => {
      const page = useCatalogStore.getState().pages[providerId];
      return (
        settings.defaultModelId ??
        page?.models.find((model) => model.codex?.isDefault)?.id ??
        page?.models[0]?.id
      );
    };
    let modelId = pickModel();
    if (!modelId) {
      // O catálogo pode ainda estar carregando na abertura do aplicativo:
      // esperamos por ele antes de concluir que não há modelo disponível.
      await loadCatalog(providerId).catch(() => undefined);
      modelId = pickModel();
    }
    if (!modelId) {
      openDialog('catalog');
      return;
    }
    await createConversation({
      engineId,
      providerId,
      modelId,
      mode: settings.defaultMode,
      workspacePath: settings.defaultWorkspacePath,
    });
    composerRef.current?.focus();
  }, [settings, providers, createConversation, openDialog, loadCatalog]);

  // Recolhe painéis secundários em janelas menores, preservando o composer.
  const narrow = windowWidth < NARROW_BREAKPOINT;
  const veryNarrow = windowWidth < VERY_NARROW_BREAKPOINT;
  const showRightPanel = !layout.rightPanelCollapsed && !narrow;
  const showSidebar = !layout.sidebarCollapsed && !veryNarrow;

  const sidebarResizer = useResizablePanel({
    value: layout.sidebarWidth,
    min: 220,
    max: 460,
    edge: 'left',
    onChange: (value) => setLayout({ sidebarWidth: value }),
    onCommit: (value) => void applySettings({ layout: { sidebarWidth: value } }),
  });

  const rightResizer = useResizablePanel({
    value: layout.rightPanelWidth,
    min: 320,
    max: 760,
    edge: 'right',
    onChange: (value) => setLayout({ rightPanelWidth: value }),
    onCommit: (value) => void applySettings({ layout: { rightPanelWidth: value } }),
  });

  useHotkeys({
    newConversation: () => void handleNewConversation(),
    commandPalette: () => openDialog('palette'),
    chooseWorkspace: () => openDialog('workspaces'),
    attachFiles: () => composerRef.current?.attach(),
    send: () => composerRef.current?.submit(),
    openSettings: () => openDialog('settings'),
    escape: () => {
      if (activeId) void interrupt(activeId);
    },
    toggleRightPanel: () => {
      const next = !layout.rightPanelCollapsed;
      setLayout({ rightPanelCollapsed: next });
      void applySettings({ layout: { rightPanelCollapsed: next } });
    },
    toggleSidebar: () => {
      const next = !layout.sidebarCollapsed;
      setLayout({ sidebarCollapsed: next });
      void applySettings({ layout: { sidebarCollapsed: next } });
    },
  });

  if (!isBridgeAvailable()) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="ch-panel max-w-[52ch] p-5 text-center">
          <IconAlert size={22} className="mx-auto mb-2 text-[var(--danger)]" />
          <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('errors.title')}</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{t('app.bridgeMissing')}</p>
        </div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        {bootError ? (
          <div className="ch-panel max-w-[56ch] p-5 text-center">
            <IconAlert size={22} className="mx-auto mb-2 text-[var(--danger)]" />
            <h1 className="text-[15px] font-semibold text-[var(--text)]">{t('errors.title')}</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{bootError}</p>
            <Button className="mt-3" variant="primary" onClick={() => void bootstrap()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
            <Spinner /> {t('app.loading')}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {notices.length > 0 ? (
        <div className="flex-none">
          {notices.map((notice, index) => (
            <div
              key={`${notice.message}-${index}`}
              className="flex items-start gap-2 border-b px-3 py-1.5 text-[12.5px]"
              style={{
                background:
                  notice.level === 'error'
                    ? 'var(--danger-soft)'
                    : notice.level === 'warn'
                      ? 'var(--warning-soft)'
                      : 'var(--info-soft)',
              }}
              role={notice.level === 'error' ? 'alert' : undefined}
            >
              <IconAlert
                size={14}
                className="mt-[2px] flex-none"
                style={{
                  color:
                    notice.level === 'error'
                      ? 'var(--danger)'
                      : notice.level === 'warn'
                        ? 'var(--warning)'
                        : 'var(--info)',
                }}
              />
              <p className="min-w-0 flex-1 leading-snug text-[var(--text)]">
                {notice.message}
                {notice.action ? <span className="text-[var(--text-muted)]"> {notice.action}</span> : null}
              </p>
              <button
                type="button"
                onClick={() => dismissNotice(index)}
                className="flex-none text-[11.5px] text-[var(--text-faint)] underline underline-offset-2"
              >
                {t('errors.dismiss')}
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {showSidebar ? (
          <>
            <Sidebar onNewConversation={() => void handleNewConversation()} />
            <div className="ch-resizer" {...sidebarResizer.handleProps('Largura da barra lateral')} />
          </>
        ) : (
          <Sidebar onNewConversation={() => void handleNewConversation()} />
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          <Header conversation={conversation} />
          <MessageList conversation={conversation} />
          <Composer
            conversation={conversation}
            registerHandle={(handle) => {
              composerRef.current = handle;
            }}
          />
        </main>

        {showRightPanel ? (
          <>
            <div className="ch-resizer" {...rightResizer.handleProps('Largura do painel de contexto')} />
            <RightPanel conversation={conversation} />
          </>
        ) : null}
      </div>

      <StatusBar conversation={conversation} />
      <ToastRegion />

      <OnboardingDialog open={dialog === 'onboarding'} onClose={closeDialog} />
      <CatalogDialog open={dialog === 'catalog'} onClose={closeDialog} />
      <SettingsDialog open={dialog === 'settings'} onClose={closeDialog} />
      <SkillsDialog open={dialog === 'skills'} onClose={closeDialog} />
      <WorkspacesDialog open={dialog === 'workspaces'} onClose={closeDialog} />
      <CommandPalette
        open={dialog === 'palette'}
        onClose={closeDialog}
        onNewConversation={() => void handleNewConversation()}
      />
    </div>
  );
}
