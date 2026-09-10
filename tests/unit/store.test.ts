import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransactionalStore, type Migration } from '../../src/main/persistence/store';

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'codex-hub-store-'));
}

const noMigrations: Migration[] = [];

describe('TransactionalStore', () => {
  it('grava e relê registros', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('conversas', { id: 'c1', titulo: 'Uma' });
    store.put('conversas', { id: 'c2', titulo: 'Outra' });

    const reopened = new TransactionalStore(dir);
    reopened.open(noMigrations);
    expect(reopened.all('conversas')).toHaveLength(2);
    expect(reopened.get<{ id: string; titulo: string }>('conversas', 'c1')?.titulo).toBe('Uma');
  });

  it('aplica delete', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('t', { id: 'a' });
    store.delete('t', 'a');
    const reopened = new TransactionalStore(dir);
    reopened.open(noMigrations);
    expect(reopened.all('t')).toHaveLength(0);
  });

  it('grava uma transação como bloco único', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.transaction(() => {
      store.put('t', { id: 'a' });
      store.put('t', { id: 'b' });
      store.put('t', { id: 'c' });
    });
    const raw = readFileSync(join(dir, 'store.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(JSON.parse(lines[0] as string)).toEqual({ k: 'txn', n: 3 });
    expect(lines).toHaveLength(4);
  });

  it('descarta transação incompleta ao recarregar (crash no meio da gravação)', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('t', { id: 'antes' });

    // Simula um encerramento abrupto no meio de uma transação de 3 operações.
    appendFileSync(
      join(dir, 'store.jsonl'),
      `${JSON.stringify({ k: 'txn', n: 3 })}\n${JSON.stringify({ k: 'put', t: 't', id: 'meio', v: { id: 'meio' } })}\n`,
      'utf8',
    );

    const reopened = new TransactionalStore(dir);
    reopened.open(noMigrations);
    expect(reopened.get('t', 'antes')).not.toBeNull();
    // A operação do bloco incompleto NÃO é aplicada.
    expect(reopened.get('t', 'meio')).toBeNull();
  });

  it('descarta última linha truncada', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('t', { id: 'ok' });
    appendFileSync(join(dir, 'store.jsonl'), '{"k":"txn","n":1}\n{"k":"put","t":"t","id":"tru', 'utf8');

    const reopened = new TransactionalStore(dir);
    reopened.open(noMigrations);
    expect(reopened.all('t')).toHaveLength(1);
  });

  it('desfaz as operações quando a transação lança', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('t', { id: 'inicial' });
    expect(() =>
      store.transaction(() => {
        store.put('t', { id: 'temporario' });
        throw new Error('falhou no meio');
      }),
    ).toThrow('falhou no meio');
    expect(store.get('t', 'temporario')).toBeNull();
    expect(store.get('t', 'inicial')).not.toBeNull();
  });

  it('compacta o log preservando os dados', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    for (let i = 0; i < 400; i += 1) {
      store.put('t', { id: 'sempre-o-mesmo', valor: i });
    }
    const before = readFileSync(join(dir, 'store.jsonl'), 'utf8').trim().split('\n').length;
    store.compact();
    const after = readFileSync(join(dir, 'store.jsonl'), 'utf8').trim().split('\n').length;
    expect(after).toBeLessThan(before);

    const reopened = new TransactionalStore(dir);
    reopened.open(noMigrations);
    expect(reopened.get<{ id: string; valor: number }>('t', 'sempre-o-mesmo')?.valor).toBe(399);
  });

  it('ignora meta ilegível assumindo versão 0', () => {
    const dir = newDir();
    writeFileSync(join(dir, 'store.meta.json'), '{quebrado', 'utf8');
    const store = new TransactionalStore(dir);
    store.open([{ version: 1, description: 'inicial', up: (ctx) => ctx.put('t', { id: 'criado' }) }]);
    expect(store.version).toBe(1);
    expect(store.get('t', 'criado')).not.toBeNull();
  });
});

describe('migrações', () => {
  it('aplica em ordem e grava a versão', () => {
    const dir = newDir();
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 2, description: 'segunda', up: () => applied.push(2) },
      { version: 1, description: 'primeira', up: () => applied.push(1) },
    ];
    const store = new TransactionalStore(dir);
    store.open(migrations);
    expect(applied).toEqual([1, 2]);
    expect(store.version).toBe(2);
    expect(existsSync(join(dir, 'store.meta.json'))).toBe(true);
  });

  it('não reaplica migrações já executadas', () => {
    const dir = newDir();
    let count = 0;
    const migrations: Migration[] = [{ version: 1, description: 'uma', up: () => (count += 1) }];
    new TransactionalStore(dir).open(migrations);
    new TransactionalStore(dir).open(migrations);
    expect(count).toBe(1);
  });

  it('transforma dados existentes', () => {
    const dir = newDir();
    const first = new TransactionalStore(dir);
    first.open([]);
    first.put('itens', { id: 'a', texto: 'x' });

    const second = new TransactionalStore(dir);
    second.open([
      {
        version: 1,
        description: 'adiciona seq',
        up(ctx) {
          for (const row of ctx.all('itens')) {
            ctx.put('itens', { ...row, seq: 1 });
          }
        },
      },
    ]);
    expect(second.get<{ id: string; seq: number }>('itens', 'a')?.seq).toBe(1);
  });

  it('não regride quando os dados vêm de uma versão mais nova', () => {
    const dir = newDir();
    const advanced = new TransactionalStore(dir);
    advanced.open([
      { version: 1, description: 'a', up: () => undefined },
      { version: 2, description: 'b', up: () => undefined },
    ]);
    const older = new TransactionalStore(dir);
    older.open([{ version: 1, description: 'a', up: () => undefined }]);
    expect(older.version).toBe(2);
  });

  it('reporta estatísticas úteis para o diagnóstico', () => {
    const dir = newDir();
    const store = new TransactionalStore(dir);
    store.open(noMigrations);
    store.put('conversations', { id: 'c1' });
    store.put('items', { id: 'i1' });
    const stats = store.stats();
    expect(stats.tables.conversations).toBe(1);
    expect(stats.tables.items).toBe(1);
    expect(stats.location).toBe(join(dir, ''));
    expect(stats.sizeBytes).toBeGreaterThan(0);
  });
});
