/**
 * Fila central de aprovações.
 *
 * Tudo que precise de consentimento passa por aqui: comandos, alterações de
 * arquivo, permissões extras, rede e ferramentas específicas. Serve os dois
 * motores: no Codex a solicitação vem do servidor; no motor direto, das
 * ferramentas locais.
 *
 * Regras aplicadas:
 *  - "permitir na sessão" tem escopo ESTREITO e descrito. Nunca vira acesso
 *    irrestrito.
 *  - operações destrutivas identificadas nunca são aprovadas automaticamente.
 *  - aprovações de uma conexão encerrada não são reutilizadas em outra.
 *  - `cancel` interrompe apenas a solicitação; interromper o turno é ação
 *    separada e explícita.
 */

import { randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalRequest,
  RiskEstimate,
} from '../../shared/domain';
import { appError } from '../../shared/errors';
import { logger } from '../services/logger';

export interface ApprovalBrokerCallbacks {
  onRequested(request: ApprovalRequest): void;
  onResolved(request: ApprovalRequest, decision: ApprovalDecision): void;
}

interface Entry {
  request: ApprovalRequest;
  /** Geração da conexão que originou a solicitação (Codex) ou 0 (motor direto). */
  generation: number;
  resolve(decision: ApprovalDecision): void;
  timer?: NodeJS.Timeout;
}

export interface RequestApprovalInput {
  conversationId: string;
  turnId?: string;
  engineId: ApprovalRequest['engineId'];
  kind: ApprovalKind;
  title: string;
  reason?: string;
  command?: ApprovalRequest['command'];
  files?: string[];
  diffs?: ApprovalRequest['diffs'];
  networkTargets?: string[];
  allowedDecisions?: ApprovalDecision[];
  /** Chave de escopo para "permitir na sessão". Sem ela, a opção não aparece. */
  sessionScopeKey?: string;
  sessionScopeDescription?: string;
  generation?: number;
  timeoutMs?: number;
}

/** Padrões que caracterizam operação destrutiva — nunca auto-aprovados. */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; signal: string }> = [
  { re: /\brm\b[^|;]*\s-[a-zA-Z]*[rf]/, signal: 'Remoção recursiva ou forçada de arquivos (rm -rf).' },
  { re: /\bRemove-Item\b[^|;]*-Recurse/i, signal: 'Remoção recursiva no PowerShell.' },
  { re: /\bformat\b|\bmkfs\b/i, signal: 'Formatação de dispositivo.' },
  { re: /\bdd\b\s+if=/, signal: 'Escrita direta em dispositivo com dd.' },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)/, signal: 'Operação destrutiva do Git.' },
  { re: /\b(shutdown|reboot)\b/i, signal: 'Desligamento ou reinício da máquina.' },
  { re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;]*\|\s*(ba)?sh/i, signal: 'Download executado diretamente por shell.' },
  { re: /\bnpm\s+publish\b|\bpip\s+install\b.*--break-system-packages/, signal: 'Publicação ou instalação com efeito global.' },
  { re: /:\(\)\s*\{.*\}\s*;/, signal: 'Possível fork bomb.' },
];

export function estimateRisk(input: {
  kind: ApprovalKind;
  commandDisplay?: string;
  files?: string[];
  networkTargets?: string[];
}): RiskEstimate {
  const signals: string[] = [];
  let level: RiskEstimate['level'] = 'low';

  const display = input.commandDisplay ?? '';
  for (const { re, signal } of DESTRUCTIVE_PATTERNS) {
    if (re.test(display)) {
      signals.push(signal);
      level = 'high';
    }
  }
  if (input.kind === 'networkAccess' && (input.networkTargets?.length ?? 0) > 0) {
    signals.push('A operação envolve acesso de rede pelas ferramentas do agente.');
    if (level === 'low') level = 'medium';
  }
  if (input.kind === 'additionalPermission') {
    signals.push('A operação pede ampliação de permissões além do workspace atual.');
    level = 'high';
  }
  if ((input.files?.length ?? 0) > 20) {
    signals.push(`A operação afeta ${input.files?.length} arquivos.`);
    if (level === 'low') level = 'medium';
  }
  if (signals.length === 0) {
    signals.push('Nenhum padrão de risco conhecido foi identificado nesta solicitação.');
  }
  return { level, method: 'heuristic', signals };
}

export function isDestructive(commandDisplay: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(({ re }) => re.test(commandDisplay));
}

export class ApprovalBroker {
  private readonly entries = new Map<string, Entry>();
  /** Concessões de sessão: conversationId → conjunto de chaves de escopo. */
  private readonly sessionGrants = new Map<string, Set<string>>();

  constructor(private readonly callbacks: ApprovalBrokerCallbacks) {}

