import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  createId,
  createOpaqueToken,
  hashMetadata,
  hashOpaqueToken,
  hashPassword,
  verifyPassword,
} from './auth-crypto.mjs';

const JSON_HEADERS = Object.freeze({
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
});
const AUTH_RATE_BUCKETS = new Map();
const AUTH_RATE_BUCKET_LIMIT = 5_000;
const HOSTED_AUTH_EMAIL_MINIMUM_RESPONSE_MS = 600;
const INITIALIZED_DATABASES = new WeakMap();
const ADMIN_ROLES = new Set(['owner', 'admin', 'facilitator']);
const STUDENT_MANAGER_ROLES = new Set(['owner', 'admin']);
const ASSIGNABLE_TEAM_ROLES = new Set(['student', 'facilitator', 'admin']);
const ACCOUNT_STATUSES = new Set(['active', 'disabled']);
const COURSE_CATEGORIES = new Set(['Alcançar', 'Adorar', 'Relacionar', 'Discipular', 'Engajar']);
const PAYMENT_METHODS = new Set(['pix', 'credit_card', 'boleto']);
const PAYMENT_ACCESS_REVOKING_STATUSES = new Set(['rejected', 'cancelled', 'refunded', 'charged_back']);
const QUIZ_STATUSES = new Set(['locked', 'available', 'failed', 'exhausted', 'passed']);
const VIDEO_COMPLETION_THRESHOLD = 0.95;
const VIDEO_TRACKING_MAX_DURATION_SECONDS = 24 * 60 * 60;
const VIDEO_TRACKING_MAX_INTERVAL_SECONDS = 12.5;
const AUTH_TOKEN_PURPOSES = new Set(['complete_registration', 'reset_password']);
const AUTH_EMAIL_RESPONSE = Object.freeze({
  success: true,
  message: 'Se o endereço puder ser utilizado, enviaremos as instruções por e-mail.',
});
const CATALOG_ANSWER_FIELDS = new Set([
  'answer',
  'correct',
  'correctAnswer',
  'correctIndex',
  'correctOption',
  'correctOptionId',
  'isCorrect',
]);

class ApplicationError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApplicationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(payload, status = 200, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...(headers || {}) },
  });
}

function empty(status = 204, headers) {
  return new Response(null, { status, headers: headers || {} });
}

function errorResponse(error) {
  if (error instanceof ApplicationError) {
    return json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }, error.status);
  }
  console.error('Beta Cursos application API error', error);
  return json({
    error: {
      code: 'internal_error',
      message: 'Não foi possível concluir a operação.',
    },
  }, 500);
}

function envValue(config, camelName, constantName, fallback) {
  if (config?.[camelName] !== undefined) return config[camelName];
  if (config?.[constantName] !== undefined) return config[constantName];
  return fallback;
}

function enabled(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function applicationConfig(config = {}) {
  const sessionConfig = config.session && typeof config.session === 'object' ? config.session : {};
  const featureConfig = config.features && typeof config.features === 'object' ? config.features : {};
  const bootstrapConfig = config.bootstrap && typeof config.bootstrap === 'object' ? config.bootstrap : {};
  const emailConfig = config.email && typeof config.email === 'object' ? config.email : {};
  const paymentConfig = config.payments && typeof config.payments === 'object' ? config.payments : {};
  const ownerValue = envValue(
    config,
    'ownerEmails',
    'OWNER_EMAILS',
    bootstrapConfig.ownerEmail ? [bootstrapConfig.ownerEmail] : [],
  );
  const ownerEmails = (Array.isArray(ownerValue) ? ownerValue : String(ownerValue || '').split(','))
    .map(normalizeEmail)
    .filter(Boolean);
  const adminValue = envValue(
    config,
    'adminEmails',
    'BOOTSTRAP_ADMIN_EMAILS',
    bootstrapConfig.adminEmails || [],
  );
  const adminEmails = (Array.isArray(adminValue) ? adminValue : String(adminValue || '').split(','))
    .map(normalizeEmail)
    .filter(Boolean);
  const couponValue = envValue(config, 'testCoupons', 'TEST_COUPONS', null);
  let testCoupons = couponValue;
  if (typeof couponValue === 'string') {
    try { testCoupons = JSON.parse(couponValue); }
    catch { testCoupons = null; }
  }
  return {
    cookieName: String(envValue(
      config,
      'cookieName',
      'SESSION_COOKIE_NAME',
      sessionConfig.cookieName || 'beta_session',
    )),
    sessionSecret: String(envValue(
      config,
      'sessionSecret',
      'SESSION_SECRET',
      sessionConfig.secret || '',
    )),
    secureCookies: envValue(
      config,
      'secureCookies',
      'SECURE_COOKIES',
      sessionConfig.cookieSecure ?? true,
    ) !== false
      && String(envValue(
        config,
        'secureCookies',
        'SECURE_COOKIES',
        sessionConfig.cookieSecure ?? true,
      )).toLowerCase() !== 'false',
    sessionTtlSeconds: positiveInteger(
      envValue(
        config,
        'sessionTtlSeconds',
        'SESSION_TTL_SECONDS',
        sessionConfig.ttlSeconds || 7 * 24 * 60 * 60,
      ),
      7 * 24 * 60 * 60,
      300,
      90 * 24 * 60 * 60,
    ),
    minimumPasswordLength: positiveInteger(
      envValue(config, 'minimumPasswordLength', 'MINIMUM_PASSWORD_LENGTH', 10),
      10,
      10,
      128,
    ),
    registrationEnabled: enabled(envValue(
      config,
      'registrationEnabled',
      'REGISTRATION_ENABLED',
      featureConfig.registration ?? true,
    )),
    enableDemoLogin: enabled(envValue(
      config,
      'enableDemoLogin',
      'ENABLE_DEMO_LOGIN',
      featureConfig.demoAccess ?? false,
    )),
    demoEmail: normalizeEmail(envValue(config, 'demoEmail', 'DEMO_EMAIL', 'demo@beta.local')),
    demoName: normalizeName(envValue(config, 'demoName', 'DEMO_NAME', 'Conta de demonstração')),
    demoRole: safeRole(envValue(
      config,
      'demoRole',
      'DEMO_ROLE',
      featureConfig.demoRole || 'student',
    ), 'student'),
    demoCourseId: safeIdentifier(envValue(config, 'demoCourseId', 'DEMO_COURSE_ID', 'jornada-lidere')),
    checkoutMode: String(envValue(
      config,
      'checkoutMode',
      'CHECKOUT_MODE',
      featureConfig.paymentsMode || paymentConfig.mode || 'disabled',
    )).toLowerCase(),
    paymentProvider: String(envValue(
      config,
      'paymentProvider',
      'PAYMENT_PROVIDER',
      paymentConfig.provider || 'mercado_pago',
    )).toLowerCase(),
    paymentAccessToken: String(envValue(
      config,
      'paymentAccessToken',
      'MERCADO_PAGO_ACCESS_TOKEN',
      paymentConfig.accessToken || '',
    )),
    paymentWebhookSecret: String(envValue(
      config,
      'paymentWebhookSecret',
      'MERCADO_PAGO_WEBHOOK_SECRET',
      paymentConfig.webhookSecret || '',
    )),
    paymentTestPayerEmail: normalizeEmail(envValue(
      config,
      'paymentTestPayerEmail',
      'MERCADO_PAGO_TEST_PAYER_EMAIL',
      paymentConfig.testPayerEmail || 'test@testuser.com',
    )),
    paymentTimeoutMs: positiveInteger(
      envValue(
        config,
        'paymentTimeoutMs',
        'MERCADO_PAGO_TIMEOUT_MS',
        paymentConfig.timeoutMs || 10000,
      ),
      10000,
      1000,
      30000,
    ),
    paymentFetch: typeof paymentConfig.fetch === 'function'
      ? paymentConfig.fetch
      : fetch,
    isHosted: enabled(envValue(config, 'isHosted', 'IS_HOSTED', false)),
    appOrigin: String(envValue(config, 'appOrigin', 'APP_ORIGIN', 'http://127.0.0.1:3000')),
    emailVerificationRequired: enabled(envValue(
      config,
      'emailVerificationRequired',
      'EMAIL_VERIFICATION_REQUIRED',
      featureConfig.emailVerificationRequired ?? false,
    )),
    passwordResetEnabled: enabled(envValue(
      config,
      'passwordResetEnabled',
      'PASSWORD_RESET_ENABLED',
      featureConfig.passwordReset ?? false,
    )),
    emailTokenSecret: String(envValue(
      config,
      'emailTokenSecret',
      'EMAIL_TOKEN_SECRET',
      emailConfig.tokenSecret || sessionConfig.secret || '',
    )),
    registrationTokenTtlSeconds: positiveInteger(
      envValue(
        config,
        'registrationTokenTtlSeconds',
        'EMAIL_VERIFICATION_TTL_SECONDS',
        emailConfig.registrationTokenTtlSeconds || 24 * 60 * 60,
      ),
      24 * 60 * 60,
      10 * 60,
      7 * 24 * 60 * 60,
    ),
    passwordResetTtlSeconds: positiveInteger(
      envValue(
        config,
        'passwordResetTtlSeconds',
        'PASSWORD_RESET_TTL_SECONDS',
        emailConfig.passwordResetTtlSeconds || 30 * 60,
      ),
      30 * 60,
      10 * 60,
      24 * 60 * 60,
    ),
    ownerEmails: new Set(ownerEmails),
    adminEmails: new Set(adminEmails),
    testCoupons: testCoupons && typeof testCoupons === 'object'
      ? testCoupons
      : {},
    authRateLimitMax: positiveInteger(
      envValue(config, 'authRateLimitMax', 'AUTH_RATE_LIMIT_MAX', 10),
      10,
      1,
      1_000,
    ),
    authRateLimitIpMax: positiveInteger(
      envValue(config, 'authRateLimitIpMax', 'AUTH_RATE_LIMIT_IP_MAX', 30),
      30,
      1,
      10_000,
    ),
    authRateLimitWindowMs: positiveInteger(
      envValue(config, 'authRateLimitWindowMs', 'AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1_000),
      15 * 60 * 1_000,
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    scrypt: {
      cost: positiveInteger(envValue(config, 'scryptCost', 'SCRYPT_COST', 16_384), 16_384, 1_024, 1_048_576),
      blockSize: positiveInteger(envValue(config, 'scryptBlockSize', 'SCRYPT_BLOCK_SIZE', 8), 8, 1, 32),
      parallelization: positiveInteger(envValue(config, 'scryptParallelization', 'SCRYPT_PARALLELIZATION', 1), 1, 1, 16),
    },
    allowedOrigins: normalizeAllowedOrigins(envValue(config, 'allowedOrigins', 'ALLOWED_ORIGINS', [])),
  };
}

function normalizeAllowedOrigins(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map(item => {
    try { return new URL(String(item).trim()).origin; }
    catch { return ''; }
  }).filter(Boolean));
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function validateBirthDate(value, minimumAge = 16) {
  const birthDate = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) {
    throw new ApplicationError(422, 'invalid_birth_date', 'Informe uma data de nascimento válida.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1900
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new ApplicationError(422, 'invalid_birth_date', 'Informe uma data de nascimento válida.');
  }

  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (parsed.getTime() > todayUtc) {
    throw new ApplicationError(422, 'birth_date_in_future', 'A data de nascimento não pode estar no futuro.');
  }

  let age = today.getUTCFullYear() - year;
  const birthdayHasPassed = today.getUTCMonth() + 1 > month
    || (today.getUTCMonth() + 1 === month && today.getUTCDate() >= day);
  if (!birthdayHasPassed) age -= 1;
  if (age < minimumAge) {
    throw new ApplicationError(
      422,
      'minimum_age_required',
      `É necessário ter pelo menos ${minimumAge} anos para criar uma conta.`,
    );
  }

  return birthDate;
}

function normalizeAccountStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return ACCOUNT_STATUSES.has(status) ? status : 'active';
}

function safeRole(value, fallback = 'student') {
  const role = String(value || '').trim().toLowerCase();
  return ['student', 'facilitator', 'admin', 'owner'].includes(role) ? role : fallback;
}

function bootstrapRoleForEmail(config, email, fallback = 'student') {
  const normalized = normalizeEmail(email);
  if (config.ownerEmails.has(normalized)) return 'owner';
  if (config.adminEmails.has(normalized)) return 'admin';
  return safeRole(fallback, 'student');
}

async function synchronizeBootstrapRole(DB, row, config) {
  if (!row) return row;
  const role = bootstrapRoleForEmail(config, row.email, row.role);
  if (role === row.role) return row;
  const timestamp = nowIso();
  await DB.prepare('UPDATE app_users SET role = ?, updated_at = ? WHERE id = ?')
    .bind(role, timestamp, row.id)
    .run();
  return { ...row, role, updated_at: timestamp };
}

function safeIdentifier(value) {
  const identifier = String(value || '').trim();
  return /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(identifier) ? identifier : '';
}

function nowIso() {
  return new Date().toISOString();
}

function addSeconds(value, seconds) {
  return new Date(value.getTime() + seconds * 1_000).toISOString();
}

function runChanges(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

async function all(statement) {
  const result = await statement.all();
  return Array.isArray(result) ? result : (result?.results || []);
}

async function first(statement) {
  if (typeof statement.first === 'function') return statement.first();
  const rows = await all(statement);
  return rows[0] || null;
}

async function ensureApplicationSchema(DB) {
  if (!DB || typeof DB.prepare !== 'function' || typeof DB.batch !== 'function') {
    throw new ApplicationError(503, 'database_unavailable', 'O banco de dados não está disponível.');
  }
  let initialization = INITIALIZED_DATABASES.get(DB);
  if (!initialization) {
    initialization = DB.batch([
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        date_of_birth TEXT,
        member_code TEXT,
        member_code_validated INTEGER NOT NULL DEFAULT 0,
        role TEXT NOT NULL DEFAULT 'student',
        account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'disabled')),
        disabled_at TEXT,
        disabled_by TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_access_at TEXT,
        email_verified_at TEXT
      )`),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        ip_hash TEXT,
        user_agent_hash TEXT
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_sessions_user_idx ON app_sessions (user_id, expires_at)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_auth_tokens (
        token_hash TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        email TEXT NOT NULL,
        user_id TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        requested_ip_hash TEXT,
        user_agent_hash TEXT
      )`),
      DB.prepare(`DELETE FROM app_auth_tokens
        WHERE token_hash IN (
          SELECT token_hash FROM (
            SELECT token_hash,
              ROW_NUMBER() OVER (
                PARTITION BY lower(email), purpose
                ORDER BY created_at DESC, token_hash DESC
              ) AS duplicate_rank
            FROM app_auth_tokens
            WHERE consumed_at IS NULL
          ) ranked
          WHERE duplicate_rank > 1
        )`),
      DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS app_auth_tokens_active_email_purpose_idx
        ON app_auth_tokens (lower(email), purpose)
        WHERE consumed_at IS NULL`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_auth_tokens_email_purpose_idx ON app_auth_tokens (email, purpose, expires_at)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_auth_tokens_user_purpose_idx ON app_auth_tokens (user_id, purpose, expires_at)'),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_auth_tokens_expiry_idx ON app_auth_tokens (expires_at)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_enrollments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        checkout_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, course_id)
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_enrollments_user_idx ON app_enrollments (user_id, status)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_progress (
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, course_id)
      )`),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_video_progress (
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        tracking_cycle INTEGER NOT NULL DEFAULT 1,
        duration_seconds REAL NOT NULL DEFAULT 0,
        watched_seconds REAL NOT NULL DEFAULT 0,
        percentage REAL NOT NULL DEFAULT 0,
        last_position_seconds REAL NOT NULL DEFAULT 0,
        intervals_json TEXT NOT NULL DEFAULT '[]',
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, course_id, lesson_id)
      )`),
      DB.prepare(`CREATE INDEX IF NOT EXISTS app_video_progress_user_idx
        ON app_video_progress (user_id, course_id, updated_at DESC)`),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_course_completions (
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        course_revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (user_id, course_id)
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_course_completions_course_idx ON app_course_completions (course_id, completed_at)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_quiz_attempts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        lesson_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        score INTEGER NOT NULL,
        question_count INTEGER NOT NULL,
        attempts_used INTEGER NOT NULL,
        passed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        answers_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_quiz_attempts_user_course_idx ON app_quiz_attempts (user_id, course_id, created_at)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_checkouts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        status TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        coupon_code TEXT,
        idempotency_key TEXT,
        provider TEXT NOT NULL DEFAULT 'legacy_test',
        provider_mode TEXT NOT NULL DEFAULT 'test',
        provider_preference_id TEXT,
        provider_order_id TEXT,
        provider_payment_id TEXT,
        provider_checkout_url TEXT,
        last_provider_sync_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, idempotency_key)
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_checkouts_user_idx ON app_checkouts (user_id, created_at)'),
      DB.prepare(`CREATE TABLE IF NOT EXISTS app_enrollment_grants (
        id TEXT PRIMARY KEY,
        grant_key TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL,
        course_id TEXT NOT NULL,
        source TEXT NOT NULL,
        checkout_id TEXT,
        status TEXT NOT NULL,
        suspension_reason TEXT,
        suspended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      DB.prepare('CREATE INDEX IF NOT EXISTS app_enrollment_grants_user_course_status_idx ON app_enrollment_grants (user_id, course_id, status)'),
    ]).catch(error => {
      INITIALIZED_DATABASES.delete(DB);
      throw error;
    });
    INITIALIZED_DATABASES.set(DB, initialization);
  }
  await initialization;
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    birthDate: row.date_of_birth || null,
    memberCode: row.member_code || null,
    memberCodeValidated: Boolean(Number(row.member_code_validated)),
    role: safeRole(row.role),
    isDemo: Boolean(Number(row.is_demo)),
    emailVerified: Boolean(row.email_verified_at),
  };
}

