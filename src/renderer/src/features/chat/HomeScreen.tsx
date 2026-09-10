import { t } from '../../i18n';
import { formatRelative } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Button, Kbd } from '../../components/ui/primitives';
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconCode,
  IconFolder,
  IconPlus,
  IconSearch,
  IconSpark,
} from '../../components/ui/icons';

export function TaskCards({ onChoose }: { onChoose(prompt: string): void }) {
  const tasks = [
    {
      id: 'review',
      title: t('workspaceExperience.reviewTitle'),
      body: t('workspaceExperience.reviewBody'),
      prompt: t('workspaceExperience.reviewPrompt'),
      icon: <IconSearch size={19} />,
    },
    {
      id: 'plan',
      title: t('workspaceExperience.planTitle'),
      body: t('workspaceExperience.planBody'),
      prompt: t('workspaceExperience.planPrompt'),
      icon: <IconBrain size={19} />,
    },
    {
      id: 'tests',
      title: t('workspaceExperience.testsTitle'),
      body: t('workspaceExperience.testsBody'),
      prompt: t('workspaceExperience.testsPrompt'),
      icon: <IconCheck size={19} />,
    },
    {
      id: 'explain',
      title: t('workspaceExperience.explainTitle'),
      body: t('workspaceExperience.explainBody'),
      prompt: t('workspaceExperience.explainPrompt'),
      icon: <IconCode size={19} />,
    },
  ];
  return (
    <div className="ch-task-grid">
      {tasks.map((task) => (
        <button
          type="button"
          key={task.id}
          className={`ch-task-card ch-task-${task.id}`}
          onClick={() => onChoose(task.prompt)}
        >
          <span className="ch-task-icon">{task.icon}</span>
          <strong>{task.title}</strong>
          <span>{task.body}</span>
          <IconChevronRight size={14} className="ch-task-arrow" />
        </button>
      ))}
    </div>
  );
}

export function HomeScreen({
  onNewConversation,
}: {
  onNewConversation(prompt?: string, workspacePath?: string): void;
}) {
  const conversations = useConversationStore((state) => state.conversations);
  const setActive = useConversationStore((state) => state.setActive);
  const workspaces = useAppStore((state) => state.workspaces);
  const connections = useAppStore((state) => state.connections);
  const openDialog = useUiStore((state) => state.openDialog);
  const active = conversations.filter((conversation) => !conversation.archived);
  const recent = active.filter((conversation) => conversation.messageCount > 0).slice(0, 4);
  const connected = Object.values(connections).filter(
    (connection) => connection.state === 'connected',
  ).length;
  return (
    <div className="ch-home-scroll">
      <div className="ch-home ch-anim-rise">
        <div className="ch-home-eyebrow">
          <span className="ch-home-signal" />
          {t('workspaceExperience.eyebrow')}
        </div>
        <section className="ch-home-hero">
          <div>
            <h1>{t('workspaceExperience.title')}</h1>
            <p>{t('workspaceExperience.subtitle')}</p>
            <div className="ch-home-actions">
              <Button variant="primary" iconLeft={<IconPlus />} onClick={() => onNewConversation()}>
                {t('workspaceExperience.start')}
              </Button>
              <Button variant="subtle" onClick={() => openDialog('catalog')}>
                {t('workspaceExperience.browseModels')} <IconChevronRight size={13} />
              </Button>
            </div>
          </div>
          <div className="ch-home-symbol" aria-hidden="true">
            <IconCode size={40} />
            <span>CODEX HUB</span>
          </div>
        </section>
        <dl className="ch-home-stats">
          <div>
            <dd>{active.length}</dd>
            <dt>{t('workspaceExperience.conversations')}</dt>
          </div>
          <div>
            <dd>{workspaces.length}</dd>
            <dt>{t('workspaceExperience.workspaces')}</dt>
          </div>
          <div>
            <dd>
              {connected}
              <span className={connected ? 'ch-stat-dot' : ''} />
            </dd>
            <dt>{t('workspaceExperience.connected')}</dt>
          </div>
        </dl>
        <section className="ch-home-section">
          <h2>{t('workspaceExperience.tasksTitle')}</h2>
          <p className="ch-home-caption">{t('workspaceExperience.tasksHint')}</p>
          <TaskCards onChoose={(prompt) => onNewConversation(prompt)} />
        </section>
        <div className="ch-home-columns">
          <section className="ch-home-section">
            <h2>{t('workspaceExperience.recentTitle')}</h2>
            <div className="ch-home-list">
              {recent.length ? (
                recent.map((conversation) => (
                  <button
                    type="button"
                    key={conversation.id}
                    onClick={() => void setActive(conversation.id)}
                    className="ch-home-recent"
                  >
                    <span className="ch-home-list-icon">
                      <IconSpark size={16} />
                    </span>
                    <span className="ch-home-list-text">
                      <strong>{conversation.title}</strong>
                      <span>{conversation.modelId}</span>
                    </span>
                    <small>{formatRelative(conversation.updatedAt)}</small>
                    <IconChevronRight size={13} />
                  </button>
                ))
              ) : (
                <p className="ch-home-empty">{t('workspaceExperience.noRecent')}</p>
              )}
            </div>
          </section>
          <section className="ch-home-section">
            <h2>{t('workspaceExperience.projectsTitle')}</h2>
            <div className="ch-home-list">
              {workspaces.slice(0, 3).map((workspace) => (
                <button
                  type="button"
                  key={workspace.id}
                  title={workspace.path}
                  className="ch-home-recent"
                  onClick={() => onNewConversation(undefined, workspace.path)}
                >
                  <IconFolder size={17} className="text-[var(--accent)]" />
                  <span className="ch-home-list-text">
                    <strong>{workspace.name}</strong>
                    <span>{workspace.path}</span>
                  </span>
                  <IconChevronRight size={13} />
                </button>
              ))}
              {!workspaces.length ? (
                <p className="ch-home-empty">{t('workspaceExperience.noProjects')}</p>
              ) : null}
              <button type="button" className="ch-home-add-project" onClick={() => openDialog('workspaces')}>
                <IconPlus size={14} />
                {t('workspaceExperience.addProject')}
                <Kbd>Ctrl+O</Kbd>
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
