import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { ConfigurationError, loadConfig } from '../railway/config.mjs';

function freeVolumeEnvironment(overrides = {}) {
  return {
    RAILWAY_PROJECT_ID: 'project',
    RAILWAY_ENVIRONMENT_NAME: 'production',
    RAILWAY_VOLUME_MOUNT_PATH: resolve('.test-railway-volume'),
    RAILWAY_FREE_VOLUME_MODE: 'true',
    APP_ENV: 'staging',
    APP_ORIGIN: 'https://beta-cursos-testes.up.railway.app',
    SESSION_SECRET: 'segredo-gratuito-com-mais-de-trinta-e-dois-caracteres',
    BOOTSTRAP_OWNER_EMAIL: 'owner@beta.example',
    DEMO_ROLE: 'student',
    EMAIL_DRIVER: 'resend',
    EMAIL_FROM: 'Beta Cursos <cursos@beta.example>',
    EMAIL_TOKEN_SECRET: 'segredo-exclusivo-de-email-com-mais-de-32-caracteres',
    RESEND_API_KEY: 're_test_123456789',
    ...overrides,
  };
}

test('modo gratuito usa SQLite e filesystem somente dentro do volume Railway', () => {
  const volume = resolve('.test-railway-volume');
  const config = loadConfig(freeVolumeEnvironment(), { cwd: process.cwd() });

  assert.equal(config.persistence.railwayFreeVolumeMode, true);
  assert.equal(config.persistence.volumeMountPath, volume);
  assert.equal(config.databaseUrl, `sqlite:${resolve(volume, 'db', 'beta-cursos.sqlite')}`);
  assert.equal(config.storage.driver, 'filesystem');
  assert.equal(config.storage.localPath, resolve(volume, 'media'));
  assert.equal(config.storage.maxBytes, 400 * 1024 * 1024);
  assert.equal(config.uploads.pdfMaxBytes, 15 * 1024 * 1024);
  assert.equal(config.uploads.imageMaxBytes, 5 * 1024 * 1024);
  assert.equal(config.uploads.videoMaxBytes, 25 * 1024 * 1024);
});

test('modo gratuito falha fechado quando o volume não está anexado', () => {
  assert.throws(
    () => loadConfig(freeVolumeEnvironment({
      RAILWAY_VOLUME_MOUNT_PATH: '',
    })),
    error => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /volume anexado/);
      return true;
    },
  );
});

test('modo gratuito rejeita banco ou mídia fora do volume', () => {
  assert.throws(
    () => loadConfig(freeVolumeEnvironment({
      DATABASE_URL: `sqlite:${resolve('.outside', 'beta.sqlite')}`,
      LOCAL_STORAGE_PATH: resolve('.outside', 'media'),
    })),
    error => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /DATABASE_URL deve usar o arquivo SQLite/);
      assert.match(error.message, /LOCAL_STORAGE_PATH deve ficar dentro do volume/);
      return true;
    },
  );
});

test('modo gratuito pode usar configuração de produção sem recursos demonstrativos', () => {
  const config = loadConfig(freeVolumeEnvironment({ APP_ENV: 'production' }));
  assert.equal(config.appEnv, 'production');
  assert.equal(config.persistence.railwayFreeVolumeMode, true);
  assert.equal(config.features.demoAccess, false);
  assert.equal(config.features.paymentsMode, 'disabled');
});

test('modo gratuito não permite desativar a cota do volume', () => {
  assert.throws(
    () => loadConfig(freeVolumeEnvironment({ STORAGE_MAX_MB: '0' })),
    /STORAGE_MAX_MB deve ser um número inteiro entre 1 e 10240/,
  );
});
