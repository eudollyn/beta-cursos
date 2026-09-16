import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const POSTGRES_URL_PATTERN = /^postgres(?:ql)?:\/\//i;
const SQLITE_MEMORY_VALUES = new Set([':memory:', 'sqlite::memory:', 'sqlite://:memory:']);
const WORKER_SCHEMA_TABLES = '(?:admins|courses|media|audit_log|app_meta)';
const WORKER_SCHEMA_INDEXES = '(?:courses_slug_unique|courses_status_updated_idx|media_storage_key_unique|media_kind_created_idx|audit_log_created_idx)';

function normalizeUniqueError(error) {
  if (error?.code !== '23505') return error;
  const suffix = error.constraint ? `: ${error.constraint}` : '';
  const normalized = new Error(`UNIQUE constraint failed${suffix}`, { cause: error });
  normalized.name = 'DatabaseConstraintError';
  normalized.code = error.code;
  normalized.constraint = error.constraint;
  normalized.detail = error.detail;
  return normalized;
}

function normalizePgValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return value;
}

function normalizePgRow(row) {
  const normalized = {};
  for (const [key, rawValue] of Object.entries(row || {})) {
    let value = normalizePgValue(rawValue);
    if (key.endsWith('_json') && value !== null && typeof value === 'object') {
      value = JSON.stringify(value);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeSqliteValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value === undefined ? null : value;
}

function normalizeSqliteRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, normalizePgValue(value)]),
  );
}

