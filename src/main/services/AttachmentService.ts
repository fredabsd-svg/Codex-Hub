/**
 * Preparação de anexos.
 *
 * Regras aplicadas:
 *  - o caminho vem do processo principal (diálogo nativo) ou de
 *    `webUtils.getPathForFile` no renderer. Ter o caminho NÃO concede leitura:
 *    tudo é revalidado contra as raízes autorizadas aqui.
 *  - documentos são COPIADOS para `<workspace>/.codex-hub/anexos`, preservando
 *    o nome quando possível e evitando conflitos, nomes reservados do Windows
 *    e path traversal. O destino é informado.
 *  - imagem é imagem por conteúdo/MIME; PDF, DOCX, XLSX, CSV, TXT e código
 *    NÃO são imagens.
 *  - extração local por formato quando aplicável; falhas e necessidade de OCR
 *    são informadas. Conteúdo binário nunca é apresentado como "lido".
 *  - nada é executado, e o workspace inteiro nunca é enviado automaticamente.
 */

import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import type { AttachmentDelivery, AttachmentRef, EngineId } from '../../shared/domain';
import { appError } from '../../shared/errors';
import { logger } from './logger';
import { safeFileName } from './pathSafety';
import type { WorkspaceService } from './WorkspaceService';

export const ATTACHMENTS_DIRNAME = join('.codex-hub', 'anexos');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.cs',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.php', '.swift', '.scala', '.sh', '.bash', '.ps1', '.sql', '.html',
  '.css', '.scss', '.less', '.vue', '.svelte', '.xml', '.gradle', '.dockerfile', '.env', '.gitignore',
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

/** Assinaturas de imagem — o tipo vem do CONTEÚDO, não da extensão. */
function sniffImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return null;
}

export interface AttachmentLimits {
  maxCount: number;
  maxBytes: number;
}

export interface PreparedAttachment extends AttachmentRef {
  conversationId: string;
}

