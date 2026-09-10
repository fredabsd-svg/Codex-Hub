/**
 * Exportação de conversas em Markdown e JSON.
 *
 * Função pura, compartilhada entre o processo principal (salvar em arquivo) e
 * o renderer (copiar para a área de transferência). Nada aqui toca disco.
 *
 * Regras de honestidade preservadas: uso e custo só aparecem quando o provedor
 * informou; estimativas são rotuladas como estimativas.
 */

import type { ConversationItem, ConversationSummary, TokenUsage } from './domain';

export type ConversationExportFormat = 'markdown' | 'json';

export interface ConversationExportInput {
  conversation: ConversationSummary;
  items: ConversationItem[];
  /** Nome e versão do aplicativo, para o rodapé. */
  app?: { name: string; version: string };
  /** Data de geração (ISO). Padrão: agora. */
  generatedAt?: string;
}

const KIND_LABEL: Record<ConversationItem['kind'], string> = {
  userMessage: 'Você',
  agentMessage: 'Assistente',
  reasoningSummary: 'Resumo de raciocínio',
  plan: 'Plano',
  commandExecution: 'Comando',
  toolCall: 'Ferramenta',
  fileChange: 'Alterações de arquivo',
  error: 'Erro',
  notice: 'Aviso',
};

const MODE_LABEL: Record<ConversationSummary['mode'], string> = {
  chat: 'Conversar',
  plan: 'Planejar',
  execute: 'Executar',
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function usageLine(usage: TokenUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.promptTokens !== undefined) parts.push(`entrada ${usage.promptTokens}`);
  if (usage.completionTokens !== undefined) parts.push(`saída ${usage.completionTokens}`);
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`);
  if (usage.reportedCost !== undefined) {
    parts.push(`custo informado ${usage.currency ?? 'USD'} ${usage.reportedCost.toFixed(6)}`);
  } else if (usage.estimatedCost !== undefined) {
    parts.push(`custo ESTIMADO ${usage.currency ?? 'USD'} ${usage.estimatedCost.toFixed(6)}`);
  }
  return parts.length > 0 ? `_Uso: ${parts.join(' · ')} tokens_` : null;
}

/** Fecha um bloco de código com uma cerca maior do que qualquer cerca interna. */
function fence(content: string): string {
  const longest = Math.max(2, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

function renderItem(item: ConversationItem): string[] {
  const lines: string[] = [];
  const time = formatDate(item.createdAt);
  const heading = `### ${KIND_LABEL[item.kind] ?? item.kind} · ${time}`;

  switch (item.kind) {
    case 'userMessage': {
      lines.push(heading, '', item.text ?? '');
      if (item.attachments && item.attachments.length > 0) {
        lines.push('', ...item.attachments.map((a) => `- Anexo: ${a.fileName}${a.error ? ` (falhou: ${a.error})` : ''}`));
      }
      break;
    }
    case 'agentMessage': {
      const meta = [item.modelId, item.effectiveUpstream ? `via ${item.effectiveUpstream}` : undefined]
        .filter(Boolean)
        .join(' · ');
      lines.push(meta ? `${heading} · ${meta}` : heading, '', item.text ?? '');
      const usage = usageLine(item.usage);
      if (usage) lines.push('', usage);
      break;
    }
    case 'reasoningSummary':
      lines.push(heading, '', `> ${(item.text ?? '').split('\n').join('\n> ')}`);
      break;
    case 'plan':
      lines.push(
        heading,
        '',
        ...(item.plan ?? []).map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.text}`),
      );
      break;
    case 'commandExecution': {
      const command = item.command;
      lines.push(heading, '');
      if (command) {
        const f = fence(command.output);
        lines.push(`${f}sh`, `$ ${command.command}`, f);
        if (command.exitCode !== undefined) lines.push('', `Código de saída: ${command.exitCode}`);
        if (command.output !== '') lines.push('', `${f}text`, command.output, f);
        if (command.outputTruncated) lines.push('', '_Saída truncada na interface._');
      }
      break;
    }
    case 'toolCall': {
      const tool = item.tool;
      lines.push(heading, '');
      if (tool) {
        lines.push(`Ferramenta: \`${tool.toolName}\`${item.status === 'failed' || tool.error ? ' (falhou)' : ''}`);
        if (tool.error) lines.push('', tool.error);
        if (tool.arguments !== undefined) {
          const json = safeJson(tool.arguments);
          const f = fence(json);
          lines.push('', `${f}json`, json, f);
        }
      }
      break;
    }
    case 'fileChange': {
      lines.push(heading, '');
      for (const file of item.fileChange?.files ?? []) {
        lines.push(`- ${file.changeKind} \`${file.path}\` (+${file.additions} −${file.deletions})`);
        if (file.unifiedDiff) {
          const f = fence(file.unifiedDiff);
          lines.push('', `${f}diff`, file.unifiedDiff, f, '');
        }
      }
      break;
    }
    case 'error':
      lines.push(heading, '', item.errorDetail?.message ?? item.text ?? 'Falha.');
      if (item.errorDetail?.action) lines.push('', item.errorDetail.action);
      break;
    case 'notice':
    default:
      lines.push(heading, '', item.text ?? '');
      break;
  }
  return lines;
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function renderConversationMarkdown(input: ConversationExportInput): string {
  const { conversation, items } = input;
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const head: string[] = [
    `# ${conversation.title}`,
    '',
    `- Criada em: ${formatDate(conversation.createdAt)}`,
    `- Atualizada em: ${formatDate(conversation.updatedAt)}`,
    `- Provedor: ${conversation.providerId}`,
    `- Modelo: \`${conversation.modelId}\``,
    `- Motor: ${conversation.engineId === 'codex' ? 'Codex App Server' : 'Motor direto'}`,
    `- Modo: ${MODE_LABEL[conversation.mode] ?? conversation.mode}`,
  ];
  if (conversation.workspacePath) head.push(`- Workspace: \`${conversation.workspacePath}\``);
  if (conversation.forkedFromId) head.push('- Esta conversa é uma ramificação de outra.');

  const body = items.flatMap((item) => [...renderItem(item), '']);
  const totals = summarizeUsage(items);
  const footer: string[] = ['---', ''];
  if (totals.messages > 0) {
    footer.push(`Mensagens: ${totals.messages}.`);
  }
  if (totals.totalTokens !== undefined) footer.push(`Tokens informados pelo provedor: ${totals.totalTokens}.`);
  if (totals.reportedCost !== undefined) {
    footer.push(`Custo informado pelo provedor: ${totals.currency} ${totals.reportedCost.toFixed(6)}.`);
  }
  if (totals.estimatedCost !== undefined) {
    footer.push(`Custo ESTIMADO localmente (não confirmado): ${totals.currency} ${totals.estimatedCost.toFixed(6)}.`);
  }
  footer.push(
    '',
    `_Exportado por ${input.app ? `${input.app.name} ${input.app.version}` : 'Codex Hub'} em ${formatDate(generatedAt)}._`,
  );

  return [...head, '', ...body, ...footer].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd().concat('\n');
}