// Converts D1/SQLite positional parameters to node-postgres parameters while
// leaving quoted strings, identifiers and comments untouched.
export function translatePostgresPlaceholders(sql) {
  let output = '';
  let parameter = 0;
  let index = 0;
  let state = 'normal';
  let dollarTag = '';

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === 'single') {
      output += character;
      if (character === "'" && next === "'") {
        output += next;
        index += 2;
        continue;
      }
      if (character === "'") state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'double') {
      output += character;
      if (character === '"' && next === '"') {
        output += next;
        index += 2;
        continue;
      }
      if (character === '"') state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'line-comment') {
      output += character;
      if (character === '\n') state = 'normal';
      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      output += character;
      if (character === '*' && next === '/') {
        output += next;
        index += 2;
        state = 'normal';
        continue;
      }
      index += 1;
      continue;
    }

    if (state === 'dollar') {
      if (sql.startsWith(dollarTag, index)) {
        output += dollarTag;
        index += dollarTag.length;
        state = 'normal';
        continue;
      }
      output += character;
      index += 1;
      continue;
    }

    if (character === "'") {
      state = 'single';
      output += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      state = 'double';
      output += character;
      index += 1;
      continue;
    }
    if (character === '-' && next === '-') {
      state = 'line-comment';
      output += '--';
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      output += '/*';
      index += 2;
      continue;
    }
    if (character === '$') {
      const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = 'dollar';
        output += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (character === '?') {
      parameter += 1;
      output += `$${parameter}`;
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function postgresCompatibilityResult(sql) {
  const compact = String(sql || '').trim().replace(/\s+/g, ' ');
  if (/\bFROM sqlite_master\b/i.test(compact)) {
    return { kind: 'query', result: { rows: [], rowCount: 0, command: 'SELECT' } };
  }
  if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${WORKER_SCHEMA_TABLES}\\b`, 'i').test(compact)
    || new RegExp(`^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${WORKER_SCHEMA_INDEXES}\\b`, 'i').test(compact)
    || /^ALTER TABLE media RENAME TO media_before_images\b/i.test(compact)
    || /^CREATE TABLE media\s*\(/i.test(compact)
    || /^INSERT INTO media\b[\s\S]*\bFROM media_before_images\b/i.test(compact)
    || /^DROP TABLE media_before_images\b/i.test(compact)) {
    return { kind: 'mutation', result: { rows: [], rowCount: 0, command: 'DDL' } };
  }
  return null;
}

function queryResult(result) {
  return {
    success: true,
    results: (result?.rows || []).map(normalizePgRow),
  };
}

function mutationResult(result) {
  return {
    success: true,
    meta: { changes: Number(result?.rowCount || 0) },
  };
}

class AsyncMutex {
  constructor() {
    this._tail = Promise.resolve();
  }

  async runExclusive(callback) {
    const previous = this._tail;
    let release;
    this._tail = new Promise((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

class SQLiteStatement {
  constructor(binding, sql, values = []) {
    this.binding = binding;
    this.sql = String(sql);
    this.values = values;
  }

  bind(...values) {
    return new SQLiteStatement(this.binding, this.sql, values.map(normalizeSqliteValue));
  }

  _statement() {
    this.binding._assertOpen();
    return this.binding._database.prepare(this.sql);
  }

  _runSync() {
    try {
      const result = this._statement().run(...this.values);
      return { success: true, meta: { changes: Number(result.changes || 0) } };
    } catch (error) {
      throw normalizeUniqueError(error);
    }
  }

  _allSync() {
    try {
      return {
        success: true,
        results: this._statement().all(...this.values).map(normalizeSqliteRow),
      };
    } catch (error) {
      throw normalizeUniqueError(error);
    }
  }

  _firstSync() {
    try {
      const row = this._statement().get(...this.values);
      return row ? normalizeSqliteRow(row) : null;
    } catch (error) {
      throw normalizeUniqueError(error);
    }
  }

  _executeForBatchSync() {
    return /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql) ? this._allSync() : this._runSync();
  }

  async run() {
    return this.binding._executeSerialized(() => this._runSync());
  }

  async all() {
    return this.binding._executeSerialized(() => this._allSync());
  }

  async first() {
    return this.binding._executeSerialized(() => this._firstSync());
  }
}

class SQLiteBinding {
  constructor(database, filename, ownsDatabase = true) {
    this.dialect = 'sqlite';
    this.filename = filename;
    this._database = database;
    this._ownsDatabase = ownsDatabase;
    this._closed = false;
    this._closing = false;
    this._closePromise = null;
    this._mutex = new AsyncMutex();
    this._transactionContext = new AsyncLocalStorage();
  }

  _assertOpen() {
    if (this._closed) throw new Error('A conexão SQLite já foi encerrada.');
  }

  _assertAcceptingOperations() {
    this._assertOpen();
    if (this._closing && !this._activeTransaction()) {
      throw new Error('A conexão SQLite está sendo encerrada.');
    }
  }

  _activeTransaction() {
    const context = this._transactionContext.getStore();
    return context?.binding === this && context.active === true ? context : null;
  }

  async _executeSerialized(callback) {
    if (this._activeTransaction()) {
      this._assertOpen();
      return callback();
    }
    this._assertAcceptingOperations();
    return this._mutex.runExclusive(async () => {
      this._assertOpen();
      return callback();
    });
  }

  prepare(sql) {
    this._assertAcceptingOperations();
    return new SQLiteStatement(this, sql);
  }

  async batch(statements) {
    this._assertAcceptingOperations();
    if (!Array.isArray(statements)) throw new TypeError('batch() exige uma lista de statements.');
    const execute = () => statements.map((statement) => {
      if (!(statement instanceof SQLiteStatement) || statement.binding._database !== this._database) {
        throw new TypeError('Todos os statements do batch devem pertencer à mesma conexão SQLite.');
      }
      return statement._executeForBatchSync();
    });
    const nested = Boolean(this._activeTransaction());
    return this._executeSerialized(() => {
      if (nested) return execute();
      this._database.exec('BEGIN IMMEDIATE');
      try {
        const results = execute();
        this._database.exec('COMMIT');
        return results;
      } catch (error) {
        this._database.exec('ROLLBACK');
        throw normalizeUniqueError(error);
      }
    });
  }

  async exec(sql) {
    return this._executeSerialized(() => {
      try {
        this._database.exec(String(sql));
        return { success: true };
      } catch (error) {
        throw normalizeUniqueError(error);
      }
    });
  }

  async transaction(callback) {
    this._assertAcceptingOperations();
    if (typeof callback !== 'function') throw new TypeError('transaction() exige uma função.');
    if (this._activeTransaction()) return callback(this);

    return this._mutex.runExclusive(async () => {
      this._assertOpen();
      this._database.exec('BEGIN IMMEDIATE');
      const context = { binding: this, active: true };
      try {
        const result = await this._transactionContext.run(
          context,
          () => callback(this),
        );
        context.active = false;
        this._database.exec('COMMIT');
        return result;
      } catch (error) {
        context.active = false;
        try {
          this._database.exec('ROLLBACK');
        } catch (rollbackError) {
          throw normalizeUniqueError(new AggregateError(
            [error, rollbackError],
            'A transação SQLite falhou e o rollback não pôde ser concluído.',
          ));
        }
        throw normalizeUniqueError(error);
      } finally {
        context.active = false;
      }
    });
  }

  async healthcheck() {
    const startedAt = performance.now();
    try {
      const row = await this.prepare('SELECT 1 AS ok').first();
      return {
        ok: Number(row?.ok) === 1,
        dialect: this.dialect,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      return {
        ok: false,
        dialect: this.dialect,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: error?.message || String(error),
      };
    }
  }

  async close() {
    if (this._closed) return;
    if (this._activeTransaction()) {
      throw new Error('A conexão SQLite não pode ser encerrada durante uma transação.');
    }
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._closePromise = this._mutex.runExclusive(async () => {
      if (this._closed) return;
      let checkpointError = null;
      try {
        if (this._ownsDatabase && this.filename !== ':memory:') {
          this._database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        }
      } catch (error) {
        checkpointError = normalizeUniqueError(error);
      }
      try {
        if (this._ownsDatabase) this._database.close();
      } finally {
        this._closed = true;
      }
      if (checkpointError) throw checkpointError;
    });
    return this._closePromise;
  }
}

class PostgresStatement {
  constructor(binding, sql, values = []) {
    this.binding = binding;
    this.sql = String(sql);
    this.values = values;
  }

  bind(...values) {
    return new PostgresStatement(this.binding, this.sql, values);
  }

  async _query(executor = this.binding._executor()) {
    this.binding._assertOpen();
    const compatibility = postgresCompatibilityResult(this.sql);
    if (compatibility) return compatibility.result;
    try {
      return await executor.query(translatePostgresPlaceholders(this.sql), this.values);
    } catch (error) {
      throw normalizeUniqueError(error);
    }
  }

  async run(executor) {
    return mutationResult(await this._query(executor));
  }

  async all(executor) {
    return queryResult(await this._query(executor));
  }

  async first(executor) {
    const result = await this._query(executor);
    return result.rows?.length ? normalizePgRow(result.rows[0]) : null;
  }

  async _executeForBatch(executor) {
    const result = await this._query(executor);
    return result.command === 'SELECT' || Array.isArray(result.rows) && result.rows.length > 0
      ? queryResult(result)
      : mutationResult(result);
  }
}

class PostgresBinding {
  constructor(pool, { client = null, ownsPool = true } = {}) {
    this.dialect = 'postgres';
    this._pool = pool;
    this._client = client;
    this._ownsPool = ownsPool;
    this._closed = false;
  }

  _assertOpen() {
    if (this._closed) throw new Error('A conexão PostgreSQL já foi encerrada.');
  }

  _executor() {
    return this._client || this._pool;
  }

  prepare(sql) {
    this._assertOpen();
    return new PostgresStatement(this, sql);
  }

  async _withClient(callback) {
    if (this._client) return callback(this._client);
    const client = await this._pool.connect();
    try {
      return await callback(client);
    } finally {
      client.release();
    }
  }

  async batch(statements) {
    this._assertOpen();
    if (!Array.isArray(statements)) throw new TypeError('batch() exige uma lista de statements.');
    const execute = async (client) => {
      const results = [];
      for (const statement of statements) {
        if (!(statement instanceof PostgresStatement) || statement.binding._pool !== this._pool) {
          throw new TypeError('Todos os statements do batch devem pertencer ao mesmo pool PostgreSQL.');
        }
        results.push(await statement._executeForBatch(client));
      }
      return results;
    };
    if (this._client) return execute(this._client);

    return this._withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const results = await execute(client);
        await client.query('COMMIT');
        return results;
      } catch (error) {
        await client.query('ROLLBACK');
        throw normalizeUniqueError(error);
      }
    });
  }

  async exec(sql) {
    this._assertOpen();
    try {
      await this._executor().query(String(sql));
      return { success: true };
    } catch (error) {
      throw normalizeUniqueError(error);
    }
  }

  async transaction(callback) {
    this._assertOpen();
    if (typeof callback !== 'function') throw new TypeError('transaction() exige uma função.');
    if (this._client) return callback(this);

    return this._withClient(async (client) => {
      await client.query('BEGIN');
      const scoped = new PostgresBinding(this._pool, { client, ownsPool: false });
      try {
        const result = await callback(scoped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw normalizeUniqueError(error);
      } finally {
        scoped._closed = true;
      }
    });
  }

  async healthcheck() {
    const startedAt = performance.now();
    try {
      const result = await this._executor().query('SELECT 1 AS ok');
      return {
        ok: Number(result.rows?.[0]?.ok) === 1,
        dialect: this.dialect,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    } catch (error) {
      return {
        ok: false,
        dialect: this.dialect,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        error: error?.message || String(error),
      };
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._ownsPool && !this._client) await this._pool.end();
  }
}

function sqliteFilename(value) {
  if (!value) return resolve(process.cwd(), 'railway', '.data', 'beta-cursos.sqlite');
  if (SQLITE_MEMORY_VALUES.has(value)) return ':memory:';
  if (value.startsWith('file:')) return fileURLToPath(value);
  if (value.startsWith('sqlite:')) {
    const path = value.slice('sqlite:'.length).replace(/^\/\//, '');
    return resolve(path);
  }
  return resolve(value);
}

async function createSqliteDatabase(options, env) {
  const filename = sqliteFilename(options.filename || options.sqlitePath || env.SQLITE_PATH
    || (!POSTGRES_URL_PATTERN.test(options.databaseUrl || env.DATABASE_URL || '')
      ? options.databaseUrl || env.DATABASE_URL
      : null));
  if (filename !== ':memory:') await mkdir(dirname(filename), { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  if (filename !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = FULL');
  database.exec('PRAGMA journal_size_limit = 16777216');
  return new SQLiteBinding(database, filename);
}

async function createPostgresDatabase(options, env) {
  const connectionString = options.databaseUrl || env.DATABASE_URL;
  if (!connectionString && !options.pool) {
    throw new Error('DATABASE_URL é obrigatória para usar PostgreSQL.');
  }

  let pool = options.pool;
  let ownsPool = options.ownsPool ?? !pool;
  if (!pool) {
    let pg;
    try {
      pg = await import('pg');
    } catch (error) {
      const missing = new Error('O pacote "pg" é necessário para conectar ao PostgreSQL.', { cause: error });
      missing.code = 'postgres_driver_missing';
      throw missing;
    }
    const Pool = pg.Pool || pg.default?.Pool;
    pool = new Pool({
      connectionString,
      application_name: options.applicationName || 'beta-cursos-railway',
      max: Number(options.maxConnections || env.PGPOOL_MAX || 10),
      idleTimeoutMillis: Number(options.idleTimeoutMillis || env.PG_IDLE_TIMEOUT_MS || 30_000),
      connectionTimeoutMillis: Number(options.connectionTimeoutMillis || env.PG_CONNECT_TIMEOUT_MS || 10_000),
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
    });
    ownsPool = true;
  }
  return new PostgresBinding(pool, { ownsPool });
}

export async function createDatabase(options = {}) {
  if (typeof options === 'string' || options instanceof URL) {
    options = { databaseUrl: String(options) };
  }
  const env = options.env || process.env;
  const databaseUrl = options.databaseUrl || options.url || env.DATABASE_URL || '';
  const driver = String(options.driver || options.dialect || env.DB_DRIVER
    || (POSTGRES_URL_PATTERN.test(databaseUrl) ? 'postgres' : 'sqlite')).toLowerCase();

  if (driver === 'postgres' || driver === 'postgresql' || driver === 'pg') {
    return createPostgresDatabase({ ...options, databaseUrl }, env);
  }
  if (driver === 'sqlite') return createSqliteDatabase({ ...options, databaseUrl }, env);
  throw new Error(`Driver de banco não suportado: ${driver}.`);
}

export async function healthcheck(database) {
  if (!database || typeof database.healthcheck !== 'function') {
    throw new TypeError('healthcheck() exige um banco criado por createDatabase().');
  }
  return database.healthcheck();
}

export async function close(database) {
  if (database && typeof database.close === 'function') await database.close();
}
