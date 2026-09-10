/**
 * Armazenamento local transacional em arquivo.
 *
 * Não é SQLite. É um log append-only com marcadores de transação e compactação
 * por gravação atômica (`write` em arquivo temporário + `fsync` + `rename`).
 * As garantias reais são:
 *
 *  - Durabilidade: cada transação é um único `write` seguido de `fsync`.
 *  - Atomicidade: uma transação é gravada como um bloco precedido por
 *    `{"k":"txn","n":N}`. Na leitura, um bloco incompleto (crash no meio da
 *    gravação) é descartado inteiro.
 *  - Recuperação: linhas ilegíveis no fim do arquivo são descartadas.
 *  - Migrações versionadas com `schemaVersion` gravado atomicamente.
 *
 * Isso é suficiente para o volume desta aplicação (conversas e itens) e evita
 * um módulo nativo no empacotamento. Ver ARCHITECTURE.md › Persistência.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../services/logger';

export interface Row {
  id: string;
}

type LogLine =
  | { k: 'txn'; n: number }
  | { k: 'put'; t: string; id: string; v: unknown }
  | { k: 'del'; t: string; id: string };

export interface Migration {
  version: number;
  description: string;
  up(ctx: MigrationContext): void;
}

export interface MigrationContext {
  /** Todas as linhas de uma tabela, para transformação em memória. */
  all(table: string): Array<Record<string, unknown>>;
  put(table: string, row: Record<string, unknown>): void;
  del(table: string, id: string): void;
  drop(table: string): void;
}

export interface StoreStats {
  schemaVersion: number;
  location: string;
  logLines: number;
  tables: Record<string, number>;
  sizeBytes: number;
}

const COMPACT_MIN_LINES = 500;
const COMPACT_RATIO = 2.5;

