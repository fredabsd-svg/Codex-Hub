/**
 * Composer.
 *
 * Recursos: texto expansível, múltiplos anexos, arrastar/soltar, colar imagem,
 * seleção de skills, envio e interrupção, rascunho por conversa e escolha
 * explícita entre NOVO TURNO e ORIENTAÇÃO ao turno em andamento.
 *
 * IME: nada é enviado enquanto há composição de texto em andamento.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AttachmentRef, ConversationSummary } from '@shared/domain';
import { t } from '../../i18n';
import { errorOf, invoke, pathForFile } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, IconButton, Segmented, Spinner } from '../../components/ui/primitives';
import { Popover, Tooltip } from '../../components/ui/Popover';
import { IconClose, IconFile, IconPaperclip, IconSend, IconSkill, IconStop } from '../../components/ui/icons';

const MIN_ROWS = 2;
const MAX_HEIGHT = 320;
const EMPTY_ATTACHMENTS: AttachmentRef[] = [];

export interface ComposerHandle {
  focus(): void;
  attach(): void;
  submit(): void;
}

export function Composer({
  conversation,
  registerHandle,
}: {
  conversation: ConversationSummary | null;
  registerHandle(handle: ComposerHandle | null): void;
}) {
  const draft = useConversationStore((state) => (conversation ? state.drafts[conversation.id] : undefined));
  const runtime = useConversationStore((state) => (conversation ? state.runtime[conversation.id] : undefined));
  const setDraftText = useConversationStore((state) => state.setDraftText);
  const persistDraft = useConversationStore((state) => state.persistDraft);
  const addAttachments = useConversationStore((state) => state.addAttachments);
  const removeAttachment = useConversationStore((state) => state.removeAttachment);
  const send = useConversationStore((state) => state.send);
  const interrupt = useConversationStore((state) => state.interrupt);

  const skills = useAppStore((state) => state.skills);
  const setSkillEnabled = useAppStore((state) => state.setSkillEnabled);
  const pushError = useUiStore((state) => state.pushError);
  const pushToast = useUiStore((state) => state.pushToast);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [composing, setComposing] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [intent, setIntent] = useState<'newTurn' | 'steer'>('newTurn');

  const running = runtime?.status === 'running' || runtime?.status === 'awaitingApproval';
  const steerSupported = conversation?.engineId === 'codex';
  const text = draft?.text ?? '';
  // Referência estável: sem isso, `submit` seria recriado a cada render.
  const attachments = useMemo(() => draft?.attachments ?? EMPTY_ATTACHMENTS, [draft?.attachments]);

  // Um turno em andamento habilita a escolha entre novo turno e orientação.
  useEffect(() => {
    if (!running) setIntent('newTurn');
  }, [running]);

  const autoGrow = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(MAX_HEIGHT, element.scrollHeight)}px`;
  }, []);

  useEffect(autoGrow, [text, autoGrow]);

  // Rascunho é gravado com atraso curto para não escrever a cada tecla.
  useEffect(() => {
    if (!conversation) return;
    const timer = window.setTimeout(() => void persistDraft(conversation.id), 600);
    return () => window.clearTimeout(timer);
  }, [conversation, text, attachments.length, persistDraft]);

  const attachFromPaths = useCallback(
    async (paths: string[]) => {
      if (!conversation || paths.length === 0) return;
      setAttaching(true);
      try {
        const refs = await invoke('attachments:prepareFromPaths', { conversationId: conversation.id, paths });
        addAttachments(conversation.id, refs);
      } catch (err) {
        pushError(errorOf(err), 'Não foi possível anexar');
      } finally {
        setAttaching(false);
      }
    },
    [conversation, addAttachments, pushError],
  );

  const attachViaDialog = useCallback(async () => {
    if (!conversation) return;
    setAttaching(true);
    try {
      const refs = await invoke('attachments:choose', { conversationId: conversation.id });
      if (refs.length > 0) addAttachments(conversation.id, refs);
    } catch (err) {
      pushError(errorOf(err), 'Não foi possível anexar');
    } finally {
      setAttaching(false);
    }
  }, [conversation, addAttachments, pushError]);

  const submit = useCallback(async () => {
    if (!conversation) return;
    if (composing) return; // composição por IME em andamento
    if (text.trim() === '' && attachments.length === 0) return;

    const asSteer = intent === 'steer' && running && steerSupported;
    const ok = await send({
      conversationId: conversation.id,
      text,
      attachmentIds: attachments.map((attachment) => attachment.id),
      asSteer,
    });
    if (ok) {
      setIntent('newTurn');
      window.setTimeout(autoGrow, 0);
    }
  }, [conversation, composing, text, attachments, intent, running, steerSupported, send, autoGrow]);

  useEffect(() => {
    registerHandle({
      focus: () => textareaRef.current?.focus(),
      attach: () => void attachViaDialog(),
      submit: () => void submit(),
    });
    return () => registerHandle(null);
  }, [registerHandle, attachViaDialog, submit]);

  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabledLocally), [skills]);

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (!conversation) return;
    const imageItem = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    setAttaching(true);
    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const refs = await invoke('attachments:prepareFromClipboardImage', {
        conversationId: conversation.id,
        base64,
        suggestedName: file.name || undefined,
      });
      addAttachments(conversation.id, refs);
      pushToast({
        tone: 'info',
        title: t('composer.pasteImage'),
        body: refs[0]?.absolutePath ? `Salva em ${refs[0].absolutePath}` : undefined,
      });
    } catch (err) {
      pushError(errorOf(err), 'A imagem colada não pôde ser anexada');
    } finally {
      setAttaching(false);
    }
  };

  const onDrop = async (event: React.DragEvent<HTMLDivElement>): Promise<void> => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    // `pathForFile` só resolve o caminho; a autorização é decidida no main.
    const paths = files.map((file) => pathForFile(file)).filter((path) => path !== '');
    if (paths.length === 0) {
      pushToast({
        tone: 'warning',
        title: 'Nada foi anexado',
        body: 'Não foi possível resolver o caminho dos arquivos arrastados. Use o botão de anexar.',
      });
      return;
    }
    await attachFromPaths(paths);
  };

  const disabled = !conversation;
  const canSend = !disabled && (text.trim() !== '' || attachments.length > 0);

  return (
    <div
      className={clsx('flex-none border-t px-4 py-3', dragging && 'ring-1 ring-inset ring-[var(--accent)]')}
      style={{ background: 'var(--surface-1)' }}
      onDragOver={(event) => {
        event.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => void onDrop(event)}
    >
      <div className="mx-auto w-full max-w-[880px]">
        {dragging ? (
          <p className="mb-2 text-center text-[12.5px] text-[var(--accent)]">{t('composer.dropHere')}</p>
        ) : null}

        {attachments.length > 0 ? (
          <div className="mb-2">
            <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
              {t('composer.attachmentsTitle')} ({attachments.length})
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <li key={attachment.id}>
                  <span
                    className={clsx(
                      'inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-1 text-[12px]',
                    )}
                    style={{
                      background: 'var(--surface-2)',
                      borderColor: attachment.error ? 'var(--danger)' : 'var(--border)',
                    }}
                    title={attachment.error ?? attachment.absolutePath ?? attachment.fileName}
                  >
                    <IconFile size={12} className="flex-none text-[var(--text-faint)]" />
                    <span className="max-w-[220px] truncate text-[var(--text)]">{attachment.fileName}</span>
                    {attachment.sizeBytes !== undefined ? (
                      <span className="text-[11px] text-[var(--text-faint)]">
                        {formatBytes(attachment.sizeBytes)}
                      </span>
                    ) : null}
                    {attachment.error ? <Badge tone="danger">falhou</Badge> : null}
                    <IconButton
                      size="sm"
                      label={t('composer.removeAttachment')}
                      onClick={() => conversation && void removeAttachment(conversation.id, attachment.id)}
                    >
                      <IconClose size={11} />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {running ? (
          <div className="mb-2 flex items-center gap-2">
            <Segmented<'newTurn' | 'steer'>
              ariaLabel="Destino da mensagem"
              size="sm"
              value={intent}
              onChange={setIntent}
              options={[
                { value: 'newTurn', label: t('composer.newTurn'), hint: 'Enfileira como um novo turno.' },
                {
                  value: 'steer',
                  label: t('composer.steerTurn'),
                  hint: 'Entrega a mensagem ao turno que está em execução.',
                  disabled: !steerSupported,
                  disabledReason: t('composer.steerUnavailable'),
                },
              ]}
            />
            {!steerSupported ? (
              <span className="text-[11.5px] text-[var(--text-faint)]">{t('composer.steerUnavailable')}</span>
            ) : null}
          </div>
        ) : null}

        <div
          className="flex items-end gap-2 rounded-[var(--radius-lg)] border px-2.5 py-2"
          style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-strong)' }}
        >
          <div className="flex flex-none items-center gap-0.5 pb-0.5">
            <Tooltip content={t('composer.attach')}>
              <IconButton
                label={t('composer.attach')}
                onClick={() => void attachViaDialog()}
                disabled={disabled || attaching}
              >
                {attaching ? <Spinner size={13} /> : <IconPaperclip />}
              </IconButton>
            </Tooltip>

            <Popover
              label={t('composer.skills')}
              align="start"
              side="top"
              width={320}
              trigger={
                <IconButton label={t('composer.skills')} active={enabledSkills.length > 0} disabled={disabled}>
                  <IconSkill />
                </IconButton>
              }
            >
              <div className="max-h-[300px] overflow-y-auto p-2.5">
                <p className="mb-2 text-[11.5px] leading-snug text-[var(--text-faint)]">
                  {skills.length === 0 ? t('skills.codexOnly') : t('skills.localToggleNote')}
                </p>
                {skills.map((skill) => (
                  <label
                    key={skill.id}
                    className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-xs)] px-1.5 py-1.5 hover:bg-[var(--surface-3)]"
                  >
                    <input
                      type="checkbox"
                      checked={skill.enabledLocally}
                      disabled={skill.availability === 'unsupported'}
                      onChange={(event) => setSkillEnabled(skill.id, event.target.checked)}
                      className="mt-[3px]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] text-[var(--text)]">{skill.name}</span>
                      {skill.description ? (
                        <span className="block text-[11.5px] leading-snug text-[var(--text-faint)]">
                          {skill.description}
                        </span>
                      ) : null}
                      {skill.availability === 'unsupported' ? (
                        <Badge tone="danger">{skill.availabilityReason ?? t('common.unavailable')}</Badge>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </Popover>
          </div>

          <textarea
            ref={textareaRef}
            rows={MIN_ROWS}
            value={text}
            disabled={disabled}
            onChange={(event) => conversation && setDraftText(conversation.id, event.target.value)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onPaste={(event) => void onPaste(event)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                // Impede que o atalho global (window) receba o mesmo evento e
                // dispare um SEGUNDO envio do mesmo texto.
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                if (!composing && !event.nativeEvent.isComposing) void submit();
              }
            }}
            placeholder={intent === 'steer' ? t('composer.placeholderSteer') : t('composer.placeholder')}
            aria-label={t('composer.placeholder')}
            className="min-h-[44px] flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-relaxed text-[var(--text)] placeholder:text-[var(--text-faint)] focus:outline-none disabled:cursor-not-allowed"
            style={{ maxHeight: MAX_HEIGHT }}
          />

          <div className="flex flex-none items-center gap-1.5 pb-0.5">
            {running ? (
              <Button
                size="sm"
                variant="secondary"
                iconLeft={<IconStop />}
                onClick={() => conversation && void interrupt(conversation.id)}
              >
                {t('composer.stop')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              iconLeft={<IconSend />}
              onClick={() => void submit()}
              disabled={!canSend}
              disabledReason={disabled ? 'Crie uma conversa primeiro.' : 'Escreva algo ou anexe um arquivo.'}
            >
              {t('composer.send')}
            </Button>
          </div>
        </div>

        <p className="mt-1.5 text-[11px] text-[var(--text-faint)]">
          {conversation?.mode === 'chat'
            ? t('header.modes.chatHint')
            : conversation?.mode === 'plan'
              ? t('header.modes.planHint')
              : t('header.modes.executeHint')}
        </p>
      </div>
    </div>
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