export class AttachmentService {
  /** Anexos preparados por conversa, ainda não enviados. */
  private readonly pending = new Map<string, PreparedAttachment[]>();

  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly limits: () => AttachmentLimits,
  ) {}

  pendingFor(conversationId: string): PreparedAttachment[] {
    return [...(this.pending.get(conversationId) ?? [])];
  }

  /** Restaura anexos de um rascunho recuperado do disco. */
  restore(conversationId: string, attachments: AttachmentRef[]): AttachmentRef[] {
    const alive = attachments.filter((a) => !a.absolutePath || existsSync(a.absolutePath));
    this.pending.set(
      conversationId,
      alive.map((a) => ({ ...a, conversationId })),
    );
    return alive;
  }

  byIds(conversationId: string, ids: string[]): AttachmentRef[] {
    const list = this.pending.get(conversationId) ?? [];
    return ids
      .map((id) => list.find((a) => a.id === id))
      .filter((a): a is PreparedAttachment => a !== undefined);
  }

  consume(conversationId: string, ids: string[]): AttachmentRef[] {
    const used = this.byIds(conversationId, ids);
    const remaining = (this.pending.get(conversationId) ?? []).filter((a) => !ids.includes(a.id));
    this.pending.set(conversationId, remaining);
    return used;
  }

  async discard(conversationId: string, attachmentId: string): Promise<boolean> {
    const list = this.pending.get(conversationId) ?? [];
    const target = list.find((a) => a.id === attachmentId);
    if (!target) return false;
    this.pending.set(
      conversationId,
      list.filter((a) => a.id !== attachmentId),
    );
    // Remove o temporário copiado, se ainda existir e for nosso.
    if (target.absolutePath && target.absolutePath.includes(ATTACHMENTS_DIRNAME)) {
      await unlink(target.absolutePath).catch(() => undefined);
    }
    return true;
  }

  /**
   * Prepara arquivos para uma conversa.
   * `workspacePath` é obrigatório: sem pasta autorizada não há destino seguro.
   */
  async prepare(input: {
    conversationId: string;
    workspacePath: string | undefined;
    paths: string[];
    engineId: EngineId;
  }): Promise<AttachmentRef[]> {
    const limits = this.limits();
    if (!input.workspacePath) {
      throw appError('workspaceDenied', {
        message: 'Selecione um workspace antes de anexar arquivos.',
        action: 'Use Ctrl+O para escolher a pasta do projeto.',
      });
    }
    const existing = this.pending.get(input.conversationId) ?? [];
    if (existing.length + input.paths.length > limits.maxCount) {
      throw appError('validation', {
        message: `O limite de ${limits.maxCount} anexos por mensagem foi excedido.`,
        action: 'Remova alguns anexos ou aumente o limite em Configurações › Anexos.',
      });
    }

    const guard = this.workspaces.guardFor(input.workspacePath);
    const targetDir = join(guard.realRoot, ATTACHMENTS_DIRNAME);
    await mkdir(targetDir, { recursive: true });

    const prepared: PreparedAttachment[] = [];
    for (const rawPath of input.paths) {
      const ref = await this.prepareOne(rawPath, {
        conversationId: input.conversationId,
        engineId: input.engineId,
        targetDir,
        guard,
        maxBytes: limits.maxBytes,
      });
      prepared.push(ref);
    }
    this.pending.set(input.conversationId, [...existing, ...prepared]);
    return prepared;
  }

  private async prepareOne(
    rawPath: string,
    ctx: {
      conversationId: string;
      engineId: EngineId;
      targetDir: string;
      guard: ReturnType<WorkspaceService['guardFor']>;
      maxBytes: number;
    },
  ): Promise<PreparedAttachment> {
    const id = randomUUID();
    const fileName = basename(rawPath);
    const fail = (reason: string): PreparedAttachment => ({
      id,
      conversationId: ctx.conversationId,
      kind: 'unknown',
      fileName,
      error: reason,
      delivery: { type: 'failed', reason },
    });

    let info;
    try {
      info = await stat(rawPath);
    } catch {
      return fail(`O arquivo "${fileName}" não pôde ser lido no caminho informado.`);
    }
    if (!info.isFile()) return fail(`"${fileName}" não é um arquivo.`);
    if (info.size > ctx.maxBytes) {
      return fail(
        `"${fileName}" tem ${formatBytes(info.size)}, acima do limite de ${formatBytes(ctx.maxBytes)} por anexo.`,
      );
    }
    if (info.size === 0) return fail(`"${fileName}" está vazio.`);

    // Copia para a pasta de anexos do workspace, com nome seguro e único.
    const safeName = safeFileName(fileName);
    const destination = await uniqueDestination(ctx.targetDir, safeName);
    try {
      await copyFile(rawPath, destination);
    } catch (err) {
      return fail(
        `Não foi possível copiar "${fileName}" para a pasta de anexos: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const safe = ctx.guard.tryResolve(destination);
    if (!safe) {
      await unlink(destination).catch(() => undefined);
      return fail(`O destino do anexo "${fileName}" ficou fora das raízes autorizadas e foi descartado.`);
    }

    const head = await readHead(destination, 64 * 1024);
    const extension = extname(safeName).toLowerCase();
    const imageMime = sniffImageMime(head);
    if (!imageMime && IMAGE_EXTENSIONS.has(extension)) {
      // A extensão diz imagem, mas o conteúdo não confirma. Não tratamos como
      // imagem só por causa do nome do arquivo.
      return {
        id,
        conversationId: ctx.conversationId,
        kind: 'unknown',
        fileName: basename(destination),
        absolutePath: safeRealPath(ctx.guard, destination),
        sizeBytes: info.size,
        error: `"${fileName}" tem extensão de imagem, mas o conteúdo não corresponde a um formato de imagem reconhecido.`,
        delivery: {
          type: 'failed',
          reason: 'Conteúdo não reconhecido como imagem. O arquivo foi copiado para a pasta de anexos e pode ser lido pelas ferramentas.',
        },
      };
    }
    const kind: AttachmentRef['kind'] = imageMime
      ? 'image'
      : extension === '.pdf' || extension === '.docx' || extension === '.xlsx'
        ? 'document'
        : TEXT_EXTENSIONS.has(extension)
          ? 'code'
          : 'document';

    const delivery = await this.deliveryFor({
      kind,
      extension,
      imageMime,
      absolutePath: safe.realPath,
      engineId: ctx.engineId,
      sizeBytes: info.size,
    });

    return {
      id,
      conversationId: ctx.conversationId,
      kind,
      fileName: basename(destination),
      absolutePath: safe.realPath,
      mimeType: imageMime ?? MIME_BY_EXTENSION[extension],
      sizeBytes: info.size,
      delivery,
      error: delivery.type === 'failed' ? delivery.reason : undefined,
    };
  }

  private async deliveryFor(input: {
    kind: AttachmentRef['kind'];
    extension: string;
    imageMime: string | null;
    absolutePath: string;
    engineId: EngineId;
    sizeBytes: number;
  }): Promise<AttachmentDelivery> {
    if (input.imageMime) {
      return input.engineId === 'codex'
        ? { type: 'codexLocalPath', path: input.absolutePath }
        : { type: 'inlineImage', mimeType: input.imageMime, bytes: input.sizeBytes };
    }

    if (input.engineId === 'codex') {
      // O runtime do Codex lê arquivos por caminho absoluto autorizado.
      return { type: 'codexLocalPath', path: input.absolutePath };
    }

    // Motor direto: um caminho local não dá acesso ao provedor remoto.
    if (TEXT_EXTENSIONS.has(input.extension)) {
      try {
        const text = await readFile(input.absolutePath, 'utf8');
        return { type: 'extractedText', characters: text.length };
      } catch (err) {
        return {
          type: 'failed',
          reason: `Não foi possível ler o arquivo como texto: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    if (input.extension === '.pdf') {
      const extracted = await extractPdfText(input.absolutePath);
      if (extracted.text.trim() === '') {
        return {
          type: 'failed',
          reason:
            'Este PDF não expõe texto extraível (provavelmente é digitalizado). É necessário OCR, que este aplicativo não faz. Use o motor Codex ou converta o arquivo para texto antes de anexar.',
        };
      }
      const cachePath = `${input.absolutePath}.extraido.txt`;
      await writeFile(cachePath, extracted.text, 'utf8').catch(() => undefined);
      return { type: 'extractedText', characters: extracted.text.length, pages: extracted.pages };
    }

    if (input.extension === '.docx' || input.extension === '.xlsx') {
      return {
        type: 'failed',
        reason: `Extração de ${input.extension.replace('.', '').toUpperCase()} não está implementada nesta versão. O arquivo foi copiado para a pasta de anexos e pode ser lido pelas ferramentas no modo Planejar ou Executar.`,
      };
    }

    return { type: 'toolReadable', path: input.absolutePath };
  }

  /** Cola de imagem: bytes vêm do renderer, o destino é decidido aqui. */
  async prepareClipboardImage(input: {
    conversationId: string;
    workspacePath: string | undefined;
    base64: string;
    suggestedName?: string;
    engineId: EngineId;
  }): Promise<AttachmentRef[]> {
    if (!input.workspacePath) {
      throw appError('workspaceDenied', {
        message: 'Selecione um workspace antes de colar imagens.',
        action: 'Use Ctrl+O para escolher a pasta do projeto.',
      });
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(input.base64, 'base64');
    } catch {
      throw appError('validation', { message: 'A imagem colada não pôde ser decodificada.' });
    }
    const mime = sniffImageMime(buffer);
    if (!mime) {
      throw appError('validation', {
        message: 'O conteúdo colado não é uma imagem reconhecida.',
        action: 'Cole PNG, JPEG, GIF, WEBP ou BMP.',
      });
    }
    const limits = this.limits();
    if (buffer.byteLength > limits.maxBytes) {
      throw appError('validation', {
        message: `A imagem colada tem ${formatBytes(buffer.byteLength)}, acima do limite de ${formatBytes(limits.maxBytes)}.`,
      });
    }

    const guard = this.workspaces.guardFor(input.workspacePath);
    const targetDir = join(guard.realRoot, ATTACHMENTS_DIRNAME);
    await mkdir(targetDir, { recursive: true });
    const extension = mime === 'image/png' ? '.png' : mime === 'image/jpeg' ? '.jpg' : `.${mime.split('/')[1]}`;
    const base = safeFileName(input.suggestedName ?? `colado-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}${extension}`);
    const destination = await uniqueDestination(targetDir, base.includes('.') ? base : `${base}${extension}`);
    await writeFile(destination, buffer);
    const safe = guard.tryResolve(destination);
    if (!safe) {
      await unlink(destination).catch(() => undefined);
      throw appError('workspaceDenied', { message: 'O destino da imagem ficou fora do workspace autorizado.' });
    }

    const ref: PreparedAttachment = {
      id: randomUUID(),
      conversationId: input.conversationId,
      kind: 'image',
      fileName: basename(destination),
      absolutePath: safe.realPath,
      mimeType: mime,
      sizeBytes: buffer.byteLength,
      delivery:
        input.engineId === 'codex'
          ? { type: 'codexLocalPath', path: safe.realPath }
          : { type: 'inlineImage', mimeType: mime, bytes: buffer.byteLength },
    };
    const existing = this.pending.get(input.conversationId) ?? [];
    this.pending.set(input.conversationId, [...existing, ref]);
    logger.info('attachments', 'Imagem colada salva na pasta de anexos', { destination: safe.relativePath });
    return [ref];
  }

  /** Limpa temporários não referenciados por nenhuma conversa. */
  async cleanupOrphans(workspacePath: string, referenced: Set<string>): Promise<number> {
    const guard = this.workspaces.guardFor(workspacePath);
    const dir = join(guard.realRoot, ATTACHMENTS_DIRNAME);
    if (!existsSync(dir)) return 0;
    let removed = 0;
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry);
      if (referenced.has(full)) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      // Só remove o que ficou parado por mais de 7 dias.
      if (Date.now() - info.mtimeMs < 7 * 24 * 60 * 60 * 1000) continue;
      await unlink(full).catch(() => undefined);
      removed += 1;
    }
    if (removed > 0) logger.info('attachments', 'Anexos órfãos removidos', { removed });
    return removed;
  }
}

