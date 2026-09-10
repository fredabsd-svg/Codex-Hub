import type {
  Capability,
  CapabilityKey,
  CapabilityMap,
  CapabilityState,
  EngineId,
  ModelDescriptor,
} from './domain';

export function cap(state: CapabilityState, source: Capability['source'], reason?: string): Capability {
  return { state, source, reason, observedAt: new Date().toISOString() };
}

export function capabilityOf(model: ModelDescriptor | undefined, key: CapabilityKey): Capability {
  return model?.capabilities?.[key] ?? { state: 'unknown', source: 'inferred' };
}

export function isSupported(model: ModelDescriptor | undefined, key: CapabilityKey): boolean {
  return capabilityOf(model, key).state === 'supported';
}

export function isUnsupported(model: ModelDescriptor | undefined, key: CapabilityKey): boolean {
  return capabilityOf(model, key).state === 'unsupported';
}

/**
 * Combina a capacidade declarada pelo modelo com a do motor.
 * `unsupported` de qualquer lado vence; `unknown` só é superado por `unsupported`.
 */
export function effectiveCapability(model: CapabilityMap, engine: CapabilityMap, key: CapabilityKey): Capability {
  const m = model[key] ?? { state: 'unknown' as CapabilityState, source: 'inferred' as const };
  const e = engine[key] ?? { state: 'unknown' as CapabilityState, source: 'inferred' as const };
  if (m.state === 'unsupported') return m;
  if (e.state === 'unsupported') return e;
  if (m.state === 'supported' && e.state === 'supported') {
    // Preferir a procedência mais forte.
    return m.source === 'tested' ? m : e.source === 'tested' ? e : m;
  }
  return m.state === 'unknown' ? e : m;
}

/** Capacidades intrínsecas de cada motor, independentes do modelo. */
export const ENGINE_CAPABILITIES: Record<EngineId, CapabilityMap> = {
  codex: {
    chat: cap('supported', 'declared', 'Fluxo oficial de turnos do Codex App Server.'),
    streaming: cap('supported', 'declared', 'Deltas de mensagem, plano e saída de comandos.'),
    toolCalling: cap('supported', 'declared', 'Ferramentas executadas pelo runtime oficial do Codex.'),
    taskExecution: cap('supported', 'declared', 'Execução de comandos com sandbox e aprovações do Codex.'),
    imageInput: cap('unknown', 'inferred', 'Depende do modelo selecionado no Codex.'),
    fileInput: cap('supported', 'declared', 'Arquivos são referenciados por caminho absoluto autorizado.'),
    reasoningSummary: cap('unknown', 'inferred', 'Só aparece quando a API envia resumo para exibição.'),
  },
  direct: {
    chat: cap('supported', 'declared', 'Chat Completions do provedor.'),
    streaming: cap('supported', 'declared', 'SSE do provedor.'),
    toolCalling: cap('unknown', 'inferred', 'Depende do modelo declarar `tools` nos parâmetros suportados.'),
    taskExecution: cap(
      'unsupported',
      'declared',
      'Execução de comandos arbitrários está desabilitada no motor direto: não há mecanismo de isolamento verificado. As ferramentas estruturadas continuam disponíveis.',
    ),
    imageInput: cap('unknown', 'inferred', 'Depende das modalidades de entrada do modelo.'),
    fileInput: cap(
      'supported',
      'declared',
      'Arquivos são lidos por ferramentas autorizadas ou extraídos localmente — o provedor remoto não recebe caminhos locais.',
    ),
  },
};

/** Rótulos em pt-BR para exibição. */
export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  chat: 'Conversa',
  streaming: 'Streaming',
  imageInput: 'Entrada de imagem',
  fileInput: 'Entrada de arquivos',
  toolCalling: 'Chamada de ferramentas',
  taskExecution: 'Execução de tarefas',
  reasoningEffort: 'Esforço de raciocínio',
  reasoningSummary: 'Resumo de raciocínio',
  temperature: 'Temperatura',
  personality: 'Personalidade',
};

export const CAPABILITY_STATE_LABELS: Record<CapabilityState, string> = {
  supported: 'Suportado',
  unsupported: 'Não suportado',
  unknown: 'Desconhecido',
};

export const CAPABILITY_SOURCE_LABELS: Record<Capability['source'], string> = {
  declared: 'Declarado pelo catálogo',
  tested: 'Verificado em uso',
  inferred: 'Inferido',
};
