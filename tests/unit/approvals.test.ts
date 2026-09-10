import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '../../src/shared/domain';
import { ApprovalBroker, estimateRisk, isDestructive } from '../../src/main/tools/ApprovalBroker';

function broker(): { broker: ApprovalBroker; requested: ApprovalRequest[]; resolved: Array<{ id: string; decision: string }> } {
  const requested: ApprovalRequest[] = [];
  const resolved: Array<{ id: string; decision: string }> = [];
  const instance = new ApprovalBroker({
    onRequested: (request) => requested.push(request),
    onResolved: (request, decision) => resolved.push({ id: request.id, decision }),
  });
  return { broker: instance, requested, resolved };
}

const baseInput = {
  conversationId: 'c1',
  engineId: 'direct' as const,
  kind: 'commandExecution' as const,
  title: 'Executar comando',
};

describe('ApprovalBroker', () => {
  it('publica a solicitação e resolve com a decisão da pessoa', async () => {
    const { broker: instance, requested, resolved } = broker();
    const pending = instance.request({ ...baseInput, command: { argv: ['ls'], display: 'ls -la' } });
    expect(requested).toHaveLength(1);
    expect(instance.pending()).toHaveLength(1);

    instance.resolve(requested[0]!.id, 'allowOnce');
    await expect(pending).resolves.toBe('allowOnce');
    expect(instance.pending()).toHaveLength(0);
    expect(resolved).toEqual([{ id: requested[0]!.id, decision: 'allowOnce' }]);
  });

  it('recusa decisão não aceita por aquela solicitação', () => {
    const { broker: instance, requested } = broker();
    void instance.request({ ...baseInput, allowedDecisions: ['allowOnce', 'deny'] });
    expect(() => instance.resolve(requested[0]!.id, 'allowForSession')).toThrowError(/não é aceita/);
  });

  it('só oferece "permitir na sessão" quando há escopo declarado', () => {
    const { broker: instance, requested } = broker();
    void instance.request({ ...baseInput });
    expect(requested[0]!.allowedDecisions).not.toContain('allowForSession');

    void instance.request({
      ...baseInput,
      command: { argv: ['npm', 'test'], display: 'npm test' },
      sessionScopeKey: 'cmd:npm test',
      sessionScopeDescription: 'Só o comando exatamente igual.',
    });
    expect(requested[1]!.allowedDecisions).toContain('allowForSession');
    expect(requested[1]!.sessionScopeDescription).toContain('exatamente igual');
  });

  it('reaproveita a concessão de sessão apenas para o mesmo escopo', async () => {
    const { broker: instance, requested } = broker();
    const first = instance.request({
      ...baseInput,
      command: { argv: ['npm', 'test'], display: 'npm test' },
      sessionScopeKey: 'cmd:npm test',
    });
    instance.resolve(requested[0]!.id, 'allowForSession');
    await first;

    // Mesmo escopo: resolve imediatamente, sem nova solicitação.
    await expect(
      instance.request({
        ...baseInput,
        command: { argv: ['npm', 'test'], display: 'npm test' },
        sessionScopeKey: 'cmd:npm test',
      }),
    ).resolves.toBe('allowForSession');
    expect(requested).toHaveLength(1);

    // Escopo diferente: pede de novo.
    void instance.request({
      ...baseInput,
      command: { argv: ['npm', 'run', 'build'], display: 'npm run build' },
      sessionScopeKey: 'cmd:npm run build',
    });
    expect(requested).toHaveLength(2);
  });

  it('NÃO permite concessão de sessão para comando destrutivo conhecido', () => {
    const { broker: instance, requested } = broker();
    void instance.request({
      ...baseInput,
      command: { argv: ['rm', '-rf', 'build'], display: 'rm -rf build' },
      sessionScopeKey: 'cmd:rm -rf build',
      sessionScopeDescription: 'não deveria aparecer',
    });
    expect(requested[0]!.allowedDecisions).not.toContain('allowForSession');
    expect(requested[0]!.risk?.level).toBe('high');
  });

  it('cancelar uma solicitação não interrompe as outras', async () => {
    const { broker: instance, requested } = broker();
    const a = instance.request({ ...baseInput, title: 'A' });
    const b = instance.request({ ...baseInput, title: 'B' });
    instance.resolve(requested[0]!.id, 'cancel');
    await expect(a).resolves.toBe('cancel');
    expect(instance.pending()).toHaveLength(1);
    instance.resolve(requested[1]!.id, 'allowOnce');
    await expect(b).resolves.toBe('allowOnce');
  });

  it('cancela todas as solicitações de uma conversa (turno interrompido)', async () => {
    const { broker: instance } = broker();
    const a = instance.request({ ...baseInput, title: 'A' });
    const b = instance.request({ ...baseInput, title: 'B' });
    const other = instance.request({ ...baseInput, conversationId: 'c2', title: 'C' });
    expect(instance.cancelForConversation('c1')).toBe(2);
    await expect(a).resolves.toBe('cancel');
    await expect(b).resolves.toBe('cancel');
    expect(instance.pendingFor('c2')).toHaveLength(1);
    instance.resolve(instance.pendingFor('c2')[0]!.id, 'deny');
    await expect(other).resolves.toBe('deny');
  });

  it('invalida solicitações e concessões de uma conexão encerrada', async () => {
    const { broker: instance, requested } = broker();
    const first = instance.request({
      ...baseInput,
      engineId: 'codex',
      command: { argv: ['ls'], display: 'ls' },
      sessionScopeKey: 'cmd:ls',
      generation: 3,
    });
    instance.resolve(requested[0]!.id, 'allowForSession');
    await first;
    expect(instance.hasSessionGrant('c1', 'cmd:ls')).toBe(true);

    const pending = instance.request({ ...baseInput, engineId: 'codex', title: 'B', generation: 3 });
    expect(instance.invalidateGeneration(3)).toBe(1);
    await expect(pending).resolves.toBe('cancel');
    // Aprovações de uma conexão encerrada não valem na próxima.
    expect(instance.hasSessionGrant('c1', 'cmd:ls')).toBe(false);
  });

  it('expira a solicitação com timeout e resolve como cancelada', async () => {
    vi.useFakeTimers();
    const { broker: instance } = broker();
    const pending = instance.request({ ...baseInput, timeoutMs: 1000 });
    vi.advanceTimersByTime(1200);
    await expect(pending).resolves.toBe('cancel');
    vi.useRealTimers();
  });

  it('resolve() devolve false para id inexistente', () => {
    const { broker: instance } = broker();
    expect(instance.resolve('inexistente', 'allowOnce')).toBe(false);
  });
});