function publicFeatures(config) {
  return {
    demoAccess: config.enableDemoLogin,
    registration: config.registrationEnabled,
    paymentsMode: config.checkoutMode,
    emailVerificationRequired: config.emailVerificationRequired,
    passwordReset: config.passwordResetEnabled,
  };
}

function getRequestIp(request) {
  return String(
    request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]
      || 'unknown',
  ).trim().slice(0, 128);
}

function pruneAuthRateBuckets(current) {
  for (const [key, bucket] of AUTH_RATE_BUCKETS) {
    if (bucket.resetAt <= current) AUTH_RATE_BUCKETS.delete(key);
  }
  while (AUTH_RATE_BUCKETS.size >= AUTH_RATE_BUCKET_LIMIT) {
    const oldestKey = AUTH_RATE_BUCKETS.keys().next().value;
    if (oldestKey === undefined) break;
    AUTH_RATE_BUCKETS.delete(oldestKey);
  }
}

function consumeAuthRateBucket(key, limit, windowMs, current) {
  const existing = AUTH_RATE_BUCKETS.get(key);
  const bucket = !existing || existing.resetAt <= current
    ? { count: 0, resetAt: current + windowMs }
    : existing;
  bucket.count += 1;
  // Mantém as chaves recentes no fim do Map para preservar o limite comum do IP.
  AUTH_RATE_BUCKETS.delete(key);
  AUTH_RATE_BUCKETS.set(key, bucket);
  if (bucket.count > limit) {
    throw new ApplicationError(
      429,
      'auth_rate_limited',
      'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
      { retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1_000)) },
    );
  }
}

function enforceAuthRateLimit(request, config, action, email = '') {
  const current = Date.now();
  pruneAuthRateBuckets(current);
  const ipHash = hashOpaqueToken(getRequestIp(request));
  consumeAuthRateBucket(
    `${action}:ip:${ipHash}`,
    config.authRateLimitIpMax,
    config.authRateLimitWindowMs,
    current,
  );
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    consumeAuthRateBucket(
      `${action}:email:${hashOpaqueToken(normalizedEmail)}`,
      config.authRateLimitMax,
      config.authRateLimitWindowMs,
      current,
    );
  }
}

function validateUnsafeOrigin(request, config) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  if (origin === requestOrigin || config.allowedOrigins.has(origin)) return;
  throw new ApplicationError(403, 'origin_not_allowed', 'A origem da solicitação não é permitida.');
}

async function readJson(request, maximumBytes = 128 * 1_024) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApplicationError(415, 'json_required', 'Envie os dados como application/json.');
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > maximumBytes) {
    throw new ApplicationError(413, 'payload_too_large', 'Os dados enviados excedem o limite permitido.');
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new ApplicationError(413, 'payload_too_large', 'Os dados enviados excedem o limite permitido.');
  }
  try {
    const payload = JSON.parse(text || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('object required');
    return payload;
  } catch {
    throw new ApplicationError(400, 'invalid_json', 'O JSON enviado é inválido.');
  }
}

function parseCookie(request, cookieName) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== cookieName) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function sessionCookie(token, config) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionTtlSeconds}`,
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(config) {
  const parts = [
    `${config.cookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.secureCookies) parts.push('Secure');
  return parts.join('; ');
}

async function createSession(request, context, userId) {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token, context.config.sessionSecret);
  const createdAt = nowIso();
  const expiresAt = addSeconds(new Date(), context.config.sessionTtlSeconds);
  await context.DB.prepare(`INSERT INTO app_sessions
    (token_hash, user_id, expires_at, created_at, last_seen_at, ip_hash, user_agent_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      tokenHash,
      userId,
      expiresAt,
      createdAt,
      createdAt,
      hashMetadata(getRequestIp(request)),
      hashMetadata(request.headers.get('user-agent')),
    )
    .run();
  return token;
}

async function revokeRequestSession(request, context) {
  const token = parseCookie(request, context.config.cookieName);
  if (!token) return;
  await context.DB.prepare('DELETE FROM app_sessions WHERE token_hash = ?')
    .bind(hashOpaqueToken(token, context.config.sessionSecret))
    .run();
}

export async function resolveSession(request, { DB, config = {} } = {}) {
  const resolvedConfig = applicationConfig(config);
  await ensureApplicationSchema(DB);
  const token = parseCookie(request, resolvedConfig.cookieName);
  if (!token || token.length > 256) return null;
  const tokenHash = hashOpaqueToken(token, resolvedConfig.sessionSecret);
  let row = await first(DB.prepare(`SELECT
      u.id, u.email, u.full_name, u.date_of_birth, u.member_code, u.member_code_validated, u.role,
      u.account_status, u.disabled_at, u.disabled_by, u.is_demo, u.email_verified_at, s.expires_at
    FROM app_sessions s
    JOIN app_users u ON u.id = s.user_id
    WHERE s.token_hash = ?`)
    .bind(tokenHash));
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await DB.prepare('DELETE FROM app_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  if (normalizeAccountStatus(row.account_status) !== 'active') {
    await DB.prepare('DELETE FROM app_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return null;
  }
  row = await synchronizeBootstrapRole(DB, row, resolvedConfig);
  const timestamp = nowIso();
  await DB.batch([
    DB.prepare('UPDATE app_sessions SET last_seen_at = ? WHERE token_hash = ?').bind(timestamp, tokenHash),
    DB.prepare('UPDATE app_users SET last_access_at = ?, updated_at = ? WHERE id = ?')
      .bind(timestamp, timestamp, row.id),
  ]);
  return publicUser(row);
}

async function requireSession(request, context) {
  const session = context.session === undefined
    ? await resolveSession(request, context)
    : context.session;
  if (!session) throw new ApplicationError(401, 'authentication_required', 'Entre para continuar.');
  return session;
}

function requireAdmin(user) {
  if (!ADMIN_ROLES.has(user?.role)) {
    throw new ApplicationError(403, 'admin_required', 'Acesso administrativo necessário.');
  }
}

function requireStudentManager(user) {
  if (!STUDENT_MANAGER_ROLES.has(user?.role)) {
    throw new ApplicationError(403, 'student_manager_required', 'Somente administradores podem alterar o acesso de alunos.');
  }
}

function requireOwner(user) {
  if (user?.role !== 'owner') {
    throw new ApplicationError(403, 'owner_required', 'Somente o proprietário pode realizar esta ação.');
  }
}

async function recordAdministrativeAudit(DB, actorEmail, action, entityType, entityId, details = {}) {
  try {
    await DB.prepare(`INSERT INTO audit_log
      (actor_email, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        actorEmail,
        action,
        entityType,
        entityId || null,
        JSON.stringify(details).slice(0, 10_000),
        nowIso(),
      )
      .run();
  } catch {
    // A operação principal não deve ser desfeita somente por falha no histórico.
  }
}

async function findUserByEmail(DB, email) {
  return first(DB.prepare(`SELECT
    id, email, full_name, password_hash, date_of_birth, member_code, member_code_validated, role,
    account_status, disabled_at, disabled_by, is_demo, email_verified_at
    FROM app_users WHERE email = ?`)
    .bind(normalizeEmail(email)));
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApplicationError(422, 'invalid_email', 'Informe um e-mail válido.');
  }
  return email;
}

function validatePassword(value, config) {
  const password = String(value || '');
  if (password.length < config.minimumPasswordLength || password.length > 256) {
    throw new ApplicationError(
      422,
      'invalid_password',
      `A senha deve ter pelo menos ${config.minimumPasswordLength} caracteres.`,
    );
  }
  return password;
}

function validateRegistration(payload, config) {
  const name = normalizeName(payload.name);
  const email = normalizeEmail(payload.email);
  const password = validatePassword(payload.password, config);
  const birthDate = validateBirthDate(payload.birthDate);
  const memberCode = String(payload.memberCode || '').trim().slice(0, 40) || null;
  if (name.length < 2) {
    throw new ApplicationError(422, 'invalid_name', 'Informe seu nome completo.');
  }
  validateEmail(email);
  return { name, email, password, birthDate, memberCode };
}

function authTokenHash(token, purpose, config) {
  if (!AUTH_TOKEN_PURPOSES.has(purpose)) throw new TypeError('Finalidade de token inválida.');
  return hashOpaqueToken(`${purpose}:${String(token || '')}`, config.emailTokenSecret);
}

function authActionUrl(config, route, token) {
  const url = new URL(config.appOrigin);
  url.pathname = '/';
  url.search = '';
  url.hash = `${route}/${encodeURIComponent(token)}`;
  return url.toString();
}

function invalidAuthToken() {
  return new ApplicationError(
    400,
    'invalid_or_expired_token',
    'Este link é inválido, expirou ou já foi utilizado. Solicite um novo e-mail.',
  );
}

function prepareAuthToken(request, context, { purpose, email, userId = null, ttlSeconds }) {
  const token = createOpaqueToken();
  const tokenHash = authTokenHash(token, purpose, context.config);
  const createdAt = nowIso();
  const expiresAt = addSeconds(new Date(), ttlSeconds);
  return {
    token,
    tokenHash,
    purpose,
    email: normalizeEmail(email),
    userId,
    expiresAt,
    createdAt,
    requestedIpHash: hashMetadata(getRequestIp(request)),
    userAgentHash: hashMetadata(request.headers.get('user-agent')),
  };
}

async function activateAuthToken(context, issued) {
  const operation = async DB => {
    // PostgreSQL transactions do not serialize concurrent DELETE + INSERT pairs
    // by themselves when there is no previous row. This per-address advisory
    // lock makes replacement deterministic; the partial unique index remains a
    // database-level invariant in case another writer bypasses this code path.
    if (DB.dialect === 'postgres') {
      await first(DB.prepare(`SELECT pg_advisory_xact_lock(
          hashtextextended(?, 0)
        ) AS locked`)
        .bind(`beta-auth-token:${issued.purpose}:${issued.email}`));
    }
    await DB.prepare(`DELETE FROM app_auth_tokens
      WHERE lower(email) = ? AND purpose = ? AND consumed_at IS NULL`)
      .bind(issued.email, issued.purpose)
      .run();
    await DB.prepare(`DELETE FROM app_auth_tokens
      WHERE expires_at <= ? OR consumed_at IS NOT NULL`)
      .bind(issued.createdAt)
      .run();
    await DB.prepare(`INSERT INTO app_auth_tokens
      (token_hash, purpose, email, user_id, expires_at, created_at, consumed_at, requested_ip_hash, user_agent_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        issued.tokenHash,
        issued.purpose,
        issued.email,
        issued.userId,
        issued.expiresAt,
        issued.createdAt,
        null,
        issued.requestedIpHash,
        issued.userAgentHash,
      )
      .run();
  };
  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else {
    const statements = [
      context.DB.prepare(`DELETE FROM app_auth_tokens
        WHERE lower(email) = ? AND purpose = ? AND consumed_at IS NULL`)
        .bind(issued.email, issued.purpose),
      context.DB.prepare(`DELETE FROM app_auth_tokens
        WHERE expires_at <= ? OR consumed_at IS NOT NULL`)
        .bind(issued.createdAt),
      context.DB.prepare(`INSERT INTO app_auth_tokens
        (token_hash, purpose, email, user_id, expires_at, created_at, consumed_at, requested_ip_hash, user_agent_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          issued.tokenHash,
          issued.purpose,
          issued.email,
          issued.userId,
          issued.expiresAt,
          issued.createdAt,
          null,
          issued.requestedIpHash,
          issued.userAgentHash,
        ),
    ];
    await context.DB.batch(statements);
  }
}

async function sendAuthEmail(context, method, message) {
  try {
    const sender = context.emailSender?.[method];
    if (typeof sender !== 'function') throw new Error('Remetente de e-mail indisponível.');
    return await sender.call(context.emailSender, message);
  } catch (error) {
    console.error('Beta Cursos auth email delivery failed', {
      purpose: message.purpose,
      error: error?.message || String(error),
    });
    return null;
  }
}

async function activateDeliveredAuthToken(context, issued, delivery) {
  if (!delivery) return null;
  try {
    await activateAuthToken(context, issued);
    return delivery;
  } catch (error) {
    // Keep the public response indistinguishable for existing and unknown
    // accounts. Because activation is atomic, a previous valid token survives.
    console.error('Beta Cursos auth token activation failed', {
      purpose: issued.purpose,
      error: error?.message || String(error),
    });
    return null;
  }
}

async function genericAuthEmailResponse(context, delivery, startedAt) {
  if (context.config.isHosted) {
    const remaining = HOSTED_AUTH_EMAIL_MINIMUM_RESPONSE_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  }
  return json({
    ...AUTH_EMAIL_RESPONSE,
    ...(!context.config.isHosted && delivery?.previewUrl
      ? { previewUrl: delivery.previewUrl }
      : {}),
  }, 202);
}

async function handleRegistrationRequest(request, context) {
  const startedAt = Date.now();
  const payload = await readJson(request);
  enforceAuthRateLimit(request, context.config, 'register', payload.email);
  const email = validateEmail(payload.email);
  const existing = await findUserByEmail(context.DB, email);
  let delivery = null;
  if (!existing?.email_verified_at) {
    const issued = prepareAuthToken(request, context, {
      purpose: 'complete_registration',
      email,
      userId: existing?.id || null,
      ttlSeconds: context.config.registrationTokenTtlSeconds,
    });
    delivery = await sendAuthEmail(context, 'sendRegistration', {
      purpose: 'complete_registration',
      to: email,
      confirmUrl: authActionUrl(context.config, 'complete-registration', issued.token),
      expiresAt: issued.expiresAt,
      idempotencyKey: `registration-${issued.tokenHash}`,
    });
    delivery = await activateDeliveredAuthToken(context, issued, delivery);
  }
  return genericAuthEmailResponse(context, delivery, startedAt);
}

async function handleDirectRegister(request, context) {
  const payload = await readJson(request);
  enforceAuthRateLimit(request, context.config, 'register', payload.email);
  const registration = validateRegistration(payload, context.config);
  const existing = await findUserByEmail(context.DB, registration.email);
  if (existing) {
    throw new ApplicationError(409, 'email_already_registered', 'Este e-mail já está cadastrado.');
  }
  const id = createId('usr');
  const timestamp = nowIso();
  const role = bootstrapRoleForEmail(context.config, registration.email);
  const passwordHash = await hashPassword(registration.password, context.config.scrypt);
  try {
    await context.DB.prepare(`INSERT INTO app_users
      (id, email, full_name, password_hash, date_of_birth, member_code, member_code_validated, role, is_demo, created_at, updated_at, last_access_at, email_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id,
        registration.email,
        registration.name,
        passwordHash,
        registration.birthDate,
        registration.memberCode,
        0,
        role,
        0,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
  } catch (error) {
    if (/unique|duplicate/i.test(String(error?.message || ''))) {
      throw new ApplicationError(409, 'email_already_registered', 'Este e-mail já está cadastrado.');
    }
    throw error;
  }
  const user = await findUserByEmail(context.DB, registration.email);
  const token = await createSession(request, context, id);
  return json(
    {
      success: true,
      user: publicUser(user),
      features: publicFeatures(context.config),
    },
    201,
    { 'Set-Cookie': sessionCookie(token, context.config) },
  );
}

async function handleRegister(request, context) {
  if (!context.config.registrationEnabled) {
    throw new ApplicationError(404, 'registration_disabled', 'Novos cadastros não estão disponíveis.');
  }
  return context.config.emailVerificationRequired
    ? handleRegistrationRequest(request, context)
    : handleDirectRegister(request, context);
}

async function handleCompleteRegistration(request, context) {
  if (!context.config.registrationEnabled || !context.config.emailVerificationRequired) {
    throw new ApplicationError(404, 'registration_confirmation_disabled', 'A confirmação de cadastro não está disponível.');
  }
  const payload = await readJson(request);
  const token = String(payload.token || '');
  const name = normalizeName(payload.name);
  const birthDate = validateBirthDate(payload.birthDate);
  const password = validatePassword(payload.password, context.config);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw invalidAuthToken();
  if (name.length < 2) {
    throw new ApplicationError(422, 'invalid_name', 'Informe seu nome completo.');
  }
  enforceAuthRateLimit(request, context.config, 'complete-registration');
  const tokenHash = authTokenHash(token, 'complete_registration', context.config);
  const pending = await first(context.DB.prepare(`SELECT
      token_hash, email, user_id, expires_at, consumed_at
    FROM app_auth_tokens
    WHERE token_hash = ? AND purpose = 'complete_registration'`)
    .bind(tokenHash));
  if (!pending || pending.consumed_at || Date.parse(pending.expires_at) <= Date.now()) {
    throw invalidAuthToken();
  }
  const passwordHash = await hashPassword(password, context.config.scrypt);
  const timestamp = nowIso();
  let completedUserId = '';
  const operation = async DB => {
    const consumed = await DB.prepare(`UPDATE app_auth_tokens
      SET consumed_at = ?
      WHERE token_hash = ? AND purpose = 'complete_registration'
        AND consumed_at IS NULL AND expires_at > ?`)
      .bind(timestamp, tokenHash, timestamp)
      .run();
    if (runChanges(consumed) !== 1) throw invalidAuthToken();
    const existing = await findUserByEmail(DB, pending.email);
    if (existing?.email_verified_at) throw invalidAuthToken();
    const role = bootstrapRoleForEmail(context.config, pending.email, existing?.role);
    if (existing) {
      completedUserId = existing.id;
      await DB.prepare(`UPDATE app_users
        SET full_name = ?, date_of_birth = ?, password_hash = ?, role = ?, is_demo = 0,
          email_verified_at = ?, updated_at = ?, last_access_at = ?
        WHERE id = ?`)
        .bind(name, birthDate, passwordHash, role, timestamp, timestamp, timestamp, existing.id)
        .run();
      await DB.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(existing.id).run();
    } else {
      completedUserId = createId('usr');
      await DB.prepare(`INSERT INTO app_users
        (id, email, full_name, password_hash, date_of_birth, member_code, member_code_validated, role, is_demo,
          created_at, updated_at, last_access_at, email_verified_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          completedUserId,
          pending.email,
          name,
          passwordHash,
          birthDate,
          null,
          0,
          role,
          0,
          timestamp,
          timestamp,
          timestamp,
          timestamp,
        )
        .run();
    }
    await DB.prepare(`DELETE FROM app_auth_tokens
      WHERE email = ? AND purpose = 'complete_registration' AND token_hash <> ?`)
      .bind(pending.email, tokenHash)
      .run();
  };
  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else await operation(context.DB);
  const user = await findUserByEmail(context.DB, pending.email);
  const sessionToken = await createSession(request, context, completedUserId);
  return json({
    success: true,
    user: publicUser(user),
    features: publicFeatures(context.config),
  }, 201, { 'Set-Cookie': sessionCookie(sessionToken, context.config) });
}

