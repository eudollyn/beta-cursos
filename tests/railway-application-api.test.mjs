import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import {
  handleApplicationApi,
  resolveSession,
} from '../railway/application-api.mjs';

class D1StatementMock {
  constructor(database, sql, beforeRun) {
    this.database = database;
    this.sql = sql;
    this.beforeRun = beforeRun;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  statement() {
    return this.database.prepare(this.sql);
  }

  async run() {
    if (this.beforeRun) await this.beforeRun(this.sql, this.values);
    const result = this.statement().run(...this.values);
    return { success: true, meta: { changes: Number(result.changes || 0) } };
  }

  async all() {
    return { success: true, results: this.statement().all(...this.values) };
  }

  async first() {
    return this.statement().get(...this.values) || null;
  }

  async executeForBatch() {
    return /^\s*SELECT\b/i.test(this.sql) ? this.all() : this.run();
  }
}

class D1Mock {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.beforeRun = null;
    this.inTransaction = false;
    this.transactionCalls = 0;
  }

  prepare(sql) {
    return new D1StatementMock(
      this.database,
      sql,
      (statementSql, values) => this.beforeRun?.(statementSql, values),
    );
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

  async transaction(callback) {
    this.transactionCalls += 1;
    if (this.inTransaction) return callback(this);
    this.database.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = await callback(this);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close() {
    this.database.close();
  }
}

const databases = [];
const origin = 'https://beta.test';
let orderSequence = 100000;
const mockOrders = new Map();
const orderByCheckout = new Map();
let lastCreatedOrderBody = null;

async function mercadoPagoFetch(url, init = {}) {
  const endpoint = new URL(url);
  if (endpoint.pathname === '/v1/orders' && init.method === 'POST') {
    const body = JSON.parse(init.body);
    lastCreatedOrderBody = body;
    const orderId = `ORDTST${String(++orderSequence).padStart(8, '0')}`;
    mockOrders.set(orderId, {
      id: orderId,
      status: 'processed',
      external_reference: body.external_reference,
      total_amount: body.total_amount,
      currency: 'BRL',
      transactions: { payments: [{ id: String(orderSequence) }] },
    });
    orderByCheckout.set(body.external_reference, orderId);
    return Response.json({
      id: orderId,
      checkout_url: `https://sandbox.mercadopago.com/checkout?order_id=${orderId}`,
    });
  }

  const orderMatch = endpoint.pathname.match(/^\/v1\/orders\/(ORD[A-Z0-9]+)$/i);
  if (orderMatch) {
    const order = mockOrders.get(orderMatch[1]);
    return order
      ? Response.json(order)
      : Response.json({ error: 'not_found' }, { status: 404 });
  }

  return Response.json({ error: 'unexpected_request' }, { status: 500 });
}

const baseConfig = {
  checkoutMode: 'test',
  appOrigin: origin,
  secureCookies: true,
  scryptCost: 1_024,
  authRateLimitMax: 50,
  payments: {
    provider: 'mercado_pago',
    mode: 'test',
    accessToken: 'TEST-access-token',
    webhookSecret: 'test-webhook-secret',
    timeoutMs: 1000,
    fetch: mercadoPagoFetch,
  },
};

afterEach(() => {
  while (databases.length) databases.pop().close();
  mockOrders.clear();
  orderByCheckout.clear();
  lastCreatedOrderBody = null;
});

function createDatabase() {
  const DB = new D1Mock();
  databases.push(DB);
  DB.database.exec(`CREATE TABLE admins (
    email TEXT PRIMARY KEY NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  )`);
  DB.database.exec(`CREATE TABLE courses (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`);
  const course = {
    id: 'jornada-lidere',
    status: 'published',
    version: 1,
    revision: 1,
    title: 'Jornada Lidere',
    pricing: {
      fullPrice: 19.90,
      currency: 'BRL',
      paymentMethods: ['pix', 'credit_card', 'boleto'],
    },
    quizConfig: {
      passingScore: 1,
      maxAttempts: 3,
    },
    modules: [{
      id: 'modulo-1',
      order: 1,
      lessons: [
        {
          id: 'licao-1',
          order: 1,
          quiz: [{
            id: 'q1',
            correctOptionId: 'a',
            options: [{ id: 'a' }, { id: 'b' }],
          }],
        },
        {
          id: 'licao-2',
          order: 2,
          quiz: [{
            id: 'q2',
            correctOptionId: 'a',
            options: [{ id: 'a' }, { id: 'b' }],
          }],
        },
      ],
    }],
  };
  DB.database.prepare('INSERT INTO courses (id, status, data_json) VALUES (?, ?, ?)')
    .run(course.id, course.status, JSON.stringify(course));
  return DB;
}

function request(path, {
  method = 'GET',
  body,
  cookie,
  ip = '203.0.113.10',
  headers,
} = {}) {
  const requestHeaders = new Headers({
    'X-Forwarded-For': ip,
    ...(headers || {}),
  });
  if (cookie) requestHeaders.set('Cookie', cookie);
  if (body !== undefined) {
    requestHeaders.set('Content-Type', 'application/json');
    requestHeaders.set('Origin', origin);
  }
  return new Request(`${origin}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

async function payload(response) {
  return response.status === 204 ? null : response.json();
}

async function register(DB, {
  name = 'Maria da Silva',
  email = 'maria@example.com',
  password = 'uma senha longa',
  birthDate = '1990-01-01',
  config = baseConfig,
  ip = '203.0.113.10',
} = {}) {
  const response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    ip,
    body: { name, email, password, birthDate },
  }), { DB, config });
  return { response, body: await payload(response), cookie: cookieFrom(response) };
}

async function checkout(DB, cookie, headers = {}) {
  const checkoutHeaders = {
    'Idempotency-Key': `checkout-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...headers,
  };
  let response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie,
    headers: checkoutHeaders,
    body: {
      courseId: 'jornada-lidere',
      paymentMethod: 'pix',
      userId: 'usuario-forjado',
      role: 'owner',
      amountCents: 1,
    },
  }), { DB, config: baseConfig });
  let body = await payload(response);

  if (body?.checkout?.checkoutUrl && body?.checkout?.id) {
    const orderId = orderByCheckout.get(body.checkout.id);
    response = await handleApplicationApi(request(
      `/api/checkouts/${encodeURIComponent(body.checkout.id)}?order_id=${orderId}`,
      { cookie },
    ), { DB, config: baseConfig });
    body = await payload(response);
  }

  return { response, body };
}

async function notifyMercadoPagoOrder(DB, orderId, requestId) {
  const timestamp = '1700000000';
  const signature = createHmac('sha256', 'test-webhook-secret')
    .update(`id:${String(orderId).toLowerCase()};request-id:${requestId};ts:${timestamp};`)
    .digest('hex');
  return handleApplicationApi(request(
    `/api/webhooks/mercado-pago?data.id=${encodeURIComponent(orderId)}&type=order`,
    {
      method: 'POST',
      headers: {
        'X-Request-Id': requestId,
        'X-Signature': `ts=${timestamp},v1=${signature}`,
      },
      body: { type: 'order', data: { id: orderId } },
    },
  ), { DB, config: baseConfig });
}