export function renderConversationJson(input: ConversationExportInput): string {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  return JSON.stringify(
    {
      format: 'codex-hub/conversation',
      version: 1,
      generatedAt,
      app: input.app,
      conversation: input.conversation,
      items: input.items,
    },
    null,
    2,
  ).concat('\n');
}

export function renderConversationExport(format: ConversationExportFormat, input: ConversationExportInput): string {
  return format === 'json' ? renderConversationJson(input) : renderConversationMarkdown(input);
}

/* ------------------------------------------------------------------ *
 * Totais de uso da conversa
 * ------------------------------------------------------------------ */

export interface UsageTotals {
  /** Mensagens de pessoa e assistente (itens técnicos não contam). */
  messages: number;
  /** Turnos que informaram uso. */
  turnsWithUsage: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** Soma dos custos INFORMADOS pelo provedor. */
  reportedCost?: number;
  /** Soma das estimativas locais — sempre identificadas como estimativa. */
  estimatedCost?: number;
  currency: string;
  /** true quando pelo menos um turno com uso não informou custo algum. */
  costIncomplete: boolean;
}

export function summarizeUsage(items: ConversationItem[]): UsageTotals {
  const totals: UsageTotals = { messages: 0, turnsWithUsage: 0, currency: 'USD', costIncomplete: false };
  const add = (key: 'promptTokens' | 'completionTokens' | 'reasoningTokens' | 'totalTokens', value?: number): void => {
    if (value === undefined || !Number.isFinite(value)) return;
    totals[key] = (totals[key] ?? 0) + value;
  };
  for (const item of items) {
    if (item.kind === 'userMessage' || item.kind === 'agentMessage') totals.messages += 1;
    const usage = item.usage;
    if (!usage) continue;
    totals.turnsWithUsage += 1;
    add('promptTokens', usage.promptTokens);
    add('completionTokens', usage.completionTokens);
    add('reasoningTokens', usage.reasoningTokens);
    add('totalTokens', usage.totalTokens);
    if (usage.currency) totals.currency = usage.currency;
    if (usage.reportedCost !== undefined) totals.reportedCost = (totals.reportedCost ?? 0) + usage.reportedCost;
    else if (usage.estimatedCost !== undefined) totals.estimatedCost = (totals.estimatedCost ?? 0) + usage.estimatedCost;
    else totals.costIncomplete = true;
  }
  return totals;
}

/** Nome de arquivo seguro para a exportação. */
export function exportFileName(conversation: ConversationSummary, format: ConversationExportFormat): string {
  const base = conversation.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  const stamp = conversation.updatedAt.slice(0, 10);
  return `${base || 'conversa'}-${stamp}.${format === 'json' ? 'json' : 'md'}`;
}
