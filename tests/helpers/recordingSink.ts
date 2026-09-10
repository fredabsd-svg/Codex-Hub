/**
 * `TurnSink` de teste que registra tudo o que o motor publica.
 */

import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, ConversationItem, EffectivePolicy, ErrorDetail, FileDiff, PlanStep, TokenUsage } from '../../src/shared/domain';
import type { NewItem, StatusValue, TurnSink } from '../../src/main/engines/types';

export interface RecordedSink extends TurnSink {
  items: ConversationItem[];
  statuses: StatusValue[];
  diffs: FileDiff[][];
  usages: TokenUsage[];
  errors: ErrorDetail[];
  policies: EffectivePolicy[];
  approvals: ApprovalRequest[];
  completed: Array<{ usage?: TokenUsage; upstream?: string }>;
  failures: ErrorDetail[];
  cancellations: string[];
  nativeThreads: string[];
  textOf(itemId: string): string;
  itemsOfKind(kind: ConversationItem['kind']): ConversationItem[];
}

export function createRecordingSink(conversationId = 'c1'): RecordedSink {
  const items: ConversationItem[] = [];
  const sink: RecordedSink = {
    items,
    statuses: [],
    diffs: [],
    usages: [],
    errors: [],
    policies: [],
    approvals: [],
    completed: [],
    failures: [],
    cancellations: [],
    nativeThreads: [],

    newItemId: () => randomUUID(),

    status(status) {
      sink.statuses.push(status);
    },

    itemStarted(item: NewItem) {
      const at = new Date().toISOString();
      const created: ConversationItem = {
        ...item,
        id: item.id ?? randomUUID(),
        conversationId,
        createdAt: at,
        updatedAt: at,
      };
      items.push(created);
      return created;
    },

    textDelta(itemId, delta) {
      const item = items.find((entry) => entry.id === itemId);
      if (item) item.text = `${item.text ?? ''}${delta}`;
    },

    reasoningDelta(itemId, delta) {
      const item = items.find((entry) => entry.id === itemId);
      if (item) item.text = `${item.text ?? ''}${delta}`;
    },

    planUpdated(itemId, steps: PlanStep[]) {
      const item = items.find((entry) => entry.id === itemId);
      if (item) item.plan = steps;
    },

    outputDelta(itemId, chunk) {
      const item = items.find((entry) => entry.id === itemId);
      if (item?.command) item.command.output += chunk;
    },

    itemCompleted(itemId, patch) {
      const index = items.findIndex((entry) => entry.id === itemId);
      if (index >= 0) items[index] = { ...(items[index] as ConversationItem), ...patch, status: patch?.status ?? 'completed' };
    },

    itemFailed(itemId, error) {
      const index = items.findIndex((entry) => entry.id === itemId);
      if (index >= 0) items[index] = { ...(items[index] as ConversationItem), status: 'failed', errorDetail: error };
    },

    diffUpdated(files) {
      sink.diffs.push(files);
    },

    usage(usage) {
      sink.usages.push(usage);
    },

    approvalRequested(request) {
      sink.approvals.push(request);
    },

    policy(policy) {
      sink.policies.push(policy);
    },

    turnCompleted(usage, effectiveUpstream) {
      sink.completed.push({ usage, upstream: effectiveUpstream });
    },

    turnFailed(error) {
      sink.failures.push(error);
    },

    turnCancelled(reason) {
      sink.cancellations.push(reason ?? '');
    },

    nativeThread(threadId) {
      sink.nativeThreads.push(threadId);
    },

    titleSuggested() {
      /* não usado nos testes */
    },

    error(error) {
      sink.errors.push(error);
    },

    textOf(itemId) {
      return items.find((entry) => entry.id === itemId)?.text ?? '';
    },

    itemsOfKind(kind) {
      return items.filter((entry) => entry.kind === kind);
    },
  };
  return sink;
}
