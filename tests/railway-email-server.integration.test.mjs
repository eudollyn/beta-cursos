import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../railway/config.mjs';
import { createBetaServer } from '../railway/server.mjs';

function tokenFromUrl(value) {
  const [, token = ''] = new URL(value).hash.replace(/^#/, '').split('/');
  return decodeURIComponent(token);
}

test('servidor completo liga confirmação e recuperação ao banco migrado', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'beta-cursos-email-server-'));
  const loaded = loadConfig({
    APP_ENV: 'test',
    NODE_ENV: 'test',
    PORT: '3198',
    APP_ORIGIN: 'http://127.0.0.1:3198',
    DATABASE_URL: 'sqlite::memory:',
    STORAGE_DRIVER: 'filesystem',
    LOCAL_STORAGE_PATH: dataRoot,
    SESSION_SECRET: 'integration-session-secret-with-more-than-32-characters',
    COOKIE_SECURE: 'false',
    BOOTSTRAP_OWNER_EMAIL: 'owner@beta.local',
    EMAIL_DRIVER: 'preview',
    EMAIL_VERIFICATION_REQUIRED: 'true',
    PASSWORD_RESET_ENABLED: 'true',
    EMAIL_TOKEN_SECRET: 'integration-email-secret-with-more-than-32-characters',
    ENABLE_DEMO_LOGIN: 'false',
    CHECKOUT_MODE: 'disabled',
  });
  const config = {
    ...loaded,
    port: 0,
    storage: { ...loaded.storage, localPath: dataRoot },
  };
  const messages = [];
  let emailHealthy = true;
  const emailSender = {
    driver: 'test',
    async sendRegistration(message) {
      messages.push(message);
      return { previewUrl: message.confirmUrl };
    },
    async sendPasswordReset(message) {
      messages.push(message);
      return { previewUrl: message.resetUrl };
    },
    async healthcheck() {
      return {
        ok: emailHealthy,
        driver: 'test',
        enabled: true,
        required: true,
        configured: true,
        status: emailHealthy ? 'ready' : 'degraded',
        providerProbe: 'not_performed',
      };
    },
    async close() {},
  };
  const application = await createBetaServer({
    config,
    emailSender,
    seedCatalog: false,
    clientRoot: fileURLToPath(new URL('..', import.meta.url)),
  });
  await application.listen();
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { 'Content-Type': 'application/json', Origin: baseUrl };

  try {
    emailHealthy = false;
    let response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 503);
    let ready = await response.json();
    assert.equal(ready.email.ok, false);
    assert.equal(messages.length, 0, 'readiness degradado não pode disparar e-mail de teste');

    emailHealthy = true;
    response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    ready = await response.json();
    assert.equal(ready.email.required, true);
    assert.equal(ready.email.providerProbe, 'not_performed');
    assert.equal(messages.length, 0, 'readiness não pode disparar e-mail de teste');

    response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'owner@beta.local' }),
    });
    assert.equal(response.status, 202);
    const registration = await response.json();
    assert.ok(registration.previewUrl);
    assert.equal(messages.length, 1);

    response = await fetch(`${baseUrl}/api/auth/complete-registration`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        token: tokenFromUrl(registration.previewUrl),
        name: 'Responsável Beta',
        birthDate: '1990-01-01',
        password: 'senha-inicial-segura',
      }),
    });
    assert.equal(response.status, 201);
    const owner = await response.json();
    assert.equal(owner.user.role, 'owner');
    assert.equal(owner.user.emailVerified, true);
    const originalCookie = String(response.headers.get('set-cookie') || '').split(';')[0];

    response = await fetch(`${baseUrl}/api/auth/password/forgot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'owner@beta.local' }),
    });
    assert.equal(response.status, 202);
    const recovery = await response.json();
    assert.ok(recovery.previewUrl);

    response = await fetch(`${baseUrl}/api/auth/password/reset`, {
      method: 'POST',
      headers: { ...headers, Cookie: originalCookie },
      body: JSON.stringify({
        token: tokenFromUrl(recovery.previewUrl),
        password: 'senha-substituta-segura',
      }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: originalCookie },
    });
    assert.equal(response.status, 401, 'a sessão anterior deve ser revogada após a troca');
  } finally {
    await application.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
