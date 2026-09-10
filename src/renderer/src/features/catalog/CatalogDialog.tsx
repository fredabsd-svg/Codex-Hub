/**
 * Catálogo completo de modelos.
 *
 * Busca por nome e ID, favoritos, recentes, filtros por provedor, capacidade e
 * preço, ordenação, virtualização e cache com data de atualização.
 * Campos ausentes aparecem como "Não informado"; preço ausente NÃO significa
 * gratuito.
 */

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ModelDescriptor } from '@shared/domain';
import { t } from '../../i18n';
import { describePricing, formatContextWindow, formatDateTime, formatNumber, NOT_INFORMED } from '../../lib/format';
import { filterModels, useCatalogStore, vendorsOf, type CatalogSort } from '../../stores/catalogStore';
import { useAppStore } from '../../stores/appStore';
import { useConversationStore } from '../../stores/conversationStore';
import { Badge, Button, IconButton, Input, Select, Spinner, Switch } from '../../components/ui/primitives';
import { Dialog } from '../../components/ui/Dialog';
import { VirtualList } from '../../components/ui/VirtualList';
import { CapabilityChip } from '../../components/ui/CapabilityChip';
import { IconCheck, IconRefresh, IconSearch, IconStar, IconStarFilled } from '../../components/ui/icons';

const ROW_HEIGHT = 64;

