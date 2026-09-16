import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { close, createDatabase } from './db.mjs';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
// Stable signed bigint namespace reserved for Beta Cursos migrations.
const POSTGRES_MIGRATION_LOCK_ID = 4_270_132_026;

function migrationTableSql(dialect) {
  return dialect === 'postgres'
    ? `CREATE TABLE IF NOT EXISTS railway_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    : `CREATE TABLE IF NOT EXISTS railway_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
}

function checksum(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function applyMigrationFiles(database, options) {
  const dialect = database.dialect === 'postgres' ? 'postgres' : 'sqlite';
  const directory = resolve(options.directory || join(currentDirectory, 'migrations', dialect));
  await database.exec(migrationTableSql(dialect));

  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d+[-_].+\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));

  const appliedRows = (await database.prepare(
    'SELECT name, checksum FROM railway_migrations ORDER BY name',
  ).all()).results || [];
  const applied = new Map(appliedRows.map((row) => [row.name, row.checksum]));
  const result = { dialect, directory, applied: [], skipped: [] };

  for (const name of entries) {
    const contents = await readFile(join(directory, name), 'utf8');
    const digest = checksum(contents);
    if (applied.has(name)) {
      if (applied.get(name) !== digest) {
        throw new Error(`A migration ${name} foi alterada depois de aplicada.`);
      }
      result.skipped.push(name);
      continue;
    }

    await database.transaction(async (transaction) => {
      await transaction.exec(contents);
      await transaction.prepare(
        'INSERT INTO railway_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
      ).bind(name, digest, new Date().toISOString()).run();
    });
    result.applied.push(name);
  }

  return result;
}

export async function applyMigrations(database, options = {}) {
  if (!database?.dialect || typeof database.exec !== 'function') {
    throw new TypeError('applyMigrations() exige um banco criado por createDatabase().');
  }
  if (database.dialect !== 'postgres') {
    return applyMigrationFiles(database, options);
  }
  if (typeof database.transaction !== 'function') {
    throw new TypeError('Migrations PostgreSQL exigem suporte a transações.');
  }

  // The transaction-scoped lock remains held while the migration table is
  // inspected and every pending migration is applied. Concurrent Railway
  // replicas therefore serialize startup instead of racing on the same file.
  return database.transaction(async (transaction) => {
    await transaction.exec(
      `SELECT pg_advisory_xact_lock(${POSTGRES_MIGRATION_LOCK_ID})`,
    );
    return applyMigrationFiles(transaction, options);
  });
}

async function main() {
  const database = await createDatabase();
  try {
    const result = await applyMigrations(database);
    const health = await database.healthcheck();
    console.log(JSON.stringify({ ...result, health }, null, 2));
    if (!health.ok) process.exitCode = 1;
  } finally {
    await close(database);
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
