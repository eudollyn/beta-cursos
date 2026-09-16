import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import worker, { __test as workerTest } from '../worker.mjs';

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

class MediaMock {
  constructor() {
    this.putCalls = 0;
  }

  async put() {
    this.putCalls += 1;
  }

  async get() {
    return null;
  }

  async head() {
    return null;
  }

  async delete() {}
}

const origin = 'https://beta-upload.example';
const ownerHeaders = {
  Origin: origin,
  'oai-authenticated-user-email': 'owner@example.com',
  'oai-authenticated-user-full-name': 'Owner',
};
const uploads = {
  pdfMaxBytes: 64,
  imageMaxBytes: 64,
  videoMaxBytes: 64,
};

function streamFromChunks(chunks, onCancel) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      onCancel?.();
    },
  });
}

function uploadRequest({ body, contentType, contentLength }) {
  const headers = new Headers(ownerHeaders);
  headers.set('Content-Type', contentType);
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  return new Request(`${origin}/api/admin/media`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  });
}

async function validMultipart() {
  const form = new FormData();
  form.append('kind', 'pdf');
  form.append('file', new File(
    [new TextEncoder().encode('%PDF-1.7\n')],
    'apostila.pdf',
    { type: 'application/pdf' },
  ));
  const encoded = new Request('https://multipart.example', {
    method: 'POST',
    body: form,
  });
  return {
    bytes: new Uint8Array(await encoded.arrayBuffer()),
    contentType: encoded.headers.get('Content-Type'),
  };
}

async function withAdmin(callback) {
  const DB = new D1Mock();
  const MEDIA = new MediaMock();
  const env = { DB, MEDIA, UPLOADS: uploads };
  try {
    const bootstrap = await worker.fetch(new Request(`${origin}/api/admin/bootstrap`, {
      method: 'POST',
      headers: ownerHeaders,
    }), env);
    assert.equal(bootstrap.status, 201);
    await callback({ env, MEDIA });
  } finally {
    DB.close();
  }
}

test('worker schema bootstrap preserves a newer schema version', async () => {
  const DB = new D1Mock();
  try {
    DB.database.exec(`CREATE TABLE app_meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    DB.database.prepare(`INSERT INTO app_meta (key, value) VALUES ('schema_version', '6')`).run();

    await workerTest.ensureSchema({ DB });

    const row = DB.database.prepare(
      `SELECT value FROM app_meta WHERE key = 'schema_version'`,
    ).get();
    assert.equal(row.value, '6');
  } finally {
    DB.close();
  }
});

test('upload multipart sem Content-Length é aceito quando o stream está dentro do limite', async () => {
  await withAdmin(async ({ env, MEDIA }) => {
    const multipart = await validMultipart();
    const request = uploadRequest({
      body: streamFromChunks([
        multipart.bytes.subarray(0, 100),
        multipart.bytes.subarray(100),
      ]),
      contentType: multipart.contentType,
    });
    assert.equal(request.headers.has('Content-Length'), false);

    const response = await worker.fetch(request, env);
    assert.equal(response.status, 201);
    assert.equal(MEDIA.putCalls, 1);
  });
});

test('upload rejeita Content-Length malformado antes do parser multipart', async () => {
  await withAdmin(async ({ env, MEDIA }) => {
    const multipart = await validMultipart();
    const response = await worker.fetch(uploadRequest({
      body: streamFromChunks([multipart.bytes]),
      contentType: multipart.contentType,
      contentLength: '12x',
    }), env);

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_content_length');
    assert.equal(MEDIA.putCalls, 0);
  });
});

test('upload rejeita Content-Length declarado acima do limite', async () => {
  await withAdmin(async ({ env, MEDIA }) => {
    const multipart = await validMultipart();
    const maximum = workerTest.maximumMediaRequestBytes(env);
    const response = await worker.fetch(uploadRequest({
      body: streamFromChunks([multipart.bytes]),
      contentType: multipart.contentType,
      contentLength: maximum + 1,
    }), env);

    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'media_too_large');
    assert.equal(MEDIA.putCalls, 0);
  });
});

test('upload chunked é interrompido quando o corpo real ultrapassa o limite', async () => {
  await withAdmin(async ({ env, MEDIA }) => {
    const maximum = workerTest.maximumMediaRequestBytes(env);
    const response = await worker.fetch(uploadRequest({
      body: streamFromChunks([new Uint8Array(maximum), new Uint8Array(1)]),
      contentType: 'multipart/form-data; boundary=body-limit-test',
    }), env);

    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'media_too_large');
    assert.equal(MEDIA.putCalls, 0);
  });
});
