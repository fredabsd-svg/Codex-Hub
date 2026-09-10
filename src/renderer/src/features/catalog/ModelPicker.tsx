/**
 * Seletor pesquisável de provedor + modelo.
 *
 * Mostra ID exato, capacidades relevantes e preço com unidade. Trocar de
 * provedor ou motor avisa que pode ser necessária uma nova sessão no motor.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { ConversationSummary, ModelDescriptor, ProviderDescriptor } from '@shared/domain';
import { t } from '../../i18n';
import { describePricing, formatContextWindow, truncateMiddle } from '../../lib/format';
import { filterModels, useCatalogStore } from '../../stores/catalogStore';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { useUiStore } from '../../stores/uiStore';
import { Badge, Button, Input, SectionTitle, Spinner } from '../../components/ui/primitives';
import { Popover } from '../../components/ui/Popover';
import { VirtualList } from '../../components/ui/VirtualList';
import { CapabilityChip } from '../../components/ui/CapabilityChip';
import { IconChevronDown, IconList, IconPlug, IconStarFilled } from '../../components/ui/icons';

const ROW_HEIGHT = 58;

export function ModelPicker({ conversation }: { conversation: ConversationSummary | null }) {
  const providers = useAppStore((state) => state.providers);
  const connections = useAppStore((state) => state.connections);
  const pages = useCatalogStore((state) => state.pages);
  const loading = useCatalogStore((state) => state.loading);
  const favorites = useCatalogStore((state) => state.favorites);
  const load = useCatalogStore((state) => state.load);
  const setParameters = useConversationStore((state) => state.setParameters);
  const openDialog = useUiStore((state) => state.openDialog);
  const pushToast = useUiStore((state) => state.pushToast);

  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState(conversation?.providerId ?? providers[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (conversation?.providerId) setProviderId(conversation.providerId);
  }, [conversation?.providerId]);

  useEffect(() => {
    if (open && providerId) void load(providerId);
  }, [open, providerId, load]);

  const page = pages[providerId];
  const models = useMemo(
    () =>
      filterModels(page?.models ?? [], { ...useCatalogStore.getState().filters, query, sort: 'name' }, favorites),
    [page?.models, query, favorites],
  );

  const currentModel = conversation ? pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId) : undefined;
  const currentProvider = providers.find((p) => p.id === conversation?.providerId);

  const choose = (model: ModelDescriptor): void => {
    if (!conversation) return;
    const engineId = model.providerId === 'codex' ? 'codex' : 'direct';
    const changesProvider = conversation.providerId !== model.providerId;
    const changesEngine = conversation.engineId !== engineId;
    void setParameters(conversation.id, { modelId: model.id, providerId: model.providerId, engineId });
    if (changesProvider || changesEngine) {
      pushToast({
        tone: 'info',
        title: 'Provedor ou motor alterado',
        body:
          'Uma nova sessão pode ser aberta no motor para o próximo turno. O histórico atual permanece salvo; nada foi convertido ou migrado sem aviso.',
      });
    }
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={t('header.model')}
      align="start"
      width={520}
      trigger={
        <button
          type="button"
          className={clsx(
            // min-w garante que o nome do modelo nunca some por falta de espaço.
            'flex h-8 min-w-[132px] max-w-[320px] items-center gap-2 rounded-[var(--radius-sm)] border px-2.5',
            'text-left transition-colors hover:bg-[var(--surface-3)]',
          )}
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
          disabled={!conversation}
          // O rótulo acessível diz o que o botão é, não só o nome do modelo.
          aria-label={`${t('header.model')}: ${conversation ? (currentModel?.displayName ?? conversation.modelId) : 'nenhum'}`}
          title={
            conversation
              ? `${currentProvider?.label ?? conversation.providerId} · ${conversation.modelId}`
              : 'Crie uma conversa para escolher o modelo'
          }
        >
          <IconPlug size={14} className="flex-none text-[var(--text-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text)]">
            {conversation ? (currentModel?.displayName ?? conversation.modelId) : 'Sem modelo'}
          </span>
          <IconChevronDown size={14} className="flex-none text-[var(--text-faint)]" />
        </button>
      }
    >
      <div className="flex flex-col" style={{ maxHeight: 460 }}>
        <div className="border-b p-2.5">
          <div className="mb-2 flex flex-wrap gap-1">
            {providers.map((provider) => (
              <ProviderTab
                key={provider.id}
                provider={provider}
                active={provider.id === providerId}
                state={connections[provider.id]?.state}
                onClick={() => {
                  setProviderId(provider.id);
                  setActiveIndex(0);
                }}
              />
            ))}
          </div>
          <Input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(models.length - 1, index + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(0, index - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const model = models[activeIndex];
                if (model) choose(model);
              }
            }}
            placeholder={t('catalog.searchPlaceholder')}
            aria-label={t('catalog.searchPlaceholder')}
            className="h-8"
          />
        </div>

        <div className="min-h-0 flex-1">
          {loading[providerId] ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-[var(--text-muted)]">
              <Spinner /> {t('common.loading')}
            </div>
          ) : models.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)]">
              {page?.warning ?? t('catalog.empty')}
            </div>
          ) : (
            <VirtualList
              items={models}
              itemHeight={ROW_HEIGHT}
              height={300}
              ariaLabel={t('header.model')}
              activeIndex={activeIndex}
              renderItem={(model, index) => (
                <ModelRow
                  model={model}
                  active={index === activeIndex}
                  selected={conversation?.modelId === model.id && conversation.providerId === model.providerId}
                  favorite={favorites.includes(`${model.providerId}::${model.id}`)}
                  index={index}
                  total={models.length}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(model)}
                />
              )}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-2.5 py-2">
          <span className="text-[11.5px] text-[var(--text-faint)]">
            {page
              ? `${page.models.length} modelo(s)${page.fromCache ? ` · ${t('catalog.fromCache')}` : ''}`
              : t('catalog.noProvider')}
          </span>
          <Button
            size="sm"
            variant="ghost"
            iconLeft={<IconList />}
            onClick={() => {
              setOpen(false);
              openDialog('catalog');
            }}
          >
            {t('catalog.title')}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

function ProviderTab({
  provider,
  active,
  state,
  onClick,
}: {
  provider: ProviderDescriptor;
  active: boolean;
  state: string | undefined;
  onClick(): void;
}) {
  const tone =
    state === 'connected' ? 'success' : state === 'unauthorized' ? 'warning' : state === 'error' ? 'danger' : 'neutral';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] border px-2 py-1 text-[12px] transition-colors',
        active ? 'text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]',
      )}
      style={{
        background: active ? 'var(--accent-soft)' : 'var(--surface-1)',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
      }}
      title={provider.description}
    >
      {provider.label}
      <Badge tone={tone}>{state === 'connected' ? 'ok' : (state ?? '—')}</Badge>
    </button>
  );
}

function ModelRow({
  model,
  active,
  selected,
  favorite,
  index,
  total,
  onClick,
  onMouseEnter,
}: {
  model: ModelDescriptor;
  active: boolean;
  selected: boolean;
  favorite: boolean;
  index: number;
  total: number;
  onClick(): void;
  onMouseEnter(): void;
}) {
  const pricing = describePricing(model.pricing);
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      className={clsx(
        'flex h-full w-full items-center gap-2.5 px-2.5 text-left transition-colors',
        active && 'bg-[var(--surface-3)]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {favorite ? <IconStarFilled size={12} className="flex-none text-[var(--warning)]" /> : null}
          <span className="truncate text-[13px] font-medium text-[var(--text)]">{model.displayName}</span>
          {model.unverified ? <Badge tone="warning">{t('catalog.unverified')}</Badge> : null}
          {selected ? <Badge tone="accent">{t('catalog.selected')}</Badge> : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="ch-mono truncate text-[11px] text-[var(--text-faint)]" title={model.id}>
            {truncateMiddle(model.id, 46)}
          </span>
          <span className="flex-none text-[11px] text-[var(--text-faint)]">
            {formatContextWindow(model.contextWindow)}
          </span>
          <span className="flex-none truncate text-[11px] text-[var(--text-faint)]" title={pricing.detail.join(' · ')}>
            {pricing.label}
          </span>
        </div>
      </div>
      <div className="flex flex-none items-center gap-1">
        <CapabilityChip capability={model.capabilities.toolCalling} capabilityKey="toolCalling" compact />
        <CapabilityChip capability={model.capabilities.imageInput} capabilityKey="imageInput" compact />
      </div>
    </button>
  );
}

export function EffortPicker({ conversation }: { conversation: ConversationSummary | null }) {
  const setParameters = useConversationStore((state) => state.setParameters);
  const pages = useCatalogStore((state) => state.pages);
  const model = conversation ? pages[conversation.providerId]?.models.find((m) => m.id === conversation.modelId) : undefined;

  const capability = model?.capabilities.reasoningEffort;
  if (!conversation || !capability || capability.state === 'unsupported') return null;

  const levels = model?.codex?.reasoningEffortLevels ?? ['minimal', 'low', 'medium', 'high'];
  const current = conversation.parameters.reasoningEffort;

  return (
    <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)]">
      <span className="ch-sr-only">{t('header.effort')}</span>
      <select
        className="h-8 rounded-[var(--radius-sm)] border px-2 text-[12.5px]"
        style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
        value={current ?? ''}
        title={
          capability.state === 'unknown'
            ? 'O catálogo não confirma suporte a esforço de raciocínio para este modelo. O parâmetro só é enviado se você escolher um valor.'
            : (capability.reason ?? t('header.effort'))
        }
        onChange={(event) => {
          const value = event.target.value;
          void setParameters(conversation.id, {
            reasoningEffort: value === '' ? undefined : (value as 'minimal' | 'low' | 'medium' | 'high'),
          });
        }}
      >
        <option value="">Esforço: padrão do modelo</option>
        {levels.map((level) => (
          <option key={level} value={level}>
            Esforço: {level}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CatalogSectionTitle({ children }: { children: React.ReactNode }) {
  return <SectionTitle>{children}</SectionTitle>;
}