  pending(): ApprovalRequest[] {
    return [...this.entries.values()].map((e) => e.request);
  }

  pendingFor(conversationId: string): ApprovalRequest[] {
    return this.pending().filter((r) => r.conversationId === conversationId);
  }

  hasSessionGrant(conversationId: string, scopeKey: string): boolean {
    return this.sessionGrants.get(conversationId)?.has(scopeKey) ?? false;
  }

  /**
   * Solicita aprovação. Resolve com a decisão da pessoa.
   * Se já existir concessão de sessão para o mesmo escopo, resolve na hora —
   * exceto para operações destrutivas identificadas.
   */
  async request(input: RequestApprovalInput): Promise<ApprovalDecision> {
    const commandDisplay = input.command?.display ?? '';
    const destructive = commandDisplay !== '' && isDestructive(commandDisplay);

    if (input.sessionScopeKey && !destructive && this.hasSessionGrant(input.conversationId, input.sessionScopeKey)) {
      logger.debug('approvals', 'Concessão de sessão aplicada', { scope: input.sessionScopeKey });
      return 'allowForSession';
    }

    const allowed: ApprovalDecision[] = input.allowedDecisions ?? [
      'allowOnce',
      ...(input.sessionScopeKey && !destructive ? (['allowForSession'] as ApprovalDecision[]) : []),
      'deny',
      'cancel',
    ];

    const request: ApprovalRequest = {
      id: randomUUID(),
      conversationId: input.conversationId,
      turnId: input.turnId,
      engineId: input.engineId,
      kind: input.kind,
      createdAt: new Date().toISOString(),
      title: input.title,
      reason: input.reason,
      command: input.command,
      files: input.files,
      diffs: input.diffs,
      networkTargets: input.networkTargets,
      allowedDecisions: allowed,
      risk: estimateRisk({
        kind: input.kind,
        commandDisplay,
        files: input.files,
        networkTargets: input.networkTargets,
      }),
      sessionScopeDescription: allowed.includes('allowForSession') ? input.sessionScopeDescription : undefined,
      expiresAt: input.timeoutMs ? new Date(Date.now() + input.timeoutMs).toISOString() : undefined,
    };

    return new Promise<ApprovalDecision>((resolve) => {
      const entry: Entry = {
        request,
        generation: input.generation ?? 0,
        resolve: (decision) => {
          if (entry.timer) clearTimeout(entry.timer);
          this.entries.delete(request.id);
          if (decision === 'allowForSession' && input.sessionScopeKey) {
            const set = this.sessionGrants.get(request.conversationId) ?? new Set<string>();
            set.add(input.sessionScopeKey);
            this.sessionGrants.set(request.conversationId, set);
          }
          this.callbacks.onResolved(request, decision);
          resolve(decision);
        },
      };
      if (input.timeoutMs) {
        entry.timer = setTimeout(() => {
          logger.info('approvals', 'Solicitação expirou sem decisão', { id: request.id });
          entry.resolve('cancel');
        }, input.timeoutMs);
      }
      this.entries.set(request.id, entry);
      this.callbacks.onRequested(request);
    });
  }

  resolve(approvalId: string, decision: ApprovalDecision): boolean {
    const entry = this.entries.get(approvalId);
    if (!entry) return false;
    if (!entry.request.allowedDecisions.includes(decision)) {
      throw appError('validation', {
        message: 'Esta decisão não é aceita por esta solicitação.',
        action: `Decisões possíveis: ${entry.request.allowedDecisions.join(', ')}.`,
      });
    }
    entry.resolve(decision);
    return true;
  }

  /** Cancela todas as solicitações de uma conversa (ex.: turno interrompido). */
  cancelForConversation(conversationId: string, reason = 'Turno interrompido.'): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.request.conversationId !== conversationId) continue;
      logger.debug('approvals', 'Solicitação cancelada', { id: entry.request.id, reason });
      entry.resolve('cancel');
      count += 1;
    }
    return count;
  }

  /**
   * Invalida solicitações e concessões de uma conexão encerrada.
   * Aprovações de uma conexão não podem ser reutilizadas em outra.
   */
  invalidateGeneration(generation: number): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.generation !== generation) continue;
      entry.resolve('cancel');
      count += 1;
    }
    // Concessões de sessão ficam atreladas à conexão que as originou.
    this.sessionGrants.clear();
    return count;
  }

  clearSessionGrants(conversationId?: string): void {
    if (conversationId) this.sessionGrants.delete(conversationId);
    else this.sessionGrants.clear();
  }

  sessionGrantsOf(conversationId: string): string[] {
    return [...(this.sessionGrants.get(conversationId) ?? [])];
  }
}