/** Tamanho do arquivo, ou 0 quando não é possível ler. */
function readSizeSafely(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export class TransactionalStore {
  private readonly logPath: string;
  private readonly metaPath: string;
  private readonly tables = new Map<string, Map<string, Record<string, unknown>>>();
  private logLines = 0;
  private schemaVersion = 0;
  private opened = false;
  private txDepth = 0;
  private pending: LogLine[] = [];

  constructor(private readonly dir: string) {
    this.logPath = join(dir, 'store.jsonl');
    this.metaPath = join(dir, 'store.meta.json');
  }

  get location(): string {
    return this.dir;
  }

  get version(): number {
    return this.schemaVersion;
  }

  open(migrations: Migration[]): void {
    if (this.opened) return;
    mkdirSync(this.dir, { recursive: true });
    this.readMeta();
    this.replayLog();
    this.runMigrations(migrations);
    this.opened = true;
    logger.info('store', 'Armazenamento aberto', {
      location: this.dir,
      schemaVersion: this.schemaVersion,
      logLines: this.logLines,
    });
    this.maybeCompact();
  }

  private readMeta(): void {
    if (!existsSync(this.metaPath)) {
      this.schemaVersion = 0;
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.metaPath, 'utf8')) as { schemaVersion?: number };
      this.schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0;
    } catch {
      logger.warn('store', 'store.meta.json ilegível; assumindo versão 0');
      this.schemaVersion = 0;
    }
  }

  private writeMeta(): void {
    const tmp = `${this.metaPath}.tmp`;
    const payload = JSON.stringify({ schemaVersion: this.schemaVersion, updatedAt: new Date().toISOString() }, null, 2);
    writeFileSync(tmp, payload, 'utf8');
    this.fsyncFile(tmp);
    renameSync(tmp, this.metaPath);
  }

  private fsyncFile(path: string): void {
    try {
      const fd = openSync(path, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      /* fsync é best-effort em alguns sistemas de arquivos */
    }
  }

  /** Lê o log inteiro, aplicando apenas transações completas. */
  private replayLog(): void {
    this.tables.clear();
    this.logLines = 0;
    if (!existsSync(this.logPath)) return;

    let raw: string;
    try {
      raw = readFileSync(this.logPath, 'utf8');
    } catch (err) {
      logger.error('store', 'Falha ao ler o log de dados', err);
      return;
    }

    const lines = raw.split('\n');
    // Se o arquivo termina sem `\n`, a última linha pode estar truncada.
    const parsed: Array<LogLine | null> = lines.map((line) => {
      const trimmed = line.trim();
      if (trimmed === '') return null;
      try {
        return JSON.parse(trimmed) as LogLine;
      } catch {
        return null;
      }
    });

    let i = 0;
    let discarded = 0;
    while (i < parsed.length) {
      const entry = parsed[i];
      if (entry === null || entry === undefined) {
        i += 1;
        continue;
      }
      if (entry.k === 'txn') {
        const n = Number.isInteger(entry.n) && entry.n > 0 ? entry.n : 0;
        const group = parsed.slice(i + 1, i + 1 + n);
        const complete = group.length === n && group.every((g) => g !== null && g.k !== 'txn');
        if (!complete) {
          discarded += 1;
          break; // bloco incompleto no fim do arquivo: descarta e para.
        }
        for (const op of group) this.applyOp(op as LogLine);
        this.logLines += 1 + n;
        i += 1 + n;
        continue;
      }
      // Linha solta (formato anterior a transações ou compactação): aplica.
      this.applyOp(entry);
      this.logLines += 1;
      i += 1;
    }
    if (discarded > 0) {
      logger.warn('store', 'Transação incompleta descartada na recuperação', { discarded });
    }
  }

  private applyOp(op: LogLine): void {
    if (op.k === 'put') {
      const table = this.tableMap(op.t);
      table.set(op.id, op.v as Record<string, unknown>);
    } else if (op.k === 'del') {
      this.tableMap(op.t).delete(op.id);
    }
  }

  private tableMap(name: string): Map<string, Record<string, unknown>> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  private runMigrations(migrations: Migration[]): void {
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    const target = ordered.length > 0 ? (ordered[ordered.length - 1] as Migration).version : 0;
    if (this.schemaVersion > target) {
      logger.warn('store', 'Dados gravados por uma versão mais nova do aplicativo', {
        dataVersion: this.schemaVersion,
        appVersion: target,
      });
      return;
    }
    const ctx: MigrationContext = {
      all: (table) => [...this.tableMap(table).values()].map((v) => ({ ...v })),
      put: (table, row) => {
        const rid = String(row.id ?? '');
        if (!rid) throw new Error('Migração tentou gravar linha sem id');
        this.tableMap(table).set(rid, row);
      },
      del: (table, rid) => {
        this.tableMap(table).delete(rid);
      },
      drop: (table) => {
        this.tables.delete(table);
      },
    };
    let applied = 0;
    for (const migration of ordered) {
      if (migration.version <= this.schemaVersion) continue;
      migration.up(ctx);
      this.schemaVersion = migration.version;
      applied += 1;
      logger.info('store', `Migração aplicada: v${migration.version} — ${migration.description}`);
    }
    if (applied > 0) {
      // Migração reescreve o snapshot inteiro de forma atômica.
      this.compact();
    } else if (!existsSync(this.metaPath)) {
      this.writeMeta();
    }
  }

  /* -------------------- API de dados -------------------- */

  get<T extends Row>(table: string, id: string): T | null {
    const row = this.tableMap(table).get(id);
    return row ? ({ ...row } as unknown as T) : null;
  }

  all<T extends Row>(table: string): T[] {
    return [...this.tableMap(table).values()].map((r) => ({ ...r }) as unknown as T);
  }

  count(table: string): number {
    return this.tableMap(table).size;
  }

  put<T extends Row>(table: string, row: T): T {
    this.enqueue({ k: 'put', t: table, id: row.id, v: row });
    return row;
  }

  delete(table: string, id: string): void {
    this.enqueue({ k: 'del', t: table, id });
  }

  /** Todas as operações dentro de `fn` viram uma única transação atômica. */
  transaction<T>(fn: () => T): T {
    this.txDepth += 1;
    const startedAt = this.pending.length;
    try {
      const result = fn();
      this.txDepth -= 1;
      if (this.txDepth === 0) this.flush();
      return result;
    } catch (err) {
      this.txDepth -= 1;
      if (this.txDepth === 0) {
        // Descarta as operações da transação falhada e recarrega o estado real.
        this.pending.length = startedAt;
        this.pending = [];
        this.replayLog();
      }
      throw err;
    }
  }

  private enqueue(op: LogLine): void {
    this.applyOp(op);
    this.pending.push(op);
    if (this.txDepth === 0) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const ops = this.pending;
    this.pending = [];
    const header: LogLine = { k: 'txn', n: ops.length };
    const payload = [header, ...ops].map((l) => JSON.stringify(l)).join('\n') + '\n';
    try {
      const fd = openSync(this.logPath, 'a');
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      this.logLines += ops.length + 1;
    } catch (err) {
      logger.error('store', 'Falha ao gravar transação', err);
      throw err;
    }
    this.maybeCompact();
  }

  private maybeCompact(): void {
    const records = [...this.tables.values()].reduce((sum, t) => sum + t.size, 0);
    if (this.logLines < COMPACT_MIN_LINES) return;
    if (this.logLines < records * COMPACT_RATIO) return;
    this.compact();
  }

  /** Reescreve o log como snapshot mínimo, de forma atômica. */
  compact(): void {
    const tmp = `${this.logPath}.tmp`;
    const lines: string[] = [];
    for (const [table, rows] of this.tables) {
      for (const [id, value] of rows) {
        lines.push(JSON.stringify({ k: 'txn', n: 1 }));
        lines.push(JSON.stringify({ k: 'put', t: table, id, v: value }));
      }
    }
    try {
      writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
      this.fsyncFile(tmp);
      renameSync(tmp, this.logPath);
      this.logLines = lines.length;
      this.writeMeta();
      logger.debug('store', 'Log compactado', { lines: this.logLines });
    } catch (err) {
      logger.error('store', 'Falha ao compactar o log', err);
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  stats(): StoreStats {
    const tables: Record<string, number> = {};
    for (const [name, rows] of this.tables) tables[name] = rows.size;
    const sizeBytes = readSizeSafely(this.logPath);
    return {
      schemaVersion: this.schemaVersion,
      location: this.dir,
      logLines: this.logLines,
      tables,
      sizeBytes,
    };
  }
}
