/**
 * Ferramentas estruturadas de arquivo para o motor direto.
 *
 * Todas passam pela validação de workspace na camada privilegiada. Uma string
 * de comando vinda de uma resposta do modelo NUNCA é interpretada como shell:
 * as únicas operações possíveis são as declaradas aqui.
 */

import { readFile, readdir, stat, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { FileDiff } from '../../shared/domain';
import { appError } from '../../shared/errors';
import { hasReservedWindowsName } from '../services/pathSafety';
import { buildUnifiedDiff, isProbablyBinary } from './diff';
import { truncateResult, type ToolDefinition, type ToolResult } from './types';

/** Nomes de arquivo que tipicamente contêm credenciais. */
export function isSecretLikeFile(name: string): boolean {
  if (name === '.env.example' || name === '.env.sample' || name === '.env.template') return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  return /^\.(npmrc|netrc|pypirc|yarnrc|git-credentials)$/.test(name) || /\.(pem|key|p12|pfx)$/i.test(name);
}

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  '.gradle',
  'target',
  'release',
]);

const MAX_READ_BYTES = 512 * 1024;

/* ------------------------------------------------------------------ *
 * list_files
 * ------------------------------------------------------------------ */

const listFilesSchema = z
  .object({
    path: z.string().max(4096).default('.').describe('Caminho relativo ao workspace. Use "." para a raiz.'),
    recursive: z.boolean().default(false),
    maxEntries: z.number().int().min(1).max(2000).default(300),
  })
  .strict();

export const listFilesTool: ToolDefinition<typeof listFilesSchema> = {
  name: 'list_files',
  description:
    'Lista arquivos e pastas dentro do workspace autorizado. Ignora node_modules, .git e diretórios de build.',
  schema: listFilesSchema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho relativo ao workspace. Use "." para a raiz.' },
      recursive: { type: 'boolean', description: 'Percorre subpastas.' },
      maxEntries: { type: 'integer', minimum: 1, maximum: 2000 },
    },
    required: [],
    additionalProperties: false,
  },
  allowedModes: ['chat', 'plan', 'execute'],
  mutating: false,
  retryableAfterFailure: true,
  async execute(args, ctx): Promise<ToolResult> {
    const resolved = ctx.guard.resolve(args.path);
    const entries: Array<{ path: string; kind: 'file' | 'directory'; sizeBytes?: number }> = [];
    let truncated = false;

    const walk = async (absolute: string, depth: number): Promise<void> => {
      if (entries.length >= args.maxEntries) {
        truncated = true;
        return;
      }
      ctx.signal.throwIfAborted();
      let dirents;
      try {
        dirents = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      for (const dirent of dirents) {
        if (entries.length >= args.maxEntries) {
          truncated = true;
          return;
        }
        if (dirent.isDirectory() && IGNORED_DIRECTORIES.has(dirent.name)) continue;
        // Arquivos que costumam guardar segredos não são listados ao modelo.
        // `.env.example` é documentação e continua visível.
        if (dirent.isFile() && isSecretLikeFile(dirent.name)) continue;
        const child = join(absolute, dirent.name);
        // Revalida cada caminho: um symlink pode apontar para fora.
        const safe = ctx.guard.tryResolve(child);
        if (!safe) continue;
        const rel = relative(ctx.guard.realRoot, safe.realPath).split(sep).join('/') || '.';
        if (dirent.isDirectory()) {
          entries.push({ path: `${rel}/`, kind: 'directory' });
          if (args.recursive && depth < 12) await walk(child, depth + 1);
        } else if (dirent.isFile()) {
          let sizeBytes: number | undefined;
          try {
            sizeBytes = (await stat(child)).size;
          } catch {
            sizeBytes = undefined;
          }
          entries.push({ path: rel, kind: 'file', sizeBytes });
        }
      }
    };

    const info = await stat(resolved.realPath).catch(() => null);
    if (!info) {
      throw appError('validation', {
        message: `O caminho "${args.path}" não existe no workspace.`,
        action: 'Use list_files na raiz para descobrir os caminhos disponíveis.',
      });
    }
    if (info.isFile()) {
      entries.push({ path: resolved.relativePath, kind: 'file', sizeBytes: info.size });
    } else {
      await walk(resolved.realPath, 0);
    }

    const lines = entries.map((e) =>
      e.kind === 'directory' ? e.path : `${e.path}${e.sizeBytes !== undefined ? ` (${e.sizeBytes} B)` : ''}`,
    );
    const body = lines.length > 0 ? lines.join('\n') : '(nenhum arquivo encontrado)';
    const header = `${entries.length} entrada(s) em ${resolved.relativePath}${truncated ? ' — lista truncada' : ''}\n`;
    const result = truncateResult(header + body, ctx.maxResultBytes);
    return { content: result.content, data: entries, truncated: result.truncated || truncated };
  },
};

