/**
 * Skills.
 *
 * No Codex são descobertas por `skills/list`. Habilitar/desabilitar aqui é
 * uma preferência LOCAL desta interface e isso é declarado — não altera a
 * configuração do Codex.
 */

import { useEffect } from 'react';
import { t } from '../../i18n';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { Badge, Button, EmptyState, Switch } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { IconRefresh, IconSkill } from '../../components/ui/icons';

export function SkillsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const skills = useAppStore((state) => state.skills);
  const refreshSkills = useAppStore((state) => state.refreshSkills);
  const setSkillEnabled = useAppStore((state) => state.setSkillEnabled);
  const conversations = useConversationStore((state) => state.conversations);
  const activeId = useConversationStore((state) => state.activeId);
  const conversation = conversations.find((c) => c.id === activeId) ?? null;

  useEffect(() => {
    if (open && conversation) void refreshSkills(conversation.engineId, conversation.workspacePath);
  }, [open, conversation, refreshSkills]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('skills.title')}
      description={conversation?.engineId === 'codex' ? t('skills.localToggleNote') : t('skills.codexOnly')}
      width={640}
      footer={
        <>
          <Button
            variant="ghost"
            iconLeft={<IconRefresh />}
            onClick={() => conversation && void refreshSkills(conversation.engineId, conversation.workspacePath)}
          >
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {skills.length === 0 ? (
        <EmptyState
          icon={<IconSkill size={22} />}
          title={t('skills.empty')}
          body={
            conversation?.engineId === 'codex'
              ? 'Conecte o Codex e verifique se a versão instalada implementa skills/list.'
              : t('skills.codexOnly')
          }
        />
      ) : (
        <ul className="space-y-2">
          {skills.map((skill) => (
            <li key={skill.id} className="ch-raised p-3">
              <Switch
                checked={skill.enabledLocally}
                disabled={skill.availability === 'unsupported'}
                disabledReason={skill.availabilityReason ?? t('common.unavailable')}
                onChange={(value) => setSkillEnabled(skill.id, value)}
                label={skill.name}
                hint={skill.description}
              />
              <dl className="mt-2 flex flex-wrap gap-2 text-[11.5px]">
                {skill.origin ? (
                  <div className="flex gap-1">
                    <dt className="text-[var(--text-faint)]">{t('skills.origin')}:</dt>
                    <dd className="text-[var(--text-muted)]">{skill.origin}</dd>
                  </div>
                ) : null}
                {skill.scope ? (
                  <div className="flex gap-1">
                    <dt className="text-[var(--text-faint)]">{t('skills.scope')}:</dt>
                    <dd className="ch-mono text-[var(--text-muted)]">{skill.scope}</dd>
                  </div>
                ) : null}
                <div className="flex gap-1">
                  <dt className="text-[var(--text-faint)]">{t('skills.availability')}:</dt>
                  <dd>
                    <Badge
                      tone={
                        skill.availability === 'supported'
                          ? 'success'
                          : skill.availability === 'unsupported'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {skill.availability === 'supported'
                        ? t('common.supported')
                        : skill.availability === 'unsupported'
                          ? t('common.unsupported')
                          : t('common.unknown')}
                    </Badge>
                  </dd>
                </div>
                {skill.toggleIsLocalOnly ? (
                  <div>
                    <Badge tone="warning" title={t('skills.localToggleNote')}>
                      preferência local
                    </Badge>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
