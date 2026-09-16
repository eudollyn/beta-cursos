import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, test } from 'node:test';

import { createDatabase } from '../railway/db.mjs';
import { createFullBackup } from '../railway/full-backup.mjs';
import { applyMigrations } from '../railway/migrate.mjs';
import { parseFullBackup, restoreFullBackup } from '../railway/restore.mjs';
import { createFilesystemMediaStore } from '../railway/storage.mjs';

const temporaryPaths = [];
const resources = [];

afterEach(async () => {
  while (resources.length) await resources.pop().close();
  while (temporaryPaths.length) await rm(temporaryPaths.pop(), { recursive: true, force: true });
});

async function fixture() {
  const sourceDb = await createDatabase({ driver: 'sqlite', databaseUrl: 'sqlite::memory:' });
  const destinationDb = await createDatabase({ driver: 'sqlite', databaseUrl: 'sqlite::memory:' });
  resources.push(destinationDb, sourceDb);
  await applyMigrations(sourceDb);
  await applyMigrations(destinationDb);

  const sourcePath = await mkdtemp(join(tmpdir(), 'beta-restore-source-'));
  const destinationPath = await mkdtemp(join(tmpdir(), 'beta-restore-destination-'));
  temporaryPaths.push(destinationPath, sourcePath);
  const sourceStore = await createFilesystemMediaStore({ driver: 'filesystem', localPath: sourcePath, prefix: '', maxBytes: 0 });
  const destinationStore = await createFilesystemMediaStore({ driver: 'filesystem', localPath: destinationPath, prefix: '', maxBytes: 0 });
  resources.push(destinationStore, sourceStore);

  const now = '2026-09-16T12:00:00.000Z';
  const mediaBytes = Buffer.from('%PDF-1.7\nconteudo do curso');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(mediaBytes).digest('hex');
  await sourceStore.put('pdf/material.pdf', mediaBytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: { sha256 },
  });
  await sourceDb.prepare(`INSERT INTO courses
    (id, slug, title, status, data_json, version, created_at, updated_at, published_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('curso-restaurado', 'curso-restaurado', 'Curso restaurado', 'published', '{"id":"curso-restaurado","modules":[]}', 1, now, now, now, 'owner@example.com', 'owner@example.com').run();
  await sourceDb.prepare(`INSERT INTO media
    (id, storage_key, filename, content_type, kind, size, sha256, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('mid-restaurado', 'pdf/material.pdf', 'material.pdf', 'application/pdf', 'pdf', mediaBytes.length, sha256, now, 'owner@example.com').run();
  await sourceDb.prepare(`INSERT INTO app_users
    (id, email, full_name, password_hash, member_code, member_code_validated, role, is_demo, created_at, updated_at, last_access_at, email_verified_at, date_of_birth, account_status, disabled_at, disabled_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('usr-restaurado', 'aluno@example.com', 'Aluno', 'hash-seguro', null, 0, 'student', 0, now, now, now, now, '2000-01-01', 'active', null, null).run();
  await sourceDb.prepare(`INSERT INTO app_enrollments
    (id, user_id, course_id, status, source, checkout_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('enr-restaurado', 'usr-restaurado', 'curso-restaurado', 'active', 'manual', null, now, now).run();
  await sourceDb.prepare(`INSERT INTO app_enrollment_grants
    (id, grant_key, user_id, course_id, source, checkout_id, status, suspension_reason, suspended_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind('grant-restaurado', 'source:manual:usr-restaurado:curso-restaurado', 'usr-restaurado', 'curso-restaurado', 'manual', null, 'active', null, null, now, now).run();
  await sourceDb.prepare(`INSERT INTO app_progress
    (user_id, course_id, snapshot_json, version, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind('usr-restaurado', 'curso-restaurado', '{"completedLessons":[]}', 1, now).run();

  const generated = await createFullBackup({ database: sourceDb, mediaStore: sourceStore, exportedBy: 'owner@example.com', now: new Date(now) });
  const backup = Buffer.from(await new Response(generated.body).arrayBuffer());
  return { sourceDb, destinationDb, sourceStore, destinationStore, backup, mediaBytes };
}

test('dry-run não altera o destino e restore transfere SQLite e filesystem integralmente', async () => {
  const { destinationDb, destinationStore, backup, mediaBytes } = await fixture();
  const preview = await restoreFullBackup({ database: destinationDb, mediaStore: destinationStore, input: backup });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.rows.courses, 1);
  assert.equal(preview.rows.app_enrollment_grants, 1);
  assert.equal((await destinationDb.prepare('SELECT COUNT(*) AS count FROM courses').first()).count, 0);
  assert.equal(await destinationStore.head('pdf/material.pdf'), null);

  const applied = await restoreFullBackup({ database: destinationDb, mediaStore: destinationStore, input: backup, dryRun: false });
  assert.equal(applied.media.created, 1);
  assert.equal((await destinationDb.prepare('SELECT title FROM courses WHERE id = ?').bind('curso-restaurado').first()).title, 'Curso restaurado');
  assert.equal((await destinationDb.prepare('SELECT COUNT(*) AS count FROM app_enrollment_grants').first()).count, 1);
  const restored = await destinationStore.get('pdf/material.pdf');
  assert.deepEqual(Buffer.from(await new Response(restored.body).arrayBuffer()), mediaBytes);

  await assert.rejects(
    restoreFullBackup({ database: destinationDb, mediaStore: destinationStore, input: backup, dryRun: false }),
    error => error.code === 'restore_destination_not_empty',
  );
});

test('parser rejeita mídia corrompida e backup truncado antes de alterar o destino', async () => {
  const { backup } = await fixture();
  const records = gunzipSync(backup).toString('utf8').trim().split('\n').map(JSON.parse);
  const chunk = records.find(record => record.type === 'media-chunk');
  chunk.data = Buffer.from('arquivo adulterado').toString('base64');
  const corrupted = gzipSync(`${records.map(JSON.stringify).join('\n')}\n`);
  await assert.rejects(parseFullBackup(corrupted), error => ['restore_media_size_mismatch', 'restore_media_checksum_mismatch'].includes(error.code));

  const truncatedRecords = records.filter(record => record.type !== 'media-end');
  const truncated = gzipSync(`${truncatedRecords.map(JSON.stringify).join('\n')}\n`);
  await assert.rejects(parseFullBackup(truncated), error => error.code === 'restore_media_truncated');
});

test('falha na transação remove apenas as mídias criadas durante a tentativa', async () => {
  const { backup } = await fixture();
  const objects = new Map();
  const mediaStore = {
    async head(key) { const value = objects.get(key); return value ? { size: value.length, customMetadata: {} } : null; },
    async put(key, value) { objects.set(key, Buffer.from(value)); },
    async delete(key) { objects.delete(key); },
  };
  const database = {
    dialect: 'sqlite',
    prepare(sql) {
      if (/COUNT\(\*\)/i.test(sql)) return { first: async () => ({ count: 0 }) };
      throw new Error(`consulta inesperada: ${sql}`);
    },
    async transaction() { throw new Error('falha injetada'); },
  };
  await assert.rejects(
    restoreFullBackup({ database, mediaStore, input: backup, dryRun: false }),
    /falha injetada/,
  );
  assert.equal(objects.size, 0);
});