test('catálogo público oculta conteúdo e rotas administrativas seguem para o módulo próprio', async () => {
  const DB = createDatabase();
  let response = await handleApplicationApi(request('/api/courses'), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  const catalog = await payload(response);
  const lesson = catalog.courses[0].modules[0].lessons[0];
  assert.deepEqual(lesson.quiz, []);
  assert.equal(Object.hasOwn(lesson, 'correctOptionId'), false);

  response = await handleApplicationApi(request('/api/admin/courses'), { DB, config: baseConfig });
  assert.equal(response, null);
});

test('registro exige 10 caracteres e cria sessão opaca em cookie seguro', async () => {
  const DB = createDatabase();
  let response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Maria da Silva',
      email: 'maria@example.com',
      birthDate: '1990-01-01',
      password: '123456789',
    },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 422);
  assert.equal((await payload(response)).error.code, 'invalid_password');

  const registration = await register(DB);
  assert.equal(registration.response.status, 201);
  assert.deepEqual(registration.body, {
    success: true,
    user: {
      id: registration.body.user.id,
      name: 'Maria da Silva',
      email: 'maria@example.com',
      birthDate: '1990-01-01',
      memberCode: null,
      memberCodeValidated: false,
      role: 'student',
      isDemo: false,
      emailVerified: true,
    },
    features: {
      demoAccess: false,
      registration: true,
      paymentsMode: 'test',
      emailVerificationRequired: false,
      passwordReset: false,
    },
  });
  const setCookie = registration.response.headers.get('set-cookie');
  assert.match(setCookie, /^beta_session=[A-Za-z0-9_-]+;/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Secure/i);

  const storedUser = DB.database.prepare(
    'SELECT password_hash FROM app_users WHERE email = ?',
  ).get('maria@example.com');
  assert.match(storedUser.password_hash, /^scrypt\$/);
  assert.doesNotMatch(storedUser.password_hash, /uma senha longa/);
  const rawToken = registration.cookie.split('=')[1];
  const storedSession = DB.database.prepare('SELECT token_hash FROM app_sessions').get();
  assert.notEqual(storedSession.token_hash, rawToken);

  const session = await resolveSession(request('/api/auth/session', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  assert.equal(session.email, 'maria@example.com');
});

test('cadastro rejeita menor de 16 anos e data de nascimento futura', async () => {
  const DB = createDatabase();
  const today = new Date();
  const underageDate = new Date(Date.UTC(
    today.getUTCFullYear() - 15,
    today.getUTCMonth(),
    today.getUTCDate(),
  )).toISOString().slice(0, 10);

  let response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Pessoa Menor',
      email: 'menor@example.com',
      birthDate: underageDate,
      password: 'senha-segura-123',
    },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 422);
  assert.equal((await payload(response)).error.code, 'minimum_age_required');

  response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Pessoa do Futuro',
      email: 'futuro@example.com',
      birthDate: '2999-01-01',
      password: 'senha-segura-123',
    },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 422);
  assert.equal((await payload(response)).error.code, 'birth_date_in_future');
});

test('login usa mensagem genérica, sessão é restaurada e logout a revoga', async () => {
  const DB = createDatabase();
  const registration = await register(DB);

  let response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    ip: '203.0.113.11',
    body: { email: 'maria@example.com', password: 'senha incorreta' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 401);
  assert.equal((await payload(response)).error.code, 'invalid_credentials');

  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    ip: '203.0.113.12',
    body: { email: 'maria@example.com', password: 'uma senha longa' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  const loginCookie = cookieFrom(response);
  assert.equal((await payload(response)).success, true);

  response = await handleApplicationApi(request('/api/auth/session', {
    cookie: loginCookie,
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  assert.deepEqual(await payload(response), {
    authenticated: true,
    user: {
      id: registration.body.user.id,
      name: 'Maria da Silva',
      email: 'maria@example.com',
      birthDate: '1990-01-01',
      memberCode: null,
      memberCodeValidated: false,
      role: 'student',
      isDemo: false,
      emailVerified: true,
    },
    features: {
      demoAccess: false,
      registration: true,
      paymentsMode: 'test',
      emailVerificationRequired: false,
      passwordReset: false,
    },
  });

  response = await handleApplicationApi(request('/api/auth/logout', {
    method: 'POST',
    cookie: loginCookie,
    body: {},
  }), { DB, config: baseConfig });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/i);

  response = await handleApplicationApi(request('/api/auth/session', {
    cookie: loginCookie,
  }), { DB, config: baseConfig });
  assert.equal(response.status, 401);
  assert.deepEqual(await payload(response), {
    authenticated: false,
    features: {
      demoAccess: false,
      registration: true,
      paymentsMode: 'test',
      emailVerificationRequired: false,
      passwordReset: false,
    },
  });
});

test('limite simples de autenticação bloqueia tentativas repetidas por IP e e-mail', async () => {
  const DB = createDatabase();
  const config = {
    ...baseConfig,
    authRateLimitMax: 2,
    authRateLimitWindowMs: 60_000,
  };
  await register(DB, {
    email: 'limite@example.com',
    config,
    ip: '203.0.113.40',
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await handleApplicationApi(request('/api/auth/login', {
      method: 'POST',
      ip: '203.0.113.41',
      body: { email: 'limite@example.com', password: 'senha incorreta' },
    }), { DB, config });
    assert.equal(response.status, 401);
  }
  const blocked = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    ip: '203.0.113.41',
    body: { email: 'limite@example.com', password: 'senha incorreta' },
  }), { DB, config });
  assert.equal(blocked.status, 429);
  assert.equal((await payload(blocked)).error.code, 'auth_rate_limited');
});

test('limite global por IP impede contornar a protecao alternando enderecos de e-mail', async () => {
  const DB = createDatabase();
  const config = {
    ...baseConfig,
    authRateLimitMax: 50,
    authRateLimitIpMax: 2,
    authRateLimitWindowMs: 60_000,
  };
  const ip = '203.0.113.242';

  for (const index of [1, 2]) {
    const response = await handleApplicationApi(request('/api/auth/register', {
      method: 'POST',
      ip,
      body: {
        name: `Pessoa ${index}`,
        email: `alternado-${index}@example.com`,
        birthDate: '1990-01-01',
        password: 'senha-segura-completa',
      },
    }), { DB, config });
    assert.equal(response.status, 201);
  }

  const blocked = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    ip,
    body: {
      name: 'Pessoa 3',
      email: 'alternado-3@example.com',
      birthDate: '1990-01-01',
      password: 'senha-segura-completa',
    },
  }), { DB, config });
  assert.equal(blocked.status, 429);
  assert.equal((await payload(blocked)).error.code, 'auth_rate_limited');
});

test('conta demo só existe quando habilitada e o servidor determina sua função', async () => {
  const DB = createDatabase();
  let response = await handleApplicationApi(request('/api/auth/demo', {
    method: 'POST',
    body: {},
  }), { DB, config: baseConfig });
  assert.equal(response.status, 404);
  assert.equal((await payload(response)).error.code, 'demo_disabled');

  response = await handleApplicationApi(request('/api/auth/demo', {
    method: 'POST',
    ip: '203.0.113.20',
    body: { role: 'owner', userId: 'forjado' },
  }), {
    DB,
    config: {
      ...baseConfig,
      enableDemoLogin: true,
      demoRole: 'admin',
    },
  });
  assert.equal(response.status, 200);
  const body = await payload(response);
  assert.equal(body.user.role, 'admin');
  assert.notEqual(body.user.id, 'forjado');
  assert.equal(body.user.isDemo, true);

  const cookie = cookieFrom(response);
  response = await handleApplicationApi(request('/api/me/state', { cookie }), {
    DB,
    config: { ...baseConfig, enableDemoLogin: true },
  });
  assert.deepEqual((await payload(response)).enrollments, ['jornada-lidere']);
});

