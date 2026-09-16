import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { close, createDatabase } from './db.mjs';
import { createMediaStore } from './storage.mjs';
import config from './config.mjs';

const TABLES = Object.freeze([
  'admins', 'courses', 'media', 'audit_log', 'app_meta', 'app_users',
  'app_checkouts', 'app_enrollments', 'app_progress', 'app_quiz_attempts',
  'app_course_completions', 'app_video_progress', 'app_enrollment_grants',
]);
const TABLE_SET = new Set(TABLES);
const JSON_COLUMNS = new Set(['data_json', 'details_json', 'snapshot_json', 'answers_json', 'results_json', 'intervals_json']);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

function restoreError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function asNodeReadable(input) {
  if (typeof input === 'string' || input instanceof URL) return createReadStream(String(input));
  if (Buffer.isBuffer(input) || input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return Readable.from([Buffer.from(input)]);
  }
  if (input && typeof input.getReader === 'function') return Readable.fromWeb(input);
  if (input && typeof input.pipe === 'function') return input;
  throw new TypeError('O backup deve ser um caminho, Buffer ou stream.');
}

function decodeChunk(data, record) {
  if (typeof data !== 'string' || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw restoreError('restore_invalid_media_chunk', `Chunk inválido para ${record.storageKey}.`);
  }
  return Buffer.from(data, 'base64');
}

/**
 * Reads and validates the streaming NDJSON backup format without mutating a
 * database or storage. It deliberately rejects unknown records and truncated
 * media instead of trying to guess how to recover them.
 */
export async function parseFullBackup(input, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const source = asNodeReadable(input).pipe(createGunzip());
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  let manifest = null;
  let complete = null;
  let bytesRead = 0;
  const rows = new Map(TABLES.map(table => [table, []]));
  const media = new Map();

  try {
    for await (const line of lines) {
      bytesRead += Buffer.byteLength(line) + 1;
      if (bytesRead > maxBytes) throw restoreError('restore_too_large', 'O backup excede o limite de segurança.', { maxBytes });
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch (error) {
        throw restoreError('restore_invalid_json', 'O backup contém uma linha JSON inválida.', { cause: error });
      }
      if (!record || typeof record.type !== 'string') throw restoreError('restore_invalid_record', 'Registro de backup sem tipo.');
      if (record.type === 'manifest') {
        if (manifest) throw restoreError('restore_duplicate_manifest', 'O backup contém mais de um manifesto.');
        manifest = record;
        if (record.format !== 'beta-cursos-full-backup' || record.version !== 1) {
          throw restoreError('restore_unsupported_version', 'Formato ou versão de backup não suportado.', { format: record.format, version: record.version });
        }
        continue;
      }
      if (!manifest) throw restoreError('restore_manifest_missing', 'O manifesto deve ser o primeiro registro.');
      if (record.type === 'row') {
        if (!TABLE_SET.has(record.table) || !record.value || typeof record.value !== 'object' || Array.isArray(record.value)) {
          throw restoreError('restore_invalid_row', 'Registro de tabela inválido.', { table: record.table });
        }
        rows.get(record.table).push(record.value);
        continue;
      }
      if (record.type === 'media-start') {
        if (!record.storageKey || media.has(record.storageKey)) throw restoreError('restore_duplicate_media', 'Mídia duplicada ou sem chave.', { storageKey: record.storageKey });
        media.set(record.storageKey, { storageKey: record.storageKey, mediaId: record.mediaId, size: Number(record.size), httpMetadata: record.httpMetadata || {}, customMetadata: record.customMetadata || {}, chunks: [], ended: false });
        continue;
      }
      if (record.type === 'media-chunk') {
        const current = media.get(record.storageKey);
        if (!current || current.ended || Number(record.index) !== current.chunks.length) throw restoreError('restore_invalid_media_chunk', 'Ordem de chunks de mídia inválida.', { storageKey: record.storageKey });
        current.chunks.push(decodeChunk(record.data, record));
        continue;
      }
      if (record.type === 'media-end') {
        const current = media.get(record.storageKey);
        if (!current || current.ended || Number(record.chunks) !== current.chunks.length) throw restoreError('restore_media_truncated', 'Mídia truncada ou com contagem de chunks divergente.', { storageKey: record.storageKey });
        current.ended = true;
        continue;
      }
      if (record.type === 'complete') {
        if (complete) throw restoreError('restore_duplicate_complete', 'O backup contém mais de um marcador de conclusão.');
        complete = record;
        continue;
      }
      throw restoreError('restore_unknown_record', `Registro de backup desconhecido: ${record.type}.`);
    }
  } catch (error) {
    lines.close();
    throw error;
  }

  if (!manifest) throw restoreError('restore_manifest_missing', 'O backup não contém manifesto.');
  if (!complete) throw restoreError('restore_incomplete', 'O backup não contém marcador de conclusão.');
  for (const [key, item] of media) {
    if (!item.ended) throw restoreError('restore_media_truncated', `A mídia ${key} não foi concluída.`);
    const data = Buffer.concat(item.chunks);
    if (!Number.isSafeInteger(item.size) || item.size <= 0 || item.size !== data.length) {
      throw restoreError('restore_media_size_mismatch', `O tamanho da mídia ${key} não confere.`, { expected: item.size, actual: data.length });
    }
    item.body = data;
    delete item.chunks;
    const mediaRow = rows.get('media').find(row => row.storage_key === key);
    if (!mediaRow) throw restoreError('restore_media_row_missing', `Não existe registro de mídia para ${key}.`);
    const digest = createHash('sha256').update(data).digest('hex');
    if (mediaRow.sha256 && String(mediaRow.sha256).toLowerCase() !== digest) {
      throw restoreError('restore_media_checksum_mismatch', `O hash da mídia ${key} não confere.`, { expected: mediaRow.sha256, actual: digest });
    }
    item.sha256 = digest;
  }

  const expectedCounts = complete.tableCounts || {};
  for (const table of TABLES) {
    if (expectedCounts[table] !== undefined && Number(expectedCounts[table]) !== rows.get(table).length) {
      throw restoreError('restore_table_count_mismatch', `A contagem da tabela ${table} não confere.`, { expected: expectedCounts[table], actual: rows.get(table).length });
    }
  }
  if (Number(complete.mediaFiles) !== media.size) throw restoreError('restore_media_count_mismatch', 'A contagem de mídias não confere.');
  return { manifest, rows, media, complete, compressedBytes: bytesRead };
}

