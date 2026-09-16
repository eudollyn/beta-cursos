import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { handleApplicationApi } from '../railway/application-api.mjs';
import { hashOpaqueToken } from '../railway/auth-crypto.mjs';
import { close, createDatabase } from '../railway/db.mjs';

const origin = 'https://auth-token.test';
const databases = [];
const config = Object.freeze({
  appOrigin: origin,
  isHosted: false,
  secureCookies: true,
  scryptCost: 1_024,
  authRateLimitMax: 50,
  authRateLimitIpMax: 100,
  registrationEnabled: true,
  emailVerificationRequired: true,
  passwordResetEnabled: true,
  emailTokenSecret: 'auth-token-delivery-test-secret-over-32-characters',
  registrationTokenTtlSeconds: 86_400,
  passwordResetTtlSeconds: 1_800,
});

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => close(database)));
});

async function database() {
  const DB = await createDatabase({
    driver: 'sqlite',
    databaseUrl: 'sqlite::memory:',
  });
  databases.push(DB);
  return DB;
}

function request(path, body, ip) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'X-Forwarded-For': ip,
    },
    body: JSON.stringify(body),
  });
}

function actionToken(url) {
  const [, token = ''] = new URL(url).hash.replace(/^#/, '').split('/');
  return decodeURIComponent(token);
}

function sender(messages, state = {}) {
  return {
    async sendRegistration(message) {
      messages.push(message);
      if (state.fail) throw new Error('provider unavailable');
      return { id: `registration-${messages.length}`, previewUrl: message.confirmUrl };
    },
    async sendPasswordReset(message) {
      messages.push(message);
      if (state.fail) throw new Error('provider unavailable');
      return { id: `password-${messages.length}`, previewUrl: message.resetUrl };
    },
  };
}

test('falha no reenvio conserva o token de cadastro anterior', async () => {
  const DB = await database();
  const messages = [];
  const state = { fail: false };
  const emailSender = sender(messages, state);

  let response = await handleApplicationApi(request(
    '/api/auth/register',
    { email: 'preservado@example.com' },
    '203.0.113.101',
  ), { DB, config, emailSender });
  assert.equal(response.status, 202);
  const firstToken = actionToken(messages.at(-1).confirmUrl);
  const before = await DB.prepare(`SELECT token_hash
    FROM app_auth_tokens
    WHERE email = ? AND purpose = 'complete_registration' AND consumed_at IS NULL`)
    .bind('preservado@example.com')
    .first();
  assert.ok(before?.token_hash);

  state.fail = true;
  response = await handleApplicationApi(request(
    '/api/auth/email/resend',
    { email: 'preservado@example.com' },
    '203.0.113.102',
  ), { DB, config, emailSender });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).previewUrl, undefined);
  const after = await DB.prepare(`SELECT token_hash
    FROM app_auth_tokens
    WHERE email = ? AND purpose = 'complete_registration' AND consumed_at IS NULL`)
    .bind('preservado@example.com')
    .first();
  assert.equal(after.token_hash, before.token_hash);

  response = await handleApplicationApi(request(
    '/api/auth/complete-registration',
    {
      token: firstToken,
      name: 'Conta Preservada',
      birthDate: '1990-01-01',
      password: 'senha-segura-123',
      passwordConfirmation: 'senha-segura-123',
    },
    '203.0.113.103',
  ), { DB, config, emailSender });
  assert.equal(response.status, 201, 'o link anterior deve continuar utilizável');
});