async function handleForgotPassword(request, context) {
  const startedAt = Date.now();
  if (!context.config.passwordResetEnabled) {
    throw new ApplicationError(404, 'password_reset_disabled', 'A recuperação de senha não está disponível.');
  }
  const payload = await readJson(request);
  enforceAuthRateLimit(request, context.config, 'forgot-password', payload.email);
  const email = validateEmail(payload.email);
  const user = await findUserByEmail(context.DB, email);
  let delivery = null;
  if (user?.email_verified_at && !Number(user.is_demo)) {
    const issued = prepareAuthToken(request, context, {
      purpose: 'reset_password',
      email,
      userId: user.id,
      ttlSeconds: context.config.passwordResetTtlSeconds,
    });
    delivery = await sendAuthEmail(context, 'sendPasswordReset', {
      purpose: 'reset_password',
      to: email,
      name: user.full_name,
      resetUrl: authActionUrl(context.config, 'reset-password', issued.token),
      expiresAt: issued.expiresAt,
      idempotencyKey: `password-${issued.tokenHash}`,
    });
    delivery = await activateDeliveredAuthToken(context, issued, delivery);
  }
  return genericAuthEmailResponse(context, delivery, startedAt);
}

async function handleResetPassword(request, context) {
  if (!context.config.passwordResetEnabled) {
    throw new ApplicationError(404, 'password_reset_disabled', 'A recuperação de senha não está disponível.');
  }
  const payload = await readJson(request);
  const token = String(payload.token || '');
  const password = validatePassword(payload.password, context.config);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw invalidAuthToken();
  enforceAuthRateLimit(request, context.config, 'reset-password');
  const tokenHash = authTokenHash(token, 'reset_password', context.config);
  const pending = await first(context.DB.prepare(`SELECT
      token_hash, email, user_id, expires_at, consumed_at
    FROM app_auth_tokens
    WHERE token_hash = ? AND purpose = 'reset_password'`)
    .bind(tokenHash));
  if (!pending?.user_id || pending.consumed_at || Date.parse(pending.expires_at) <= Date.now()) {
    throw invalidAuthToken();
  }
  const passwordHash = await hashPassword(password, context.config.scrypt);
  const timestamp = nowIso();
  const operation = async DB => {
    const consumed = await DB.prepare(`UPDATE app_auth_tokens
      SET consumed_at = ?
      WHERE token_hash = ? AND purpose = 'reset_password'
        AND consumed_at IS NULL AND expires_at > ?`)
      .bind(timestamp, tokenHash, timestamp)
      .run();
    if (runChanges(consumed) !== 1) throw invalidAuthToken();
    const updated = await DB.prepare(`UPDATE app_users
      SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
      WHERE id = ? AND email = ?`)
      .bind(passwordHash, timestamp, timestamp, pending.user_id, pending.email)
      .run();
    if (runChanges(updated) !== 1) throw invalidAuthToken();
    await DB.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(pending.user_id).run();
    await DB.prepare(`DELETE FROM app_auth_tokens
      WHERE user_id = ? AND purpose = 'reset_password' AND token_hash <> ?`)
      .bind(pending.user_id, tokenHash)
      .run();
  };
  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else await operation(context.DB);
  return json({
    success: true,
    message: 'Sua senha foi alterada. Entre novamente com a nova senha.',
  }, 200, { 'Set-Cookie': clearSessionCookie(context.config) });
}

async function handleLogin(request, context) {
  const payload = await readJson(request);
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');
  enforceAuthRateLimit(request, context.config, 'login', email);
  let row = email ? await findUserByEmail(context.DB, email) : null;
  const valid = row?.password_hash ? await verifyPassword(password, row.password_hash) : false;
  if (!valid) {
    throw new ApplicationError(401, 'invalid_credentials', 'E-mail ou senha incorretos.');
  }
  if (normalizeAccountStatus(row.account_status) !== 'active') {
    throw new ApplicationError(403, 'account_disabled', 'Seu acesso está desativado. Entre em contato com a administração da Igreja Beta.');
  }
  if (context.config.emailVerificationRequired && !row.email_verified_at) {
    throw new ApplicationError(
      403,
      'email_not_verified',
      'Confirme seu e-mail antes de entrar. Você pode solicitar um novo link de confirmação.',
    );
  }
  row = await synchronizeBootstrapRole(context.DB, row, context.config);
  const token = await createSession(request, context, row.id);
  return json(
    {
      success: true,
      user: publicUser(row),
      features: publicFeatures(context.config),
    },
    200,
    { 'Set-Cookie': sessionCookie(token, context.config) },
  );
}

