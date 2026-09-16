import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigurationError, loadConfig } from '../railway/config.mjs';

test('ambiente hospedado separa o segredo dos links do segredo de sessao', () => {
  const env = hostedEnvironment('production');
  assert.throws(
    () => loadConfig({
      ...env,
      EMAIL_TOKEN_SECRET: env.SESSION_SECRET,
    }),
    /EMAIL_TOKEN_SECRET deve ser diferente de SESSION_SECRET/,
  );
});

test('configuração local inicia com SQLite, filesystem e checkout desabilitado', () => {
  const config = loadConfig({
    APP_ENV: 'local',
    PORT: '3000',
  }, { cwd: process.cwd() });
  assert.equal(config.databaseUrl, 'sqlite:.data/beta-cursos.sqlite');
  assert.equal(config.storage.driver, 'filesystem');
  assert.equal(config.features.demoAccess, true);
  assert.equal(config.features.demoRole, 'admin');
  assert.equal(config.features.registration, true);
  assert.equal(config.features.paymentsMode, 'disabled');
  assert.equal(config.features.emailVerificationRequired, false);
  assert.equal(config.features.passwordReset, true);
  assert.equal(config.email.driver, 'preview');
  assert.equal(config.session.cookieSecure, false);
  assert.equal(config.authRateLimitMax, 10);
  assert.equal(config.authRateLimitIpMax, 30);
  assert.equal(config.authRateLimitWindowMs, 900_000);
});

test('Railway recusa inicialização sem origem, banco, owner, segredo e bucket', () => {
  assert.throws(
    () => loadConfig({
      RAILWAY_PROJECT_ID: 'project',
      RAILWAY_ENVIRONMENT_NAME: 'staging',
    }),
    error => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /APP_ORIGIN/);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /SESSION_SECRET/);
      assert.match(error.message, /BOOTSTRAP_OWNER_EMAIL/);
      assert.match(error.message, /BUCKET/);
      return true;
    },
  );
});

function hostedEnvironment(name) {
  return {
    RAILWAY_PROJECT_ID: 'project',
    RAILWAY_ENVIRONMENT_NAME: name,
    APP_ORIGIN: `https://${name}.beta.example`,
    DATABASE_URL: 'postgresql://beta:secret@postgres.railway.internal:5432/railway',
    SESSION_SECRET: 'segredo-de-homologacao-com-mais-de-32-caracteres',
    BOOTSTRAP_OWNER_EMAIL: 'owner@beta.example',
    BOOTSTRAP_ADMIN_EMAILS: 'pastor@beta.example, secretaria@beta.example',
    STORAGE_DRIVER: 's3',
    BUCKET: 'beta-media-abc123',
    ENDPOINT: 'https://storage.railway.app',
    REGION: 'auto',
    ACCESS_KEY_ID: 'access-key',
    SECRET_ACCESS_KEY: 'secret-key',
    EMAIL_DRIVER: 'resend',
    EMAIL_FROM: 'Beta Cursos <cursos@beta.example>',
    EMAIL_TOKEN_SECRET: 'segredo-exclusivo-de-email-com-mais-de-32-caracteres',
    RESEND_API_KEY: 're_test_123456789',
  };
}

test('staging Railway usa PostgreSQL, bucket privado e cookies seguros', () => {
  const config = loadConfig(hostedEnvironment('staging'));
  assert.equal(config.appEnv, 'staging');
  assert.equal(config.storage.driver, 's3');
  assert.equal(config.storage.bucket, 'beta-media-abc123');
  assert.equal(config.storage.forcePathStyle, false);
  assert.equal(config.session.cookieName, '__Host-beta_session');
  assert.equal(config.session.cookieSecure, true);
  assert.equal(config.features.demoAccess, false);
  assert.equal(config.features.demoRole, 'student');
  assert.equal(config.features.paymentsMode, 'disabled');
  assert.equal(config.features.emailVerificationRequired, true);
  assert.equal(config.features.passwordReset, true);
  assert.equal(config.email.driver, 'resend');
  assert.equal(config.bootstrap.ownerEmail, 'owner@beta.example');
  assert.deepEqual(config.bootstrap.adminEmails, ['pastor@beta.example', 'secretaria@beta.example']);
});


test('configuração rejeita e-mails administrativos inválidos ou repetidos com o owner', () => {
  assert.throws(
    () => loadConfig({
      ...hostedEnvironment('staging'),
      BOOTSTRAP_ADMIN_EMAILS: 'email-invalido',
    }),
    /BOOTSTRAP_ADMIN_EMAILS\[0\]/,
  );
  assert.throws(
    () => loadConfig({
      ...hostedEnvironment('staging'),
      BOOTSTRAP_ADMIN_EMAILS: 'owner@beta.example',
    }),
    /não deve repetir BOOTSTRAP_OWNER_EMAIL/,
  );
});

test('ambiente hospedado recusa conta demo administrativa', () => {
  assert.throws(
    () => loadConfig({
      ...hostedEnvironment('staging'),
      ENABLE_DEMO_LOGIN: 'true',
      DEMO_ROLE: 'admin',
    }),
    /DEMO_ROLE deve ser student/,
  );
});

test('produção mantém checkout desabilitado por padrão', () => {
  const config = loadConfig(hostedEnvironment('production'));
  assert.equal(config.isProduction, true);
  assert.equal(config.features.demoAccess, false);
  assert.equal(config.features.demoRole, 'student');
  assert.equal(config.features.paymentsMode, 'disabled');
});

test('ambiente hospedado não permite cadastro sem confirmação real de e-mail', () => {
  assert.throws(
    () => loadConfig({
      ...hostedEnvironment('production'),
      EMAIL_VERIFICATION_REQUIRED: 'false',
      PASSWORD_RESET_ENABLED: 'false',
    }),
    /cadastro aberto exigem EMAIL_VERIFICATION_REQUIRED=true/,
  );
  assert.throws(
    () => loadConfig({
      ...hostedEnvironment('production'),
      EMAIL_DRIVER: 'preview',
      RESEND_API_KEY: '',
    }),
    /EMAIL_DRIVER=preview só pode ser usado localmente/,
  );
});