test('falha no novo envio conserva o token anterior de recuperação de senha', async () => {
  const DB = await database();
  const messages = [];
  const state = { fail: false };
  const emailSender = sender(messages, state);

  await handleApplicationApi(request(
    '/api/auth/register',
    { email: 'recuperacao@example.com' },
    '203.0.113.121',
  ), { DB, config, emailSender });
  const registrationToken = actionToken(messages.at(-1).confirmUrl);
  let response = await handleApplicationApi(request(
    '/api/auth/complete-registration',
    {
      token: registrationToken,
      name: 'Conta Recuperação',
      birthDate: '1990-01-01',
      password: 'senha-antiga-123',
      passwordConfirmation: 'senha-antiga-123',
    },
    '203.0.113.122',
  ), { DB, config, emailSender });
  assert.equal(response.status, 201);

  response = await handleApplicationApi(request(
    '/api/auth/password/forgot',
    { email: 'recuperacao@example.com' },
    '203.0.113.123',
  ), { DB, config, emailSender });
  assert.equal(response.status, 202);
  const resetToken = actionToken(messages.at(-1).resetUrl);
  const before = await DB.prepare(`SELECT token_hash
    FROM app_auth_tokens
    WHERE email = ? AND purpose = 'reset_password' AND consumed_at IS NULL`)
    .bind('recuperacao@example.com')
    .first();

  state.fail = true;
  response = await handleApplicationApi(request(
    '/api/auth/password/forgot',
    { email: 'recuperacao@example.com' },
    '203.0.113.124',
  ), { DB, config, emailSender });
  assert.equal(response.status, 202);
  const after = await DB.prepare(`SELECT token_hash
    FROM app_auth_tokens
    WHERE email = ? AND purpose = 'reset_password' AND consumed_at IS NULL`)
    .bind('recuperacao@example.com')
    .first();
  assert.equal(after.token_hash, before.token_hash);

  response = await handleApplicationApi(request(
    '/api/auth/password/reset',
    {
      token: resetToken,
      password: 'senha-nova-segura-123',
      passwordConfirmation: 'senha-nova-segura-123',
    },
    '203.0.113.125',
  ), { DB, config, emailSender });
  assert.equal(response.status, 200, 'o link anterior de recuperação deve continuar utilizável');
});

test('emissões SQLite concorrentes deixam somente um token ativo', async () => {
  const DB = await database();
  const messages = [];
  let calls = 0;
  let release;
  const bothEmailsStarted = new Promise(resolve => { release = resolve; });
  const emailSender = {
    async sendRegistration(message) {
      messages.push(message);
      calls += 1;
      if (calls === 2) release();
      await bothEmailsStarted;
      return { id: `concurrent-${calls}`, previewUrl: message.confirmUrl };
    },
  };

  const responses = await Promise.all([
    handleApplicationApi(request(
      '/api/auth/register',
      { email: 'concorrente@example.com' },
      '203.0.113.111',
    ), { DB, config, emailSender }),
    handleApplicationApi(request(
      '/api/auth/email/resend',
      { email: 'concorrente@example.com' },
      '203.0.113.112',
    ), { DB, config, emailSender }),
  ]);
  assert.deepEqual(responses.map(response => response.status), [202, 202]);
  assert.equal(messages.length, 2);

  const active = (await DB.prepare(`SELECT token_hash
    FROM app_auth_tokens
    WHERE email = ? AND purpose = 'complete_registration' AND consumed_at IS NULL`)
    .bind('concorrente@example.com')
    .all()).results;
  assert.equal(active.length, 1);
  const issuedHashes = messages.map(message => hashOpaqueToken(
    `complete_registration:${actionToken(message.confirmUrl)}`,
    config.emailTokenSecret,
  ));
  assert.ok(issuedHashes.includes(active[0].token_hash));

  const index = await DB.prepare(`SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'app_auth_tokens_active_email_purpose_idx'`).first();
  assert.match(index.sql, /UNIQUE INDEX/i);
  assert.match(index.sql, /WHERE consumed_at IS NULL/i);
});

test('PostgreSQL combina lock transacional e índice parcial único', async () => {
  const [applicationSource, migration] = await Promise.all([
    readFile(new URL('../railway/application-api.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../railway/migrations/postgres/004_auth_token_uniqueness.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(applicationSource, /pg_advisory_xact_lock\s*\(/i);
  assert.match(applicationSource, /beta-auth-token:\$\{issued\.purpose\}:\$\{issued\.email\}/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS app_auth_tokens_active_email_purpose_idx/i);
  assert.match(migration, /ON app_auth_tokens \(lower\(email\), purpose\)[\s\S]*WHERE consumed_at IS NULL/i);
});