/* ------------------------------------------------------------------ *
 * read_file
 * ------------------------------------------------------------------ */

const readFileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
  })
  .strict();

export const readFileTool: ToolDefinition<typeof readFileSchema> = {
  name: 'read_file',
  description: 'Lê um arquivo de texto do workspace autorizado. Opcionalmente um intervalo de linhas.',
  schema: readFileSchema,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Caminho relativo ao workspace.' },
      startLine: { type: 'integer', minimum: 1 },
      endLine: { type: 'integer', minimum: 1 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  allowedModes: ['chat', 'plan', 'execute'],
  mutating: false,
  retryableAfterFailure: true,
  async execute(args, ctx): Promise<ToolResult> {
    const resolved = ctx.guard.resolve(args.path);
    const info = await stat(resolved.realPath).catch(() => null);
    if (!info || !info.isFile()) {
      throw appError('validation', { message: `"${args.path}" não é um arquivo legível no workspace.` });
    }
    const buffer = await readFile(resolved.realPath);
    if (isProbablyBinary(buffer)) {
      return {
        content: `O arquivo "${resolved.relativePath}" parece ser binário (${info.size} bytes) e não foi lido como texto.`,
        data: { binary: true, sizeBytes: info.size },
      };
    }
    const limited = buffer.byteLength > MAX_READ_BYTES ? buffer.subarray(0, MAX_READ_BYTES) : buffer;
    let text = limited.toString('utf8');
    let truncated = buffer.byteLength > MAX_READ_BYTES;

    if (args.startLine !== undefined || args.endLine !== undefined) {
      const lines = text.split('\n');
      const start = (args.startLine ?? 1) - 1;
      const end = args.endLine ?? lines.length;
      text = lines
        .slice(Math.max(0, start), Math.min(lines.length, end))
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join('\n');
    }
    const result = truncateResult(text, ctx.maxResultBytes);
    truncated = truncated || result.truncated;
    return {
      content: `# ${resolved.relativePath}\n${result.content}`,
      data: { path: resolved.relativePath, sizeBytes: info.size },
      truncated,
    };
  },
};

/* ------------------------------------------------------------------ *
 * search_content
 * ------------------------------------------------------------------ */

const searchSchema = z
  .object({
    query: z.string().min(1).max(500),
    isRegex: z.boolean().default(false),
    caseSensitive: z.boolean().default(false),
    path: z.string().max(4096).default('.'),
    maxMatches: z.number().int().min(1).max(500).default(80),
    includeGlob: z.string().max(200).optional(),
  })
  .strict();

export const searchContentTool: ToolDefinition<typeof searchSchema> = {
  name: 'search_content',
  description: 'Procura texto ou expressão regular nos arquivos de texto do workspace autorizado.',
  schema: searchSchema,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      isRegex: { type: 'boolean' },
      caseSensitive: { type: 'boolean' },
      path: { type: 'string', description: 'Subpasta onde procurar. Padrão: raiz.' },
      maxMatches: { type: 'integer', minimum: 1, maximum: 500 },
      includeGlob: { type: 'string', description: 'Filtro simples de extensão, ex.: *.ts' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  allowedModes: ['chat', 'plan', 'execute'],
  mutating: false,
  retryableAfterFailure: true,
  async execute(args, ctx): Promise<ToolResult> {
    const root = ctx.guard.resolve(args.path);
    let matcher: RegExp;
    try {
      matcher = args.isRegex
        ? new RegExp(args.query, args.caseSensitive ? 'g' : 'gi')
        : new RegExp(escapeRegExp(args.query), args.caseSensitive ? 'g' : 'gi');
    } catch (err) {
      throw appError('validation', {
        message: 'A expressão regular informada é inválida.',
        technical: err instanceof Error ? err.message : String(err),
      });
    }
    const extension = args.includeGlob?.replace(/^\*/, '') ?? null;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesScanned = 0;

    const walk = async (absolute: string, depth: number): Promise<void> => {
      if (matches.length >= args.maxMatches) return;
      ctx.signal.throwIfAborted();
      let dirents;
      try {
        dirents = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (matches.length >= args.maxMatches) return;
        if (dirent.isDirectory()) {
          if (IGNORED_DIRECTORIES.has(dirent.name)) continue;
          if (depth < 14) await walk(join(absolute, dirent.name), depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (extension && !dirent.name.endsWith(extension)) continue;
        const child = join(absolute, dirent.name);
        const safe = ctx.guard.tryResolve(child);
        if (!safe) continue;
        let buffer: Buffer;
        try {
          const info = await stat(child);
          if (info.size > MAX_READ_BYTES) continue;
          buffer = await readFile(child);
        } catch {
          continue;
        }
        if (isProbablyBinary(buffer)) continue;
        filesScanned += 1;
        const lines = buffer.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i] ?? '';
          matcher.lastIndex = 0;
          if (!matcher.test(line)) continue;
          matches.push({
            path: relative(ctx.guard.realRoot, safe.realPath).split(sep).join('/'),
            line: i + 1,
            text: line.trim().slice(0, 400),
          });
          if (matches.length >= args.maxMatches) return;
        }
      }
    };

    await walk(root.realPath, 0);
    const body =
      matches.length === 0
        ? `Nenhuma ocorrência de "${args.query}" em ${filesScanned} arquivo(s) analisado(s).`
        : matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n');
    const result = truncateResult(body, ctx.maxResultBytes);
    return { content: result.content, data: matches, truncated: result.truncated };
  },
};

/* ------------------------------------------------------------------ *
 * apply_file_changes (alteração estruturada, com aprovação)
 * ------------------------------------------------------------------ */

const changeSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('create'),
      path: z.string().min(1).max(4096),
      content: z.string().max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      operation: z.literal('overwrite'),
      path: z.string().min(1).max(4096),
      content: z.string().max(2 * 1024 * 1024),
    })
    .strict(),
  z
    .object({
      operation: z.literal('replace'),
      path: z.string().min(1).max(4096),
      /** Texto exato a substituir. Deve ocorrer exatamente uma vez. */
      find: z.string().min(1).max(200_000),
      replace: z.string().max(200_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal('delete'),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      operation: z.literal('rename'),
      path: z.string().min(1).max(4096),
      newPath: z.string().min(1).max(4096),
    })
    .strict(),
]);

