import assert from 'node:assert/strict';
import { stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { close, createDatabase } from '../railway/db.mjs';

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

async function memoryDatabase() {
  return createDatabase({
    driver: 'sqlite',
    databaseUrl: 'sqlite::memory:',
    env: {},
  });
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

test('duas transações concorrentes são executadas integralmente em ordem', async () => {
  const database = await memoryDatabase();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order = [];
  let firstTransaction;
  let secondTransaction;
  try {
    await database.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
    firstTransaction = database.transaction(async (transaction) => {
      order.push('first:start');
      await transaction.prepare(
        'INSERT INTO events (id, label) VALUES (?, ?)',
      ).bind(1, 'primeiro').run();
      firstEntered.resolve();
      await releaseFirst.promise;
      await transaction.prepare(
        'INSERT INTO events (id, label) VALUES (?, ?)',
      ).bind(2, 'segundo').run();
      order.push('first:end');
    });
    await firstEntered.promise;

    let secondEntered = false;
    secondTransaction = database.transaction(async (transaction) => {
      secondEntered = true;
      order.push('second:start');
      const count = await transaction.prepare(
        'SELECT COUNT(*) AS count FROM events',
      ).first();
      assert.equal(count.count, 2, 'a segunda transação deve observar o primeiro commit completo');
      await transaction.prepare(
        'INSERT INTO events (id, label) VALUES (?, ?)',
      ).bind(3, 'terceiro').run();
      order.push('second:end');
    });

    try {
      await nextTurn();
      assert.equal(secondEntered, false, 'a segunda transação não pode entrar na primeira');
    } finally {
      releaseFirst.resolve();
    }
    await Promise.all([firstTransaction, secondTransaction]);

    assert.deepEqual(order, [
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
    const rows = await database.prepare(
      'SELECT id, label FROM events ORDER BY id',
    ).all();
    assert.deepEqual(rows.results, [
      { id: 1, label: 'primeiro' },
      { id: 2, label: 'segundo' },
      { id: 3, label: 'terceiro' },
    ]);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled(
      [firstTransaction, secondTransaction].filter(Boolean),
    );
    await close(database);
  }
});

test('rollback desfaz toda a transação assíncrona e libera a fila', async () => {
  const database = await memoryDatabase();
  try {
    await database.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    await assert.rejects(
      database.transaction(async (transaction) => {
        await transaction.prepare(
          'INSERT INTO ledger (id, value) VALUES (?, ?)',
        ).bind(1, 'externo').run();
        await nextTurn();
        await transaction.transaction(async (nested) => {
          await nested.prepare(
            'INSERT INTO ledger (id, value) VALUES (?, ?)',
          ).bind(2, 'aninhado').run();
          await nextTurn();
        });
        throw new Error('rollback intencional');
      }),
      /rollback intencional/,
    );

    const afterRollback = await database.prepare(
      'SELECT COUNT(*) AS count FROM ledger',
    ).first();
    assert.equal(afterRollback.count, 0);

    await database.transaction(async (transaction) => {
      await transaction.prepare(
        'INSERT INTO ledger (id, value) VALUES (?, ?)',
      ).bind(3, 'após rollback').run();
    });
    const rows = await database.prepare(
      'SELECT id, value FROM ledger',
    ).all();
    assert.deepEqual(rows.results, [{ id: 3, value: 'após rollback' }]);
  } finally {
    await close(database);
  }
});

test('leituras e escritas externas aguardam a transação ativa', async () => {
  const database = await memoryDatabase();
  const transactionEntered = deferred();
  const releaseTransaction = deferred();
  let activeTransaction;
  try {
    await database.exec('CREATE TABLE queue_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    activeTransaction = database.transaction(async (transaction) => {
      await transaction.prepare(
        'INSERT INTO queue_test (id, value) VALUES (?, ?)',
      ).bind(1, 'confirmado').run();
      transactionEntered.resolve();
      await releaseTransaction.promise;
    });
    await transactionEntered.promise;

    let readSettled = false;
    let writeSettled = false;
    const queuedRead = database.prepare(
      'SELECT COUNT(*) AS count FROM queue_test',
    ).first().then((row) => {
      readSettled = true;
      return row;
    });
    const queuedWrite = database.prepare(
      'INSERT INTO queue_test (id, value) VALUES (?, ?)',
    ).bind(2, 'depois').run().then((result) => {
      writeSettled = true;
      return result;
    });

    try {
      await nextTurn();
      assert.equal(readSettled, false);
      assert.equal(writeSettled, false);
    } finally {
      releaseTransaction.resolve();
    }
    await activeTransaction;
    assert.equal((await queuedRead).count, 1);
    assert.equal((await queuedWrite).meta.changes, 1);
    const finalCount = await database.prepare(
      'SELECT COUNT(*) AS count FROM queue_test',
    ).first();
    assert.equal(finalCount.count, 2);
  } finally {
    releaseTransaction.resolve();
    await Promise.allSettled([activeTransaction].filter(Boolean));
    await close(database);
  }
});

test('SQLite usa PRAGMAs de durabilidade e trunca o WAL ao fechar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beta-cursos-sqlite-'));
  const filename = join(directory, 'durability.sqlite');
  const walPath = `${filename}-wal`;
  let database;
  try {
    database = await createDatabase({
      driver: 'sqlite',
      filename,
      env: {},
    });
    const synchronous = await database.prepare('PRAGMA synchronous').first();
    const journalLimit = await database.prepare('PRAGMA journal_size_limit').first();
    const journalMode = await database.prepare('PRAGMA journal_mode').first();
    assert.equal(synchronous.synchronous, 2);
    assert.equal(journalLimit.journal_size_limit, 16 * 1024 * 1024);
    assert.equal(String(journalMode.journal_mode).toLowerCase(), 'wal');

    await database.exec(`
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE durable_data (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    `);
    const payload = 'x'.repeat(256 * 1024);
    await database.transaction(async (transaction) => {
      for (let id = 1; id <= 4; id += 1) {
        await transaction.prepare(
          'INSERT INTO durable_data (id, payload) VALUES (?, ?)',
        ).bind(id, payload).run();
      }
    });
    assert.ok(await fileSize(walPath) > 0, 'o teste deve produzir conteúdo no WAL');

    await close(database);
    database = null;
    assert.equal(await fileSize(walPath), 0, 'o close deve executar checkpoint TRUNCATE');

    const reopened = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        reopened.prepare('SELECT COUNT(*) AS count FROM durable_data').get().count,
        4,
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (database) await close(database);
    await rm(directory, { recursive: true, force: true });
  }
});
