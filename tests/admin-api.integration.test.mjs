import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../worker.mjs';

class D1StatementMock {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  _statement() {
    return this.database.prepare(this.sql);
  }

  async run() {
    const result = this._statement().run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }

  async all() {
    return { success: true, results: this._statement().all(...this.values) };
  }

  async first() {
    return this._statement().get(...this.values) || null;
  }

  async executeForBatch() {
    return /^\s*SELECT\b/i.test(this.sql) ? this.all() : this.run();
  }
}

class D1Mock {
  constructor() {
    this.database = new DatabaseSync(':memory:');
  }

  prepare(sql) {
    return new D1StatementMock(this.database, sql);
  }

  async batch(statements) {
    this.database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.executeForBatch());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

class R2Mock {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options) {
    const bytes = body instanceof ArrayBuffer
      ? new Uint8Array(body)
      : new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, { bytes: new Uint8Array(bytes), options });
  }

  async get(key, options) {
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options?.range;
    const bytes = range
      ? object.bytes.slice(range.offset, range.offset + range.length)
      : object.bytes;
    return { body: bytes, size: bytes.byteLength };
  }

  async head(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength } : null;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}

const origin = 'https://beta.example';
const ownerHeaders = {
  Origin: origin,
  'oai-authenticated-user-email': 'pastor@example.com',
  'oai-authenticated-user-full-name': 'Pr.%20Andr%C3%A9',
  'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
};

function jsonRequest(path, method, body, headers = ownerHeaders) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('fluxo administrativo persiste curso, arquivo, backup e controle de concorrência', async () => {
  const DB = new D1Mock();
  const MEDIA = new R2Mock();
  const env = { DB, MEDIA };
  try {
    let response = await worker.fetch(jsonRequest('/api/admin/bootstrap', 'POST'), env);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).admin.role, 'owner');

    response = await worker.fetch(jsonRequest('/api/admin/bootstrap', 'POST'), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).created, false);

    response = await worker.fetch(jsonRequest('/api/admin/bootstrap', 'POST', undefined, {
      Origin: origin,
      'oai-authenticated-user-email': 'stranger@example.com',
    }), env);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'bootstrap_closed');

    response = await worker.fetch(new Request(`${origin}/api/courses`), env);
    assert.deepEqual(await response.json(), { courses: [], initialized: true });

    const form = new FormData();
    form.append('kind', 'pdf');
    form.append('file', new File([new TextEncoder().encode('%PDF-1.7\nconteudo')], 'apostila.pdf', {
      type: 'application/pdf',
    }));
    response = await worker.fetch(new Request(`${origin}/api/admin/media`, {
      method: 'POST',
      headers: ownerHeaders,
      body: form,
    }), env);
    assert.equal(response.status, 201);
    const uploaded = (await response.json()).media;
    assert.match(uploaded.url, /^\/api\/media\//);

    const imageForm = new FormData();
    imageForm.append('kind', 'image');
    imageForm.append('file', new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'capa.webp', {
      type: 'image/webp',
    }));
    response = await worker.fetch(new Request(`${origin}/api/admin/media`, {
      method: 'POST',
      headers: ownerHeaders,
      body: imageForm,
    }), env);
    assert.equal(response.status, 201);
    const cover = (await response.json()).media;
    assert.equal(cover.kind, 'image');
    assert.match(cover.url, /^\/api\/media\//);

    response = await worker.fetch(new Request(`${origin}${uploaded.url}`, {
      headers: { Range: 'bytes=0-3' },
    }), env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/17');
    assert.equal(await response.text(), '%PDF');

    const course = {
      title: 'Formação de Líderes',
      slug: 'formacao-de-lideres',
      status: 'published',
      coverImage: cover.url,
      coverMediaId: cover.id,
      modules: [{
        id: 'module-1',
        title: 'Fundamentos',
        lessons: [{
          id: 'lesson-1',
          title: 'Chamado e propósito',
          pdfUrl: uploaded.url,
          videoUrl: 'https://youtu.be/abcdefghijk',
          quiz: Array.from({ length: 5 }, (_, index) => ({
            id: `question-${index + 1}`,
            question: `Qual é o passo correto número ${index + 1}?`,
            options: [
              { id: 'a', text: 'Reconhecer o chamado' },
              { id: 'b', text: 'Ignorar o chamado' },
              { id: 'c', text: 'Adiar o chamado' },
              { id: 'd', text: 'Delegar o chamado' },
            ],
            correctOptionId: 'a',
          })),
        }],
      }],
    };
    response = await worker.fetch(jsonRequest('/api/admin/courses', 'POST', course), env);
    assert.equal(response.status, 201);
    const created = (await response.json()).course;
    assert.equal(created.version, 1);
    assert.equal(created.revision, 1);

    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      title: 'Tentativa sem revisão',
    }), env);
    assert.equal(response.status, 428);
    assert.equal((await response.json()).error.code, 'revision_required');

    response = await worker.fetch(new Request(`${origin}/api/courses`), env);
    const catalog = await response.json();
    assert.equal(catalog.courses.length, 1);
    assert.equal(catalog.courses[0].title, 'Formação de Líderes');
    const publicLesson = catalog.courses[0].modules[0].lessons[0];
    assert.deepEqual(publicLesson.quiz, []);
    assert.equal(Object.hasOwn(publicLesson, 'pdfUrl'), false);
    assert.equal(Object.hasOwn(publicLesson, 'videoUrl'), false);

    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      revision: 1,
      title: 'Formação de Líderes — Atualizado',
    }), env);
    assert.equal(response.status, 200);
    const updated = (await response.json()).course;
    assert.equal(updated.version, 2);
    assert.equal(updated.revision, 2);

    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      version: 1,
      title: 'Edição antiga',
    }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'version_conflict');

    response = await worker.fetch(new Request(`${origin}/api/admin/courses/${created.id}`, {
      method: 'DELETE', headers: ownerHeaders,
    }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'course_delete_requires_draft');

    const changedIds = structuredClone(updated.modules);
    changedIds[0].lessons[0].id = 'lesson-troca';
    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      revision: 2,
      modules: changedIds,
    }), env);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'immutable_nested_id');

    response = await worker.fetch(new Request(`${origin}/api/admin/export`, { headers: ownerHeaders }), env);
    assert.equal(response.status, 200);
    const backup = await response.json();
    assert.equal(backup.format, 'beta-cursos-admin-export');
    assert.equal(backup.courses.length, 1);
    assert.equal(backup.media.length, 2);

    response = await worker.fetch(new Request(`${origin}/api/admin/media/${uploaded.id}`, {
      method: 'DELETE', headers: ownerHeaders,
    }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'media_in_use');

    response = await worker.fetch(new Request(`${origin}/api/admin/media/${uploaded.id}?force=true`, {
      method: 'DELETE', headers: ownerHeaders,
    }), env);
    assert.equal(response.status, 200);

    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      revision: 2,
      status: 'archived',
    }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).course.revision, 3);

    response = await worker.fetch(new Request(`${origin}/api/courses`), env);
    assert.equal((await response.json()).courses.length, 0);

    response = await worker.fetch(new Request(`${origin}/api/admin/courses/${created.id}`, {
      method: 'DELETE', headers: ownerHeaders,
    }), env);
    assert.equal(response.status, 409);

    response = await worker.fetch(jsonRequest(`/api/admin/courses/${created.id}`, 'PUT', {
      revision: 3,
      status: 'draft',
    }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).course.revision, 4);

    response = await worker.fetch(new Request(`${origin}/api/admin/courses/${created.id}`, {
      method: 'DELETE', headers: ownerHeaders,
    }), env);
    assert.equal(response.status, 200);

    const strangerHeaders = { Origin: origin, 'oai-authenticated-user-email': 'stranger@example.com' };
    response = await worker.fetch(new Request(`${origin}/api/admin/courses`, { headers: strangerHeaders }), env);
    assert.equal(response.status, 403);
  } finally {
    DB.close();
  }
});