const applyChangesSchema = z
  .object({
    summary: z.string().min(1).max(500).describe('Resumo curto do que a alteração faz.'),
    changes: z.array(changeSchema).min(1).max(50),
  })
  .strict();

export const applyFileChangesTool: ToolDefinition<typeof applyChangesSchema> = {
  name: 'apply_file_changes',
  description:
    'Propõe alterações estruturadas de arquivo no workspace (criar, sobrescrever, substituir trecho, remover, renomear). Cada aplicação exige aprovação da pessoa e mostra o diff antes.',
  schema: applyChangesSchema,
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      changes: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['create', 'overwrite', 'replace', 'delete', 'rename'] },
            path: { type: 'string' },
            content: { type: 'string' },
            find: { type: 'string' },
            replace: { type: 'string' },
            newPath: { type: 'string' },
          },
          required: ['operation', 'path'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'changes'],
    additionalProperties: false,
  },
  // Só no modo Executar: a restrição é do BACKEND, não do texto do prompt.
  allowedModes: ['execute'],
  mutating: true,
  retryableAfterFailure: false,
  async execute(args, ctx): Promise<ToolResult> {
    if (ctx.policy.sandbox === 'readOnly') {
      throw appError('workspaceDenied', {
        message: 'A política atual é somente leitura: nenhuma alteração de arquivo é aplicada.',
        action: 'Mude para o modo Executar com política de escrita no workspace.',
      });
    }

    // 1. Calcula o diff SEM gravar nada.
    const planned: Array<{ diff: FileDiff; apply: () => Promise<void> }> = [];
    for (const change of args.changes) {
      const resolved = ctx.guard.resolve(change.path);
      if (hasReservedWindowsName(resolved.absolutePath)) {
        throw appError('validation', {
          message: `O caminho "${change.path}" usa um nome reservado do Windows.`,
          action: 'Escolha outro nome de arquivo.',
        });
      }
      const before = await readIfExists(resolved.realPath);

      if (change.operation === 'delete') {
        if (before === null) {
          throw appError('validation', { message: `Não é possível remover: "${change.path}" não existe.` });
        }
        planned.push({
          diff: buildUnifiedDiff(resolved.relativePath, before, null, 'delete'),
          apply: () => unlink(resolved.realPath),
        });
        continue;
      }

      if (change.operation === 'rename') {
        const target = ctx.guard.resolve(change.newPath);
        if (before === null) {
          throw appError('validation', { message: `Não é possível renomear: "${change.path}" não existe.` });
        }
        planned.push({
          diff: {
            path: target.relativePath,
            oldPath: resolved.relativePath,
            changeKind: 'rename',
            binary: false,
            additions: 0,
            deletions: 0,
          },
          apply: async () => {
            await mkdir(dirname(target.realPath), { recursive: true });
            await rename(resolved.realPath, target.realPath);
          },
        });
        continue;
      }

      let next: string;
      if (change.operation === 'create') {
        if (before !== null) {
          throw appError('validation', {
            message: `"${change.path}" já existe.`,
            action: 'Use a operação overwrite ou replace se a intenção é alterar o arquivo existente.',
          });
        }
        next = change.content;
      } else if (change.operation === 'overwrite') {
        next = change.content;
      } else {
        if (before === null) {
          throw appError('validation', { message: `Não é possível substituir trecho: "${change.path}" não existe.` });
        }
        const occurrences = countOccurrences(before, change.find);
        if (occurrences === 0) {
          throw appError('validation', {
            message: `O trecho informado não foi encontrado em "${change.path}".`,
            action: 'Leia o arquivo novamente com read_file e repita com o texto exato.',
          });
        }
        if (occurrences > 1) {
          throw appError('validation', {
            message: `O trecho aparece ${occurrences} vezes em "${change.path}".`,
            action: 'Inclua mais contexto no campo find para tornar a correspondência única.',
          });
        }
        next = before.replace(change.find, () => change.replace);
      }

      planned.push({
        diff: buildUnifiedDiff(
          resolved.relativePath,
          before,
          next,
          before === null ? 'add' : 'modify',
        ),
        apply: async () => {
          await mkdir(dirname(resolved.realPath), { recursive: true });
          await writeFile(resolved.realPath, next, 'utf8');
        },
      });
    }

    // 2. Pede aprovação mostrando comando/ação, diretório, arquivos e diff.
    const diffs = planned.map((p) => p.diff);
    const decision = await ctx.approvals.request({
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      engineId: 'direct',
      kind: 'filePatch',
      title: args.summary,
      reason: 'O modelo propôs alterações estruturadas de arquivo no workspace.',
      files: diffs.map((d) => d.path),
      diffs,
      // Escrita de arquivos NÃO recebe concessão de sessão: cada lote é aprovado.
      allowedDecisions: ['allowOnce', 'deny', 'cancel'],
    });

    if (decision !== 'allowOnce') {
      throw appError('approvalDenied', {
        message:
          decision === 'cancel'
            ? 'A solicitação de alteração foi cancelada. Nada foi gravado.'
            : 'A alteração foi recusada. Nada foi gravado.',
        action: 'Peça outra abordagem ou ajuste a proposta.',
      });
    }

    // 3. Aplica.
    const applied: string[] = [];
    for (const item of planned) {
      ctx.signal.throwIfAborted();
      await item.apply();
      applied.push(item.diff.path);
    }

    return {
      content: `Alterações aplicadas em ${applied.length} arquivo(s): ${applied.join(', ')}.`,
      data: { applied },
      diffs,
    };
  },
};

async function readIfExists(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path);
    if (isProbablyBinary(buffer)) {
      throw appError('validation', {
        message: `"${path}" é binário e não pode ser alterado como texto.`,
      });
    }
    return buffer.toString('utf8');
  } catch (err) {
    if (err && typeof err === 'object' && 'detail' in err) throw err;
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const FS_TOOLS = [listFilesTool, readFileTool, searchContentTool, applyFileChangesTool];