async function ensureDemoUser(request, context) {
  if (!context.config.enableDemoLogin) {
    throw new ApplicationError(404, 'demo_disabled', 'A conta de demonstração não está disponível.');
  }
  enforceAuthRateLimit(request, context.config, 'demo', context.config.demoEmail);
  let row = await findUserByEmail(context.DB, context.config.demoEmail);
  if (!row) {
    const id = createId('usr');
    const timestamp = nowIso();
    const unusablePassword = await hashPassword(createOpaqueToken(), context.config.scrypt);
    await context.DB.prepare(`INSERT INTO app_users
      (id, email, full_name, password_hash, member_code, member_code_validated, role, is_demo, created_at, updated_at, last_access_at, email_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        id,
        context.config.demoEmail,
        context.config.demoName,
        unusablePassword,
        null,
        0,
        context.config.demoRole,
        1,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    row = await findUserByEmail(context.DB, context.config.demoEmail);
  } else if (!Number(row.is_demo)) {
    throw new ApplicationError(409, 'demo_email_conflict', 'O e-mail de demonstração já pertence a uma conta real.');
  }
  if (context.config.demoCourseId) {
    const course = await getPublishedCourse(context.DB, context.config.demoCourseId, false);
    if (course) await ensureEnrollment(context, row.id, course, 'demo', null);
  }
  const token = await createSession(request, context, row.id);
  return json(
    {
      success: true,
      user: publicUser(row),
      features: publicFeatures(context.config),
    },
    200,
    { 'Set-Cookie': sessionCookie(token, context.config) },
  );
}

function normalizeCourseCategory(value) {
  const raw = String(value || '').trim();
  if (COURSE_CATEGORIES.has(raw)) return raw;
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  if (/(evangel|miss|alcanc|atrair)/.test(normalized)) return 'Alcançar';
  if (/(ador|espiritual)/.test(normalized)) return 'Adorar';
  if (/(famil|relacion)/.test(normalized)) return 'Relacionar';
  if (/(lider|minister|engaj)/.test(normalized)) return 'Engajar';
  return 'Discipular';
}

function normalizeCourseAccessPolicy(course) {
  const source = course?.accessPolicy && typeof course.accessPolicy === 'object'
    ? course.accessPolicy
    : {};
  const mode = source.mode === 'restricted' ? 'restricted' : 'open';
  const prerequisiteCourseIds = Array.isArray(source.prerequisiteCourseIds)
    ? [...new Set(source.prerequisiteCourseIds.map(id => safeIdentifier(id)).filter(Boolean))]
    : [];
  return {
    mode,
    prerequisiteCourseIds: mode === 'restricted' ? prerequisiteCourseIds : [],
    prerequisiteMode: 'all',
    catalogVisibility: source.catalogVisibility === 'hidden_until_eligible'
      ? 'hidden_until_eligible'
      : 'show_locked',
  };
}

function parseCourse(row) {
  if (!row) return null;
  try {
    const data = JSON.parse(row.data_json || '{}');
    const course = { ...data, id: row.id || data.id, status: row.status || data.status };
    course.category = normalizeCourseCategory(course.category);
    course.accessPolicy = normalizeCourseAccessPolicy(course);
    return course;
  } catch {
    throw new ApplicationError(500, 'invalid_course_data', 'Os dados do curso estão inválidos.');
  }
}

function stripCatalogAnswers(value) {
  if (Array.isArray(value)) return value.map(stripCatalogAnswers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CATALOG_ANSWER_FIELDS.has(key))
      .map(([key, nested]) => [key, stripCatalogAnswers(nested)]),
  );
}

function catalogCourse(row, contentAvailable) {
  const parsed = parseCourse(row);
  const course = stripCatalogAnswers({
    ...parsed,
    id: row.id || parsed.id,
    slug: row.slug || parsed.slug,
    title: row.title || parsed.title,
    status: row.status || parsed.status,
    version: Number(row.version || parsed.version || 1),
    revision: Number(row.version || parsed.revision || parsed.version || 1),
    createdAt: row.created_at || parsed.createdAt,
    updatedAt: row.updated_at || parsed.updatedAt,
    publishedAt: row.published_at || parsed.publishedAt || null,
  });
  course.modules = (Array.isArray(course.modules) ? course.modules : []).map(module => ({
    ...module,
    lessons: (Array.isArray(module.lessons) ? module.lessons : []).map(lesson => {
      if (contentAvailable) return { ...lesson, contentAvailable: true };
      const publicLesson = { ...lesson, quiz: [], contentAvailable: false };
      [
        'captionUrl',
        'pdfMediaId',
        'pdfUrl',
        'videoEmbedId',
        'videoMediaId',
        'videoSource',
        'videoUrl',
      ].forEach(field => delete publicLesson[field]);
      return publicLesson;
    }),
  }));
  return course;
}

async function publishedCourseRows(DB) {
  try {
    return await all(DB.prepare(`SELECT
      id, slug, title, status, data_json, version, created_at, updated_at, published_at
      FROM courses WHERE status = 'published' ORDER BY updated_at DESC`));
  } catch (error) {
    if (!/no such column|does not exist/i.test(String(error?.message || ''))) throw error;
    return all(DB.prepare(`SELECT id, status, data_json
      FROM courses WHERE status = 'published'`));
  }
}

async function handlePublicCatalog(request, context) {
  const user = context.session === undefined
    ? await resolveSession(request, context)
    : context.session;
  const privileged = ADMIN_ROLES.has(user?.role);
  const enrolledCourseIds = new Set();
  if (user && !privileged) {
    const enrollmentRows = await all(context.DB.prepare(`SELECT course_id
      FROM app_enrollments WHERE user_id = ? AND status = 'active'`)
      .bind(user.id));
    enrollmentRows.forEach(row => enrolledCourseIds.add(row.course_id));
  }
  const rows = await publishedCourseRows(context.DB);
  const courseMap = await allCourseMap(context.DB);
  const completedCourseIds = await completionIdsForUser(context.DB, user?.id, courseMap);
  const courses = [];
  for (const row of rows) {
    const parsed = courseMap.get(row.id) || parseCourse(row);
    const decision = accessDecision(parsed, user, completedCourseIds, courseMap);
    if (!privileged && !decision.allowed
      && parsed.accessPolicy.catalogVisibility === 'hidden_until_eligible') continue;
    const enrolled = privileged || enrolledCourseIds.has(row.id);
    const course = catalogCourse(row, decision.allowed && enrolled);
    course.category = normalizeCourseCategory(course.category);
    course.accessPolicy = normalizeCourseAccessPolicy(course);
    course.access = { ...decision, enrolled, contentAvailable: Boolean(decision.allowed && enrolled) };
    courses.push(course);
  }
  return json({ courses, initialized: true });
}

async function getPublishedCourse(DB, courseId, required = true) {
  const id = safeIdentifier(courseId);
  if (!id) throw new ApplicationError(404, 'course_not_found', 'Curso não encontrado.');
  let row;
  try {
    row = await first(DB.prepare('SELECT id, status, data_json FROM courses WHERE id = ?').bind(id));
  } catch (error) {
    if (/no such table|does not exist/i.test(String(error?.message || ''))) {
      if (!required) return null;
      throw new ApplicationError(503, 'catalog_unavailable', 'O catálogo ainda não foi configurado.');
    }
    throw error;
  }
  if (!row || row.status !== 'published') {
    if (!required) return null;
    throw new ApplicationError(404, 'course_not_found', 'Curso não encontrado.');
  }
  return parseCourse(row);
}

async function getCourseForEnrollment(DB, courseId) {
  const id = safeIdentifier(courseId);
  if (!id) throw new ApplicationError(404, 'course_not_found', 'Curso não encontrado.');
  const row = await first(
    DB.prepare('SELECT id, status, data_json FROM courses WHERE id = ?').bind(id),
  );
  if (!row) throw new ApplicationError(404, 'course_not_found', 'Curso não encontrado.');
  return parseCourse(row);
}

function orderedLessons(course) {
  return (Array.isArray(course?.modules) ? course.modules : [])
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .flatMap(module => (Array.isArray(module.lessons) ? module.lessons : [])
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0)));
}

function progressCompletesCourse(course, snapshot) {
  const lessons = orderedLessons(course);
  return lessons.length > 0 && lessons.every(lesson => snapshot?.lessons?.[lesson.id]?.lessonCompleted === true);
}

async function recordCourseCompletion(DB, userId, course, snapshot) {
  if (!progressCompletesCourse(course, snapshot)) return false;
  await DB.prepare(`INSERT INTO app_course_completions
    (user_id, course_id, completed_at, course_revision)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (user_id, course_id) DO NOTHING`)
    .bind(userId, course.id, nowIso(), Number(course.revision || course.version || 1))
    .run();
  return true;
}

async function completionIdsForUser(DB, userId, courseMap) {
  const completed = new Set();
  if (!userId) return completed;
  const completionRows = await all(DB.prepare(
    'SELECT course_id FROM app_course_completions WHERE user_id = ?',
  ).bind(userId));
  completionRows.forEach(row => completed.add(row.course_id));
  const progressRows = await all(DB.prepare(
    'SELECT course_id, snapshot_json FROM app_progress WHERE user_id = ?',
  ).bind(userId));
  for (const row of progressRows) {
    if (completed.has(row.course_id)) continue;
    const course = courseMap.get(row.course_id);
    if (!course) continue;
    try {
      const snapshot = JSON.parse(row.snapshot_json || '{}');
      if (await recordCourseCompletion(DB, userId, course, snapshot)) completed.add(row.course_id);
    } catch {
      // Progresso corrompido nunca satisfaz um pré-requisito.
    }
  }
  return completed;
}

function accessDecision(course, user, completedCourseIds, courseMap) {
  const policy = normalizeCourseAccessPolicy(course);
  const privileged = ADMIN_ROLES.has(user?.role);
  if (privileged || policy.mode === 'open') {
    return { allowed: true, reasonCode: null, reason: '', nextStep: '', missingPrerequisiteCourseIds: [], missingPrerequisites: [] };
  }
  const allPrerequisites = policy.prerequisiteCourseIds.map(id => ({ id, title: courseMap.get(id)?.title || id }));
  if (!user) {
    return {
      allowed: false,
      reasonCode: 'authentication_required',
      reason: 'Entre na sua conta para verificar os pré-requisitos.',
      nextStep: 'Entre ou crie sua conta para continuar.',
      missingPrerequisiteCourseIds: policy.prerequisiteCourseIds,
      missingPrerequisites: allPrerequisites,
    };
  }
  const missingPrerequisiteCourseIds = policy.prerequisiteCourseIds.filter(id => !completedCourseIds.has(id));
  const missingPrerequisites = missingPrerequisiteCourseIds.map(id => ({ id, title: courseMap.get(id)?.title || id }));
  if (missingPrerequisiteCourseIds.length) {
    return {
      allowed: false,
      reasonCode: 'prerequisite_incomplete',
      reason: 'Conclua os cursos obrigatórios antes de continuar.',
      nextStep: `Conclua primeiro: ${missingPrerequisites.map(item => item.title).join(', ')}.`,
      missingPrerequisiteCourseIds,
      missingPrerequisites,
    };
  }
  return { allowed: true, reasonCode: null, reason: '', nextStep: '', missingPrerequisiteCourseIds: [], missingPrerequisites: [] };
}

async function allCourseMap(DB) {
  let rows;
  try {
    rows = await all(DB.prepare('SELECT id, slug, title, status, data_json, version FROM courses'));
  } catch (error) {
    if (!/no such column|does not exist/i.test(String(error?.message || ''))) throw error;
    rows = await all(DB.prepare('SELECT id, status, data_json FROM courses'));
  }
  return new Map(rows.map(row => [row.id, parseCourse(row)]));
}

async function resolveCourseAccess(DB, user, course) {
  const courseMap = await allCourseMap(DB);
  if (!courseMap.has(course.id)) courseMap.set(course.id, course);
  const completedCourseIds = await completionIdsForUser(DB, user?.id, courseMap);
  return accessDecision(course, user, completedCourseIds, courseMap);
}

async function requireCoursePrerequisites(DB, user, course) {
  const decision = await resolveCourseAccess(DB, user, course);
  if (!decision.allowed) {
    throw new ApplicationError(
      decision.reasonCode === 'authentication_required' ? 401 : 403,
      decision.reasonCode,
      decision.nextStep || decision.reason,
      { missingPrerequisites: decision.missingPrerequisites },
    );
  }
  return decision;
}

function lessonRequirements(lesson) {
  return {
    hasPdf: typeof lesson?.pdfUrl === 'string' && lesson.pdfUrl.trim() !== '',
    hasVideo: Boolean(
      String(lesson?.videoUrl || '').trim()
      || String(lesson?.videoEmbedId || '').trim(),
    ),
    hasQuiz: lessonQuizQuestions(lesson).length > 0,
  };
}

function courseLesson(course, lessonId) {
  const id = safeIdentifier(lessonId);
  if (!id) return null;
  return orderedLessons(course).find(lesson => lesson.id === id) || null;
}

function videoProvider(lesson) {
  const provider = String(lesson?.videoProvider || '').trim().toLowerCase();
  return ['youtube', 'vimeo', 'direct', 'upload', 's3'].includes(provider)
    ? provider
    : 'unknown';
}

function videoSourceKey(lesson) {
  return hashMetadata([
    videoProvider(lesson),
    String(lesson?.videoEmbedId || lesson?.videoUrl || '').trim(),
  ].join(':'));
}

async function completedVideoLessonIds(DB, userId, course) {
  const rows = await all(DB.prepare(`SELECT lesson_id, source_key
    FROM app_video_progress
    WHERE user_id = ? AND course_id = ? AND completed_at IS NOT NULL`)
    .bind(userId, course.id));
  const completed = new Set();
  for (const row of rows) {
    const lesson = courseLesson(course, row.lesson_id);
    if (
      lesson
      && lessonRequirements(lesson).hasVideo
      && row.source_key === videoSourceKey(lesson)
    ) {
      completed.add(lesson.id);
    }
  }
  return completed;
}

function videoTrackingCycle(value, fallback = 1) {
  return positiveInteger(value, fallback, 1, 10_000);
}

function finiteVideoSeconds(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(VIDEO_TRACKING_MAX_DURATION_SECONDS, number);
}

function normalizeVideoIntervals(value, duration, { incoming = false } = {}) {
  if (!Array.isArray(value)) return [];
  const maximum = duration > 0 ? duration : VIDEO_TRACKING_MAX_DURATION_SECONDS;
  return value.slice(0, incoming ? 500 : 2_000).flatMap(interval => {
    const start = finiteVideoSeconds(Array.isArray(interval) ? interval[0] : interval?.start, -1);
    const end = finiteVideoSeconds(Array.isArray(interval) ? interval[1] : interval?.end, -1);
    if (start < 0 || end <= start) return [];
    const boundedStart = Math.max(0, Math.min(maximum, start));
    const boundedEnd = Math.max(0, Math.min(maximum, end));
    const length = boundedEnd - boundedStart;
    if (length < 0.1) return [];
    if (incoming && length > VIDEO_TRACKING_MAX_INTERVAL_SECONDS) return [];
    return [[boundedStart, boundedEnd]];
  });
}

function mergeVideoIntervals(value, duration) {
  const sorted = normalizeVideoIntervals(value, duration)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + 0.75) {
      previous[1] = Math.max(previous[1], interval[1]);
    } else {
      merged.push([...interval]);
    }
  }
  return merged.slice(0, 500);
}

function watchedVideoSeconds(intervals) {
  return intervals.reduce(
    (total, interval) => total + Math.max(0, Number(interval[1]) - Number(interval[0])),
    0,
  );
}

function parseVideoIntervals(value, duration) {
  try { return mergeVideoIntervals(JSON.parse(value || '[]'), duration); }
  catch { return []; }
}

function publicVideoTracking(row, defaults = {}) {
  const duration = finiteVideoSeconds(row?.duration_seconds, defaults.durationSeconds || 0);
  const intervals = row
    ? parseVideoIntervals(row.intervals_json, duration)
    : [];
  const watched = row
    ? Math.min(duration || VIDEO_TRACKING_MAX_DURATION_SECONDS, watchedVideoSeconds(intervals))
    : 0;
  const percentage = duration > 0
    ? Math.min(100, watched / duration * 100)
    : 0;
  return {
    provider: String(row?.provider || defaults.provider || 'unknown'),
    trackingCycle: videoTrackingCycle(row?.tracking_cycle, defaults.trackingCycle || 1),
    durationSeconds: Number(duration.toFixed(3)),
    watchedSeconds: Number(watched.toFixed(3)),
    percentage: Number(percentage.toFixed(1)),
    lastPositionSeconds: Number(finiteVideoSeconds(
      row?.last_position_seconds,
      defaults.lastPositionSeconds || 0,
    ).toFixed(3)),
    intervals: intervals.map(interval => interval.map(value => Number(value.toFixed(3)))),
    completed: Boolean(row?.completed_at),
    completedAt: row?.completed_at || null,
    updatedAt: row?.updated_at || null,
  };
}

function quizRules(course, lesson) {
  const source = { ...(course?.quizConfig || {}), ...(lesson?.quizConfig || {}) };
  const questionCount = lessonQuizQuestions(lesson).length;
  if (questionCount === 0) {
    return { questionCount: 0, passingScore: 0, maxAttempts: 0 };
  }
  return {
    questionCount,
    passingScore: Math.min(
      questionCount,
      Math.max(1, positiveInteger(source.passingScore, Math.min(4, questionCount), 1, questionCount)),
    ),
    maxAttempts: positiveInteger(source.maxAttempts, 3, 1, 10),
  };
}

function initialProgress(course) {
  const lessons = {};
  orderedLessons(course).forEach((lesson, index) => {
    const requirements = lessonRequirements(lesson);
    const prerequisitesComplete = !requirements.hasPdf && !requirements.hasVideo;
    lessons[lesson.id] = {
      lessonId: lesson.id,
      unlocked: index === 0,
      pdfRead: !requirements.hasPdf,
      videoCompleted: !requirements.hasVideo,
      quizStatus: requirements.hasQuiz
        ? (prerequisitesComplete ? 'available' : 'locked')
        : 'passed',
      quizAttemptsUsed: 0,
      quizScore: null,
      lessonCompleted: false,
      attemptRound: 1,
      reReadAfterExhaustion: !requirements.hasPdf,
      reWatchedAfterExhaustion: !requirements.hasVideo,
    };
  });
  return {
    courseId: course.id,
    courseRevision: Number(course.revision || course.version || 1),
    startedAt: nowIso(),
    lessons,
  };
}

function safeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function synchronizeProgress(course, existingValue, incomingValue, {
  verifiedVideoLessonIds = new Set(),
  verifiedVideoRewatchLessonIds = new Set(),
} = {}) {
  const existing = existingValue && typeof existingValue === 'object'
    ? existingValue
    : initialProgress(course);
  const incoming = incomingValue && typeof incomingValue === 'object' ? incomingValue : {};
  const incomingLessons = incoming.lessons && typeof incoming.lessons === 'object' ? incoming.lessons : {};
  const synchronized = initialProgress(course);
  synchronized.startedAt = existing.startedAt || synchronized.startedAt;
  synchronized.reconciledAt = nowIso();
  let previousCompleted = true;
  let transitionCount = 0;

  for (const lesson of orderedLessons(course)) {
    const requirements = lessonRequirements(lesson);
    const old = existing.lessons?.[lesson.id] || synchronized.lessons[lesson.id];
    const proposed = incomingLessons[lesson.id] || {};
    const rules = quizRules(course, lesson);
    const videoVerified = requirements.hasVideo && verifiedVideoLessonIds.has(lesson.id);
    const state = {
      ...synchronized.lessons[lesson.id],
      unlocked: previousCompleted,
      pdfRead: !requirements.hasPdf || Boolean(old.pdfRead),
      // A conclusão do vídeo nunca é uma afirmação do navegador: ela vem do
      // registro de acompanhamento do player em app_video_progress. Manter a
      // conclusão já persistida preserva alunos que concluíram antes desta
      // proteção; novos avanços precisam de evidência do servidor.
      videoCompleted: !requirements.hasVideo || Boolean(old.videoCompleted) || videoVerified,
      quizStatus: requirements.hasQuiz
        ? (QUIZ_STATUSES.has(old.quizStatus) ? old.quizStatus : 'locked')
        : 'passed',
      quizAttemptsUsed: requirements.hasQuiz
        ? Math.max(0, Math.min(rules.maxAttempts, safeInteger(old.quizAttemptsUsed)))
        : 0,
      quizScore: requirements.hasQuiz && old.quizScore != null ? safeInteger(old.quizScore) : null,
      lessonCompleted: Boolean(
        old.lessonCompleted
        && (!requirements.hasQuiz || old.quizStatus === 'passed'),
      ),
      attemptRound: Math.max(1, safeInteger(old.attemptRound, 1)),
      reReadAfterExhaustion: !requirements.hasPdf || Boolean(old.reReadAfterExhaustion),
      reWatchedAfterExhaustion: !requirements.hasVideo || Boolean(old.reWatchedAfterExhaustion),
    };

    if (!state.unlocked) {
      synchronized.lessons[lesson.id] = state;
      previousCompleted = false;
      continue;
    }

    if (requirements.hasPdf && !state.pdfRead && proposed.pdfRead === true) {
      state.pdfRead = true;
      transitionCount += 1;
    }
    if (requirements.hasVideo && proposed.videoCompleted === true && !Boolean(old.videoCompleted) && !videoVerified) {
      throw new ApplicationError(
        409,
        'video_tracking_required',
        'A conclusão do vídeo precisa ser confirmada pelo player antes de avançar.',
      );
    }
    if (
      requirements.hasQuiz
      && state.pdfRead
      && state.videoCompleted
      && state.quizStatus === 'locked'
    ) {
      state.quizStatus = 'available';
    }

    if (requirements.hasQuiz && state.quizStatus === 'exhausted') {
      if (
        requirements.hasPdf
        && !state.reReadAfterExhaustion
        && proposed.reReadAfterExhaustion === true
      ) {
        state.reReadAfterExhaustion = true;
        transitionCount += 1;
      }
      if (
        requirements.hasVideo
        && !state.reWatchedAfterExhaustion
        && proposed.reWatchedAfterExhaustion === true
      ) {
        if (!verifiedVideoRewatchLessonIds.has(lesson.id)) {
          throw new ApplicationError(
            409,
            'video_tracking_required',
            'A revisão do vídeo precisa ser confirmada pelo player antes de liberar nova tentativa.',
          );
        }
        state.reWatchedAfterExhaustion = true;
        transitionCount += 1;
      }
      const proposedRound = safeInteger(proposed.attemptRound, state.attemptRound);
      const explicitReset = proposedRound === state.attemptRound + 1
        && proposed.quizStatus === 'available'
        && safeInteger(proposed.quizAttemptsUsed) === 0;
      if (
        (state.reReadAfterExhaustion && state.reWatchedAfterExhaustion)
        || (explicitReset && (state.reReadAfterExhaustion || state.reWatchedAfterExhaustion))
      ) {
        if (explicitReset) transitionCount += 1;
        state.quizStatus = 'available';
        state.quizAttemptsUsed = 0;
        state.quizScore = null;
        state.attemptRound += 1;
        state.reReadAfterExhaustion = !requirements.hasPdf;
        state.reWatchedAfterExhaustion = !requirements.hasVideo;
      }
    }

    const proposedAttempts = safeInteger(proposed.quizAttemptsUsed, state.quizAttemptsUsed);
    if (proposedAttempts > state.quizAttemptsUsed) {
      throw new ApplicationError(
        409,
        'quiz_submission_required',
        'Envie as respostas pela rota segura do teste para registrar a tentativa.',
      );
    }

    if (
      !requirements.hasQuiz
      && !state.lessonCompleted
      && proposed.lessonCompleted === true
    ) {
      if (!state.pdfRead || !state.videoCompleted) {
        throw new ApplicationError(
          409,
          'lesson_prerequisites_required',
          'Conclua os materiais existentes antes de finalizar a lição.',
        );
      }
      state.lessonCompleted = true;
      state.quizStatus = 'passed';
      transitionCount += 1;
    }

    if (requirements.hasQuiz && state.quizStatus !== 'passed') state.lessonCompleted = false;
    synchronized.lessons[lesson.id] = state;
    previousCompleted = state.lessonCompleted;
  }
  if (transitionCount > 1) {
    throw new ApplicationError(
      409,
      'invalid_progress_transition',
      'Envie uma etapa concluída por vez para preservar a ordem do curso.',
    );
  }
  return synchronized;
}

async function ensureEnrollment(context, userId, course, source, checkoutId) {
  const timestamp = nowIso();
  const id = createId('enr');
  const normalizedSource = String(source || 'manual').trim().toLowerCase() || 'manual';
  const normalizedCheckoutId = checkoutId ? String(checkoutId).trim() : null;
  const grantKey = normalizedCheckoutId
    ? `checkout:${normalizedCheckoutId}`
    : `source:${normalizedSource}:${userId}:${course.id}`;

  // A matrícula é uma visão agregada do acesso. Cada origem recebe sua própria
  // concessão para que um estorno nunca apague uma liberação pastoral/manual ou
  // uma segunda compra válida do mesmo curso.
  await context.DB.prepare(`INSERT INTO app_enrollment_grants
    (id, grant_key, user_id, course_id, source, checkout_id, status,
      suspension_reason, suspended_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)
    ON CONFLICT (grant_key) DO UPDATE SET
      status = 'active',
      suspension_reason = NULL,
      suspended_at = NULL,
      updated_at = excluded.updated_at`)
    .bind(createId('eng'), grantKey, userId, course.id, normalizedSource,
      normalizedCheckoutId, timestamp, timestamp)
    .run();

  await context.DB.prepare(`INSERT INTO app_enrollments
    (id, user_id, course_id, status, source, checkout_id, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT (user_id, course_id) DO UPDATE SET
      status = 'active',
      updated_at = excluded.updated_at`)
    .bind(id, userId, course.id, normalizedSource, normalizedCheckoutId, timestamp, timestamp)
    .run();
  const enrollment = await first(context.DB.prepare(`SELECT
    id, course_id, status, created_at
    FROM app_enrollments WHERE user_id = ? AND course_id = ?`)
    .bind(userId, course.id));
  const progressRow = await first(context.DB.prepare(
    'SELECT version FROM app_progress WHERE user_id = ? AND course_id = ?',
  ).bind(userId, course.id));
  if (!progressRow) {
    await context.DB.prepare(`INSERT INTO app_progress
      (user_id, course_id, snapshot_json, version, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (user_id, course_id) DO NOTHING`)
      .bind(userId, course.id, JSON.stringify(initialProgress(course)), timestamp)
      .run();
  }
  return {
    id: enrollment.id,
    courseId: enrollment.course_id,
    status: enrollment.status,
    enrolledAt: enrollment.created_at,
  };
}

async function handleStudentState(request, context) {
  const user = await requireSession(request, context);
  const enrollmentRows = await all(context.DB.prepare(`SELECT course_id
    FROM app_enrollments
    WHERE user_id = ? AND status = 'active'
    ORDER BY created_at ASC`)
    .bind(user.id));
  const progressRows = await all(context.DB.prepare(`SELECT course_id, snapshot_json
    FROM app_progress WHERE user_id = ?`)
    .bind(user.id));
  const activeIds = new Set(enrollmentRows.map(row => row.course_id));
  const progress = {};
  for (const row of progressRows) {
    if (!activeIds.has(row.course_id)) continue;
    try { progress[row.course_id] = JSON.parse(row.snapshot_json); }
    catch { progress[row.course_id] = null; }
  }
  return json({
    enrollments: [...activeIds],
    progress,
  });
}

async function handleProgressSync(request, context, courseId) {
  const user = await requireSession(request, context);
  const id = safeIdentifier(courseId);
  if (!id) throw new ApplicationError(404, 'course_not_found', 'Curso não encontrado.');
  const enrollment = await first(context.DB.prepare(`SELECT id
    FROM app_enrollments
    WHERE user_id = ? AND course_id = ? AND status = 'active'`)
    .bind(user.id, id));
  if (!enrollment) throw new ApplicationError(403, 'enrollment_required', 'A matrícula ativa é necessária.');
  const course = await getPublishedCourse(context.DB, id);
  await requireCoursePrerequisites(context.DB, user, course);
  const payload = await readJson(request, 512 * 1_024);
  const row = await first(context.DB.prepare(`SELECT snapshot_json, version
    FROM app_progress WHERE user_id = ? AND course_id = ?`)
    .bind(user.id, id));
  let existing;
  try { existing = row ? JSON.parse(row.snapshot_json) : initialProgress(course); }
  catch { existing = initialProgress(course); }
  const verifiedVideoLessonIds = await completedVideoLessonIds(context.DB, user.id, course);
  const progress = synchronizeProgress(course, existing, payload.progress, { verifiedVideoLessonIds });
  const timestamp = nowIso();
  if (row) {
    const nextVersion = Number(row.version || 1) + 1;
    const result = await context.DB.prepare(`UPDATE app_progress
      SET snapshot_json = ?, version = ?, updated_at = ?
      WHERE user_id = ? AND course_id = ? AND version = ?`)
      .bind(JSON.stringify(progress), nextVersion, timestamp, user.id, id, Number(row.version || 1))
      .run();
    if (runChanges(result) !== 1) {
      throw new ApplicationError(409, 'progress_conflict', 'O progresso mudou em outra sessão. Atualize e tente novamente.');
    }
    await recordCourseCompletion(context.DB, user.id, course, progress);
    return json({ success: true, progress, version: nextVersion });
  }
  await context.DB.prepare(`INSERT INTO app_progress
    (user_id, course_id, snapshot_json, version, updated_at)
    VALUES (?, ?, ?, 1, ?)`)
    .bind(user.id, id, JSON.stringify(progress), timestamp)
    .run();
  await recordCourseCompletion(context.DB, user.id, course, progress);
  return json({ success: true, progress, version: 1 });
}

async function videoProgressAccess(request, context, courseId, lessonId) {
  const user = await requireSession(request, context);
  const safeCourseId = safeIdentifier(courseId);
  const safeLessonId = safeIdentifier(lessonId);
  if (!safeCourseId || !safeLessonId) {
    throw new ApplicationError(404, 'video_not_found', 'Vídeo não encontrado.');
  }
  const enrollment = await first(context.DB.prepare(`SELECT id
    FROM app_enrollments
    WHERE user_id = ? AND course_id = ? AND status = 'active'`)
    .bind(user.id, safeCourseId));
  if (!enrollment) {
    throw new ApplicationError(403, 'enrollment_required', 'A matrícula ativa é necessária.');
  }
  const course = await getPublishedCourse(context.DB, safeCourseId);
  await requireCoursePrerequisites(context.DB, user, course);
  const lesson = courseLesson(course, safeLessonId);
  if (!lesson || !lessonRequirements(lesson).hasVideo) {
    throw new ApplicationError(404, 'video_not_found', 'Vídeo não encontrado.');
  }
  const progressRow = await first(context.DB.prepare(`SELECT snapshot_json, version
    FROM app_progress WHERE user_id = ? AND course_id = ?`)
    .bind(user.id, safeCourseId));
  const existingProgress = parseJsonObject(progressRow?.snapshot_json, initialProgress(course));
  const verifiedVideoLessonIds = await completedVideoLessonIds(context.DB, user.id, course);
  const progress = synchronizeProgress(course, existingProgress, existingProgress, { verifiedVideoLessonIds });
  const lessonProgress = progress.lessons?.[safeLessonId];
  const requirements = lessonRequirements(lesson);
  if (!lessonProgress?.unlocked) {
    throw new ApplicationError(403, 'lesson_locked', 'Conclua a lição anterior primeiro.');
  }
  if (requirements.hasPdf && !lessonProgress.pdfRead) {
    throw new ApplicationError(409, 'pdf_required', 'Conclua a apostila antes de assistir ao vídeo.');
  }
  return {
    user,
    course,
    lesson,
    progress,
    progressRow,
    lessonProgress,
    safeCourseId,
    safeLessonId,
    provider: videoProvider(lesson),
    sourceKey: videoSourceKey(lesson),
    verifiedVideoLessonIds,
  };
}

async function handleVideoProgress(request, context, courseId, lessonId) {
  const access = await videoProgressAccess(request, context, courseId, lessonId);
  const url = new URL(request.url);
  const requestedCycle = videoTrackingCycle(url.searchParams.get('cycle'), 1);
  const existingRow = await first(context.DB.prepare(`SELECT
    source_key, provider, tracking_cycle, duration_seconds, watched_seconds,
    percentage, last_position_seconds, intervals_json, completed_at, updated_at
    FROM app_video_progress
    WHERE user_id = ? AND course_id = ? AND lesson_id = ?`)
    .bind(access.user.id, access.safeCourseId, access.safeLessonId));

  if (request.method === 'GET') {
    const usable = existingRow
      && existingRow.source_key === access.sourceKey
      && Number(existingRow.tracking_cycle || 1) >= requestedCycle;
    return json({
      tracking: publicVideoTracking(usable ? existingRow : null, {
        provider: access.provider,
        trackingCycle: requestedCycle,
      }),
      videoCompleted: Boolean(access.lessonProgress.videoCompleted),
    });
  }

  const payload = await readJson(request, 64 * 1_024);
  const incomingCycle = videoTrackingCycle(payload.trackingCycle, requestedCycle);
  if (
    existingRow
    && existingRow.source_key === access.sourceKey
    && Number(existingRow.tracking_cycle || 1) > incomingCycle
  ) {
    return json({
      success: true,
      tracking: publicVideoTracking(existingRow),
      videoCompleted: Boolean(access.lessonProgress.videoCompleted),
    });
  }

  const reset = !existingRow
    || existingRow.source_key !== access.sourceKey
    || Number(existingRow.tracking_cycle || 1) < incomingCycle;
  const previousDuration = reset ? 0 : finiteVideoSeconds(existingRow.duration_seconds);
  const duration = Math.max(previousDuration, finiteVideoSeconds(payload.durationSeconds));
  const previousIntervals = reset
    ? []
    : parseVideoIntervals(existingRow.intervals_json, duration);
  const incomingIntervals = normalizeVideoIntervals(payload.intervals, duration, { incoming: true });
  const intervals = mergeVideoIntervals([...previousIntervals, ...incomingIntervals], duration);
  const watched = Math.min(duration || VIDEO_TRACKING_MAX_DURATION_SECONDS, watchedVideoSeconds(intervals));
  const percentage = duration > 0 ? Math.min(100, watched / duration * 100) : 0;
  const wasCompleted = !reset && Boolean(existingRow.completed_at);
  const ended = payload.ended === true;
  const completed = wasCompleted
    || (ended && percentage >= VIDEO_COMPLETION_THRESHOLD * 100);
  const timestamp = nowIso();
  const completedAt = completed ? (wasCompleted ? existingRow.completed_at : timestamp) : null;
  const lastPosition = Math.min(
    duration || VIDEO_TRACKING_MAX_DURATION_SECONDS,
    finiteVideoSeconds(payload.lastPositionSeconds, reset ? 0 : existingRow.last_position_seconds),
  );

  let synchronizedProgress = null;
  const operation = async DB => {
    await DB.prepare(`INSERT INTO app_video_progress (
      user_id, course_id, lesson_id, source_key, provider, tracking_cycle,
      duration_seconds, watched_seconds, percentage, last_position_seconds,
      intervals_json, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, course_id, lesson_id) DO UPDATE SET
      source_key = excluded.source_key,
      provider = excluded.provider,
      tracking_cycle = excluded.tracking_cycle,
      duration_seconds = excluded.duration_seconds,
      watched_seconds = excluded.watched_seconds,
      percentage = excluded.percentage,
      last_position_seconds = excluded.last_position_seconds,
      intervals_json = excluded.intervals_json,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`)
      .bind(
        access.user.id,
        access.safeCourseId,
        access.safeLessonId,
        access.sourceKey,
        access.provider,
        incomingCycle,
        duration,
        watched,
        percentage,
        lastPosition,
        JSON.stringify(intervals),
        completedAt,
        timestamp,
      )
      .run();

    if (!completed) return;
    const currentRow = await first(DB.prepare(`SELECT snapshot_json, version
      FROM app_progress WHERE user_id = ? AND course_id = ?`)
      .bind(access.user.id, access.safeCourseId));
    const current = parseJsonObject(currentRow?.snapshot_json, initialProgress(access.course));
    const proposed = {
      lessons: {
        [access.safeLessonId]: {
          videoCompleted: true,
          reWatchedAfterExhaustion: true,
        },
      },
    };
    const next = synchronizeProgress(access.course, current, proposed, {
      verifiedVideoLessonIds: new Set([access.safeLessonId]),
      // Uma nova conclusão no ciclo atual é a única prova válida de que uma
      // revisão após tentativas esgotadas realmente aconteceu.
      verifiedVideoRewatchLessonIds: !wasCompleted
        ? new Set([access.safeLessonId])
        : new Set(),
    });
    if (JSON.stringify(next) === JSON.stringify(current)) {
      synchronizedProgress = current;
      return;
    }
    const version = Number(currentRow?.version || 1);
    const result = await DB.prepare(`UPDATE app_progress
      SET snapshot_json = ?, version = ?, updated_at = ?
      WHERE user_id = ? AND course_id = ? AND version = ?`)
      .bind(
        JSON.stringify(next),
        version + 1,
        timestamp,
        access.user.id,
        access.safeCourseId,
        version,
      )
      .run();
    if (runChanges(result) !== 1) {
      throw new ApplicationError(
        409,
        'progress_conflict',
        'O progresso mudou em outra sessão. Atualize e tente novamente.',
      );
    }
    synchronizedProgress = next;
  };

  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else await operation(context.DB);

  const stored = await first(context.DB.prepare(`SELECT
    source_key, provider, tracking_cycle, duration_seconds, watched_seconds,
    percentage, last_position_seconds, intervals_json, completed_at, updated_at
    FROM app_video_progress
    WHERE user_id = ? AND course_id = ? AND lesson_id = ?`)
    .bind(access.user.id, access.safeCourseId, access.safeLessonId));
  return json({
    success: true,
    tracking: publicVideoTracking(stored),
    videoCompleted: Boolean(synchronizedProgress?.lessons?.[access.safeLessonId]?.videoCompleted)
      || Boolean(access.lessonProgress.videoCompleted),
  });
}


function lessonQuizQuestions(lesson) {
  return Array.isArray(lesson?.quiz)
    ? lesson.quiz
    : Array.isArray(lesson?.quiz?.questions)
      ? lesson.quiz.questions
      : [];
}

function correctOptionFor(question, options) {
  const candidates = [
    question.correctOptionId,
    question.correctOption,
    question.correctAnswer,
    question.answer,
    question.correctIndex,
  ];
  options.forEach((option, index) => {
    if (option?.correct === true || option?.isCorrect === true) candidates.push(index);
  });
  const matches = new Set();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const option = Number.isInteger(candidate)
      ? options[candidate]
      : options.find(item => candidate === item?.id || candidate === item?.text);
    if (option?.id) matches.add(option.id);
  }
  if (matches.size !== 1) {
    throw new ApplicationError(500, 'invalid_quiz_configuration', 'O gabarito deste teste precisa ser revisado.');
  }
  return [...matches][0];
}

function gradeQuizAttempt(lesson, rawAnswers, rules) {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) {
    throw new ApplicationError(422, 'invalid_quiz_answers', 'Envie uma alternativa para cada questão.');
  }
  const questions = lessonQuizQuestions(lesson);
  if (questions.length !== rules.questionCount) {
    throw new ApplicationError(500, 'invalid_quiz_configuration', 'A quantidade de questões do teste está inconsistente.');
  }
  const expectedIds = new Set(questions.map(question => safeIdentifier(question?.id)));
  if (expectedIds.has('') || expectedIds.size !== questions.length) {
    throw new ApplicationError(500, 'invalid_quiz_configuration', 'Os identificadores das questões precisam ser revisados.');
  }
  const submittedIds = Object.keys(rawAnswers);
  if (
    submittedIds.length !== questions.length
    || submittedIds.some(questionId => !expectedIds.has(questionId))
  ) {
    throw new ApplicationError(422, 'invalid_quiz_answers', 'Responda todas as questões deste teste uma única vez.');
  }

  let score = 0;
  const graded = [];
  for (const question of questions) {
    const options = Array.isArray(question.options) ? question.options : [];
    const chosenOptionId = safeIdentifier(rawAnswers[question.id]);
    if (!chosenOptionId || !options.some(option => option?.id === chosenOptionId)) {
      throw new ApplicationError(422, 'invalid_quiz_answers', 'Uma das alternativas enviadas não pertence ao teste.');
    }
    const correctOptionId = correctOptionFor(question, options);
    const isCorrect = chosenOptionId === correctOptionId;
    if (isCorrect) score += 1;
    graded.push({
      questionId: question.id,
      chosenOptionId,
      correctOptionId,
      isCorrect,
      explanation: String(question.explanation || '').slice(0, 2_000),
    });
  }
  return { questions, score, graded };
}

function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function findQuizAttempt(DB, userId, idempotencyKey) {
  return first(DB.prepare(`SELECT
    id, course_id, lesson_id, score, question_count, attempts_used, passed, status, results_json
    FROM app_quiz_attempts
    WHERE user_id = ? AND idempotency_key = ?`)
    .bind(userId, idempotencyKey));
}

async function quizProgressRow(DB, userId, courseId) {
  return first(DB.prepare(`SELECT snapshot_json, version
    FROM app_progress WHERE user_id = ? AND course_id = ?`)
    .bind(userId, courseId));
}

function quizAttemptResponse(attempt, progressRow, idempotent = false) {
  const progress = parseJsonObject(progressRow?.snapshot_json, null);
  const results = parseJsonObject(attempt.results_json);
  return json({
    success: true,
    attemptId: attempt.id,
    idempotent,
    score: Number(attempt.score),
    total: Number(attempt.question_count),
    passed: Boolean(Number(attempt.passed)),
    attemptsUsed: Number(attempt.attempts_used),
    status: attempt.status,
    results,
    progress,
    version: Number(progressRow?.version || 1),
  });
}

async function respondToRepeatedQuizAttempt(DB, userId, courseId, lessonId, idempotencyKey) {
  const attempt = await findQuizAttempt(DB, userId, idempotencyKey);
  if (!attempt) return null;
  if (attempt.course_id !== courseId || attempt.lesson_id !== lessonId) {
    throw new ApplicationError(
      409,
      'idempotency_key_reused',
      'Esta chave de envio já foi usada em outro teste.',
    );
  }
  const progressRow = await quizProgressRow(DB, userId, courseId);
  return quizAttemptResponse(attempt, progressRow, true);
}

async function handleQuizAttempt(request, context, courseId, lessonId) {
  const user = await requireSession(request, context);
  const safeCourseId = safeIdentifier(courseId);
  const safeLessonId = safeIdentifier(lessonId);
  if (!safeCourseId || !safeLessonId) {
    throw new ApplicationError(404, 'quiz_not_found', 'Teste não encontrado.');
  }
  const idempotencyKey = String(request.headers.get('idempotency-key') || '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(idempotencyKey)) {
    throw new ApplicationError(
      400,
      'idempotency_key_required',
      'O envio do teste precisa de uma chave de segurança válida.',
    );
  }
  const repeated = await respondToRepeatedQuizAttempt(
    context.DB,
    user.id,
    safeCourseId,
    safeLessonId,
    idempotencyKey,
  );
  if (repeated) return repeated;

  const enrollment = await first(context.DB.prepare(`SELECT id
    FROM app_enrollments
    WHERE user_id = ? AND course_id = ? AND status = 'active'`)
    .bind(user.id, safeCourseId));
  if (!enrollment) {
    throw new ApplicationError(403, 'enrollment_required', 'A matrícula ativa é necessária.');
  }
  const course = await getPublishedCourse(context.DB, safeCourseId);
  await requireCoursePrerequisites(context.DB, user, course);
  const lessons = orderedLessons(course);
  const lessonIndex = lessons.findIndex(item => item.id === safeLessonId);
  if (lessonIndex < 0) throw new ApplicationError(404, 'quiz_not_found', 'Teste não encontrado.');
  const lesson = lessons[lessonIndex];
  const requirements = lessonRequirements(lesson);
  if (!requirements.hasQuiz) {
    throw new ApplicationError(404, 'quiz_not_found', 'Esta lição não possui teste.');
  }
  const rules = quizRules(course, lesson);
  const payload = await readJson(request, 128 * 1_024);
  const grading = gradeQuizAttempt(lesson, payload.answers, rules);
  const run = async (DB) => {
    const inTransactionRepeat = await respondToRepeatedQuizAttempt(
      DB,
      user.id,
      safeCourseId,
      safeLessonId,
      idempotencyKey,
    );
    if (inTransactionRepeat) return inTransactionRepeat;

    const row = await quizProgressRow(DB, user.id, safeCourseId);
    let existing;
    try { existing = row ? JSON.parse(row.snapshot_json) : initialProgress(course); }
    catch { existing = initialProgress(course); }
    const verifiedVideoLessonIds = await completedVideoLessonIds(DB, user.id, course);
    const progress = synchronizeProgress(course, existing, existing, { verifiedVideoLessonIds });
    const lessonProgress = progress.lessons?.[safeLessonId];
    if (
      !lessonProgress?.unlocked
      || (requirements.hasPdf && !lessonProgress.pdfRead)
      || (requirements.hasVideo && !lessonProgress.videoCompleted)
      || !['available', 'failed'].includes(lessonProgress.quizStatus)
      || lessonProgress.quizAttemptsUsed >= rules.maxAttempts
    ) {
      throw new ApplicationError(
        409,
        'quiz_not_available',
        'Conclua as etapas anteriores ou revise o material antes de tentar novamente.',
      );
    }

    lessonProgress.quizAttemptsUsed += 1;
    lessonProgress.quizScore = grading.score;
    const passed = grading.score >= rules.passingScore;
    if (passed) {
      lessonProgress.quizStatus = 'passed';
      lessonProgress.lessonCompleted = true;
      const nextLesson = lessons[lessonIndex + 1];
      if (nextLesson && progress.lessons[nextLesson.id]) progress.lessons[nextLesson.id].unlocked = true;
    } else if (lessonProgress.quizAttemptsUsed >= rules.maxAttempts) {
      lessonProgress.quizStatus = 'exhausted';
      lessonProgress.lessonCompleted = false;
      lessonProgress.reReadAfterExhaustion = false;
      lessonProgress.reWatchedAfterExhaustion = false;
    } else {
      lessonProgress.quizStatus = 'failed';
      lessonProgress.lessonCompleted = false;
    }
    progress.reconciledAt = nowIso();

    const terminal = passed || lessonProgress.quizStatus === 'exhausted';
    const results = Object.fromEntries(grading.graded.map(result => [
      result.questionId,
      {
        chosen: result.chosenOptionId,
        isCorrect: result.isCorrect,
        ...(terminal ? {
          correctOptionId: result.correctOptionId,
          explanation: result.explanation,
        } : {}),
      },
    ]));
    const timestamp = nowIso();
    const nextVersion = Number(row?.version || 0) + 1;
    if (row) {
      const update = await DB.prepare(`UPDATE app_progress
        SET snapshot_json = ?, version = ?, updated_at = ?
        WHERE user_id = ? AND course_id = ? AND version = ?`)
        .bind(
          JSON.stringify(progress),
          nextVersion,
          timestamp,
          user.id,
          safeCourseId,
          Number(row.version),
        )
        .run();
      if (runChanges(update) !== 1) {
        throw new ApplicationError(409, 'progress_conflict', 'O progresso mudou em outra sessão. Atualize e tente novamente.');
      }
    } else {
      const insert = await DB.prepare(`INSERT INTO app_progress
        (user_id, course_id, snapshot_json, version, updated_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT (user_id, course_id) DO NOTHING`)
        .bind(user.id, safeCourseId, JSON.stringify(progress), timestamp)
        .run();
      if (runChanges(insert) !== 1) {
        throw new ApplicationError(409, 'progress_conflict', 'O progresso mudou em outra sessão. Atualize e tente novamente.');
      }
    }

    await recordCourseCompletion(DB, user.id, course, progress);

    const attempt = {
      id: createId('qat'),
      course_id: safeCourseId,
      lesson_id: safeLessonId,
      score: grading.score,
      question_count: grading.questions.length,
      attempts_used: lessonProgress.quizAttemptsUsed,
      passed: passed ? 1 : 0,
      status: lessonProgress.quizStatus,
      results_json: JSON.stringify(results),
    };
    await DB.prepare(`INSERT INTO app_quiz_attempts
      (id, user_id, course_id, lesson_id, idempotency_key, score, question_count, attempts_used,
       passed, status, answers_json, results_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        attempt.id,
        user.id,
        safeCourseId,
        safeLessonId,
        idempotencyKey,
        attempt.score,
        attempt.question_count,
        attempt.attempts_used,
        attempt.passed,
        attempt.status,
        JSON.stringify(payload.answers),
        attempt.results_json,
        timestamp,
      )
      .run();
    return quizAttemptResponse(attempt, {
      snapshot_json: JSON.stringify(progress),
      version: nextVersion,
    });
  };

  try {
    return typeof context.DB.transaction === 'function'
      ? await context.DB.transaction(run)
      : await run(context.DB);
  } catch (error) {
    if (/UNIQUE constraint failed|duplicate key/i.test(String(error?.message || error))) {
      const recovered = await respondToRepeatedQuizAttempt(
        context.DB,
        user.id,
        safeCourseId,
        safeLessonId,
        idempotencyKey,
      );
      if (recovered) return recovered;
    }
    throw error;
  }
}

function coursePricing(course) {
  const fullPrice = Number(course?.pricing?.fullPrice || 0);
  if (!Number.isFinite(fullPrice) || fullPrice < 0 || fullPrice > 1_000_000) {
    throw new ApplicationError(422, 'invalid_course_price', 'O preço do curso está inválido.');
  }
  return {
    amountCents: Math.round(fullPrice * 100),
    currency: String(course?.pricing?.currency || 'BRL').toUpperCase() === 'BRL' ? 'BRL' : 'BRL',
    methods: Array.isArray(course?.pricing?.paymentMethods)
      ? course.pricing.paymentMethods.filter(method => PAYMENT_METHODS.has(method))
      : [...PAYMENT_METHODS],
  };
}

function applyTestCoupon(amountCents, couponCode, config) {
  const code = String(couponCode || '').trim().toUpperCase();
  if (!code) return { amountCents, couponCode: null };
  const rule = config.testCoupons[code];
  if (!rule) throw new ApplicationError(422, 'invalid_coupon', 'Código Beta inválido ou indisponível.');
  const percent = Math.max(0, Math.min(100, Number(rule.percent || 0)));
  const fixedCents = Math.max(0, safeInteger(rule.fixedCents));
  const discount = fixedCents || Math.round(amountCents * percent / 100);
  return { amountCents: Math.max(0, amountCents - discount), couponCode: code };
}

const CHECKOUT_COLUMNS = `id, user_id, course_id, status, currency, amount_cents,
  payment_method, coupon_code, idempotency_key, provider, provider_mode,
  provider_preference_id, provider_order_id, provider_payment_id, provider_checkout_url,
  last_provider_sync_at, created_at, updated_at`;

async function existingCheckout(context, userId, idempotencyKey) {
  if (!idempotencyKey) return null;
  return first(context.DB.prepare(`SELECT ${CHECKOUT_COLUMNS}
    FROM app_checkouts WHERE user_id = ? AND idempotency_key = ?`)
    .bind(userId, idempotencyKey));
}

async function checkoutById(context, checkoutId) {
  const id = String(checkoutId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{7,99}$/i.test(id)) return null;
  return first(context.DB.prepare(`SELECT ${CHECKOUT_COLUMNS}
    FROM app_checkouts WHERE id = ?`).bind(id));
}

function isUniqueConstraintError(error) {
  const code = String(error?.code || '').toUpperCase();
  return error?.name === 'DatabaseConstraintError'
    || code === '23505'
    || code.startsWith('SQLITE_CONSTRAINT')
    || /duplicate key|unique constraint|constraint failed.*unique/i.test(
      String(error?.message || ''),
    );
}

async function checkoutTransaction(context, callback) {
  if (typeof context.DB?.transaction !== 'function') return callback(context);
  return context.DB.transaction(async (transaction) => callback({
    ...context,
    DB: transaction || context.DB,
  }));
}

function assertIdempotentCheckoutMatches(checkout, course, paymentMethod) {
  if (
    checkout.course_id !== course.id
    || checkout.payment_method !== paymentMethod
  ) {
    throw new ApplicationError(
      409,
      'idempotency_conflict',
      'Esta chave de idempotência já foi usada em outra compra.',
    );
  }
}

function validMercadoPagoUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && /(^|\.)mercadopago\.com(?:\.br)?$/i.test(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

async function mercadoPagoRequest(context, path, {
  method = 'GET',
  body,
  idempotencyKey,
} = {}) {
  if (!context.config.paymentAccessToken) {
    throw new ApplicationError(
      503,
      'checkout_not_configured',
      'A credencial do Mercado Pago ainda não foi configurada.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    context.config.paymentTimeoutMs,
  );

  try {
    const response = await context.config.paymentFetch(
      `https://api.mercadopago.com${path}`,
      {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${context.config.paymentAccessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey ? { 'X-Idempotency-Key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Mercado Pago API request failed', {
        path,
        status: response.status,
        cause: String(payload?.cause?.[0]?.code || payload?.error || 'unknown'),
      });
      throw new ApplicationError(
        502,
        'payment_provider_error',
        'O Mercado Pago não conseguiu iniciar ou confirmar o pagamento.',
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApplicationError(
        504,
        'payment_provider_timeout',
        'O Mercado Pago demorou para responder. Tente novamente.',
      );
    }
    throw new ApplicationError(
      502,
      'payment_provider_unavailable',
      'Não foi possível conectar ao Mercado Pago.',
    );
  } finally {
    clearTimeout(timer);
  }
}

function mercadoPagoReturnUrl(context, status, checkoutId) {
  const url = new URL('/', context.config.appOrigin);
  url.searchParams.set('payment', status);
  url.searchParams.set('checkout', checkoutId);
  return url.href;
}

async function createMercadoPagoOrder(context, user, course, checkout) {
  const amount = (Number(checkout.amount_cents) / 100).toFixed(2);
  const payerEmail = context.config.checkoutMode === 'test'
    ? context.config.paymentTestPayerEmail
    : user.email;
  const body = {
    type: 'online',
    processing_mode: 'manual',
    total_amount: amount,
    external_reference: checkout.id,
    description: String(course.title || 'Curso Beta').slice(0, 120),
    items: [{
      external_code: course.id,
      title: String(course.title || 'Curso Beta').slice(0, 120),
      description: String(course.subtitle || course.description || '').slice(0, 250),
      quantity: 1,
      unit_price: amount,
    }],
    payer: {
      email: payerEmail,
    },
    config: {
      online: {
        success_url: mercadoPagoReturnUrl(context, 'success', checkout.id),
        pending_url: mercadoPagoReturnUrl(context, 'pending', checkout.id),
        failure_url: mercadoPagoReturnUrl(context, 'failure', checkout.id),
        auto_return: 'approved',
      },
    },
  };

  const order = await mercadoPagoRequest(
    context,
    '/v1/orders',
    {
      method: 'POST',
      body,
      idempotencyKey: checkout.id,
    },
  );

  const checkoutUrl = validMercadoPagoUrl(order.checkout_url);
  const orderId = String(order.id || '').trim();
  if (!/^ORD[A-Z0-9]{8,80}$/i.test(orderId) || !checkoutUrl) {
    throw new ApplicationError(
      502,
      'invalid_payment_provider_response',
      'O Mercado Pago respondeu sem um link de pagamento válido.',
    );
  }
  return { orderId, checkoutUrl };
}

function mercadoPagoStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['approved', 'processed'].includes(status)) return 'approved';
  if (['created', 'pending', 'in_process', 'authorized', 'action_required', 'processing'].includes(status)) return 'pending';
  if (['rejected', 'failed'].includes(status)) return 'rejected';
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled';
  if (status === 'refunded') return 'refunded';
  if (status === 'charged_back') return 'charged_back';
  return 'pending';
}

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyMercadoPagoSignature(request, dataId, secret) {
  if (!secret) return false;
  const signature = String(request.headers.get('x-signature') || '');
  const requestId = String(request.headers.get('x-request-id') || '').trim();
  const values = Object.fromEntries(
    signature.split(',').map(part => part.trim().split('=', 2)),
  );
  const timestamp = String(values.ts || '').trim();
  const received = String(values.v1 || '').trim().toLowerCase();
  if (!timestamp || !requestId || !received || !dataId) return false;
  const normalizedDataId = /^[a-z0-9]+$/i.test(dataId)
    ? dataId.toLowerCase()
    : dataId;
  const manifest = `id:${normalizedDataId};request-id:${requestId};ts:${timestamp};`;
  const expected = createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');
  return equalHex(expected, received);
}

async function synchronizeMercadoPagoOrder(context, orderId, {
  expectedCheckoutId,
  expectedUserId,
} = {}) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!/^ORD[A-Z0-9]{8,80}$/i.test(normalizedOrderId)) {
    throw new ApplicationError(422, 'invalid_order_id', 'Identificação do pedido inválida.');
  }

  const order = await mercadoPagoRequest(
    context,
    `/v1/orders/${encodeURIComponent(normalizedOrderId)}`,
  );
  const externalReference = String(order.external_reference || '').trim();
  const checkout = await checkoutById(context, externalReference);
  if (!checkout || checkout.provider !== 'mercado_pago') {
    throw new ApplicationError(404, 'checkout_not_found', 'Compra não encontrada.');
  }
  if (expectedCheckoutId && checkout.id !== expectedCheckoutId) {
    throw new ApplicationError(409, 'order_checkout_mismatch', 'O pedido não pertence a esta compra.');
  }
  if (expectedUserId && checkout.user_id !== expectedUserId) {
    throw new ApplicationError(403, 'checkout_forbidden', 'Esta compra pertence a outra conta.');
  }

  const receivedCents = Math.round(Number(order.total_amount || 0) * 100);
  const receivedCurrency = String(order.currency || '').toUpperCase();
  if (
    receivedCents !== Number(checkout.amount_cents)
    || receivedCurrency !== checkout.currency
  ) {
    throw new ApplicationError(
      409,
      'payment_amount_mismatch',
      'O valor confirmado pelo Mercado Pago não corresponde à compra.',
    );
  }

  const nextStatus = mercadoPagoStatus(order.status);
  const providerPaymentId = String(order.transactions?.payments?.[0]?.id || '').trim() || null;
  const timestamp = nowIso();
  const course = nextStatus === 'approved'
    ? await getCourseForEnrollment(context.DB, checkout.course_id)
    : null;

  return checkoutTransaction(context, async transactionContext => {
    await transactionContext.DB.prepare(`UPDATE app_checkouts SET
      status = ?,
      provider_order_id = ?,
      provider_payment_id = ?,
      last_provider_sync_at = ?,
      updated_at = ?
      WHERE id = ?`)
      .bind(
        nextStatus,
        normalizedOrderId,
        providerPaymentId,
        timestamp,
        timestamp,
        checkout.id,
      )
      .run();

    if (nextStatus === 'approved') {
      await ensureEnrollment(
        transactionContext,
        checkout.user_id,
        course,
        'mercado_pago',
        checkout.id,
      );
    } else if (PAYMENT_ACCESS_REVOKING_STATUSES.has(nextStatus)) {
      await suspendCheckoutEnrollment(
        transactionContext,
        checkout,
        nextStatus,
        timestamp,
      );
    }
    return checkoutById(transactionContext, checkout.id);
  });
}

async function checkoutResponse(context, userId, checkout) {
  const enrollment = await first(context.DB.prepare(`SELECT
    id, course_id, status, created_at
    FROM app_enrollments WHERE user_id = ? AND course_id = ?`)
    .bind(userId, checkout.course_id));
  return json({
    success: checkout.status === 'approved',
    status: checkout.status,
    testMode: checkout.provider_mode === 'test',
    enrollment: enrollment ? {
      id: enrollment.id,
      courseId: enrollment.course_id,
      status: enrollment.status,
      enrolledAt: enrollment.created_at,
    } : null,
    checkout: {
      id: checkout.id,
      courseId: checkout.course_id,
      amountCents: Number(checkout.amount_cents),
      currency: checkout.currency,
      paymentMethod: checkout.payment_method,
      checkoutUrl: checkout.provider_checkout_url || null,
      provider: checkout.provider,
      providerMode: checkout.provider_mode,
    },
  });
}

async function restoreCheckoutResult(context, userId, checkout, course) {
  if (checkout.status === 'approved') {
    await ensureEnrollment(context, userId, course, checkout.provider, checkout.id);
  }
  if (checkout.status === 'creating') {
    throw new ApplicationError(
      409,
      'checkout_processing',
      'A compra ainda está sendo preparada. Aguarde alguns segundos e tente novamente.',
    );
  }
  return checkoutResponse(context, userId, checkout);
}

async function insertCheckout(context, {
  checkoutId,
  userId,
  course,
  pricing,
  discounted,
  method,
  idempotencyKey,
  status,
  provider,
}) {
  const timestamp = nowIso();
  await context.DB.prepare(`INSERT INTO app_checkouts
    (id, user_id, course_id, status, currency, amount_cents, payment_method,
      coupon_code, idempotency_key, provider, provider_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      checkoutId,
      userId,
      course.id,
      status,
      pricing.currency,
      discounted.amountCents,
      method,
      discounted.couponCode,
      idempotencyKey,
      provider,
      context.config.checkoutMode,
      timestamp,
      timestamp,
    )
    .run();
}

async function handleCheckout(request, context) {
  const user = await requireSession(request, context);
  if (
    !['test', 'production'].includes(context.config.checkoutMode)
    || context.config.paymentProvider !== 'mercado_pago'
    || !context.config.paymentAccessToken
  ) {
    throw new ApplicationError(503, 'checkout_not_configured', 'O checkout ainda não foi configurado.');
  }

  const payload = await readJson(request);
  const course = await getPublishedCourse(context.DB, payload.courseId);
  await requireCoursePrerequisites(context.DB, user, course);
  const method = String(payload.paymentMethod || '').trim();
  const pricing = coursePricing(course);
  if (!PAYMENT_METHODS.has(method) || !pricing.methods.includes(method)) {
    throw new ApplicationError(422, 'invalid_payment_method', 'Forma de pagamento indisponível.');
  }

  const idempotencyKey = String(request.headers.get('idempotency-key') || '').trim();
  if (!/^[a-z0-9][a-z0-9._:-]{7,127}$/i.test(idempotencyKey)) {
    throw new ApplicationError(
      422,
      'idempotency_key_required',
      'Não foi possível identificar esta tentativa de compra. Atualize a página e tente novamente.',
    );
  }

  let checkout = await existingCheckout(context, user.id, idempotencyKey);
  if (checkout) {
    assertIdempotentCheckoutMatches(checkout, course, method);
    if (checkout.status !== 'failed') {
      return checkoutTransaction(context, transactionContext => (
        restoreCheckoutResult(transactionContext, user.id, checkout, course)
      ));
    }
    await context.DB.prepare(`UPDATE app_checkouts SET
      status = 'creating',
      provider_preference_id = NULL,
      provider_order_id = NULL,
      provider_payment_id = NULL,
      provider_checkout_url = NULL,
      updated_at = ?
      WHERE id = ?`)
      .bind(nowIso(), checkout.id)
      .run();
    checkout = await checkoutById(context, checkout.id);
  }

  const discounted = applyTestCoupon(
    pricing.amountCents,
    payload.couponCode,
    context.config,
  );

  if (!checkout) {
    const checkoutId = createId('chk');
    try {
      await checkoutTransaction(context, transactionContext => insertCheckout(
        transactionContext,
        {
          checkoutId,
          userId: user.id,
          course,
          pricing,
          discounted,
          method,
          idempotencyKey,
          status: discounted.amountCents === 0 ? 'approved' : 'creating',
          provider: discounted.amountCents === 0 ? 'internal_coupon' : 'mercado_pago',
        },
      ));
      checkout = await checkoutById(context, checkoutId);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      checkout = await existingCheckout(context, user.id, idempotencyKey);
      if (!checkout) throw error;
      assertIdempotentCheckoutMatches(checkout, course, method);
      if (!['creating', 'failed'].includes(checkout.status)) {
        return restoreCheckoutResult(context, user.id, checkout, course);
      }
    }
  }

  if (discounted.amountCents === 0) {
    return checkoutTransaction(context, async transactionContext => {
      await ensureEnrollment(
        transactionContext,
        user.id,
        course,
        'internal_coupon',
        checkout.id,
      );
      return checkoutResponse(
        transactionContext,
        user.id,
        await checkoutById(transactionContext, checkout.id),
      );
    });
  }

  try {
    const order = await createMercadoPagoOrder(
      context,
      user,
      course,
      checkout,
    );
    const timestamp = nowIso();
    await context.DB.prepare(`UPDATE app_checkouts SET
      status = 'pending',
      provider_order_id = ?,
      provider_checkout_url = ?,
      updated_at = ?
      WHERE id = ?`)
      .bind(
        order.orderId,
        order.checkoutUrl,
        timestamp,
        checkout.id,
      )
      .run();
    return checkoutResponse(
      context,
      user.id,
      await checkoutById(context, checkout.id),
    );
  } catch (error) {
    await context.DB.prepare(`UPDATE app_checkouts SET
      status = 'failed',
      updated_at = ?
      WHERE id = ?`)
      .bind(nowIso(), checkout.id)
      .run()
      .catch(() => {});
    throw error;
  }
}

async function handleCheckoutStatus(request, context, checkoutId) {
  const user = await requireSession(request, context);
  let checkout = await checkoutById(context, checkoutId);
  if (!checkout) throw new ApplicationError(404, 'checkout_not_found', 'Compra não encontrada.');
  if (checkout.user_id !== user.id) {
    throw new ApplicationError(403, 'checkout_forbidden', 'Esta compra pertence a outra conta.');
  }

  const url = new URL(request.url);
  const orderId = String(url.searchParams.get('order_id') || '').trim();

  if (orderId) {
    checkout = await synchronizeMercadoPagoOrder(context, orderId, {
      expectedCheckoutId: checkout.id,
      expectedUserId: user.id,
    });
  } else if (checkout.provider_order_id && checkout.status === 'pending') {
    checkout = await synchronizeMercadoPagoOrder(
      context,
      checkout.provider_order_id,
      {
        expectedCheckoutId: checkout.id,
        expectedUserId: user.id,
      },
    );
  }

  return checkoutResponse(context, user.id, checkout);
}

async function handleMercadoPagoWebhook(request, context) {
  const url = new URL(request.url);
  const payload = await readJson(request);
  const orderId = String(
    url.searchParams.get('data.id')
      || payload?.data?.id
      || '',
  ).trim();
  const type = String(url.searchParams.get('type') || payload?.type || '').toLowerCase();

  if (type !== 'order' || !orderId) return empty(200);
  if (!verifyMercadoPagoSignature(
    request,
    String(url.searchParams.get('data.id') || orderId),
    context.config.paymentWebhookSecret,
  )) {
    throw new ApplicationError(
      401,
      'invalid_webhook_signature',
      'Assinatura de notificação inválida.',
    );
  }

  try {
    await synchronizeMercadoPagoOrder(context, orderId);
  } catch (error) {
    if (
      error instanceof ApplicationError
      && ['checkout_not_found', 'order_checkout_mismatch'].includes(error.code)
    ) {
      console.warn('Mercado Pago webhook ignored', {
        orderId,
        reason: error.code,
      });
      return empty(200);
    }
    throw error;
  }
  return empty(200);
}

function progressStatus(percentage, completedLessons, totalLessons, hasActivity = false) {
  if (totalLessons > 0 && completedLessons >= totalLessons) return 'completed';
  if (percentage > 0 || hasActivity) return 'in_progress';
  return 'not_started';
}

function summarizeProgress(snapshot, {
  totalLessons,
  course = null,
  enrolledAt = null,
  updatedAt = null,
} = {}) {
  const lessons = Object.values(snapshot?.lessons || {});
  const knownTotal = Math.max(0, Number(totalLessons ?? lessons.length) || 0);
  const completedLessons = lessons.filter(lesson => lesson?.lessonCompleted).length;
  const percentage = knownTotal ? Math.round(completedLessons / knownTotal * 100) : 0;
  const current = lessons.find(lesson => lesson?.unlocked && !lesson?.lessonCompleted);
  const courseLessons = orderedLessons(course);
  const hasActivity = completedLessons > 0 || courseLessons.some(lesson => {
    const state = snapshot?.lessons?.[lesson.id] || {};
    const requirements = lessonRequirements(lesson);
    return Boolean(
      (requirements.hasPdf && state.pdfRead)
      || (requirements.hasVideo && state.videoCompleted)
      || (requirements.hasQuiz && Number(state.quizAttemptsUsed || 0) > 0)
    );
  });
  return {
    completedLessons,
    totalLessons: knownTotal,
    currentLesson: current?.lessonId || null,
    percentage,
    status: progressStatus(percentage, completedLessons, knownTotal, hasActivity),
    enrolledAt,
    updatedAt,
  };
}

function adminCourseModules(course, snapshot, attemptsByLesson, videoTrackingByLesson = new Map()) {
  return (Array.isArray(course?.modules) ? course.modules : [])
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((module, moduleIndex) => {
      const lessons = (Array.isArray(module?.lessons) ? module.lessons : [])
        .slice()
        .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
        .map((lesson, lessonIndex) => {
          const requirements = lessonRequirements(lesson);
          const progress = snapshot?.lessons?.[lesson.id] || {};
          const rules = quizRules(course, lesson);
          const attempts = attemptsByLesson.get(lesson.id) || [];
          const latestAttempt = attempts[0] || null;
          const videoTracking = videoTrackingByLesson.get(lesson.id) || null;
          let status = 'not_started';
          if (progress.lessonCompleted) status = 'completed';
          else if (!progress.unlocked) status = 'locked';
          else if (
            progress.pdfRead
            || progress.videoCompleted
            || Number(progress.quizAttemptsUsed || 0) > 0
          ) status = 'in_progress';
          else status = 'available';
          return {
            id: lesson.id,
            title: lesson.title || `Lição ${lessonIndex + 1}`,
            order: Number(lesson.order || lessonIndex + 1),
            status,
            unlocked: Boolean(progress.unlocked),
            completed: Boolean(progress.lessonCompleted),
            materials: {
              hasPdf: requirements.hasPdf,
              pdfRead: requirements.hasPdf ? Boolean(progress.pdfRead) : null,
              hasVideo: requirements.hasVideo,
              videoCompleted: requirements.hasVideo ? Boolean(progress.videoCompleted) : null,
              videoTracking: requirements.hasVideo && videoTracking ? {
                provider: videoTracking.provider,
                percentage: Number(videoTracking.percentage || 0),
                watchedSeconds: Number(videoTracking.watched_seconds || 0),
                durationSeconds: Number(videoTracking.duration_seconds || 0),
                lastPositionSeconds: Number(videoTracking.last_position_seconds || 0),
                completedAt: videoTracking.completed_at || null,
                updatedAt: videoTracking.updated_at || null,
              } : null,
            },
            quiz: {
              hasQuiz: requirements.hasQuiz,
              status: requirements.hasQuiz ? String(progress.quizStatus || 'locked') : null,
              score: requirements.hasQuiz && progress.quizScore != null
                ? Number(progress.quizScore)
                : null,
              questionCount: rules.questionCount,
              passingScore: rules.passingScore,
              attemptsUsed: requirements.hasQuiz ? Number(progress.quizAttemptsUsed || 0) : 0,
              maxAttempts: rules.maxAttempts,
              latestAttemptAt: latestAttempt?.created_at || null,
              attempts: attempts.map(attempt => ({
                score: Number(attempt.score),
                questionCount: Number(attempt.question_count),
                attemptsUsed: Number(attempt.attempts_used),
                passed: Boolean(Number(attempt.passed)),
                status: attempt.status,
                createdAt: attempt.created_at,
              })),
            },
          };
        });
      const completedLessons = lessons.filter(lesson => lesson.completed).length;
      return {
        id: module.id || `module-${moduleIndex + 1}`,
        title: module.title || `Módulo ${moduleIndex + 1}`,
        order: Number(module.order || moduleIndex + 1),
        completedLessons,
        totalLessons: lessons.length,
        percentage: lessons.length ? Math.round(completedLessons / lessons.length * 100) : 0,
        lessons,
      };
    });
}

async function handleAdminStudents(request, context) {
  const administrator = await requireSession(request, context);
  requireAdmin(administrator);
  const url = new URL(request.url);
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase().slice(0, 100);
  const courseFilter = safeIdentifier(url.searchParams.get('courseId') || '');
  const limit = positiveInteger(url.searchParams.get('limit'), 500, 1, 500);
  const pattern = `%${search.replace(/[\%_]/g, '\$&')}%`;
  const users = await all(context.DB.prepare(`SELECT
    id, email, full_name, member_code, account_status, disabled_at, disabled_by, last_access_at
    FROM app_users
    WHERE role = 'student'
      AND (? = '' OR LOWER(full_name) LIKE ? ESCAPE '\' OR LOWER(email) LIKE ? ESCAPE '\' OR LOWER(COALESCE(member_code, '')) LIKE ? ESCAPE '\')
    ORDER BY full_name ASC
    LIMIT ?`)
    .bind(search, pattern, pattern, pattern, limit));
  const userIds = new Set(users.map(user => user.id));
  const rows = userIds.size
    ? await all(context.DB.prepare(`SELECT
        e.user_id,
        e.course_id,
        e.created_at,
        e.updated_at AS enrollment_updated_at,
        p.snapshot_json,
        p.updated_at AS progress_updated_at,
        c.data_json AS course_data_json
      FROM app_enrollments e
      JOIN courses c ON c.id = e.course_id
      LEFT JOIN app_progress p ON p.user_id = e.user_id AND p.course_id = e.course_id
      WHERE e.status = 'active'
      ORDER BY e.created_at ASC`))
    : [];
  const byUser = new Map(users.map(user => [user.id, {
    id: user.id,
    name: user.full_name,
    email: user.email,
    memberCode: user.member_code || null,
    accountStatus: normalizeAccountStatus(user.account_status),
    disabledAt: user.disabled_at || null,
    disabledBy: user.disabled_by || null,
    enrolledAt: null,
    lastAccess: user.last_access_at || null,
    progress: {},
  }]));
  for (const row of rows) {
    if (!userIds.has(row.user_id)) continue;
    if (courseFilter && row.course_id !== courseFilter) continue;
    const student = byUser.get(row.user_id);
    student.enrolledAt ||= row.created_at;
    const course = parseJsonObject(row.course_data_json, {});
    const totalLessons = orderedLessons(course).length;
    const options = {
      totalLessons,
      course,
      enrolledAt: row.created_at,
      updatedAt: row.progress_updated_at || row.enrollment_updated_at || row.created_at,
    };
    try {
      student.progress[row.course_id] = summarizeProgress(
        JSON.parse(row.snapshot_json || '{}'),
        options,
      );
    } catch {
      student.progress[row.course_id] = summarizeProgress(null, options);
    }
  }
  const students = [...byUser.values()].filter(student => !courseFilter || student.progress[courseFilter]);
  return json({ students });
}

async function handleAdminStudentProgress(request, context, studentId) {
  const administrator = await requireSession(request, context);
  requireAdmin(administrator);
  const id = safeIdentifier(studentId);
  if (!id) throw new ApplicationError(404, 'student_not_found', 'Aluno não encontrado.');
  const student = await first(context.DB.prepare(`SELECT
    id, email, full_name, member_code, account_status, disabled_at, disabled_by, created_at, last_access_at
    FROM app_users
    WHERE id = ? AND role = 'student'`)
    .bind(id));
  if (!student) throw new ApplicationError(404, 'student_not_found', 'Aluno não encontrado.');

  const enrollmentRows = await all(context.DB.prepare(`SELECT
    e.course_id,
    e.status AS enrollment_status,
    e.created_at AS enrolled_at,
    e.updated_at AS enrollment_updated_at,
    c.status AS course_status,
    c.data_json AS course_data_json,
    p.snapshot_json,
    p.version AS progress_version,
    p.updated_at AS progress_updated_at
    FROM app_enrollments e
    JOIN courses c ON c.id = e.course_id
    LEFT JOIN app_progress p ON p.user_id = e.user_id AND p.course_id = e.course_id
    WHERE e.user_id = ?
    ORDER BY e.created_at DESC`)
    .bind(id));
  const attemptRows = await all(context.DB.prepare(`SELECT
    course_id, lesson_id, score, question_count, attempts_used, passed, status, created_at
    FROM app_quiz_attempts
    WHERE user_id = ?
    ORDER BY created_at DESC`)
    .bind(id));
  const videoRows = await all(context.DB.prepare(`SELECT
    course_id, lesson_id, provider, duration_seconds, watched_seconds,
    percentage, last_position_seconds, completed_at, updated_at
    FROM app_video_progress
    WHERE user_id = ?
    ORDER BY updated_at DESC`)
    .bind(id));
  const attemptsByCourse = new Map();
  for (const attempt of attemptRows) {
    if (!attemptsByCourse.has(attempt.course_id)) attemptsByCourse.set(attempt.course_id, new Map());
    const byLesson = attemptsByCourse.get(attempt.course_id);
    if (!byLesson.has(attempt.lesson_id)) byLesson.set(attempt.lesson_id, []);
    byLesson.get(attempt.lesson_id).push(attempt);
  }

  const videoByCourse = new Map();
  for (const tracking of videoRows) {
    if (!videoByCourse.has(tracking.course_id)) videoByCourse.set(tracking.course_id, new Map());
    videoByCourse.get(tracking.course_id).set(tracking.lesson_id, tracking);
  }

  const courses = enrollmentRows.map(row => {
    const course = parseJsonObject(row.course_data_json, {});
    const snapshot = parseJsonObject(row.snapshot_json, { lessons: {} });
    const modules = adminCourseModules(
      course,
      snapshot,
      attemptsByCourse.get(row.course_id) || new Map(),
      videoByCourse.get(row.course_id) || new Map(),
    );
    const totalLessons = modules.reduce((sum, module) => sum + module.totalLessons, 0);
    const completedLessons = modules.reduce((sum, module) => sum + module.completedLessons, 0);
    const percentage = totalLessons ? Math.round(completedLessons / totalLessons * 100) : 0;
    const courseLessons = modules.flatMap(module => module.lessons);
    const currentLesson = courseLessons.find(lesson => lesson.unlocked && !lesson.completed);
    const hasActivity = courseLessons.some(lesson => ['in_progress', 'completed'].includes(lesson.status));
    return {
      id: row.course_id,
      title: course.title || row.course_id,
      status: row.course_status || course.status || 'draft',
      enrollmentStatus: row.enrollment_status,
      enrolledAt: row.enrolled_at,
      startedAt: snapshot.startedAt || null,
      updatedAt: row.progress_updated_at || row.enrollment_updated_at || row.enrolled_at,
      progressVersion: Number(row.progress_version || 1),
      completedLessons,
      totalLessons,
      percentage,
      progressStatus: progressStatus(percentage, completedLessons, totalLessons, hasActivity),
      currentLesson: currentLesson
        ? { id: currentLesson.id, title: currentLesson.title }
        : null,
      modules,
    };
  });

  return json({
    student: {
      id: student.id,
      name: student.full_name,
      email: student.email,
      memberCode: student.member_code || null,
      accountStatus: normalizeAccountStatus(student.account_status),
      disabledAt: student.disabled_at || null,
      disabledBy: student.disabled_by || null,
      registeredAt: student.created_at,
      lastAccess: student.last_access_at || null,
    },
    courses,
  });
}

async function findManagedStudent(context, administrator, studentId) {
  const id = safeIdentifier(studentId);
  if (!id) throw new ApplicationError(404, 'student_not_found', 'Aluno não encontrado.');
  const student = await first(context.DB.prepare(`SELECT
    id, email, full_name, role, account_status, disabled_at, disabled_by
    FROM app_users
    WHERE id = ?`)
    .bind(id));
  if (!student) throw new ApplicationError(404, 'student_not_found', 'Aluno não encontrado.');
  if (student.id === administrator.id) {
    throw new ApplicationError(409, 'self_account_management_forbidden', 'Você não pode alterar o acesso da própria conta.');
  }
  const effectiveRole = bootstrapRoleForEmail(context.config, student.email, student.role);
  if (effectiveRole !== 'student') {
    throw new ApplicationError(409, 'protected_account', 'Contas administrativas não podem ser alteradas por esta ação.');
  }
  return student;
}

async function handleAdminStudentAccess(request, context, studentId, action) {
  const administrator = await requireSession(request, context);
  requireStudentManager(administrator);
  const student = await findManagedStudent(context, administrator, studentId);
  const timestamp = nowIso();

  if (action === 'deactivate') {
    if (normalizeAccountStatus(student.account_status) === 'disabled') {
      return json({
        success: true,
        student: {
          id: student.id,
          email: student.email,
          accountStatus: 'disabled',
          disabledAt: student.disabled_at || null,
          disabledBy: student.disabled_by || null,
        },
      });
    }
    const operation = async DB => {
      await DB.prepare(`UPDATE app_users
        SET account_status = 'disabled', disabled_at = ?, disabled_by = ?, updated_at = ?
        WHERE id = ? AND role = 'student'`)
        .bind(timestamp, administrator.email, timestamp, student.id)
        .run();
      await DB.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(student.id).run();
      await DB.prepare(`DELETE FROM app_auth_tokens
        WHERE user_id = ? OR lower(email) = ?`)
        .bind(student.id, normalizeEmail(student.email))
        .run();
    };
    if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
    else await operation(context.DB);
    await recordAdministrativeAudit(
      context.DB,
      administrator.email,
      'deactivate',
      'student',
      student.id,
      { email: student.email },
    );
    return json({
      success: true,
      student: {
        id: student.id,
        email: student.email,
        accountStatus: 'disabled',
        disabledAt: timestamp,
        disabledBy: administrator.email,
      },
    });
  }

  if (action === 'reactivate') {
    const operation = async DB => {
      await DB.prepare(`UPDATE app_users
        SET account_status = 'active', disabled_at = NULL, disabled_by = NULL, updated_at = ?
        WHERE id = ? AND role = 'student'`)
        .bind(timestamp, student.id)
        .run();
      await DB.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(student.id).run();
    };
    if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
    else await operation(context.DB);
    await recordAdministrativeAudit(
      context.DB,
      administrator.email,
      'reactivate',
      'student',
      student.id,
      { email: student.email },
    );
    return json({
      success: true,
      student: {
        id: student.id,
        email: student.email,
        accountStatus: 'active',
        disabledAt: null,
        disabledBy: null,
      },
    });
  }

  throw new ApplicationError(400, 'invalid_account_action', 'Ação de acesso inválida.');
}

async function handleAdminStudentDelete(request, context, studentId) {
  const administrator = await requireSession(request, context);
  requireOwner(administrator);
  const student = await findManagedStudent(context, administrator, studentId);
  const payload = await readJson(request);
  const confirmedEmail = normalizeEmail(payload.confirmEmail);
  if (!confirmedEmail || confirmedEmail !== normalizeEmail(student.email)) {
    throw new ApplicationError(
      422,
      'delete_confirmation_mismatch',
      'Digite exatamente o e-mail do aluno para confirmar a exclusão definitiva.',
    );
  }

  const operation = async DB => {
    await DB.prepare(`DELETE FROM app_auth_tokens
      WHERE user_id = ? OR lower(email) = ?`)
      .bind(student.id, normalizeEmail(student.email))
      .run();
    await DB.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_quiz_attempts WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_video_progress WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_progress WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_course_completions WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_enrollments WHERE user_id = ?').bind(student.id).run();
    await DB.prepare('DELETE FROM app_checkouts WHERE user_id = ?').bind(student.id).run();
    const deleted = await DB.prepare(`DELETE FROM app_users
      WHERE id = ? AND role = 'student'`)
      .bind(student.id)
      .run();
    if (runChanges(deleted) !== 1) {
      throw new ApplicationError(409, 'student_delete_conflict', 'A conta mudou antes da exclusão. Atualize o painel e tente novamente.');
    }
  };
  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else await operation(context.DB);
  await recordAdministrativeAudit(
    context.DB,
    administrator.email,
    'delete',
    'student',
    student.id,
    { emailHash: hashOpaqueToken(normalizeEmail(student.email)) },
  );
  return empty(204);
}

function serializeTeamMember(row, config) {
  const configuredRole = config
    ? bootstrapRoleForEmail(config, row.email, 'student')
    : 'student';
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    role: safeRole(row.role),
    accountStatus: normalizeAccountStatus(row.account_status),
    emailVerified: Boolean(row.email_verified_at),
    lastAccess: row.last_access_at || null,
    createdAt: row.created_at,
    roleManagedByConfig: ['owner', 'admin'].includes(configuredRole),
  };
}

async function suspendCheckoutEnrollment(context, checkout, paymentStatus, timestamp) {
  if (!PAYMENT_ACCESS_REVOKING_STATUSES.has(paymentStatus)) return null;
  const grantKey = `checkout:${checkout.id}`;
  await context.DB.prepare(`UPDATE app_enrollment_grants SET
    status = 'suspended',
    suspension_reason = ?,
    suspended_at = COALESCE(suspended_at, ?),
    updated_at = ?
    WHERE grant_key = ? AND user_id = ? AND course_id = ?`)
    .bind(`payment_${paymentStatus}`, timestamp, timestamp, grantKey,
      checkout.user_id, checkout.course_id)
    .run();

  const activeGrant = await first(context.DB.prepare(`SELECT id
    FROM app_enrollment_grants
    WHERE user_id = ? AND course_id = ? AND status = 'active'
    LIMIT 1`).bind(checkout.user_id, checkout.course_id));

  // Only change the aggregate enrollment when no other valid origin remains.
  // This keeps manual/pastoral access and a separate approved payment intact.
  await context.DB.prepare(`UPDATE app_enrollments SET
    status = ?, updated_at = ?
    WHERE user_id = ? AND course_id = ?`)
    .bind(activeGrant ? 'active' : 'suspended', timestamp,
      checkout.user_id, checkout.course_id)
    .run();

  return activeGrant;
}

async function handleAdminTeam(request, context) {
  const owner = await requireSession(request, context);
  requireOwner(owner);
  const result = await all(context.DB.prepare(`SELECT
    id, email, full_name, role, account_status, email_verified_at, last_access_at, created_at
    FROM app_users
    WHERE is_demo = 0
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'facilitator' THEN 2 ELSE 3 END,
      full_name ASC
    LIMIT 1000`));
  return json({ members: result.map(member => serializeTeamMember(member, context.config)) });
}

async function handleAdminTeamRole(request, context, memberId) {
  const owner = await requireSession(request, context);
  requireOwner(owner);
  const id = safeIdentifier(memberId);
  if (!id) throw new ApplicationError(404, 'team_member_not_found', 'Conta não encontrada.');
  const payload = await readJson(request);
  const role = String(payload.role || '').trim().toLowerCase();
  if (!ASSIGNABLE_TEAM_ROLES.has(role)) {
    throw new ApplicationError(422, 'invalid_team_role', 'Escolha aluno, facilitador ou administrador.');
  }
  const member = await first(context.DB.prepare(`SELECT
    id, email, full_name, role, account_status, email_verified_at, last_access_at, created_at
    FROM app_users WHERE id = ?`)
    .bind(id));
  if (!member) throw new ApplicationError(404, 'team_member_not_found', 'Conta não encontrada.');
  if (member.id === owner.id || safeRole(member.role) === 'owner') {
    throw new ApplicationError(409, 'owner_role_protected', 'A conta proprietária não pode ter a função alterada.');
  }
  if (bootstrapRoleForEmail(context.config, member.email, 'student') === 'admin') {
    throw new ApplicationError(
      409,
      'role_managed_by_configuration',
      'Esta conta é administradora pela configuração do servidor. Altere a variável BOOTSTRAP_ADMIN_EMAILS.',
    );
  }
  const timestamp = nowIso();
  const operation = async DB => {
    await DB.prepare('UPDATE app_users SET role = ?, updated_at = ? WHERE id = ?')
      .bind(role, timestamp, member.id)
      .run();
    if (role === 'admin') {
      await DB.prepare(`INSERT INTO admins
        (email, full_name, role, created_at, updated_at, created_by)
        VALUES (?, ?, 'admin', ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          full_name = excluded.full_name,
          role = 'admin',
          updated_at = excluded.updated_at,
          created_by = excluded.created_by`)
        .bind(member.email, member.full_name, timestamp, timestamp, owner.email)
        .run();
    } else {
      await DB.prepare("DELETE FROM admins WHERE email = ? AND role <> 'owner'")
        .bind(member.email)
        .run();
    }
  };
  if (typeof context.DB.transaction === 'function') await context.DB.transaction(operation);
  else await operation(context.DB);
  await recordAdministrativeAudit(
    context.DB,
    owner.email,
    'change_role',
    'team_member',
    member.id,
    { from: safeRole(member.role), to: role },
  );
  return json({ member: serializeTeamMember({ ...member, role }, context.config) });
}

async function dispatchApplicationApi(request, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'OPTIONS') return null;
  validateUnsafeOrigin(request, context.config);

  if (path === '/api/courses') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handlePublicCatalog(request, context);
  }
  if (path === '/api/auth/register') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleRegister(request, context);
  }
  if (path === '/api/auth/email/resend') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    if (!context.config.registrationEnabled || !context.config.emailVerificationRequired) {
      throw new ApplicationError(404, 'registration_confirmation_disabled', 'A confirmação de cadastro não está disponível.');
    }
    return handleRegistrationRequest(request, context);
  }
  if (path === '/api/auth/complete-registration') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleCompleteRegistration(request, context);
  }
  if (path === '/api/auth/password/forgot') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleForgotPassword(request, context);
  }
  if (path === '/api/auth/password/reset') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleResetPassword(request, context);
  }
  if (path === '/api/auth/login') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleLogin(request, context);
  }
  if (path === '/api/auth/session') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const user = context.session === undefined
      ? await resolveSession(request, context)
      : context.session;
    if (!user) {
      return json({
        authenticated: false,
        features: publicFeatures(context.config),
      }, 401);
    }
    return json({
      authenticated: true,
      user,
      features: publicFeatures(context.config),
    });
  }
  if (path === '/api/auth/logout') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    await revokeRequestSession(request, context);
    return empty(204, { 'Set-Cookie': clearSessionCookie(context.config) });
  }
  if (path === '/api/auth/demo') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return ensureDemoUser(request, context);
  }
  if (path === '/api/me/state') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleStudentState(request, context);
  }
  const videoProgressMatch = path.match(/^\/api\/me\/video-progress\/([a-z0-9][a-z0-9_-]{0,95})\/([a-z0-9][a-z0-9_-]{0,95})$/i);
  if (videoProgressMatch) {
    if (!['GET', 'PUT'].includes(request.method)) return methodNotAllowed(['GET', 'PUT']);
    return handleVideoProgress(request, context, videoProgressMatch[1], videoProgressMatch[2]);
  }
  const quizMatch = path.match(/^\/api\/me\/quiz\/([a-z0-9][a-z0-9_-]{0,95})\/([a-z0-9][a-z0-9_-]{0,95})\/attempt$/i);
  if (quizMatch) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleQuizAttempt(request, context, quizMatch[1], quizMatch[2]);
  }
  const progressMatch = path.match(/^\/api\/me\/progress\/([a-z0-9][a-z0-9_-]{0,95})$/i);
  if (progressMatch) {
    if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
    return handleProgressSync(request, context, decodeURIComponent(progressMatch[1]));
  }
  if (path === '/api/webhooks/mercado-pago') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleMercadoPagoWebhook(request, context);
  }
  if (path === '/api/checkouts') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleCheckout(request, context);
  }
  const checkoutStatusMatch = path.match(/^\/api\/checkouts\/([a-z0-9][a-z0-9_-]{7,99})$/i);
  if (checkoutStatusMatch) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleCheckoutStatus(request, context, checkoutStatusMatch[1]);
  }
  if (path === '/api/admin/students') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleAdminStudents(request, context);
  }
  if (path === '/api/admin/team') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleAdminTeam(request, context);
  }
  const adminTeamRoleMatch = path.match(/^\/api\/admin\/team\/([a-z0-9][a-z0-9_-]{0,95})\/role$/i);
  if (adminTeamRoleMatch) {
    if (request.method !== 'PATCH') return methodNotAllowed(['PATCH']);
    return handleAdminTeamRole(request, context, adminTeamRoleMatch[1]);
  }
  const adminStudentDeactivateMatch = path.match(/^\/api\/admin\/students\/([a-z0-9][a-z0-9_-]{0,95})\/deactivate$/i);
  if (adminStudentDeactivateMatch) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleAdminStudentAccess(request, context, adminStudentDeactivateMatch[1], 'deactivate');
  }
  const adminStudentReactivateMatch = path.match(/^\/api\/admin\/students\/([a-z0-9][a-z0-9_-]{0,95})\/reactivate$/i);
  if (adminStudentReactivateMatch) {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleAdminStudentAccess(request, context, adminStudentReactivateMatch[1], 'reactivate');
  }
  const adminStudentDeleteMatch = path.match(/^\/api\/admin\/students\/([a-z0-9][a-z0-9_-]{0,95})$/i);
  if (adminStudentDeleteMatch) {
    if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
    return handleAdminStudentDelete(request, context, adminStudentDeleteMatch[1]);
  }
  const adminStudentProgressMatch = path.match(/^\/api\/admin\/students\/([a-z0-9][a-z0-9_-]{0,95})\/progress$/i);
  if (adminStudentProgressMatch) {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleAdminStudentProgress(request, context, adminStudentProgressMatch[1]);
  }
  return null;
}

function methodNotAllowed(methods) {
  return json({
    error: {
      code: 'method_not_allowed',
      message: 'Método não permitido.',
    },
  }, 405, { Allow: methods.join(', ') });
}

export async function canAccessCourseContent(DB, user, courseId) {
  if (ADMIN_ROLES.has(user?.role)) return true;
  const course = await getPublishedCourse(DB, courseId, false);
  if (!course) return false;
  const decision = await resolveCourseAccess(DB, user, course);
  return decision.allowed;
}

export async function handleApplicationApi(request, {
  DB,
  config = {},
  session,
  emailSender,
} = {}) {
  const url = new URL(request.url);
  const knownPrefix = [
    '/api/courses',
    '/api/auth/',
    '/api/me/',
    '/api/checkouts',
    '/api/webhooks/mercado-pago',
    '/api/admin/students',
    '/api/admin/team',
  ].some(prefix => url.pathname === prefix.replace(/\/$/, '') || url.pathname.startsWith(prefix));
  if (!knownPrefix) return null;
  const context = {
    DB,
    config: applicationConfig(config),
    emailSender,
    ...(session === undefined ? {} : { session }),
  };
  try {
    await ensureApplicationSchema(DB);
    return await dispatchApplicationApi(request, context);
  } catch (error) {
    return errorResponse(error);
  }
}