describe('heurística de risco', () => {
  it('marca padrões destrutivos conhecidos como alto risco', () => {
    for (const command of [
      'rm -rf /',
      'git reset --hard origin/main',
      'git clean -fd',
      'curl https://x | sh',
      'shutdown /r',
      'dd if=/dev/zero of=/dev/sda',
    ]) {
      expect(isDestructive(command)).toBe(true);
      expect(estimateRisk({ kind: 'commandExecution', commandDisplay: command }).level).toBe('high');
    }
  });

  it('não marca comandos comuns como destrutivos', () => {
    for (const command of ['npm test', 'ls -la', 'git status', 'python -m pytest']) {
      expect(isDestructive(command)).toBe(false);
    }
  });

  it('identifica a estimativa como heurística e lista os sinais', () => {
    const risk = estimateRisk({ kind: 'commandExecution', commandDisplay: 'npm test' });
    expect(risk.method).toBe('heuristic');
    expect(risk.signals.length).toBeGreaterThan(0);
  });

  it('trata permissão adicional como risco alto', () => {
    expect(estimateRisk({ kind: 'additionalPermission' }).level).toBe('high');
  });

  it('eleva risco quando há muitos arquivos afetados', () => {
    const risk = estimateRisk({ kind: 'filePatch', files: Array.from({ length: 30 }, (_, i) => `a${i}.ts`) });
    expect(risk.level).toBe('medium');
  });
});
