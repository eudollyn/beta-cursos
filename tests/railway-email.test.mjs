import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEmailSender, EmailDeliveryError } from '../railway/email.mjs';

const baseMessage = {
  to: 'aluno@example.com',
  confirmUrl: 'http://127.0.0.1:3000/#complete-registration/token_seguro_12345678901234567890123456789012',
  resetUrl: 'http://127.0.0.1:3000/#reset-password/token_seguro_12345678901234567890123456789012',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  idempotencyKey: 'email-test-1',
};

test('driver preview devolve o link somente para o ambiente local', async () => {
  const events = [];
  const sender = createEmailSender({ driver: 'preview' }, {
    logger: { info: event => events.push(event) },
  });
  const result = await sender.sendRegistration(baseMessage);
  assert.equal(result.previewUrl, baseMessage.confirmUrl);
  assert.deepEqual(events[0], {
    event: 'email_preview_created',
    driver: 'preview',
    type: 'complete_registration',
  });
  assert.doesNotMatch(JSON.stringify(events), /aluno@example\.com|token_seguro/);
});

test('driver Resend envia payload HTML e texto com autenticação e idempotência', async () => {
  const calls = [];
  const sender = createEmailSender({
    driver: 'resend',
    from: 'Beta Cursos <cursos@beta.example>',
    replyTo: 'contato@beta.example',
    resendApiKey: 're_test_secret',
    timeoutMs: 2_000,
  }, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'email_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const result = await sender.sendPasswordReset({ ...baseMessage, name: '<Pastor>' });
  assert.equal(result.id, 'email_123');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_secret');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'email-test-1');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.from, 'Beta Cursos <cursos@beta.example>');
  assert.deepEqual(body.to, ['aluno@example.com']);
  assert.equal(body.reply_to, 'contato@beta.example');
  assert.match(body.html, /&lt;Pastor&gt;/);
  assert.match(body.text, /sessões antigas serão encerradas/);
  const health = await sender.healthcheck();
  assert.equal(health.status, 'ready');
  assert.equal(health.delivery.attempts, 1);
  assert.equal(health.delivery.successes, 1);
});

test('driver Resend normaliza falhas sem expor a resposta do provedor', async () => {
  const events = [];
  let providerCalls = 0;
  const sender = createEmailSender({
    driver: 'resend',
    from: 'Beta Cursos <cursos@beta.example>',
    resendApiKey: 're_test_secret',
    required: true,
  }, {
    fetchImpl: async () => {
      providerCalls += 1;
      return providerCalls === 1
        ? new Response('credencial secreta inválida', { status: 403 })
        : new Response(JSON.stringify({ id: 'email_recovered' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
    },
    logger: { error: event => events.push(event) },
  });
  await assert.rejects(
    sender.sendRegistration(baseMessage),
    error => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /credencial secreta/);
      return true;
    },
  );
  const health = await sender.healthcheck();
  assert.equal(health.ok, false, 'falha real deve reprovar e-mail obrigatório no readiness');
  assert.equal(health.status, 'degraded');
  assert.equal(health.delivery.failures, 1);
  assert.equal(health.delivery.lastFailureCode, 'email_provider_rejected');
  assert.equal(health.delivery.lastProviderStatus, 403);
  assert.deepEqual(events[0], {
    event: 'email_delivery_failed',
    driver: 'resend',
    type: 'complete_registration',
    code: 'email_provider_rejected',
    providerStatus: 403,
  });
  assert.doesNotMatch(JSON.stringify(events), /re_test_secret|aluno@example\.com|token_seguro|credencial secreta/);

  await sender.sendRegistration({ ...baseMessage, idempotencyKey: 'email-test-recovery' });
  const recoveredHealth = await sender.healthcheck();
  assert.equal(recoveredHealth.ok, true);
  assert.equal(recoveredHealth.status, 'ready');
  assert.equal(recoveredHealth.delivery.consecutiveFailures, 0);
});

test('driver desativado falha fechado', async () => {
  const sender = createEmailSender({ driver: 'disabled' }, { logger: { error() {} } });
  await assert.rejects(sender.sendRegistration(baseMessage), /envio de e-mail está desativado/);
});

test('healthcheck valida somente a configuração e nunca chama o provedor', async () => {
  let providerCalls = 0;
  const sender = createEmailSender({
    driver: 'resend',
    from: 'Beta Cursos <cursos@beta.example>',
    resendApiKey: 're_healthcheck_secret',
    required: true,
  }, {
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error('o healthcheck não deveria chegar aqui');
    },
  });

  const health = await sender.healthcheck();

  assert.equal(providerCalls, 0);
  assert.deepEqual({
    ok: health.ok,
    driver: health.driver,
    required: health.required,
    configured: health.configured,
    status: health.status,
    providerProbe: health.providerProbe,
  }, {
    ok: true,
    driver: 'resend',
    required: true,
    configured: true,
    status: 'ready',
    providerProbe: 'not_performed',
  });
  assert.doesNotMatch(JSON.stringify(health), /re_healthcheck_secret|cursos@beta\.example/);
});

test('healthcheck reprova driver desativado quando o envio é obrigatório', async () => {
  const sender = createEmailSender({ driver: 'disabled', required: true });
  const health = await sender.healthcheck();
  assert.equal(health.ok, false);
  assert.equal(health.status, 'misconfigured');
});