export function CatalogDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const providers = useAppStore((state) => state.providers);
  const pages = useCatalogStore((state) => state.pages);
  const loading = useCatalogStore((state) => state.loading);
  const favorites = useCatalogStore((state) => state.favorites);
  const filters = useCatalogStore((state) => state.filters);
  const setFilters = useCatalogStore((state) => state.setFilters);
  const load = useCatalogStore((state) => state.load);
  const addManual = useCatalogStore((state) => state.addManual);
  const toggleFavorite = useCatalogStore((state) => state.toggleFavorite);
  const probeTools = useCatalogStore((state) => state.probeTools);
  const probing = useCatalogStore((state) => state.probing);

  const conversations = useConversationStore((state) => state.conversations);
  const activeId = useConversationStore((state) => state.activeId);
  const setParameters = useConversationStore((state) => state.setParameters);
  const conversation = conversations.find((c) => c.id === activeId) ?? null;

  const [providerId, setProviderId] = useState(conversation?.providerId ?? providers[0]?.id ?? '');
  const [selectedId, setSelectedId] = useState<string | null>(conversation?.modelId ?? null);
  const [manualId, setManualId] = useState('');

  useEffect(() => {
    if (open && providerId) void load(providerId);
  }, [open, providerId, load]);

  const page = pages[providerId];
  const models = useMemo(() => filterModels(page?.models ?? [], filters, favorites), [page?.models, filters, favorites]);
  const vendors = useMemo(() => vendorsOf(page?.models ?? []), [page?.models]);
  const selected = models.find((model) => model.id === selectedId) ?? models[0] ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('catalog.title')}
      description={
        page
          ? `${formatNumber(page.models.length)} modelo(s) · ${t('catalog.fetchedAt', { when: formatDateTime(page.fetchedAt) })}${page.fromCache ? ` · ${t('catalog.fromCache')}` : ''}`
          : t('catalog.noProvider')
      }
      width={1080}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="primary"
            disabled={!selected || !conversation}
            disabledReason={!conversation ? 'Crie uma conversa primeiro.' : 'Selecione um modelo.'}
            iconLeft={<IconCheck />}
            onClick={() => {
              if (!selected || !conversation) return;
              void setParameters(conversation.id, {
                modelId: selected.id,
                providerId: selected.providerId,
                engineId: selected.providerId === 'codex' ? 'codex' : 'direct',
              });
              onClose();
            }}
          >
            {t('catalog.select')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => setProviderId(provider.id)}
                aria-pressed={provider.id === providerId}
                className={clsx(
                  'rounded-[var(--radius-xs)] border px-2 py-1 text-[12px] transition-colors',
                  provider.id === providerId ? 'text-[var(--text)]' : 'text-[var(--text-muted)]',
                )}
                style={{
                  background: provider.id === providerId ? 'var(--accent-soft)' : 'var(--surface-1)',
                  borderColor: provider.id === providerId ? 'var(--accent)' : 'var(--border)',
                }}
              >
                {provider.label}
              </button>
            ))}
            <div className="ml-auto">
              <IconButton label={t('catalog.refresh')} onClick={() => void load(providerId, true)}>
                <IconRefresh />
              </IconButton>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <IconSearch
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
              />
              <Input
                value={filters.query}
                onChange={(event) => setFilters({ query: event.target.value })}
                placeholder={t('catalog.searchPlaceholder')}
                aria-label={t('catalog.searchPlaceholder')}
                className="h-8 pl-8"
              />
            </div>
            <Select
              value={filters.sort}
              onChange={(event) => setFilters({ sort: event.target.value as CatalogSort })}
              aria-label="Ordenação"
              className="h-8 w-[210px]"
            >
              <option value="name">{t('catalog.sortName')}</option>
              <option value="priceAsc">{t('catalog.sortPriceAsc')}</option>
              <option value="context">{t('catalog.sortContext')}</option>
              <option value="recent">{t('catalog.sortRecent')}</option>
            </Select>
            {vendors.length > 1 ? (
              <Select
                value={filters.vendor ?? ''}
                onChange={(event) => setFilters({ vendor: event.target.value || null })}
                aria-label="Fornecedor"
                className="h-8 w-[160px]"
              >
                <option value="">Todos os fornecedores</option>
                {vendors.map((vendor) => (
                  <option key={vendor} value={vendor}>
                    {vendor}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>

          <div className="mb-2 grid gap-1.5 sm:grid-cols-2">
            <Switch
              checked={filters.onlyFavorites}
              onChange={(value) => setFilters({ onlyFavorites: value })}
              label={t('catalog.onlyFavorites')}
            />
            <Switch
              checked={filters.onlyTools}
              onChange={(value) => setFilters({ onlyTools: value })}
              label={t('catalog.onlyTools')}
              hint="Só modelos com `tools` declarado no catálogo."
            />
            <Switch
              checked={filters.onlyImages}
              onChange={(value) => setFilters({ onlyImages: value })}
              label={t('catalog.onlyImages')}
            />
            <Switch
              checked={filters.onlyZeroPrice}
              onChange={(value) => setFilters({ onlyZeroPrice: value })}
              label={t('catalog.onlyFree')}
              hint="Apenas modelos cujo preço informado é zero. Preço ausente não entra neste filtro."
            />
          </div>

          <div className="ch-panel overflow-hidden">
            {loading[providerId] ? (
              <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-[var(--text-muted)]">
                <Spinner /> {t('common.loading')}
              </div>
            ) : models.length === 0 ? (
              <p className="px-4 py-12 text-center text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                {page?.warning ?? t('catalog.empty')}
              </p>
            ) : (
              <VirtualList
                items={models}
                itemHeight={ROW_HEIGHT}
                height={360}
                ariaLabel={t('catalog.title')}
                renderItem={(model, index) => (
                  <CatalogRow
                    model={model}
                    index={index}
                    total={models.length}
                    selected={model.id === selected?.id}
                    favorite={favorites.includes(`${model.providerId}::${model.id}`)}
                    onSelect={() => setSelectedId(model.id)}
                    onToggleFavorite={() => void toggleFavorite(model.providerId, model.id)}
                  />
                )}
              />
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-end gap-2">
            <div className="min-w-[200px] flex-1">
              <label htmlFor="manual-model" className="mb-1 block text-[12px] text-[var(--text-muted)]">
                {t('catalog.manualTitle')}
              </label>
              <Input
                id="manual-model"
                value={manualId}
                onChange={(event) => setManualId(event.target.value)}
                placeholder={t('catalog.manualPlaceholder')}
                className="h-8"
              />
            </div>
            <Button
              size="sm"
              onClick={() => {
                if (manualId.trim() === '') return;
                void addManual(providerId, manualId.trim());
                setManualId('');
              }}
              disabled={manualId.trim() === ''}
              disabledReason="Informe o ID do modelo."
            >
              {t('common.add')}
            </Button>
            <p className="w-full text-[11.5px] leading-snug text-[var(--text-faint)]">{t('catalog.manualHelp')}</p>
          </div>
        </div>

        <ModelDetails
          model={selected}
          probing={probing === `${selected?.providerId}::${selected?.id}`}
          onProbe={() => selected && void probeTools(selected.providerId, selected.id)}
        />
      </div>
    </Dialog>
  );
}

function CatalogRow({
  model,
  index,
  total,
  selected,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  model: ModelDescriptor;
  index: number;
  total: number;
  selected: boolean;
  favorite: boolean;
  onSelect(): void;
  onToggleFavorite(): void;
}) {
  const pricing = describePricing(model.pricing);
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={total}
      className={clsx(
        'flex h-full items-center gap-2 border-b px-3 transition-colors',
        selected ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--surface-2)]',
      )}
    >
      <IconButton
        size="sm"
        label={favorite ? t('common.unfavorite') : t('common.favorite')}
        onClick={onToggleFavorite}
      >
        {favorite ? <IconStarFilled size={13} className="text-[var(--warning)]" /> : <IconStar size={13} />}
      </IconButton>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 py-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-[var(--text)]">{model.displayName}</span>
          {model.unverified ? <Badge tone="warning">{t('catalog.unverified')}</Badge> : null}
          {model.codex?.isDefault ? <Badge tone="accent">{t('catalog.codexDefault')}</Badge> : null}
        </span>
        <span className="ch-mono mt-0.5 block truncate text-[11px] text-[var(--text-faint)]" title={model.id}>
          {model.id}
        </span>
      </button>
      <div className="hidden w-[130px] flex-none text-right text-[11.5px] text-[var(--text-muted)] sm:block">
        {formatContextWindow(model.contextWindow)}
      </div>
      <div
        className="hidden w-[170px] flex-none truncate text-right text-[11.5px] text-[var(--text-muted)] md:block"
        title={pricing.detail.join(' · ')}
      >
        {pricing.label}
      </div>
      <div className="flex flex-none items-center gap-1">
        <CapabilityChip capability={model.capabilities.toolCalling} capabilityKey="toolCalling" compact />
        <CapabilityChip capability={model.capabilities.imageInput} capabilityKey="imageInput" compact />
      </div>
    </div>
  );
}

function ModelDetails({
  model,
  probing,
  onProbe,
}: {
  model: ModelDescriptor | null;
  probing: boolean;
  onProbe(): void;
}) {
  if (!model) {
    return (
      <aside className="ch-panel p-3 text-[12.5px] text-[var(--text-muted)]">
        Selecione um modelo para ver os detalhes.
      </aside>
    );
  }
  const pricing = describePricing(model.pricing);
  return (
    <aside className="ch-panel flex flex-col gap-3 p-3 text-[12.5px]">
      <div>
        <h3 className="text-[14px] font-semibold text-[var(--text)]">{model.displayName}</h3>
        <p className="ch-mono mt-0.5 break-all text-[11.5px] text-[var(--text-faint)]">{model.id}</p>
        {model.description ? (
          <p className="mt-1.5 max-h-24 overflow-y-auto leading-snug text-[var(--text-muted)]">{model.description}</p>
        ) : null}
      </div>

      <dl className="space-y-1">
        <DetailRow label={t('catalog.columns.provider')} value={model.vendor ?? model.providerId} />
        <DetailRow
          label={t('catalog.columns.modalities')}
          value={
            model.inputModalities.length > 0 || model.outputModalities.length > 0
              ? `${model.inputModalities.join(', ') || '?'} → ${model.outputModalities.join(', ') || '?'}`
              : NOT_INFORMED
          }
        />
        <DetailRow label={t('catalog.columns.context')} value={formatContextWindow(model.contextWindow)} />
        <DetailRow
          label={t('catalog.columns.maxOutput')}
          value={model.maxOutputTokens ? `${formatNumber(model.maxOutputTokens)} tokens` : NOT_INFORMED}
        />
      </dl>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
          {t('catalog.columns.pricing')}
        </p>
        <ul className="space-y-0.5 text-[var(--text-muted)]">
          {pricing.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
          {t('catalog.columns.parameters')}
        </p>
        {model.supportedParameters.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {model.supportedParameters.map((parameter) => (
              <Badge key={parameter} tone="neutral" mono>
                {parameter}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-[var(--text-faint)]">{NOT_INFORMED}</p>
        )}
      </div>

      <div>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
          {t('catalog.columns.capabilities')}
        </p>
        <div className="flex flex-wrap gap-1">
          <CapabilityChip capability={model.capabilities.chat} capabilityKey="chat" />
          <CapabilityChip capability={model.capabilities.streaming} capabilityKey="streaming" />
          <CapabilityChip capability={model.capabilities.toolCalling} capabilityKey="toolCalling" />
          <CapabilityChip capability={model.capabilities.imageInput} capabilityKey="imageInput" />
          <CapabilityChip capability={model.capabilities.taskExecution} capabilityKey="taskExecution" />
          <CapabilityChip capability={model.capabilities.reasoningEffort} capabilityKey="reasoningEffort" />
        </div>
        {model.providerId === 'openrouter' ? (
          <>
            <Button size="sm" variant="secondary" className="mt-2" loading={probing} onClick={onProbe}>
              {probing ? t('catalog.probeRunning') : t('catalog.probeTools')}
            </Button>
            <p className="mt-1 text-[11.5px] leading-snug text-[var(--text-faint)]">{t('catalog.probeExplain')}</p>
          </>
        ) : null}
      </div>

      {model.codex ? (
        <div>
          <p className="mb-1 text-[11px] uppercase tracking-wide text-[var(--text-faint)]">
            {t('catalog.codexExtras')}
          </p>
          <dl className="space-y-1">
            {model.codex.reasoningEffortLevels?.length ? (
              <DetailRow label={t('catalog.codexEfforts')} value={model.codex.reasoningEffortLevels.join(', ')} />
            ) : null}
            {model.codex.defaultReasoningEffort ? (
              <DetailRow label="Raciocínio padrão" value={model.codex.defaultReasoningEffort} />
            ) : null}
            {model.codex.personalities?.length ? (
              <DetailRow label={t('catalog.codexPersonalities')} value={model.codex.personalities.join(', ')} />
            ) : null}
            {model.codex.upgradeAvailable ? (
              <DetailRow label={t('catalog.codexUpgrade')} value={model.codex.upgradeNotice ?? 'sim'} />
            ) : null}
          </dl>
        </div>
      ) : null}
    </aside>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-none text-[var(--text-faint)]">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[var(--text)]" title={value}>
        {value}
      </dd>
    </div>
  );
}