/** Caminho revalidado contra as raízes autorizadas; `undefined` se recusado. */
function safeRealPath(
  guard: ReturnType<WorkspaceService['guardFor']>,
  candidate: string,
): string | undefined {
  return guard.tryResolve(candidate)?.realPath;
}

async function uniqueDestination(dir: string, fileName: string): Promise<string> {
  const extension = extname(fileName);
  const stem = extension === '' ? fileName : fileName.slice(0, -extension.length);
  let candidate = join(dir, fileName);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} (${counter})${extension}`);
    counter += 1;
    if (counter > 500) {
      candidate = join(dir, `${stem}-${randomUUID().slice(0, 8)}${extension}`);
      break;
    }
  }
  return candidate;
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const { open } = await import('node:fs/promises');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Extração de texto de PDF sem dependências externas.
 *
 * Cobre PDFs com fluxos de texto não comprimidos e comprimidos com Flate
 * (`zlib.inflate`), lendo os operadores `Tj`/`TJ`. É uma extração simples e
 * declarada como tal: PDFs digitalizados não têm texto e a falha é reportada
 * em vez de fingir leitura.
 */
export async function extractPdfText(path: string): Promise<{ text: string; pages: number }> {
  const zlib = await import('node:zlib');
  const buffer = await readFile(path);
  const raw = buffer.toString('latin1');
  const pages = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;

  const chunks: string[] = [];
  const streamRegex = /stream\r?\n?([\s\S]*?)endstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    const body = match[1] ?? '';
    // Tenta inflar; se falhar, trata como texto claro.
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1');
    } catch {
      content = body;
    }
    chunks.push(extractTextOperators(content));
  }

  const text = chunks
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, pages: pages > 0 ? pages : 1 };
}

function extractTextOperators(content: string): string {
  const out: string[] = [];
  // ( ... ) Tj   e   [ ( ... ) ... ] TJ
  const tjRegex = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ/g;
  let match: RegExpExecArray | null;
  while ((match = tjRegex.exec(content)) !== null) {
    const segment = match[0];
    const literals = segment.match(/\((?:\\.|[^\\)])*\)/g) ?? [];
    const line = literals
      .map((literal) =>
        literal
          .slice(1, -1)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\(/g, '(')
          .replace(/\\\)/g, ')')
          .replace(/\\\\/g, '\\'),
      )
      .join('');
    if (line.trim() !== '') out.push(line);
  }
  return out.join('\n');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