test('checkout de teste usa preço do servidor, é idempotente e cria matrícula real', async () => {
  const DB = createDatabase();
  const registration = await register(DB);
  let response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie: registration.cookie,
    headers: {
      'Idempotency-Key': 'checkout-invalid-coupon-1',
    },
    body: {
      courseId: 'jornada-lidere',
      paymentMethod: 'pix',
      couponCode: 'BETA20',
    },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 422);
  assert.equal((await payload(response)).error.code, 'invalid_coupon');

  const firstCheckout = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-maria-1',
  });
  assert.equal(firstCheckout.response.status, 200);
  assert.equal(firstCheckout.body.success, true);
  assert.equal(firstCheckout.body.status, 'approved');
  assert.equal(firstCheckout.body.testMode, true);
  assert.equal(firstCheckout.body.checkout.amountCents, 1990);
  assert.equal(firstCheckout.body.checkout.currency, 'BRL');
  assert.equal(firstCheckout.body.checkout.paymentMethod, 'pix');
  assert.equal(lastCreatedOrderBody.payer.email, 'test@testuser.com');
  assert.equal(firstCheckout.body.enrollment.courseId, 'jornada-lidere');
  assert.equal(firstCheckout.body.enrollment.status, 'active');

  const repeated = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-maria-1',
  });
  assert.equal(repeated.body.checkout.id, firstCheckout.body.checkout.id);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_checkouts').get().count, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments').get().count, 1);

  DB.database.prepare(
    'DELETE FROM app_progress WHERE user_id = ? AND course_id = ?',
  ).run(registration.body.user.id, 'jornada-lidere');
  DB.database.prepare(
    'DELETE FROM app_enrollments WHERE user_id = ? AND course_id = ?',
  ).run(registration.body.user.id, 'jornada-lidere');
  const repaired = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-maria-1',
  });
  assert.equal(repaired.body.checkout.id, firstCheckout.body.checkout.id);
  assert.equal(repaired.body.enrollment.status, 'active');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_progress').get().count, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments').get().count, 1);

  const stateResponse = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  const state = await payload(stateResponse);
  assert.deepEqual(state.enrollments, ['jornada-lidere']);
  assert.equal(state.progress['jornada-lidere'].lessons['licao-1'].unlocked, true);
  assert.equal(state.progress['jornada-lidere'].lessons['licao-2'].unlocked, false);
});

