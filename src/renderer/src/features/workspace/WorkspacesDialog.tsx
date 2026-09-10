/**
 * Workspaces registrados: seleção, favoritos, estado Git e remoção.
 */

import { t } from '../../i18n';
import { errorOf, invoke } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, EmptyState, IconButton } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { IconFolder, IconStar, IconStarFilled, IconTrash } from '../../components/ui/icons';

export function WorkspacesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const workspaces = useAppStore((state) => state.workspaces);
  const refreshWorkspaces = useAppStore((state) => state.refreshWorkspaces);
  const activeId = useConversationStore((state) => state.activeId);
  const refreshConversations = useConversationStore((state) => state.refresh);
  const pushError = useUiStore((state) => state.pushError);

  const use = async (path: string): Promise<void> => {
    if (!activeId) return;
    try {
      await invoke('conversations:setWorkspace', { conversationId: activeId, workspacePath: path });
      await refreshConversations(true);
      onClose();
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível vincular o workspace');
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Workspaces"
      description="Cada conversa que executa algo está vinculada a uma pasta autorizada. Trocar de workspace não redireciona um turno em andamento."
      width={680}
      footer={
        <>
          <Button
            variant="secondary"
            iconLeft={<IconFolder />}
            onClick={() => {
              void (async () => {
                const workspace = await invoke('workspaces:choose');
                if (workspace) {
                  await refreshWorkspaces();
                  await use(workspace.path);
                }
              })();
            }}
          >
            {t('header.chooseWorkspace')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {workspaces.length === 0 ? (
        <EmptyState
          icon={<IconFolder size={22} />}
          title="Nenhum workspace registrado"
          body="Use Ctrl+O para escolher a pasta do projeto."
        />
      ) : (
        <ul className="space-y-1.5">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="ch-raised flex items-center gap-2 p-2.5">
              <IconFolder size={15} className="flex-none text-[var(--text-faint)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-[var(--text)]">{workspace.name}</p>
                <p className="ch-mono truncate text-[11.5px] text-[var(--text-faint)]" title={workspace.path}>
                  {workspace.path}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-faint)]">
                  {workspace.lastUsedAt ? <span>usado {formatRelative(workspace.lastUsedAt)}</span> : null}
                  {workspace.git?.isRepository ? (
                    <Badge tone="neutral">{workspace.git.branch ?? 'repo'}</Badge>
                  ) : workspace.git?.available === false ? (
                    <Badge tone="warning">{t('statusBar.gitUnavailable')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('statusBar.noRepository')}</Badge>
                  )}
                  {workspace.git?.changedFiles ? (
                    <Badge tone="warning">{workspace.git.changedFiles} alterado(s)</Badge>
                  ) : null}
                </p>
              </div>
              <Button size="sm" onClick={() => void use(workspace.path)} disabled={!activeId} disabledReason="Crie uma conversa primeiro.">
                Usar
              </Button>
              <IconButton
                size="sm"
                label={workspace.favorite ? t('common.unfavorite') : t('common.favorite')}
                onClick={() => {
                  void invoke('workspaces:setFavorite', { id: workspace.id, favorite: !workspace.favorite }).then(() =>
                    refreshWorkspaces(),
                  );
                }}
              >
                {workspace.favorite ? (
                  <IconStarFilled size={13} className="text-[var(--warning)]" />
                ) : (
                  <IconStar size={13} />
                )}
              </IconButton>
              <IconButton
                size="sm"
                tone="danger"
                label={t('common.remove')}
                onClick={() => {
                  void invoke('workspaces:remove', { id: workspace.id }).then(() => refreshWorkspaces());
                }}
              >
                <IconTrash size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
