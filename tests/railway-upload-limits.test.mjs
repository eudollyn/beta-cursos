import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../railway/config.mjs';
import { createBetaServer } from '../railway/server.mjs';
import { __test as workerTest } from '../worker.mjs';

const MEBIBYTE = 1024 * 1024;

class CapacityMediaStore {
  constructor() {
    this.driver = 'capacity-test';
    this.putCalls = 0;
  }

  async put() {
    this.putCalls += 1;
    const error = new Error('Bucket capacity reached');
    error.code = 'STORAGE_CAPACITY_EXCEEDED';
    throw error;
  }

  async get() {
    return null;
  }

  async head() {
    return null;
  }

  async delete() {}

  async healthcheck() {
    return { ok: true, driver: this.driver };
  }

  async close() {}
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function responsePayload(response) {
  return response.json();
}

test('Railway aplica limites configurados e traduz capacidade esgotada do Bucket', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'beta-cursos-upload-limits-'));
  const media = new CapacityMediaStore();
  const baseConfig = loadConfig({
    APP_ENV: 'test',
    NODE_ENV: 'test',
    PORT: '3197',
    APP_ORIGIN: 'http://127.0.0.1:3197',
    DATABASE_URL: 'sqlite::memory:',
    STORAGE_DRIVER: 'filesystem',
    LOCAL_STORAGE_PATH: dataRoot,
    SESSION_SECRET: 'upload-limit-test-secret-with-more-than-32-characters',
    COOKIE_SECURE: 'false',
    BOOTSTRAP_OWNER_EMAIL: 'owner@beta.local',
    ENABLE_DEMO_LOGIN: 'false',
    CHECKOUT_MODE: 'disabled',
  });
  const config = {
    ...baseConfig,
    port: 0,
    uploads: {
      pdfMaxBytes: MEBIBYTE,
      imageMaxBytes: MEBIBYTE,
      videoMaxBytes: MEBIBYTE,
    },
  };
  const application = await createBetaServer({
    config,
    media,
    clientRoot: fileURLToPath(new URL('..', import.meta.url)),
  });
  await application.listen();
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    let response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: baseUrl,
      },
      body: JSON.stringify({
        name: 'Responsável Beta',
        email: 'owner@beta.local',
        birthDate: '1990-01-01',
        password: 'senha-segura-123',
      }),
    });
    assert.equal(response.status, 201);
    const cookie = cookieFrom(response);

    response = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: baseUrl },
    });
    assert.equal(response.status, 201);

    const configuredLimits = workerTest.mediaUploadLimits({ UPLOADS: config.uploads });
    assert.deepEqual(configuredLimits, {
      pdf: MEBIBYTE,
      image: MEBIBYTE,
      video: MEBIBYTE,
    });
    assert.equal(workerTest.maximumMediaRequestBytes({ UPLOADS: config.uploads }), 3 * MEBIBYTE);

    const oversizedForm = new FormData();
    oversizedForm.append('kind', 'pdf');
    oversizedForm.append('file', new File(
      [new Uint8Array(MEBIBYTE + 1)],
      'apostila-grande.pdf',
      { type: 'application/pdf' },
    ));
    response = await fetch(`${baseUrl}/api/admin/media`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: baseUrl },
      body: oversizedForm,
    });
    assert.equal(response.status, 413);
    assert.equal((await responsePayload(response)).error.code, 'media_too_large');
    assert.equal(media.putCalls, 0);

    const validForm = new FormData();
    validForm.append('kind', 'pdf');
    validForm.append('file', new File(
      [new TextEncoder().encode('%PDF-1.7\nconteúdo')],
      'apostila.pdf',
      { type: 'application/pdf' },
    ));
    response = await fetch(`${baseUrl}/api/admin/media`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: baseUrl },
      body: validForm,
    });
    const capacityPayload = await responsePayload(response);
    assert.equal(response.status, 507);
    assert.equal(capacityPayload.error.code, 'storage_capacity_exceeded');
    assert.match(capacityPayload.error.message, /capacidade disponível/i);
    assert.equal(media.putCalls, 1);
  } finally {
    await application.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