test('webhook do Mercado Pago valida assinatura e libera a matrícula', async () => {
  const DB = createDatabase();
  const registration = await register(DB, { email: 'webhook@example.com' });

  let response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'checkout-webhook-1' },
    body: {
      courseId: 'jornada-lidere',
      paymentMethod: 'pix',
    },
  }), { DB, config: baseConfig });
  const pending = await payload(response);
  assert.equal(pending.status, 'pending');

  const orderId = orderByCheckout.get(pending.checkout.id);
  const requestId = 'request-webhook-1';
  const timestamp = '1700000000';
  const signature = createHmac('sha256', 'test-webhook-secret')
    .update(`id:${orderId.toLowerCase()};request-id:${requestId};ts:${timestamp};`)
    .digest('hex');

  response = await handleApplicationApi(request(
    `/api/webhooks/mercado-pago?data.id=${orderId}&type=order`,
    {
      method: 'POST',
      headers: {
        'X-Request-Id': requestId,
        'X-Signature': `ts=${timestamp},v1=assinatura-invalida`,
      },
      body: {
        type: 'order',
        data: { id: orderId },
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 401);

  response = await handleApplicationApi(request(
    `/api/webhooks/mercado-pago?data.id=${orderId}&type=order`,
    {
      method: 'POST',
      headers: {
        'X-Request-Id': requestId,
        'X-Signature': `ts=${timestamp},v1=${signature}`,
      },
      body: {
        type: 'order',
        data: { id: orderId },
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);

  const enrollment = DB.database.prepare(
    'SELECT status FROM app_enrollments WHERE user_id = ? AND course_id = ?',
  ).get(registration.body.user.id, 'jornada-lidere');
  assert.equal(enrollment.status, 'active');
});

test('P1-01: estorno e chargeback suspendem só a concessão do checkout e reaprovação restaura acesso', async () => {
  const DB = createDatabase();
  const registration = await register(DB, { email: 'reembolso@example.com' });
  let response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'checkout-reembolso-1' },
    body: { courseId: 'jornada-lidere', paymentMethod: 'pix' },
  }), { DB, config: baseConfig });
  const firstCheckout = await payload(response);
  const firstOrderId = orderByCheckout.get(firstCheckout.checkout.id);
  const firstOrder = mockOrders.get(firstOrderId);

  firstOrder.status = 'processed';
  response = await notifyMercadoPagoOrder(DB, firstOrderId, 'reembolso-approved-1');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'active');

  firstOrder.status = 'refunded';
  response = await notifyMercadoPagoOrder(DB, firstOrderId, 'reembolso-refunded-1');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare('SELECT status FROM app_checkouts WHERE id = ?')
    .get(firstCheckout.checkout.id).status, 'refunded');
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'suspended');
  const refundedGrant = DB.database.prepare(`SELECT status, suspension_reason, suspended_at
    FROM app_enrollment_grants WHERE checkout_id = ?`).get(firstCheckout.checkout.id);
  assert.equal(refundedGrant.status, 'suspended');
  assert.equal(refundedGrant.suspension_reason, 'payment_refunded');
  assert.ok(refundedGrant.suspended_at);

  const suspendedState = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  assert.deepEqual((await payload(suspendedState)).enrollments, []);

  // Webhook retries are harmless and do not create another enrollment/grant.
  response = await notifyMercadoPagoOrder(DB, firstOrderId, 'reembolso-refunded-retry');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments').get().count, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollment_grants').get().count, 1);

  firstOrder.status = 'processed';
  response = await notifyMercadoPagoOrder(DB, firstOrderId, 'reembolso-reapproved-1');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'active');
  assert.equal(DB.database.prepare(`SELECT status, suspension_reason, suspended_at
    FROM app_enrollment_grants WHERE checkout_id = ?`).get(firstCheckout.checkout.id).status, 'active');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollment_grants').get().count, 1);

  firstOrder.status = 'charged_back';
  response = await notifyMercadoPagoOrder(DB, firstOrderId, 'reembolso-chargeback-1');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'suspended');
  assert.equal(DB.database.prepare(`SELECT suspension_reason FROM app_enrollment_grants
    WHERE checkout_id = ?`).get(firstCheckout.checkout.id).suspension_reason, 'payment_charged_back');

  // A second approved payment keeps the course available when the first one is revoked.
  response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'checkout-reembolso-2' },
    body: { courseId: 'jornada-lidere', paymentMethod: 'pix' },
  }), { DB, config: baseConfig });
  const secondCheckout = await payload(response);
  const secondOrderId = orderByCheckout.get(secondCheckout.checkout.id);
  mockOrders.get(secondOrderId).status = 'processed';
  response = await notifyMercadoPagoOrder(DB, secondOrderId, 'reembolso-approved-2');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'active');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollment_grants').get().count, 2);

  // A pastoral/manual grant is also independent from payment lifecycle.
  const timestamp = new Date().toISOString();
  DB.database.prepare(`INSERT INTO app_enrollment_grants
    (id, grant_key, user_id, course_id, source, checkout_id, status,
      suspension_reason, suspended_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'pastoral', NULL, 'active', NULL, NULL, ?, ?)`)
    .run('eng-pastoral-1', `source:pastoral:${registration.body.user.id}:jornada-lidere`,
      registration.body.user.id, 'jornada-lidere', timestamp, timestamp);
  mockOrders.get(secondOrderId).status = 'charged_back';
  response = await notifyMercadoPagoOrder(DB, secondOrderId, 'reembolso-chargeback-2');
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollments
    WHERE user_id = ? AND course_id = ?`).get(
    registration.body.user.id,
    'jornada-lidere',
  ).status, 'active');
  assert.equal(DB.database.prepare(`SELECT status FROM app_enrollment_grants
    WHERE grant_key = ?`).get(
    `source:pastoral:${registration.body.user.id}:jornada-lidere`,
  ).status, 'active');
});

test('checkout reverte checkout e matrícula se a criação do progresso falhar', async () => {
  const DB = createDatabase();
  const registration = await register(DB, { email: 'rollback@example.com' });
  let failurePending = true;
  DB.beforeRun = (sql) => {
    if (failurePending && /^\s*INSERT INTO app_progress\b/i.test(sql)) {
      failurePending = false;
      throw new Error('falha injetada ao criar progresso');
    }
  };

  const result = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-rollback-1',
  });
  assert.equal(result.response.status, 500);
  assert.equal(DB.transactionCalls, 2);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_checkouts').get().count, 1);
  assert.equal(
    DB.database.prepare('SELECT status FROM app_checkouts').get().status,
    'pending',
  );
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments').get().count, 0);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_progress').get().count, 0);
});

test('corrida de chave idempotente retorna o checkout vencedor e repara a matrícula', async () => {
  const DB = createDatabase();
  const registration = await register(DB, { email: 'corrida@example.com' });
  const originalTransaction = DB.transaction;
  DB.transaction = undefined;
  let collisionPending = true;
  DB.beforeRun = (sql, values) => {
    if (collisionPending && /^\s*INSERT INTO app_checkouts\b/i.test(sql)) {
      collisionPending = false;
      DB.database.prepare(sql).run(...values);
      const error = new Error(
        'UNIQUE constraint failed: app_checkouts.user_id, app_checkouts.idempotency_key',
      );
      error.code = 'SQLITE_CONSTRAINT_UNIQUE';
      throw error;
    }
  };

  const result = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-corrida-1',
  });
  DB.transaction = originalTransaction;

  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.enrollment.status, 'active');
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_checkouts').get().count, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments').get().count, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_progress').get().count, 1);
});

test('progresso ordenado ignora identidade do body e o quiz é corrigido somente no servidor', async () => {
  const DB = createDatabase();
  const registration = await register(DB);
  await checkout(DB, registration.cookie);

  let stateResponse = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let state = await payload(stateResponse);
  let progress = state.progress['jornada-lidere'];
  progress.userId = 'outro-usuario';
  progress.lessons['licao-2'] = {
    ...progress.lessons['licao-2'],
    unlocked: true,
    pdfRead: true,
    videoCompleted: true,
    quizAttemptsUsed: 1,
    quizScore: 1,
    quizStatus: 'passed',
    lessonCompleted: true,
  };

  let response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { userId: 'outro-usuario', progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  let result = await payload(response);
  assert.equal(result.progress.lessons['licao-2'].unlocked, false);
  assert.equal(result.progress.lessons['licao-2'].lessonCompleted, false);

  assert.equal(result.progress.lessons['licao-1'].pdfRead, true);
  assert.equal(result.progress.lessons['licao-1'].videoCompleted, true);
  assert.equal(result.progress.lessons['licao-1'].quizStatus, 'available');

  progress = structuredClone(result.progress);
  Object.assign(progress.lessons['licao-1'], {
    quizAttemptsUsed: 1,
    quizScore: 1,
    quizStatus: 'passed',
    lessonCompleted: true,
  });
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 409);
  result = await payload(response);
  assert.equal(result.error.code, 'quiz_submission_required');

  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-maria-licao-1-attempt-1' },
    body: { answers: { q1: 'a' } },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  result = await payload(response);
  assert.equal(result.score, 1);
  assert.equal(result.passed, true);
  assert.equal(result.attemptsUsed, 1);
  assert.equal(result.results.q1.correctOptionId, 'a');
  assert.equal(result.progress.lessons['licao-1'].lessonCompleted, true);
  assert.equal(result.progress.lessons['licao-2'].unlocked, true);

  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-maria-licao-1-attempt-1' },
    body: { answers: { q1: 'b' } },
  }), { DB, config: baseConfig });
  result = await payload(response);
  assert.equal(result.idempotent, true);
  assert.equal(result.score, 1);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_quiz_attempts').get().count, 1);
});

test('lição sem PDF, vídeo ou teste pode ser concluída e desbloqueia a próxima', async () => {
  const DB = createDatabase();
  const row = DB.database.prepare('SELECT data_json FROM courses WHERE id = ?').get('jornada-lidere');
  const course = JSON.parse(row.data_json);
  course.modules[0].lessons.forEach(lesson => { lesson.quiz = []; });
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(course), 'jornada-lidere');

  const registration = await register(DB);
  const enrollmentResult = await checkout(DB, registration.cookie);
  assert.equal(enrollmentResult.response.status, 200);
  assert.equal(enrollmentResult.body?.enrollment?.status, 'active');
  let response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let result = await payload(response);
  let progress = result.progress['jornada-lidere'];
  assert.equal(progress.lessons['licao-1'].pdfRead, true);
  assert.equal(progress.lessons['licao-1'].videoCompleted, true);
  assert.equal(progress.lessons['licao-1'].quizStatus, 'passed');
  assert.equal(progress.lessons['licao-1'].lessonCompleted, false);

  progress.lessons['licao-1'].lessonCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  result = await payload(response);
  assert.equal(result.progress.lessons['licao-1'].lessonCompleted, true);
  assert.equal(result.progress.lessons['licao-2'].unlocked, true);
});

test('tentativa reprovada não revela o gabarito e nova tentativa pode concluir a lição', async () => {
  const DB = createDatabase();
  const registration = await register(DB, {
    email: 'quiz@example.com',
    ip: '203.0.113.44',
  });
  await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-quiz-student-1',
  });

  let response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].pdfRead = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  progress = (await payload(response)).progress;
  progress.lessons['licao-1'].videoCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);

  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-student-licao-1-attempt-1' },
    body: { answers: { q1: 'b' }, score: 1 },
  }), { DB, config: baseConfig });
  let result = await payload(response);
  assert.equal(result.score, 0, 'a nota enviada pelo navegador deve ser ignorada');
  assert.equal(result.passed, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.results.q1.isCorrect, false);
  assert.equal(Object.hasOwn(result.results.q1, 'correctOptionId'), false);

  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-student-licao-1-attempt-2' },
    body: { answers: { q1: 'a' } },
  }), { DB, config: baseConfig });
  result = await payload(response);
  assert.equal(result.score, 1);
  assert.equal(result.passed, true);
  assert.equal(result.attemptsUsed, 2);
  assert.equal(result.results.q1.correctOptionId, 'a');
  assert.equal(result.progress.lessons['licao-2'].unlocked, true);
});


test('BOOTSTRAP_ADMIN_EMAILS promove conta nova e conta existente para admin', async () => {
  const DB = createDatabase();
  const config = {
    ...baseConfig,
    bootstrap: {
      ownerEmail: 'owner@example.com',
      adminEmails: ['pastor@example.com'],
    },
  };

  const pastor = await register(DB, {
    name: 'Pastor Beta',
    email: 'pastor@example.com',
    password: 'senha pastoral segura',
    config,
    ip: '203.0.113.41',
  });
  assert.equal(pastor.body.user.role, 'admin');

  const existing = await register(DB, {
    name: 'Secretário Beta',
    email: 'secretario@example.com',
    password: 'senha secretaria segura',
    config: baseConfig,
    ip: '203.0.113.42',
  });
  assert.equal(existing.body.user.role, 'student');

  const promotedConfig = {
    ...baseConfig,
    bootstrap: {
      adminEmails: ['secretario@example.com'],
    },
  };
  const session = await resolveSession(request('/api/auth/session', {
    cookie: existing.cookie,
  }), { DB, config: promotedConfig });
  assert.equal(session.role, 'admin');
  const stored = DB.database.prepare('SELECT role FROM app_users WHERE email = ?')
    .get('secretario@example.com');
  assert.equal(stored.role, 'admin');
});

test('listagem de alunos exige papel administrativo e agrega progresso por curso', async () => {
  const DB = createDatabase();
  const student = await register(DB);
  await checkout(DB, student.cookie);

  let response = await handleApplicationApi(request('/api/admin/students', {
    cookie: student.cookie,
  }), { DB, config: baseConfig });
  assert.equal(response.status, 403);
  assert.equal((await payload(response)).error.code, 'admin_required');

  const ownerConfig = {
    scryptCost: 1_024,
    authRateLimitMax: 50,
    session: {
      cookieName: '__Host-beta_session',
      cookieSecure: true,
      ttlSeconds: 86_400,
    },
    bootstrap: {
      ownerEmail: 'pastor@example.com',
    },
    features: {
      registration: true,
      demoAccess: false,
      paymentsMode: 'test',
    },
  };
  const owner = await register(DB, {
    name: 'Pastor André',
    email: 'pastor@example.com',
    password: 'senha pastoral segura',
    config: ownerConfig,
    ip: '203.0.113.30',
  });
  assert.equal(owner.body.user.role, 'owner');
  assert.match(owner.response.headers.get('set-cookie'), /^__Host-beta_session=/);

  response = await handleApplicationApi(request('/api/admin/students', {
    cookie: owner.cookie,
  }), { DB, config: ownerConfig });
  assert.equal(response.status, 200);
  const body = await payload(response);
  assert.equal(body.students.length, 1);
  assert.equal(body.students[0].email, 'maria@example.com');
  const summary = body.students[0].progress['jornada-lidere'];
  assert.equal(summary.completedLessons, 0);
  assert.equal(summary.totalLessons, 2);
  assert.equal(summary.currentLesson, 'licao-1');
  assert.equal(summary.percentage, 0);
  assert.equal(summary.status, 'not_started');
  assert.ok(summary.enrolledAt);
  assert.ok(summary.updatedAt);

  response = await handleApplicationApi(request(`/api/admin/students/${student.body.user.id}/progress`, {
    cookie: student.cookie,
  }), { DB, config: baseConfig });
  assert.equal(response.status, 403);

  const progressRow = DB.database.prepare(`SELECT snapshot_json
    FROM app_progress WHERE user_id = ? AND course_id = ?`)
    .get(student.body.user.id, 'jornada-lidere');
  const detailedProgress = JSON.parse(progressRow.snapshot_json);
  detailedProgress.lessons['licao-1'].unlocked = true;
  detailedProgress.lessons['licao-1'].pdfRead = true;
  detailedProgress.lessons['licao-1'].videoCompleted = true;
  detailedProgress.lessons['licao-1'].quizStatus = 'passed';
  detailedProgress.lessons['licao-1'].quizAttemptsUsed = 1;
  detailedProgress.lessons['licao-1'].quizScore = 1;
  detailedProgress.lessons['licao-1'].lessonCompleted = true;
  detailedProgress.lessons['licao-2'].unlocked = true;
  DB.database.prepare(`UPDATE app_progress
    SET snapshot_json = ?, version = version + 1, updated_at = ?
    WHERE user_id = ? AND course_id = ?`)
    .run(JSON.stringify(detailedProgress), new Date().toISOString(), student.body.user.id, 'jornada-lidere');
  DB.database.prepare(`INSERT INTO app_quiz_attempts
    (id, user_id, course_id, lesson_id, idempotency_key, score, question_count,
      attempts_used, passed, status, answers_json, results_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      'qat-admin-progress-test',
      student.body.user.id,
      'jornada-lidere',
      'licao-1',
      'admin-progress-attempt-1',
      1,
      1,
      1,
      1,
      'passed',
      '{}',
      '{}',
      new Date().toISOString(),
    );

  response = await handleApplicationApi(request(`/api/admin/students/${student.body.user.id}/progress`, {
    cookie: owner.cookie,
  }), { DB, config: ownerConfig });
  assert.equal(response.status, 200);
  const detail = await payload(response);
  assert.equal(detail.student.email, 'maria@example.com');
  assert.equal(detail.courses.length, 1);
  assert.equal(detail.courses[0].percentage, 50);
  assert.equal(detail.courses[0].currentLesson.id, 'licao-2');
  assert.equal(detail.courses[0].modules[0].lessons[0].quiz.score, 1);
  assert.equal(detail.courses[0].modules[0].lessons[0].quiz.attempts.length, 1);
  assert.equal(detail.courses[0].modules[0].lessons[0].quiz.attempts[0].passed, true);
});