test('migra uma biblioteca antiga e passa a aceitar imagens sem perder metadados', async () => {
  const DB = new D1Mock();
  const MEDIA = new R2Mock();
  DB.database.exec(`
    CREATE TABLE media (
      id TEXT PRIMARY KEY NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('pdf', 'video')),
      size INTEGER NOT NULL CHECK (size > 0),
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )
  `);
  DB.database.prepare(
    `INSERT INTO media
     (id, storage_key, filename, content_type, kind, size, sha256, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-media-1', 'pdf/legacy-media-1.pdf', 'legado.pdf', 'application/pdf', 'pdf',
    10, 'abc123', '2026-07-13T10:00:00.000Z', 'pastor@example.com',
  );

  try {
    let response = await worker.fetch(new Request(`${origin}/api/courses`), { DB, MEDIA });
    assert.equal(response.status, 200);
    const schema = DB.database.prepare("SELECT sql FROM sqlite_master WHERE name = 'media'").get().sql;
    assert.match(schema, /'image'/);
    assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM media').get().count, 1);

    response = await worker.fetch(jsonRequest('/api/admin/bootstrap', 'POST'), { DB, MEDIA });
    assert.equal(response.status, 201);
    const form = new FormData();
    form.append('kind', 'image');
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'capa.png', { type: 'image/png' }));
    response = await worker.fetch(new Request(`${origin}/api/admin/media`, {
      method: 'POST', headers: ownerHeaders, body: form,
    }), { DB, MEDIA });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).media.kind, 'image');
  } finally {
    DB.close();
  }
});
