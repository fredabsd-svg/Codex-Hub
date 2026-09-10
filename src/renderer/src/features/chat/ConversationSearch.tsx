import { useEffect, useState } from 'react';
import type { ConversationSummary } from '@shared/domain';
import type { SearchConversationsResult } from '@shared/ipc';
import { t } from '../../i18n';
import { invoke } from '../../lib/api';
import { useConversationStore } from '../../stores/conversationStore';
import { Dialog } from '../../components/ui/Dialog';
import { Input, Spinner } from '../../components/ui/primitives';
import { IconSearch } from '../../components/ui/icons';

export function ConversationSearch({
  open,
  onClose,
  conversation,
}: {
  open: boolean;
  onClose(): void;
  conversation: ConversationSummary | null;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchConversationsResult['matches']>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [index, setIndex] = useState(0);
  const revealItem = useConversationStore((state) => state.revealItem);
  const id = conversation?.id;

  useEffect(() => {
    if (open) setQuery('');
  }, [open, id]);
  useEffect(() => {
    let current = true;
    const needle = query.trim();
    setMatches([]);
    setIndex(0);
    setError(false);
    if (!open || !id || needle.length < 2) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void invoke('conversations:search', { conversationId: id, query: needle, limit: 200 })
        .then((result) => {
          if (current) setMatches(result.matches);
        })
        .catch(() => {
          if (current) setError(true);
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    }, 180);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, id, query]);

  const select = (match: SearchConversationsResult['matches'][number]) => {
    onClose();
    void revealItem(match.conversationId, match.itemId);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('workspaceExperience.searchTitle')}
      description={conversation?.title ?? t('workspaceExperience.searchDescription')}
      width={720}
    >
      <div className="ch-search-field">
        <IconSearch size={17} />
        <Input
          aria-label={t('workspaceExperience.searchTitle')}
          placeholder={t('workspaceExperience.searchPlaceholder')}
          maxLength={500}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          data-autofocus
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="conversation-search-results"
          aria-activedescendant={matches[index] ? `search-result-${matches[index]!.itemId}` : undefined}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const next = matches.length
                ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
                : 0;
              setIndex(next);
              document
                .getElementById(`search-result-${matches[next]?.itemId}`)
                ?.scrollIntoView?.({ block: 'nearest' });
            } else if (event.key === 'Enter' && matches[index]) {
              event.preventDefault();
              select(matches[index]!);
            }
          }}
        />
      </div>
      <p className="ch-search-status" role="status">
        {loading ? (
          <>
            <Spinner size={12} /> {t('common.loading')}
          </>
        ) : error ? (
          t('workspaceExperience.searchError')
        ) : query.trim().length < 2 ? (
          t('workspaceExperience.searchHint')
        ) : matches.length ? (
          t('workspaceExperience.searchCount', { count: matches.length })
        ) : (
          t('workspaceExperience.searchEmpty')
        )}
      </p>
      <ul
        id="conversation-search-results"
        role="listbox"
        aria-label={t('workspaceExperience.searchTitle')}
        className="ch-search-results"
      >
        {matches.map((match, i) => (
          <li key={match.itemId}>
            <button
              type="button"
              role="option"
              aria-selected={index === i}
              id={`search-result-${match.itemId}`}
              className="ch-search-result"
              onClick={() => select(match)}
              onFocus={() => setIndex(i)}
            >
              <span>{highlight(match.snippet, query.trim())}</span>
              <span className="ch-search-result-action">
                {t('workspaceExperience.openMessage')} <span aria-hidden="true">↗</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 200 ? (
        <p className="ch-search-status">{t('workspaceExperience.searchLimit')}</p>
      ) : null}
    </Dialog>
  );
}

function highlight(text: string, query: string) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0 || !query) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  );
}