const emailFlowConfig = Object.freeze({
  ...baseConfig,
  isHosted: false,
  appOrigin: origin,
  emailVerificationRequired: true,
  passwordResetEnabled: true,
  emailTokenSecret: 'email-token-secret-with-more-than-32-characters',
  registrationTokenTtlSeconds: 86_400,
  passwordResetTtlSeconds: 1_800,
  ownerEmails: ['pastor@example.com'],
});

function fakeEmailSender(messages, { fail = false } = {}) {
  return {
    async sendRegistration(message) {
      messages.push({ type: 'registration', ...message });
      if (fail) throw new Error('provider unavailable');
      return { id: `mail-${messages.length}`, previewUrl: message.confirmUrl };
    },
    async sendPasswordReset(message) {
      messages.push({ type: 'password', ...message });
      if (fail) throw new Error('provider unavailable');
      return { id: `mail-${messages.length}`, previewUrl: message.resetUrl };
    },
  };
}

function tokenFromActionUrl(value) {
  const [, token = ''] = new URL(value).hash.replace(/^#/, '').split('/');
  return decodeURIComponent(token);
}

test('cadastro confirmado cria a conta somente depois da prova de posse do e-mail', async () => {
  const DB = createDatabase();
  const messages = [];
  const emailSender = fakeEmailSender(messages);
  let response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: { email: 'pastor@example.com' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(DB.database.prepare('SELECT COUNT(*) AS count FROM app_users').get().count, 0);
  assert.equal(messages.length, 1);

  const rawToken = tokenFromActionUrl(messages[0].confirmUrl);
  const stored = DB.database.prepare('SELECT token_hash, purpose, email FROM app_auth_tokens').get();
  assert.equal(stored.purpose, 'complete_registration');
  assert.equal(stored.email, 'pastor@example.com');
  assert.notEqual(stored.token_hash, rawToken);
  assert.equal(stored.token_hash.includes(rawToken), false);

  response = await handleApplicationApi(request('/api/auth/complete-registration', {
    method: 'POST',
    body: {
      token: rawToken,
      name: 'Pastor Fernando',
      birthDate: '1990-01-01',
      password: 'senha-pastoral-segura',
    },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 201);
  const completed = await payload(response);
  assert.equal(completed.user.role, 'owner');
  assert.equal(completed.user.emailVerified, true);
  assert.match(cookieFrom(response), /^beta_session=/);

  response = await handleApplicationApi(request('/api/auth/complete-registration', {
    method: 'POST',
    body: {
      token: rawToken,
      name: 'Outra Pessoa',
      birthDate: '1990-01-01',
      password: 'outra-senha-segura',
    },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 400, 'o token deve ser de uso único');
  assert.equal((await payload(response)).error.code, 'invalid_or_expired_token');
});

test('reenvio invalida o link anterior e não revela se a conta existe', async () => {
  const DB = createDatabase();
  const messages = [];
  const emailSender = fakeEmailSender(messages);
  let response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: { email: 'nova@example.com' },
  }), { DB, config: emailFlowConfig, emailSender });
  const firstBody = await payload(response);
  const firstToken = tokenFromActionUrl(messages.at(-1).confirmUrl);

  response = await handleApplicationApi(request('/api/auth/email/resend', {
    method: 'POST',
    ip: '203.0.113.11',
    body: { email: 'nova@example.com' },
  }), { DB, config: emailFlowConfig, emailSender });
  const secondBody = await payload(response);
  const secondToken = tokenFromActionUrl(messages.at(-1).confirmUrl);
  assert.equal(response.status, 202);
  assert.equal(secondBody.message, firstBody.message);
  assert.notEqual(secondToken, firstToken);

  response = await handleApplicationApi(request('/api/auth/complete-registration', {
    method: 'POST',
    body: { token: firstToken, name: 'Nome Seguro', birthDate: '1990-01-01', password: 'senha-segura-123' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 400);

  const unavailableSender = fakeEmailSender([], { fail: true });
  response = await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    ip: '203.0.113.12',
    body: { email: 'sem-provedor@example.com' },
  }), { DB, config: emailFlowConfig, emailSender: unavailableSender });
  const unavailableBody = await payload(response);
  assert.equal(response.status, 202);
  assert.equal(unavailableBody.message, firstBody.message);
});

test('recuperação troca a senha, revoga sessões e impede reutilização do link', async () => {
  const DB = createDatabase();
  const messages = [];
  const emailSender = fakeEmailSender(messages);
  await handleApplicationApi(request('/api/auth/register', {
    method: 'POST',
    body: { email: 'aluna@example.com' },
  }), { DB, config: emailFlowConfig, emailSender });
  const registrationToken = tokenFromActionUrl(messages.at(-1).confirmUrl);
  let response = await handleApplicationApi(request('/api/auth/complete-registration', {
    method: 'POST',
    body: {
      token: registrationToken,
      name: 'Aluna Confirmada',
      birthDate: '1990-01-01',
      password: 'senha-antiga-segura',
    },
  }), { DB, config: emailFlowConfig, emailSender });
  const originalCookie = cookieFrom(response);
  assert.ok(await resolveSession(request('/api/auth/session', { cookie: originalCookie }), {
    DB,
    config: emailFlowConfig,
  }));

  response = await handleApplicationApi(request('/api/auth/password/forgot', {
    method: 'POST',
    ip: '203.0.113.20',
    body: { email: 'aluna@example.com' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 202);
  const resetToken = tokenFromActionUrl(messages.at(-1).resetUrl);

  response = await handleApplicationApi(request('/api/auth/password/reset', {
    method: 'POST',
    ip: '203.0.113.21',
    cookie: originalCookie,
    body: { token: resetToken, password: 'senha-nova-muito-segura' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(await resolveSession(request('/api/auth/session', { cookie: originalCookie }), {
    DB,
    config: emailFlowConfig,
  }), null);

  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    ip: '203.0.113.22',
    body: { email: 'aluna@example.com', password: 'senha-antiga-segura' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 401);
  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    ip: '203.0.113.23',
    body: { email: 'aluna@example.com', password: 'senha-nova-muito-segura' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 200);

  response = await handleApplicationApi(request('/api/auth/password/reset', {
    method: 'POST',
    ip: '203.0.113.24',
    body: { token: resetToken, password: 'terceira-senha-segura' },
  }), { DB, config: emailFlowConfig, emailSender });
  assert.equal(response.status, 400);
});

test('pré-requisito bloqueia catálogo e checkout até a conclusão histórica do curso anterior', async () => {
  const DB = createDatabase();
  const prerequisite = {
    id: 'fundamentos',
    status: 'published',
    version: 1,
    revision: 1,
    title: 'Fundamentos da Fé',
    category: 'Discipulado',
    pricing: { fullPrice: 0, currency: 'BRL', paymentMethods: ['pix'] },
    modules: [{
      id: 'modulo-fundamentos',
      order: 1,
      lessons: [{ id: 'licao-fundamentos', order: 1, title: 'Fundamentos' }],
    }],
  };
  const restricted = {
    id: 'lidere-avancado',
    status: 'published',
    version: 1,
    revision: 1,
    title: 'Lidere Avançado',
    category: 'Liderança',
    accessPolicy: {
      mode: 'restricted',
      prerequisiteCourseIds: ['fundamentos'],
      prerequisiteMode: 'all',
      catalogVisibility: 'show_locked',
    },
    pricing: { fullPrice: 19.90, currency: 'BRL', paymentMethods: ['pix'] },
    modules: [{
      id: 'modulo-lidere',
      order: 1,
      lessons: [{ id: 'licao-lidere', order: 1, title: 'Liderança' }],
    }],
  };
  const insert = DB.database.prepare('INSERT INTO courses (id, status, data_json) VALUES (?, ?, ?)');
  insert.run(prerequisite.id, prerequisite.status, JSON.stringify(prerequisite));
  insert.run(restricted.id, restricted.status, JSON.stringify(restricted));

  const registration = await register(DB, { email: 'prerequisitos@example.com' });
  let response = await handleApplicationApi(request('/api/courses', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let body = await payload(response);
  let target = body.courses.find(course => course.id === restricted.id);
  assert.equal(target.category, 'Engajar');
  assert.equal(target.access.allowed, false);
  assert.equal(target.access.reasonCode, 'prerequisite_incomplete');
  assert.deepEqual(target.access.missingPrerequisiteCourseIds, ['fundamentos']);

  response = await handleApplicationApi(request('/api/checkouts', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'checkout-bloqueado-prerequisito' },
    body: { courseId: restricted.id, paymentMethod: 'pix' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 403);
  assert.equal((await payload(response)).error.code, 'prerequisite_incomplete');

  const timestamp = new Date().toISOString();
  DB.database.prepare(`INSERT INTO app_enrollments
    (id, user_id, course_id, status, source, checkout_id, created_at, updated_at)
    VALUES (?, ?, ?, 'active', 'test', NULL, ?, ?)`)
    .run('enrollment-fundamentos', registration.body.user.id, prerequisite.id, timestamp, timestamp);

  response = await handleApplicationApi(request('/api/me/progress/fundamentos', {
    method: 'PUT',
    cookie: registration.cookie,
    body: {
      progress: {
        lessons: {
          'licao-fundamentos': { lessonCompleted: true },
        },
      },
    },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  assert.equal(
    DB.database.prepare(`SELECT COUNT(*) AS count FROM app_course_completions
      WHERE user_id = ? AND course_id = ?`).get(registration.body.user.id, prerequisite.id).count,
    1,
  );

  response = await handleApplicationApi(request('/api/courses', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  body = await payload(response);
  target = body.courses.find(course => course.id === restricted.id);
  assert.equal(target.access.allowed, true);

  prerequisite.modules[0].lessons.push({ id: 'licao-nova', order: 2, title: 'Nova lição' });
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(prerequisite), prerequisite.id);
  response = await handleApplicationApi(request('/api/courses', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  body = await payload(response);
  target = body.courses.find(course => course.id === restricted.id);
  assert.equal(target.access.allowed, true, 'a conclusão histórica não deve regredir após novas lições');
});


test('admin desativa, reativa e exclui aluno preservando ou removendo dados conforme a ação', async () => {
  const DB = createDatabase();
  const student = await register(DB, {
    name: 'Aluno de Teste',
    email: 'aluno-conta@example.com',
    password: 'senha longa do aluno',
    ip: '203.0.113.61',
  });
  await checkout(DB, student.cookie);

  const ownerConfig = {
    ...baseConfig,
    bootstrap: { ownerEmail: 'owner-contas@example.com' },
  };
  const owner = await register(DB, {
    name: 'Responsável pelas contas',
    email: 'owner-contas@example.com',
    password: 'senha longa do owner',
    config: ownerConfig,
    ip: '203.0.113.62',
  });

  let response = await handleApplicationApi(request(
    `/api/admin/students/${student.body.user.id}/deactivate`,
    { method: 'POST', cookie: owner.cookie, body: {} },
  ), { DB, config: ownerConfig });
  assert.equal(response.status, 200);
  let body = await payload(response);
  assert.equal(body.student.accountStatus, 'disabled');
  assert.equal(
    DB.database.prepare('SELECT account_status FROM app_users WHERE id = ?')
      .get(student.body.user.id).account_status,
    'disabled',
  );
  assert.equal(
    DB.database.prepare('SELECT COUNT(*) AS count FROM app_enrollments WHERE user_id = ?')
      .get(student.body.user.id).count,
    1,
    'desativação deve preservar matrícula',
  );
  assert.equal(
    DB.database.prepare('SELECT COUNT(*) AS count FROM app_progress WHERE user_id = ?')
      .get(student.body.user.id).count,
    1,
    'desativação deve preservar progresso',
  );

  response = await handleApplicationApi(request('/api/auth/session', {
    cookie: student.cookie,
  }), { DB, config: baseConfig });
  assert.equal(response.status, 401, 'sessão existente deve ser invalidada');

  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    body: { email: 'aluno-conta@example.com', password: 'senha longa do aluno' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 403);
  assert.equal((await payload(response)).error.code, 'account_disabled');

  response = await handleApplicationApi(request(
    `/api/admin/students/${student.body.user.id}/reactivate`,
    { method: 'POST', cookie: owner.cookie, body: {} },
  ), { DB, config: ownerConfig });
  assert.equal(response.status, 200);
  assert.equal((await payload(response)).student.accountStatus, 'active');

  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    body: { email: 'aluno-conta@example.com', password: 'senha longa do aluno' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200, 'a senha anterior deve voltar a funcionar após reativação');

  response = await handleApplicationApi(request(
    `/api/admin/students/${student.body.user.id}`,
    {
      method: 'DELETE',
      cookie: owner.cookie,
      body: { confirmEmail: 'email-incorreto@example.com' },
    },
  ), { DB, config: ownerConfig });
  assert.equal(response.status, 422);
  assert.equal((await payload(response)).error.code, 'delete_confirmation_mismatch');

  response = await handleApplicationApi(request(
    `/api/admin/students/${student.body.user.id}`,
    {
      method: 'DELETE',
      cookie: owner.cookie,
      body: { confirmEmail: 'aluno-conta@example.com' },
    },
  ), { DB, config: ownerConfig });
  assert.equal(response.status, 204);
  for (const table of [
    'app_users',
    'app_sessions',
    'app_auth_tokens',
    'app_enrollments',
    'app_progress',
    'app_video_progress',
    'app_quiz_attempts',
    'app_course_completions',
    'app_checkouts',
  ]) {
    const column = table === 'app_auth_tokens' ? 'user_id' : 'user_id';
    const query = table === 'app_users'
      ? 'SELECT COUNT(*) AS count FROM app_users WHERE id = ?'
      : `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`;
    assert.equal(DB.database.prepare(query).get(student.body.user.id).count, 0, `${table} deve ser removida`);
  }

  const recreated = await register(DB, {
    name: 'Aluno que voltou',
    email: 'aluno-conta@example.com',
    password: 'uma nova senha longa',
    ip: '203.0.113.63',
  });
  assert.equal(recreated.response.status, 201, 'o e-mail deve ficar livre para novo cadastro');
});

test('gerenciamento comum de alunos protege contas administrativas', async () => {
  const DB = createDatabase();
  const ownerConfig = {
    ...baseConfig,
    bootstrap: {
      ownerEmail: 'owner-protegido@example.com',
      adminEmails: ['pastor-protegido@example.com'],
    },
  };
  const owner = await register(DB, {
    name: 'Owner protegido',
    email: 'owner-protegido@example.com',
    password: 'senha longa do owner',
    config: ownerConfig,
    ip: '203.0.113.64',
  });
  const pastor = await register(DB, {
    name: 'Pastor protegido',
    email: 'pastor-protegido@example.com',
    password: 'senha longa do pastor',
    config: ownerConfig,
    ip: '203.0.113.65',
  });

  const response = await handleApplicationApi(request(
    `/api/admin/students/${pastor.body.user.id}/deactivate`,
    { method: 'POST', cookie: owner.cookie, body: {} },
  ), { DB, config: ownerConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'protected_account');
});

test('proprietário distribui funções e facilitador fica limitado ao acompanhamento', async () => {
  const DB = createDatabase();
  const roleConfig = {
    ...baseConfig,
    bootstrap: {
      ownerEmail: 'owner-equipe@example.com',
      adminEmails: ['admin-configurado@example.com'],
    },
  };
  const owner = await register(DB, {
    name: 'Owner da equipe', email: 'owner-equipe@example.com', config: roleConfig, ip: '203.0.113.71',
  });
  const member = await register(DB, {
    name: 'Pessoa facilitadora', email: 'facilitador@example.com', config: roleConfig, ip: '203.0.113.72',
  });
  const configuredAdmin = await register(DB, {
    name: 'Admin configurado', email: 'admin-configurado@example.com', config: roleConfig, ip: '203.0.113.73',
  });

  let response = await handleApplicationApi(request('/api/admin/team', { cookie: owner.cookie }), {
    DB, config: roleConfig,
  });
  assert.equal(response.status, 200);
  let body = await payload(response);
  assert.equal(body.members.find(item => item.id === configuredAdmin.body.user.id).roleManagedByConfig, true);

  response = await handleApplicationApi(request(`/api/admin/team/${member.body.user.id}/role`, {
    method: 'PATCH', cookie: owner.cookie, body: { role: 'facilitator' },
  }), { DB, config: roleConfig });
  assert.equal(response.status, 200);
  assert.equal((await payload(response)).member.role, 'facilitator');

  response = await handleApplicationApi(request('/api/auth/login', {
    method: 'POST',
    body: { email: 'facilitador@example.com', password: 'uma senha longa' },
  }), { DB, config: roleConfig });
  const facilitatorCookie = cookieFrom(response);
  response = await handleApplicationApi(request('/api/admin/students', { cookie: facilitatorCookie }), {
    DB, config: roleConfig,
  });
  assert.equal(response.status, 200);
  response = await handleApplicationApi(request('/api/admin/team', { cookie: facilitatorCookie }), {
    DB, config: roleConfig,
  });
  assert.equal(response.status, 403);

  response = await handleApplicationApi(request(`/api/admin/team/${configuredAdmin.body.user.id}/role`, {
    method: 'PATCH', cookie: owner.cookie, body: { role: 'student' },
  }), { DB, config: roleConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'role_managed_by_configuration');
});

test('P1-02: sincronização genérica não aceita conclusão de vídeo sem rastreamento do player', async () => {
  const DB = createDatabase();
  const stored = DB.database.prepare('SELECT data_json FROM courses WHERE id = ?')
    .get('jornada-lidere');
  const course = JSON.parse(stored.data_json);
  const lesson = course.modules[0].lessons[0];
  lesson.pdfUrl = 'https://cdn.example.com/apostila.pdf';
  lesson.videoProvider = 'direct';
  lesson.videoUrl = 'https://cdn.example.com/licao-1.mp4';
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(course), course.id);

  const registration = await register(DB, { email: 'video-bypass@example.com' });
  await checkout(DB, registration.cookie, { 'Idempotency-Key': 'checkout-video-bypass-1' });

  let response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].videoCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'video_tracking_required');

  response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].pdfRead = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  progress = (await payload(response)).progress;
  progress.lessons['licao-1'].videoCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'video_tracking_required');

  response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: 1,
        durationSeconds: 100,
        lastPositionSeconds: 100,
        intervals: [
          [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
          [50, 60], [60, 70], [70, 80], [80, 90], [90, 95],
        ],
        ended: true,
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  let result = await payload(response);
  assert.equal(result.tracking.completed, true);
  assert.equal(result.videoCompleted, true);

  response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  progress = (await payload(response)).progress['jornada-lidere'];
  assert.equal(progress.lessons['licao-1'].videoCompleted, true);
  assert.equal(progress.lessons['licao-1'].quizStatus, 'available');
  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-video-bypass-1' },
    body: { answers: { q1: 'a' } },
  }), { DB, config: baseConfig });
  result = await payload(response);
  assert.equal(result.passed, true);
  assert.equal(result.progress.lessons['licao-1'].lessonCompleted, true);
});

test('P1-02: lição somente com vídeo só pode ser finalizada após rastreamento válido', async () => {
  const DB = createDatabase();
  const stored = DB.database.prepare('SELECT data_json FROM courses WHERE id = ?')
    .get('jornada-lidere');
  const course = JSON.parse(stored.data_json);
  const lesson = course.modules[0].lessons[0];
  lesson.quiz = [];
  lesson.videoProvider = 'direct';
  lesson.videoUrl = 'https://cdn.example.com/somente-video.mp4';
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(course), course.id);

  const registration = await register(DB, { email: 'somente-video@example.com' });
  await checkout(DB, registration.cookie, { 'Idempotency-Key': 'checkout-somente-video-1' });
  let response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].videoCompleted = true;
  progress.lessons['licao-1'].lessonCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'video_tracking_required');

  response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: 1,
        durationSeconds: 20,
        lastPositionSeconds: 20,
        intervals: [[0, 10], [10, 20]],
        ended: true,
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  assert.equal((await payload(response)).videoCompleted, true);

  response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].lessonCompleted = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  const result = await payload(response);
  assert.equal(result.progress.lessons['licao-1'].lessonCompleted, true);
  assert.equal(result.progress.lessons['licao-2'].unlocked, true);
});

test('P1-02: revisão de vídeo após tentativas esgotadas exige um novo ciclo rastreado', async () => {
  const DB = createDatabase();
  const stored = DB.database.prepare('SELECT data_json FROM courses WHERE id = ?')
    .get('jornada-lidere');
  const course = JSON.parse(stored.data_json);
  course.quizConfig.maxAttempts = 1;
  const lesson = course.modules[0].lessons[0];
  lesson.videoProvider = 'direct';
  lesson.videoUrl = 'https://cdn.example.com/revisao-video.mp4';
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(course), course.id);

  const registration = await register(DB, { email: 'revisao-video@example.com' });
  await checkout(DB, registration.cookie, { 'Idempotency-Key': 'checkout-revisao-video-1' });
  const watchedVideo = async cycle => handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: cycle,
        durationSeconds: 20,
        lastPositionSeconds: 20,
        intervals: [[0, 10], [10, 20]],
        ended: true,
      },
    },
  ), { DB, config: baseConfig });

  let response = await watchedVideo(1);
  assert.equal(response.status, 200);
  response = await handleApplicationApi(request('/api/me/quiz/jornada-lidere/licao-1/attempt', {
    method: 'POST',
    cookie: registration.cookie,
    headers: { 'Idempotency-Key': 'quiz-revisao-video-1' },
    body: { answers: { q1: 'b' } },
  }), { DB, config: baseConfig });
  assert.equal((await payload(response)).status, 'exhausted');

  response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  let progress = (await payload(response)).progress['jornada-lidere'];
  progress.lessons['licao-1'].reWatchedAfterExhaustion = true;
  response = await handleApplicationApi(request('/api/me/progress/jornada-lidere', {
    method: 'PUT',
    cookie: registration.cookie,
    body: { progress },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 409);
  assert.equal((await payload(response)).error.code, 'video_tracking_required');

  response = await watchedVideo(2);
  assert.equal(response.status, 200);
  response = await handleApplicationApi(request('/api/me/state', {
    cookie: registration.cookie,
  }), { DB, config: baseConfig });
  progress = (await payload(response)).progress['jornada-lidere'];
  assert.equal(progress.lessons['licao-1'].quizStatus, 'available');
  assert.equal(progress.lessons['licao-1'].attemptRound, 2);
});

test('rastreamento soma trechos contínuos e só conclui após o fim real do vídeo', async () => {
  const DB = createDatabase();
  const stored = DB.database.prepare('SELECT data_json FROM courses WHERE id = ?')
    .get('jornada-lidere');
  const course = JSON.parse(stored.data_json);
  course.modules[0].lessons[0].videoProvider = 'direct';
  course.modules[0].lessons[0].videoUrl = 'https://cdn.example.com/licao-1.mp4';
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(course), course.id);

  const registration = await register(DB, { email: 'video-progress@example.com' });
  const enrollment = await checkout(DB, registration.cookie, {
    'Idempotency-Key': 'checkout-video-progress-1',
  });
  assert.equal(enrollment.response.status, 200);

  let response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: 1,
        durationSeconds: 100,
        lastPositionSeconds: 100,
        intervals: [[0, 100]],
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  let body = await payload(response);
  assert.equal(body.tracking.percentage, 0);
  assert.equal(body.tracking.completed, false);

  response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: 1,
        durationSeconds: 100,
        lastPositionSeconds: 95,
        intervals: [
          [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
          [50, 60], [60, 70], [70, 80], [80, 90], [90, 95],
        ],
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  body = await payload(response);
  assert.equal(body.tracking.percentage, 95);
  assert.equal(body.tracking.completed, false);
  assert.equal(body.tracking.completedAt, null);

  response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1',
    {
      method: 'PUT',
      cookie: registration.cookie,
      body: {
        trackingCycle: 1,
        durationSeconds: 100,
        lastPositionSeconds: 100,
        intervals: [],
        ended: true,
      },
    },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  body = await payload(response);
  assert.equal(body.tracking.percentage, 95);
  assert.equal(body.tracking.completed, true);
  assert.ok(body.tracking.completedAt);

  const progress = JSON.parse(DB.database.prepare(`SELECT snapshot_json
    FROM app_progress WHERE user_id = ? AND course_id = ?`)
    .get(registration.body.user.id, 'jornada-lidere').snapshot_json);
  assert.equal(progress.lessons['licao-1'].videoCompleted, true);
  assert.equal(progress.lessons['licao-1'].quizStatus, 'available');

  response = await handleApplicationApi(request(
    '/api/me/video-progress/jornada-lidere/licao-1?cycle=1',
    { cookie: registration.cookie },
  ), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  body = await payload(response);
  assert.equal(body.tracking.watchedSeconds, 95);
  assert.equal(body.tracking.lastPositionSeconds, 100);
});

test('P1-04: fases pastorais e liberações excepcionais são decididas pelo servidor', async () => {
  const DB = createDatabase();
  const course = JSON.parse(DB.database.prepare('SELECT data_json FROM courses WHERE id = ?').get('jornada-lidere').data_json);
  course.accessPolicy = { mode: 'restricted', requiredPastoralPhase: 'Engajar', prerequisiteCourseIds: [], prerequisiteMode: 'all', catalogVisibility: 'show_locked' };
  DB.database.prepare('UPDATE courses SET data_json = ? WHERE id = ?').run(JSON.stringify(course), course.id);
  const owner = await register(DB, { email: 'owner-fases@example.com' });
  const student = await register(DB, { email: 'aluno-fases@example.com' });
  DB.database.prepare("UPDATE app_users SET role = 'owner' WHERE email = ?").run('owner-fases@example.com');

  let response = await handleApplicationApi(request('/api/courses', { cookie: student.cookie }), { DB, config: baseConfig });
  let catalog = await payload(response);
  assert.equal(catalog.courses[0].access.reasonCode, 'pastoral_phase_unassigned');

  response = await handleApplicationApi(request(`/api/admin/students/${student.body.user.id}/pastoral-phase`, {
    method: 'PATCH', cookie: owner.cookie, body: { pastoralPhase: 'Atrair' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  response = await handleApplicationApi(request('/api/courses', { cookie: student.cookie }), { DB, config: baseConfig });
  catalog = await payload(response);
  assert.equal(catalog.courses[0].access.reasonCode, 'pastoral_phase_required');

  response = await handleApplicationApi(request(`/api/admin/students/${student.body.user.id}/pastoral-grants`, {
    method: 'POST', cookie: owner.cookie,
    body: { courseId: 'jornada-lidere', reason: 'Aprovado pela liderança para este curso.' },
  }), { DB, config: baseConfig });
  assert.equal(response.status, 201);
  const granted = await payload(response);
  response = await handleApplicationApi(request('/api/courses', { cookie: student.cookie }), { DB, config: baseConfig });
  catalog = await payload(response);
  assert.equal(catalog.courses[0].access.allowed, true);
  assert.equal(catalog.courses[0].access.pastoralGrant, true);

  response = await handleApplicationApi(request(`/api/admin/students/${student.body.user.id}/pastoral-grants/${granted.grant.id}/revoke`, {
    method: 'POST', cookie: owner.cookie, body: {},
  }), { DB, config: baseConfig });
  assert.equal(response.status, 200);
  assert.equal(DB.database.prepare('SELECT status FROM app_enrollments WHERE user_id = ? AND course_id = ?')
    .get(student.body.user.id, 'jornada-lidere').status, 'suspended');
});
