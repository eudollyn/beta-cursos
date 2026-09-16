import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';

import { createFullBackup, __test } from '../railway/full-backup.mjs';

test('backup integral inclui banco e arquivos, mas exclui sessões e tokens temporários', async () => {
  const tableData = Object.fromEntries(__test.BACKUP_TABLES.map(table => [table, []]));
  tableData.app_users = [{ id: 'usr_1', email: 'aluno@example.com', password_hash: 'hash-protegido' }];
  tableData.courses = [{ id: 'curso-1', data_json: '{"title":"Curso"}' }];
  tableData.media = [{ id: 'mid_1', storage_key: 'pdf/apostila.pdf', filename: 'apostila.pdf' }];
  const database = {
    dialect: 'sqlite',
    prepare(sql) {
      const table = /FROM\s+([a-z_]+)/i.exec(sql)?.[1];
      return { all: async () => ({ results: tableData[table] || [] }) };
    },
  };
  const fileBytes = new TextEncoder().encode('%PDF-1.7 material');
  const mediaStore = {
    async head(key) {
      return key === 'pdf/apostila.pdf'
        ? { size: fileBytes.length, httpMetadata: { contentType: 'application/pdf' } }
        : null;
    },
    async get(key) {
      return key === 'pdf/apostila.pdf'
        ? { body: new Blob([fileBytes]).stream() }
        : null;
    },
  };

  const backup = await createFullBackup({
    database,
    mediaStore,
    exportedBy: 'owner@example.com',
    now: new Date('2026-09-15T12:00:00.000Z'),
  });
  const compressed = Buffer.from(await new Response(backup.body).arrayBuffer());
  const records = gunzipSync(compressed).toString('utf8').trim().split('\n').map(JSON.parse);

  assert.equal(backup.contentType, 'application/gzip');
  assert.equal(backup.filename, 'beta-cursos-backup-completo-2026-09-15.ndjson.gz');
  assert.deepEqual(records[0].excludedEphemeralTables, ['app_sessions', 'app_auth_tokens']);
  assert.ok(records.some(record => record.type === 'row' && record.table === 'app_users'));
  assert.ok(records.some(record => record.type === 'row' && record.table === 'courses'));
  const mediaChunk = records.find(record => record.type === 'media-chunk');
  assert.deepEqual(Buffer.from(mediaChunk.data, 'base64'), Buffer.from(fileBytes));
  assert.deepEqual(records.at(-1), {
    type: 'complete',
    tableCounts: Object.fromEntries(__test.BACKUP_TABLES.map(table => [table, tableData[table].length])),
    mediaFiles: 1,
  });
});

test('backup integral falha antes do download quando um arquivo está ausente', async () => {
  const database = {
    prepare(sql) {
      const table = /FROM\s+([a-z_]+)/i.exec(sql)?.[1];
      return {
        all: async () => ({
          results: table === 'media'
            ? [{ id: 'mid_ausente', storage_key: 'pdf/ausente.pdf', filename: 'ausente.pdf' }]
            : [],
        }),
      };
    },
  };
  await assert.rejects(
    createFullBackup({ database, mediaStore: { head: async () => null }, exportedBy: 'owner' }),
    error => error.code === 'backup_media_missing',
  );
});
