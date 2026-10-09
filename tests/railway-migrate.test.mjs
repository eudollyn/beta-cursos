import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { applyMigrations } from '../railway/migrate.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => (
      rm(directory, { recursive: true, force: true })
    )),
  );
});

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function migrationDirectory(contents = 'CREATE TABLE migration_example (id INTEGER PRIMARY KEY);') {
  const directory = await mkdtemp(join(tmpdir(), 'beta-cursos-migrations-'));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, '001_create_example.sql'),
    contents,
    'utf8',
  );
  return directory;
}

function migrationConnection(dialect, events, applied = new Map()) {
  const connection = {
    dialect,
    async exec(sql) {
      events.push({ type: 'exec', sql: String(sql) });
      return { success: true };
    },
    prepare(sql) {
      const statementSql = String(sql);
      return {
        async all() {
          events.push({ type: 'all', sql: statementSql });
          return {
            success: true,
            results: [...applied].map(([name, checksum]) => ({ name, checksum })),
          };
        },
        bind(...values) {
          return {
            async run() {
              events.push({ type: 'run', sql: statementSql, values });
              if (/INSERT INTO railway_migrations/i.test(statementSql)) {
                applied.set(values[0], values[1]);
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async transaction(callback) {
      events.push({ type: 'nested-transaction' });
      return callback(connection);
    },
  };
  return connection;
}

test('PostgreSQL mantém advisory lock transacional durante todas as migrations', async () => {
  const directory = await migrationDirectory();
  const events = [];
  const scoped = migrationConnection('postgres', events);
  let rootTransactions = 0;
  const database = {
    dialect: 'postgres',
    async exec() {
      throw new Error('exec fora da transação PostgreSQL');
    },
    async transaction(callback) {
      rootTransactions += 1;
      events.push({ type: 'begin' });
      try {
        const result = await callback(scoped);
        events.push({ type: 'commit' });
        return result;
      } catch (error) {
        events.push({ type: 'rollback' });
        throw error;
      }
    },
  };

  const result = await applyMigrations(database, { directory });

  assert.deepEqual(result.applied, ['001_create_example.sql']);
  assert.equal(rootTransactions, 1);
  assert.equal(events[0].type, 'begin');
  assert.equal(events.at(-1).type, 'commit');
  const lockIndex = events.findIndex(event => (
    event.type === 'exec' && /pg_advisory_xact_lock/i.test(event.sql)
  ));
  const migrationTableIndex = events.findIndex(event => (
    event.type === 'exec' && /CREATE TABLE IF NOT EXISTS railway_migrations/i.test(event.sql)
  ));
  const migrationIndex = events.findIndex(event => (
    event.type === 'exec' && /CREATE TABLE migration_example/i.test(event.sql)
  ));
  assert.equal(lockIndex, 1);
  assert.ok(lockIndex < migrationTableIndex);
  assert.ok(migrationTableIndex < migrationIndex);
  assert.equal(
    events.filter(event => (
      event.type === 'exec' && /pg_advisory_xact_lock/i.test(event.sql)
    )).length,
    1,
  );
});

test('SQLite mantém o fluxo existente sem advisory lock global', async () => {
  const directory = await migrationDirectory();
  const events = [];
  const database = migrationConnection('sqlite', events);

  const result = await applyMigrations(database, { directory });

  assert.deepEqual(result.applied, ['001_create_example.sql']);
  assert.equal(events.filter(event => event.type === 'nested-transaction').length, 1);
  assert.equal(
    events.some(event => (
      event.type === 'exec' && /pg_advisory_xact_lock/i.test(event.sql)
    )),
    false,
  );
  assert.equal(events[0].type, 'exec');
  assert.match(events[0].sql, /CREATE TABLE IF NOT EXISTS railway_migrations/);
});

test('aceita checksum legado CRLF para migration idêntica entregue pelo GitHub em LF', async () => {
  const lfContents = [
    'CREATE TABLE migration_example (',
    '  id INTEGER PRIMARY KEY',
    ');',
    '',
  ].join('\n');
  const directory = await migrationDirectory(lfContents);
  const events = [];
  const legacyWindowsChecksum = sha256(lfContents.replace(/\n/g, '\r\n'));
  const database = migrationConnection('sqlite', events, new Map([
    ['001_create_example.sql', legacyWindowsChecksum],
  ]));

  const result = await applyMigrations(database, { directory });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['001_create_example.sql']);
  assert.equal(
    events.some(event => event.type === 'exec' && /CREATE TABLE migration_example/i.test(event.sql)),
    false,
  );
});

test('aceita checksum legado LF para migration idêntica lida em CRLF', async () => {
  const lfContents = [
    'CREATE TABLE migration_example (',
    '  id INTEGER PRIMARY KEY',
    ');',
    '',
  ].join('\n');
  const directory = await migrationDirectory(lfContents.replace(/\n/g, '\r\n'));
  const events = [];
  const database = migrationConnection('sqlite', events, new Map([
    ['001_create_example.sql', sha256(lfContents)],
  ]));

  const result = await applyMigrations(database, { directory });

  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.skipped, ['001_create_example.sql']);
});

test('registra migration nova com checksum canônico LF mesmo quando o arquivo foi lido em CRLF', async () => {
  const lfContents = [
    'CREATE TABLE migration_example (',
    '  id INTEGER PRIMARY KEY',
    ');',
    '',
  ].join('\n');
  const directory = await migrationDirectory(lfContents.replace(/\n/g, '\r\n'));
  const events = [];
  const database = migrationConnection('sqlite', events);

  await applyMigrations(database, { directory });

  const insertion = events.find(event => (
    event.type === 'run' && /INSERT INTO railway_migrations/i.test(event.sql)
  ));
  assert.equal(insertion.values[1], sha256(lfContents));
});

test('rejeita mudança semântica mesmo quando o checksum legado usava CRLF', async () => {
  const originalLfContents = [
    'CREATE TABLE migration_example (',
    '  id INTEGER PRIMARY KEY',
    ');',
    '',
  ].join('\n');
  const changedLfContents = [
    'CREATE TABLE migration_example (',
    '  id INTEGER PRIMARY KEY,',
    '  changed TEXT NOT NULL',
    ');',
    '',
  ].join('\n');
  const directory = await migrationDirectory(changedLfContents);
  const events = [];
  const legacyWindowsChecksum = sha256(originalLfContents.replace(/\n/g, '\r\n'));
  const database = migrationConnection('sqlite', events, new Map([
    ['001_create_example.sql', legacyWindowsChecksum],
  ]));

  await assert.rejects(
    () => applyMigrations(database, { directory }),
    /migration 001_create_example\.sql foi alterada depois de aplicada/i,
  );
});
