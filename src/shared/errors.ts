import type { ErrorCode, ErrorDetail } from './domain';

export class AppError extends Error {
  readonly detail: ErrorDetail;

  constructor(detail: ErrorDetail) {
    super(detail.message);
    this.name = 'AppError';
    this.detail = detail;
  }
}

interface MessageTemplate {
  message: string;
  action?: string;
  retryable: boolean;
}

/**
 * Mensagens padrão em pt-BR. Cada uma explica o problema E oferece uma ação.
 * Chamadores podem sobrescrever `message`/`action` com algo mais específico.
 */
const TEMPLATES: Record<ErrorCode, MessageTemplate> = {
  unauthorized: {
    message: 'A credencial foi recusada pelo provedor.',
    action: 'Abra Configurações › Provedores e informe a chave novamente.',
    retryable: false,
  },
  forbidden: {
    message: 'A credencial não tem permissão para esta operação.',
    action: 'Verifique as permissões da chave no painel do provedor.',
    retryable: false,
  },
  insufficientCredit: {
    message: 'O provedor recusou a requisição por saldo ou crédito insuficiente.',
    action: 'Adicione crédito na conta do provedor e tente novamente.',
    retryable: true,
  },
  rateLimited: {
    message: 'O provedor aplicou limite de uso a esta credencial.',
    action: 'Aguarde a janela indicada ou escolha outro modelo.',
    retryable: true,
  },
  contextExceeded: {
    message: 'O conteúdo enviado excede a janela de contexto do modelo.',
    action: 'Remova anexos, reduza a saída de ferramentas ou use um modelo com contexto maior.',
    retryable: false,
  },
  unsupportedParameter: {
    message: 'O modelo recusou um parâmetro enviado.',
    action: 'Desative o parâmetro no painel de contexto e reenvie.',
    retryable: false,
  },
  modelUnavailable: {
    message: 'O modelo não está disponível para esta credencial agora.',
    action: 'Atualize o catálogo ou escolha outro modelo.',
    retryable: true,
  },
  providerUnavailable: {
    message: 'O provedor está indisponível ou respondeu com erro de servidor.',
    action: 'Tente novamente em alguns instantes.',
    retryable: true,
  },
  network: {
    message: 'Não foi possível concluir a conexão de rede.',
    action: 'Verifique a conexão e o endereço configurado, depois tente novamente.',
    retryable: true,
  },
  timeout: {
    message: 'A operação excedeu o tempo limite.',
    action: 'Tente novamente; se persistir, reduza o tamanho da requisição.',
    retryable: true,
  },
  cancelled: {
    message: 'A operação foi interrompida.',
    action: 'Envie uma nova mensagem quando quiser continuar.',
    retryable: false,
  },
  protocol: {
    message: 'A resposta recebida não segue o protocolo esperado.',
    action: 'Abra Configurações › Diagnóstico e exporte o relatório técnico.',
    retryable: false,
  },
  codexMissing: {
    message: 'O executável do Codex CLI não foi encontrado.',
    action: 'Informe o caminho em Configurações › Codex ou instale o Codex CLI.',
    retryable: false,
  },
  codexIncompatible: {
    message: 'A versão do Codex CLI encontrada não respondeu ao handshake esperado.',
    action: 'Atualize o Codex CLI ou selecione outro executável em Configurações › Codex.',
    retryable: false,
  },
  workspaceDenied: {
    message: 'O caminho está fora das raízes autorizadas deste workspace.',
    action: 'Autorize a pasta explicitamente ou escolha um caminho dentro do workspace.',
    retryable: false,
  },
  approvalDenied: {
    message: 'A operação foi recusada na fila de aprovações.',
    action: 'Reenvie a solicitação se quiser autorizá-la.',
    retryable: false,
  },
  toolLimit: {
    message: 'O limite configurado para o ciclo de ferramentas foi atingido.',
    action: 'Ajuste os limites em Configurações › Ferramentas ou divida a tarefa.',
    retryable: false,
  },
  validation: {
    message: 'Os dados enviados não passaram na validação.',
    action: 'Revise os campos destacados e tente novamente.',
    retryable: false,
  },
  persistence: {
    message: 'Não foi possível gravar os dados locais.',
    action: 'Verifique o espaço em disco e as permissões da pasta de dados.',
    retryable: true,
  },
  internal: {
    message: 'Ocorreu uma falha interna no aplicativo.',
    action: 'Exporte o diagnóstico em Configurações › Diagnóstico.',
    retryable: false,
  },
};

export function errorDetail(
  code: ErrorCode,
  overrides: Partial<Omit<ErrorDetail, 'code'>> = {},
): ErrorDetail {
  const template = TEMPLATES[code];
  return {
    code,
    message: overrides.message ?? template.message,
    action: overrides.action ?? template.action,
    technical: overrides.technical,
    retryable: overrides.retryable ?? template.retryable,
  };
}

export function appError(code: ErrorCode, overrides: Partial<Omit<ErrorDetail, 'code'>> = {}): AppError {
  return new AppError(errorDetail(code, overrides));
}

/** Reconhece um `detail` de domínio mesmo sem `instanceof AppError`. */
function carriedDetail(err: unknown): ErrorDetail | null {
  if (!err || typeof err !== 'object' || !('detail' in err)) return null;
  const detail = (err as { detail: unknown }).detail;
  if (!detail || typeof detail !== 'object') return null;
  const candidate = detail as Partial<ErrorDetail>;
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    code: candidate.code as ErrorCode,
    message: candidate.message,
    action: candidate.action,
    technical: candidate.technical,
    retryable: candidate.retryable ?? false,
  };
}

export function toErrorDetail(err: unknown, fallback: ErrorCode = 'internal'): ErrorDetail {
  if (err instanceof AppError) return err.detail;
  // Erros que atravessam limites de módulo podem perder a identidade da classe.
  const carried = carriedDetail(err);
  if (carried) return carried;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return errorDetail('cancelled');
    return errorDetail(fallback, { technical: `${err.name}: ${err.message}` });
  }
  return errorDetail(fallback, { technical: String(err) });
}

export function isAbort(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (err instanceof AppError && err.detail.code === 'cancelled')
  );
}
