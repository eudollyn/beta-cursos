import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';

const BACKUP_TABLES = Object.freeze([
  'admins',
  'courses',
  'media',
  'audit_log',
  'app_meta',
  'app_users',
  'app_checkouts',
  'app_enrollments',
  'app_progress',
  'app_quiz_attempts',
  'app_course_completions',
  'app_video_progress',
  'app_enrollment_grants',
]);

const EPHEMERAL_TABLES = Object.freeze(['app_sessions', 'app_auth_tokens']);

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

async function rows(database, table) {
  const result = await database.prepare(`SELECT * FROM ${table}`).all();
  return result.results || [];
}

async function preflightMedia(mediaStore, mediaRows) {
  const objects = [];
  for (const media of mediaRows) {
    const object = await mediaStore.head(media.storage_key);
    if (!object) {
      const error = new Error(`O arquivo ${media.filename || media.id} não foi encontrado no armazenamento.`);
      error.code = 'backup_media_missing';
      throw error;
    }
    objects.push({ media, object });
  }
  return objects;
}

async function* backupRecords({ database, mediaStore, exportedBy, exportedAt, tableRows, mediaObjects }) {
  yield line({
    type: 'manifest',
    format: 'beta-cursos-full-backup',
    version: 1,
    exportedAt,
    exportedBy,
    databaseDialect: database.dialect || 'unknown',
    tables: BACKUP_TABLES,
    excludedEphemeralTables: EPHEMERAL_TABLES,
    note: 'Sessões ativas e tokens temporários não são preservados por segurança.',
  });

  const counts = {};
  for (const [table, values] of tableRows) {
    counts[table] = values.length;
    for (const value of values) yield line({ type: 'row', table, value });
  }

  for (const { media, object } of mediaObjects) {
    yield line({
      type: 'media-start',
      storageKey: media.storage_key,
      mediaId: media.id,
      size: object.size,
      httpMetadata: object.httpMetadata || {},
      customMetadata: object.customMetadata || {},
    });
    const stored = await mediaStore.get(media.storage_key);
    if (!stored?.body) throw new Error(`Não foi possível abrir ${media.filename || media.id} durante o backup.`);
    let index = 0;
    for await (const chunk of Readable.fromWeb(stored.body)) {
      yield line({
        type: 'media-chunk',
        storageKey: media.storage_key,
        index,
        data: Buffer.from(chunk).toString('base64'),
      });
      index += 1;
    }
    yield line({ type: 'media-end', storageKey: media.storage_key, chunks: index });
  }

  yield line({
    type: 'complete',
    tableCounts: counts,
    mediaFiles: mediaObjects.length,
  });
}

export async function createFullBackup({ database, mediaStore, exportedBy, now = new Date() }) {
  if (!database || !mediaStore) throw new TypeError('Banco de dados e armazenamento são obrigatórios para o backup.');
  const exportedAt = now.toISOString();

  // Execute the preflight before returning HTTP headers. A missing file must
  // fail clearly instead of producing a truncated archive that looks valid.
  const tableRows = new Map();
  for (const table of BACKUP_TABLES) tableRows.set(table, await rows(database, table));
  const mediaObjects = await preflightMedia(mediaStore, tableRows.get('media') || []);

  const source = Readable.from(backupRecords({
    database,
    mediaStore,
    exportedBy: String(exportedBy || 'unknown'),
    exportedAt,
    tableRows,
    mediaObjects,
  }));
  const gzip = createGzip({ level: 6 });
  source.pipe(gzip);
  const date = exportedAt.slice(0, 10);

  return {
    body: Readable.toWeb(gzip),
    filename: `beta-cursos-backup-completo-${date}.ndjson.gz`,
    contentType: 'application/gzip',
  };
}

export const __test = { BACKUP_TABLES, EPHEMERAL_TABLES, backupRecords };