function sqlValue(column, value) {
  if (JSON_COLUMNS.has(column) && value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === undefined ? null : value;
}

async function countRows(database, table) {
  try { return Number((await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first())?.count || 0); }
  catch (error) { throw restoreError('restore_schema_missing', `Não foi possível validar a tabela ${table}.`, { cause: error }); }
}

function dataTableIsMeaningful(table, rows) {
  if (table !== 'app_meta') return rows > 0;
  return rows > 1;
}

async function storedMediaHash(mediaStore, key) {
  const stored = await mediaStore.get(key);
  if (!stored?.body) throw restoreError('restore_media_conflict', `Não foi possível validar a mídia existente em ${key}.`);
  const hash = createHash('sha256');
  const body = stored.body && typeof stored.body.getReader === 'function'
    ? Readable.fromWeb(stored.body)
    : stored.body;
  for await (const chunk of body) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Restores a validated backup. dryRun defaults to true. Media is staged before
 * the database transaction and any newly-created objects are removed when the
 * transaction fails. Existing identical objects are reused; divergent objects
 * are never overwritten.
 */
export async function restoreFullBackup({ database, mediaStore, input, dryRun = true, allowNonEmpty = false, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!database || !mediaStore) throw new TypeError('Banco e armazenamento são obrigatórios para restaurar um backup.');
  const backup = await parseFullBackup(input, { maxBytes });
  const destinationCounts = Object.fromEntries(await Promise.all(TABLES.map(async table => [table, await countRows(database, table)])));
  const nonEmpty = Object.fromEntries(Object.entries(destinationCounts).filter(([table, count]) => dataTableIsMeaningful(table, count)));
  if (Object.keys(nonEmpty).length && !allowNonEmpty) {
    throw restoreError('restore_destination_not_empty', 'O destino já contém dados. Use allowNonEmpty somente após validar um backup e um plano de merge.', { tables: nonEmpty });
  }

  const report = {
    dryRun: Boolean(dryRun),
    source: { databaseDialect: backup.manifest.databaseDialect || 'unknown', exportedAt: backup.manifest.exportedAt || null },
    destination: { databaseDialect: database.dialect || 'unknown', existingRows: destinationCounts },
    rows: Object.fromEntries(TABLES.map(table => [table, backup.rows.get(table).length])),
    media: { total: backup.media.size, created: 0, reused: 0 },
    compressedBytes: backup.compressedBytes,
  };
  if (dryRun) return report;

  const createdKeys = [];
  try {
    for (const [key, item] of backup.media) {
      const existing = await mediaStore.head(key);
      if (existing) {
        if (Number(existing.size) !== item.body.length) throw restoreError('restore_media_conflict', `Já existe uma mídia diferente em ${key}.`);
        const declaredHash = String(existing.customMetadata?.sha256 || '').toLowerCase();
        const existingHash = declaredHash || await storedMediaHash(mediaStore, key);
        if (existingHash !== item.sha256) throw restoreError('restore_media_conflict', `O hash da mídia existente em ${key} é diferente.`);
        report.media.reused += 1;
        continue;
      }
      await mediaStore.put(key, item.body, {
        httpMetadata: item.httpMetadata,
        customMetadata: { ...item.customMetadata, sha256: item.sha256 },
      });
      const stored = await mediaStore.head(key);
      if (!stored || Number(stored.size) !== item.body.length) throw restoreError('restore_media_verify_failed', `Não foi possível verificar a mídia restaurada ${key}.`);
      createdKeys.push(key);
      report.media.created += 1;
    }

    await database.transaction(async transaction => {
      for (const table of TABLES) {
        for (const row of backup.rows.get(table)) {
          // The destination schema was already migrated. Never downgrade its
          // marker to the version recorded by an older backup.
          if (table === 'app_meta' && row.key === 'schema_version') continue;
          const columns = Object.keys(row).filter(column => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column));
          if (!columns.length || columns.length !== Object.keys(row).length) throw restoreError('restore_invalid_column', `Coluna inválida na tabela ${table}.`);
          const placeholders = columns.map(() => '?').join(', ');
          const values = columns.map(column => sqlValue(column, row[column]));
          const identityOverride = database.dialect === 'postgres' && table === 'audit_log'
            ? ' OVERRIDING SYSTEM VALUE'
            : '';
          await transaction.prepare(`INSERT INTO ${table} (${columns.join(', ')})${identityOverride} VALUES (${placeholders})`).bind(...values).run();
        }
      }
      if (database.dialect === 'postgres' && backup.rows.get('audit_log').length) {
        await transaction.exec(`SELECT setval(
          pg_get_serial_sequence('audit_log', 'id'),
          COALESCE((SELECT MAX(id) FROM audit_log), 1),
          true
        )`);
      }
    });
    return report;
  } catch (error) {
    const cleanupErrors = [];
    for (const key of createdKeys.reverse()) {
      try { await mediaStore.delete(key); } catch (cleanupError) { cleanupErrors.push({ key, error: cleanupError }); }
    }
    if (cleanupErrors.length) throw restoreError('restore_rollback_incomplete', 'A restauração falhou e alguns arquivos temporários não puderam ser removidos.', { cause: error, cleanupErrors });
    throw error;
  }
}

function cliOptions(argv) {
  const options = { apply: false, allowNonEmpty: false, file: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--allow-nonempty') options.allowNonEmpty = true;
    else if (arg === '--file') options.file = argv[++index] || '';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Opção desconhecida: ${arg}`);
  }
  return options;
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  if (options.help || !options.file) {
    console.log('Uso: pnpm restore --file backup.ndjson.gz [--apply] [--allow-nonempty]');
    console.log('Sem --apply o comando faz somente dry-run e não altera nada.');
    if (!options.file) process.exitCode = options.help ? 0 : 2;
    return;
  }
  const database = await createDatabase();
  const mediaStore = await createMediaStore(config.storage);
  try {
    const report = await restoreFullBackup({ database, mediaStore, input: resolve(options.file), dryRun: !options.apply, allowNonEmpty: options.allowNonEmpty });
    console.log(JSON.stringify(report, null, 2));
    if (!options.apply) console.log('Dry-run concluído. Para aplicar, repita com --apply após revisar o relatório.');
  } finally {
    await close(database);
    await mediaStore.close?.();
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => { console.error(error.message); process.exitCode = 1; });

export const __test = { TABLES, parseFullBackup, sqlValue };
