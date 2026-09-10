/**
 * Workspaces: registro, seleção e validação de caminhos.
 *
 * Toda conversa que executa algo está vinculada a uma pasta autorizada.
 * Trocar o workspace na interface NÃO redireciona um turno em andamento —
 * quem garante isso é o `ConversationService`, que só lê o `workspacePath`
 * gravado na conversa no início do turno.
 */

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { GitFileChange, GitSummary, WorkspaceSummary } from '../../shared/domain';
import type { FileTreeNode } from '../../shared/ipc';
import { appError } from '../../shared/errors';
import type { WorkspaceRepository, WorkspaceRow } from '../persistence/repositories';
import type { GitService } from './GitService';
import { PathGuard, realPathOfDeepestExisting } from './pathSafety';
import { logger } from './logger';

const IGNORED = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'target',
  'release',
]);

export class WorkspaceService {
  private readonly guards = new Map<string, PathGuard>();

  constructor(
    private readonly repo: WorkspaceRepository,
    private readonly git: GitService,
  ) {}

  async list(): Promise<WorkspaceSummary[]> {
    const rows = this.repo.list();
    const out: WorkspaceSummary[] = [];
    for (const row of rows) {
      out.push({ ...row, git: await this.git.summary(row.path).catch(() => undefined) });
    }
    return out;
  }

  listRaw(): WorkspaceRow[] {
    return this.repo.list();
  }

  /** Registra uma pasta como workspace, resolvendo o caminho fisicamente. */
  async register(rawPath: string): Promise<WorkspaceSummary> {
    const { realPath, exists } = realPathOfDeepestExisting(rawPath);
    if (!exists) {
      throw appError('validation', {
        message: `A pasta "${rawPath}" não existe.`,
        action: 'Escolha uma pasta existente com Ctrl+O.',
      });
    }
    const info = await stat(realPath).catch(() => null);
    if (!info?.isDirectory()) {
      throw appError('validation', {
        message: `"${rawPath}" não é uma pasta.`,
        action: 'Selecione a pasta raiz do projeto.',
      });
    }
    const row = this.repo.upsertByPath(realPath, basename(realPath) || realPath);
    this.guards.delete(row.id);
    logger.info('workspaces', 'Workspace registrado', { path: realPath });
    return { ...row, git: await this.git.summary(realPath).catch(() => undefined) };
  }

  remove(id: string): boolean {
    this.guards.delete(id);
    return this.repo.remove(id);
  }

  setFavorite(id: string, favorite: boolean): WorkspaceSummary {
    return this.repo.update(id, { favorite });
  }

  touch(path: string): void {
    const row = this.repo.findByPath(realPathOfDeepestExisting(path).realPath);
    if (row) this.repo.update(row.id, { lastUsedAt: new Date().toISOString() });
  }

  findByPath(path: string): WorkspaceRow | null {
    return this.repo.findByPath(realPathOfDeepestExisting(path).realPath);
  }

  /** Guard reutilizável por workspace, incluindo raízes extras autorizadas. */
  guardFor(path: string): PathGuard {
    const row = this.findByPath(path);
    if (!row) {
      // Workspace não registrado: guard restrito à própria pasta.
      return new PathGuard(realPathOfDeepestExisting(path).realPath, []);
    }
    const cached = this.guards.get(row.id);
    if (cached) return cached;
    const guard = new PathGuard(row.path, row.extraRoots);
    this.guards.set(row.id, guard);
    return guard;
  }

  /** Autoriza uma raiz extra — exige consentimento explícito da pessoa. */
  authorizeExtraRoot(workspaceId: string, rawPath: string): WorkspaceRow {
    const row = this.repo.get(workspaceId);
    if (!row) throw appError('validation', { message: 'Workspace não encontrado.' });
    const { realPath, exists } = realPathOfDeepestExisting(rawPath);
    if (!exists) throw appError('validation', { message: `A pasta "${rawPath}" não existe.` });
    const next = this.repo.update(workspaceId, {
      extraRoots: [...new Set([...row.extraRoots, realPath])],
    });
    this.guards.delete(workspaceId);
    logger.warn('workspaces', 'Raiz extra autorizada explicitamente', { workspaceId, realPath });
    return next;
  }

  async gitSummary(path: string): Promise<GitSummary> {
    return this.git.summary(realPathOfDeepestExisting(path).realPath);
  }

  async gitChanges(path: string): Promise<GitFileChange[]> {
    return this.git.changes(realPathOfDeepestExisting(path).realPath);
  }

  /** Árvore de arquivos limitada, para o painel direito. */
  async fileTree(path: string, maxEntries = 2000): Promise<FileTreeNode> {
    const guard = this.guardFor(path);
    const root = guard.resolve('.');
    let count = 0;

    const walk = async (absolute: string, depth: number): Promise<FileTreeNode[]> => {
      if (count >= maxEntries || depth > 8) return [];
      let dirents;
      try {
        dirents = await readdir(absolute, { withFileTypes: true });
      } catch {
        return [];
      }
      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name, 'pt-BR');
      });
      const nodes: FileTreeNode[] = [];
      for (const dirent of dirents) {
        if (count >= maxEntries) {
          nodes.push({ name: '… (lista truncada)', path: '', kind: 'file', truncated: true });
          break;
        }
        if (IGNORED.has(dirent.name)) continue;
        const child = join(absolute, dirent.name);
        const safe = guard.tryResolve(child);
        if (!safe) continue;
        count += 1;
        if (dirent.isDirectory()) {
          nodes.push({
            name: dirent.name,
            path: safe.relativePath,
            kind: 'directory',
            children: await walk(child, depth + 1),
          });
        } else if (dirent.isFile()) {
          let sizeBytes: number | undefined;
          try {
            sizeBytes = (await stat(child)).size;
          } catch {
            sizeBytes = undefined;
          }
          nodes.push({ name: dirent.name, path: safe.relativePath, kind: 'file', sizeBytes });
        }
      }
      return nodes;
    };

    return {
      name: basename(root.realPath) || root.realPath,
      path: '.',
      kind: 'directory',
      children: await walk(root.realPath, 0),
    };
  }
}
