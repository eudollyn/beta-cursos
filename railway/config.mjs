import { randomBytes } from 'node:crypto';
import { isAbsolute, parse, relative, resolve } from 'node:path';

const LOCAL_SESSION_SECRET = randomBytes(32).toString('base64url');
const APP_ENVIRONMENTS = new Set(['local', 'test', 'staging', 'production']);
const NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);
const STORAGE_DRIVERS = new Set(['filesystem', 's3']);
const EMAIL_DRIVERS = new Set(['disabled', 'preview', 'resend']);
const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const CHECKOUT_MODES = new Set(['disabled', 'test', 'production']);
const DEMO_ROLES = new Set(['student', 'admin']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export class ConfigurationError extends Error {
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues.filter(Boolean) : [String(issues || '')].filter(Boolean);
    super(`Configuração inválida:\n- ${normalized.join('\n- ')}`);
    this.name = 'ConfigurationError';
    this.issues = normalized;
  }
}

function firstValue(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function enumValue(value, allowed, fallback, field, issues) {
  const normalized = String(value || fallback || '').trim().toLowerCase();
  if (!allowed.has(normalized)) {
    issues.push(`${field} deve ser um destes valores: ${[...allowed].join(', ')}.`);
    return fallback;
  }
  return normalized;
}

function booleanValue(value, fallback, field, issues) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  issues.push(`${field} deve ser true ou false.`);
  return fallback;
}

function integerValue(value, fallback, field, issues, { min, max }) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    issues.push(`${field} deve ser um número inteiro entre ${min} e ${max}.`);
    return fallback;
  }
  return parsed;
}

function normalizedOrigin(value, field, issues, { requireHttps = false } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    if (url.pathname !== '/' || url.search || url.hash) {
      issues.push(`${field} deve conter somente a origem, sem caminho, consulta ou fragmento.`);
    }
    if (requireHttps && url.protocol !== 'https:') issues.push(`${field} deve usar HTTPS.`);
    return url.origin;
  } catch {
    issues.push(`${field} deve ser uma origem HTTP ou HTTPS válida.`);
    return '';
  }
}

function normalizedEndpoint(value, field, issues, { requireHttps = false } = {}) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    if (requireHttps && url.protocol !== 'https:') issues.push(`${field} deve usar HTTPS.`);
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/+$/, '');
  } catch {
    issues.push(`${field} deve ser um endereço HTTP ou HTTPS válido.`);
    return '';
  }
}

function normalizedMailbox(value, field, issues, { required = false } = {}) {
  const mailbox = String(value || '').trim();
  if (!mailbox) {
    if (required) issues.push(`${field} é obrigatório.`);
    return '';
  }
  if (mailbox.length > 320 || /[\r\n]/.test(mailbox)) {
    issues.push(`${field} contém caracteres inválidos.`);
    return '';
  }
  const bracketed = mailbox.match(/<([^<>]+)>\s*$/);
  const address = String(bracketed?.[1] || mailbox).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
    issues.push(`${field} deve conter um endereço de e-mail válido.`);
    return '';
  }
  return mailbox;
}

function normalizedDatabaseUrl(value, issues, { allowSqlite = false } = {}) {
  if (allowSqlite && /^(?:sqlite:|file:)/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error();
    return value;
  } catch {
    issues.push('DATABASE_URL deve ser uma URL válida do PostgreSQL.');
    return '';
  }
}

function normalizedPrefix(value, issues) {
  const prefix = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix) return '';
  const parts = prefix.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part))) {
    issues.push('S3_PREFIX deve conter somente segmentos de caminho seguros.');
    return '';
  }
  return prefix;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isWithinPath(root, target) {
  const child = relative(root, target);
  return child === '' || (!child.startsWith('..') && !parse(child).root);
}

export function loadConfig(env = process.env, options = {}) {
  const issues = [];
  const cwd = resolve(options.cwd || process.cwd());
  const isRailway = Boolean(firstValue(env, [
    'RAILWAY_PROJECT_ID',
    'RAILWAY_ENVIRONMENT_ID',
    'RAILWAY_SERVICE_ID',
  ]));
  const railwayEnvironment = firstValue(env, ['RAILWAY_ENVIRONMENT_NAME']).toLowerCase();
  const inferredAppEnvironment = railwayEnvironment === 'production'
    ? 'production'
    : isRailway
      ? 'staging'
      : 'local';
  const appEnv = enumValue(env.APP_ENV, APP_ENVIRONMENTS, inferredAppEnvironment, 'APP_ENV', issues);
  const inferredNodeEnvironment = ['staging', 'production'].includes(appEnv) || isRailway
    ? 'production'
    : appEnv === 'test'
      ? 'test'
      : 'development';
  const nodeEnv = enumValue(env.NODE_ENV, NODE_ENVIRONMENTS, inferredNodeEnvironment, 'NODE_ENV', issues);
  const isHosted = isRailway || ['staging', 'production'].includes(appEnv);
  const railwayFreeVolumeModeRequested = booleanValue(
    env.RAILWAY_FREE_VOLUME_MODE,
    false,
    'RAILWAY_FREE_VOLUME_MODE',
    issues,
  );
  const rawVolumeMountPath = firstValue(env, ['RAILWAY_VOLUME_MOUNT_PATH']);
  const volumeMountPath = rawVolumeMountPath ? resolve(rawVolumeMountPath) : '';
  const railwayFreeVolumeMode = railwayFreeVolumeModeRequested
    && isRailway
    && ['staging', 'production'].includes(appEnv);
  if (railwayFreeVolumeModeRequested && !isRailway) {
    issues.push('RAILWAY_FREE_VOLUME_MODE só pode ser usado dentro do Railway.');
  }
  if (railwayFreeVolumeModeRequested && !['staging', 'production'].includes(appEnv)) {
    issues.push('RAILWAY_FREE_VOLUME_MODE exige APP_ENV=staging ou production.');
  }
  if (railwayFreeVolumeModeRequested && !rawVolumeMountPath) {
    issues.push('RAILWAY_FREE_VOLUME_MODE exige um volume anexado ao serviço.');
  }
  if (rawVolumeMountPath && !isAbsolute(rawVolumeMountPath)) {
    issues.push('RAILWAY_VOLUME_MOUNT_PATH deve ser um caminho absoluto.');
  }
  if (volumeMountPath && volumeMountPath === parse(volumeMountPath).root) {
    issues.push('RAILWAY_VOLUME_MOUNT_PATH não pode apontar para a raiz do sistema.');
  }

  const port = integerValue(env.PORT, 3000, 'PORT', issues, { min: 1, max: 65535 });
  const host = firstValue(env, ['HOST']) || '0.0.0.0';
  if (!['0.0.0.0', '::', '127.0.0.1', 'localhost'].includes(host)) {
    issues.push('HOST deve ser 0.0.0.0, ::, 127.0.0.1 ou localhost.');
  }
  if (isRailway && !['0.0.0.0', '::'].includes(host)) {
    issues.push('No Railway, HOST deve ser 0.0.0.0 ou ::.');
  }

  const localOrigin = `http://127.0.0.1:${port}`;
  const rawAppOrigin = firstValue(env, ['APP_ORIGIN', 'PUBLIC_APP_ORIGIN']) || localOrigin;
  if (isHosted && rawAppOrigin === localOrigin) {
    issues.push('APP_ORIGIN é obrigatório no ambiente hospedado.');
  }
  const appOrigin = normalizedOrigin(rawAppOrigin, 'APP_ORIGIN', issues, { requireHttps: isHosted });
  const allowedOrigins = (firstValue(env, ['ALLOWED_ORIGINS']) || appOrigin)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map((value, index) => normalizedOrigin(value, `ALLOWED_ORIGINS[${index}]`, issues, {
      requireHttps: isHosted,
    }))
    .filter(Boolean);

  const defaultLocalDatabase = appEnv === 'test'
    ? 'sqlite::memory:'
    : 'sqlite:.data/beta-cursos.sqlite';
  const volumeDatabaseUrl = railwayFreeVolumeMode
    ? `sqlite:${resolve(volumeMountPath, 'db', 'beta-cursos.sqlite')}`
    : '';
  const rawDatabaseUrl = firstValue(env, ['DATABASE_URL'])
    || (railwayFreeVolumeMode ? volumeDatabaseUrl : isHosted ? '' : defaultLocalDatabase);
  if (!rawDatabaseUrl) issues.push('DATABASE_URL é obrigatório no ambiente hospedado.');
  const databaseUrl = rawDatabaseUrl
    ? normalizedDatabaseUrl(rawDatabaseUrl, issues, { allowSqlite: !isHosted || railwayFreeVolumeMode })
    : '';
  if (railwayFreeVolumeMode && databaseUrl !== volumeDatabaseUrl) {
    issues.push('No modo gratuito, DATABASE_URL deve usar o arquivo SQLite dentro do volume anexado.');
  }

  const sessionSecret = firstValue(env, ['SESSION_SECRET']) || (isHosted ? '' : LOCAL_SESSION_SECRET);
  if (!sessionSecret) issues.push('SESSION_SECRET é obrigatório no ambiente hospedado.');
  if (sessionSecret && sessionSecret.length < 32) issues.push('SESSION_SECRET deve ter pelo menos 32 caracteres.');
  const sessionTtlDays = integerValue(env.SESSION_TTL_DAYS, 7, 'SESSION_TTL_DAYS', issues, {
    min: 1,
    max: 30,
  });
  const cookieSecure = booleanValue(env.COOKIE_SECURE, isHosted, 'COOKIE_SECURE', issues);
  if (isHosted && !cookieSecure) issues.push('COOKIE_SECURE não pode ser desativado no ambiente hospedado.');
  const cookieName = firstValue(env, ['SESSION_COOKIE_NAME'])
    || (cookieSecure ? '__Host-beta_session' : 'beta_session');
  if (!/^(?:__Host-)?[A-Za-z0-9_-]{1,80}$/.test(cookieName)) {
    issues.push('SESSION_COOKIE_NAME contém caracteres inválidos.');
  }
  if (cookieName.startsWith('__Host-') && !cookieSecure) {
    issues.push('Cookies com prefixo __Host- exigem COOKIE_SECURE=true.');
  }
  const authRateLimitMax = integerValue(
    env.AUTH_RATE_LIMIT_MAX,
    10,
    'AUTH_RATE_LIMIT_MAX',
    issues,
    { min: 1, max: 1_000 },
  );
  const authRateLimitIpMax = integerValue(
    env.AUTH_RATE_LIMIT_IP_MAX,
    30,
    'AUTH_RATE_LIMIT_IP_MAX',
    issues,
    { min: 1, max: 10_000 },
  );
  const authRateLimitWindowMs = integerValue(
    env.AUTH_RATE_LIMIT_WINDOW_MS,
    15 * 60 * 1_000,
    'AUTH_RATE_LIMIT_WINDOW_MS',
    issues,
    { min: 1_000, max: 24 * 60 * 60 * 1_000 },
  );

  const registrationEnabled = booleanValue(
    env.REGISTRATION_ENABLED,
    true,
    'REGISTRATION_ENABLED',
    issues,
  );
  const emailDriver = enumValue(
    env.EMAIL_DRIVER,
    EMAIL_DRIVERS,
    isHosted ? 'disabled' : 'preview',
    'EMAIL_DRIVER',
    issues,
  );
  const emailVerificationRequired = booleanValue(
    env.EMAIL_VERIFICATION_REQUIRED,
    isHosted && registrationEnabled,
    'EMAIL_VERIFICATION_REQUIRED',
    issues,
  );
  const passwordResetEnabled = booleanValue(
    env.PASSWORD_RESET_ENABLED,
    emailDriver !== 'disabled',
    'PASSWORD_RESET_ENABLED',
    issues,
  );
  const emailFrom = normalizedMailbox(
    firstValue(env, ['EMAIL_FROM']) || (!isHosted && emailDriver === 'preview'
      ? 'Beta Cursos <no-reply@beta.local>'
      : ''),
    'EMAIL_FROM',
    issues,
    { required: emailDriver === 'resend' },
  );
  const emailReplyTo = normalizedMailbox(
    firstValue(env, ['EMAIL_REPLY_TO']),
    'EMAIL_REPLY_TO',
    issues,
  );
  const resendApiKey = firstValue(env, ['RESEND_API_KEY']);
  const emailTokenSecret = firstValue(env, ['EMAIL_TOKEN_SECRET']) || (!isHosted ? sessionSecret : '');
  const registrationTokenTtlMinutes = integerValue(
    env.EMAIL_VERIFICATION_TTL_MINUTES,
    24 * 60,
    'EMAIL_VERIFICATION_TTL_MINUTES',
    issues,
    { min: 10, max: 7 * 24 * 60 },
  );
  const passwordResetTtlMinutes = integerValue(
    env.PASSWORD_RESET_TTL_MINUTES,
    30,
    'PASSWORD_RESET_TTL_MINUTES',
    issues,
    { min: 10, max: 24 * 60 },
  );
  const emailTimeoutMs = integerValue(
    env.EMAIL_TIMEOUT_MS,
    10_000,
    'EMAIL_TIMEOUT_MS',
    issues,
    { min: 1_000, max: 30_000 },
  );
  if (isHosted && emailDriver === 'preview') {
    issues.push('EMAIL_DRIVER=preview só pode ser usado localmente.');
  }
  if (emailDriver === 'resend' && !resendApiKey) {
    issues.push('EMAIL_DRIVER=resend exige RESEND_API_KEY.');
  }
  if ((emailVerificationRequired || passwordResetEnabled) && emailDriver === 'disabled') {
    issues.push('Confirmação de e-mail ou recuperação de senha exige um EMAIL_DRIVER ativo.');
  }
  if ((emailVerificationRequired || passwordResetEnabled) && emailTokenSecret.length < 32) {
    issues.push('EMAIL_TOKEN_SECRET deve ter pelo menos 32 caracteres.');
  }
  if (isHosted && emailTokenSecret && emailTokenSecret === sessionSecret) {
    issues.push('EMAIL_TOKEN_SECRET deve ser diferente de SESSION_SECRET no ambiente hospedado.');
  }
  if (isHosted && registrationEnabled && !emailVerificationRequired) {
    issues.push('Ambientes hospedados com cadastro aberto exigem EMAIL_VERIFICATION_REQUIRED=true.');
  }

  const bucket = firstValue(env, [
    'S3_BUCKET',
    'S3_BUCKET_NAME',
    'AWS_S3_BUCKET',
    'AWS_BUCKET_NAME',
    'BUCKET',
  ]);
  const endpointValue = firstValue(env, [
    'S3_ENDPOINT',
    'AWS_S3_ENDPOINT',
    'AWS_ENDPOINT_URL_S3',
    'ENDPOINT',
  ]);
  const regionValue = firstValue(env, [
    'S3_REGION',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'REGION',
  ]);
  const accessKeyId = firstValue(env, [
    'S3_ACCESS_KEY_ID',
    'AWS_ACCESS_KEY_ID',
    'ACCESS_KEY_ID',
  ]);
  const secretAccessKey = firstValue(env, [
    'S3_SECRET_ACCESS_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'SECRET_ACCESS_KEY',
  ]);
  const sessionToken = firstValue(env, [
    'S3_SESSION_TOKEN',
    'AWS_SESSION_TOKEN',
  ]);
  const hasS3Configuration = Boolean(bucket || endpointValue || accessKeyId || secretAccessKey);
  const driverFallback = hasS3Configuration || (isHosted && !railwayFreeVolumeMode) ? 's3' : 'filesystem';
  const storageDriver = enumValue(env.STORAGE_DRIVER, STORAGE_DRIVERS, driverFallback, 'STORAGE_DRIVER', issues);
  const endpoint = normalizedEndpoint(endpointValue, 'S3_ENDPOINT', issues, {
    requireHttps: isHosted,
  });
  const endpointHostname = endpoint ? new URL(endpoint).hostname : '';
  const localS3Endpoint = ['localhost', '127.0.0.1', '::1'].includes(endpointHostname);
  const region = regionValue || (endpoint ? (localS3Endpoint ? 'us-east-1' : 'auto') : '');
  const forcePathStyle = booleanValue(
    firstValue(env, ['S3_FORCE_PATH_STYLE', 'AWS_S3_FORCE_PATH_STYLE']) || undefined,
    localS3Endpoint,
    'S3_FORCE_PATH_STYLE',
    issues,
  );
  const prefix = normalizedPrefix(firstValue(env, ['S3_PREFIX', 'STORAGE_PREFIX']), issues);

  const defaultLocalStoragePath = railwayFreeVolumeMode
    ? resolve(volumeMountPath, 'media')
    : '.data/media';
  const localPath = resolve(
    cwd,
    firstValue(env, ['LOCAL_STORAGE_PATH', 'STORAGE_PATH']) || defaultLocalStoragePath,
  );
  if (localPath === parse(localPath).root) issues.push('LOCAL_STORAGE_PATH não pode apontar para a raiz do sistema.');
  if (storageDriver === 'filesystem' && isHosted && !railwayFreeVolumeMode) {
    issues.push('STORAGE_DRIVER=filesystem não é permitido no ambiente hospedado.');
  }
  if (railwayFreeVolumeMode && storageDriver !== 'filesystem') {
    issues.push('RAILWAY_FREE_VOLUME_MODE exige STORAGE_DRIVER=filesystem.');
  }
  if (railwayFreeVolumeMode && !isWithinPath(volumeMountPath, localPath)) {
    issues.push('No modo gratuito, LOCAL_STORAGE_PATH deve ficar dentro do volume anexado.');
  }
  if (storageDriver === 's3') {
    if (!bucket) issues.push('O armazenamento S3 exige BUCKET ou S3_BUCKET.');
    if (!region) issues.push('O armazenamento S3 exige REGION, AWS_REGION ou S3_REGION.');
    if (!accessKeyId) issues.push('O armazenamento S3 exige ACCESS_KEY_ID ou AWS_ACCESS_KEY_ID.');
    if (!secretAccessKey) issues.push('O armazenamento S3 exige SECRET_ACCESS_KEY ou AWS_SECRET_ACCESS_KEY.');
    if (isRailway && !endpoint) issues.push('Railway Bucket exige ENDPOINT ou S3_ENDPOINT.');
  }

  const logLevel = enumValue(env.LOG_LEVEL, LOG_LEVELS, isHosted ? 'info' : 'debug', 'LOG_LEVEL', issues);
  const healthTimeoutMs = integerValue(env.HEALTHCHECK_TIMEOUT_MS, 3000, 'HEALTHCHECK_TIMEOUT_MS', issues, {
    min: 250,
    max: 30000,
  });
  const ownerEmail = firstValue(env, ['BOOTSTRAP_OWNER_EMAIL']).toLowerCase();
  const adminEmails = [...new Set(
    firstValue(env, ['BOOTSTRAP_ADMIN_EMAILS'])
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  )];
  adminEmails.forEach((email, index) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push(`BOOTSTRAP_ADMIN_EMAILS[${index}] deve ser um endereço de e-mail válido.`);
    }
  });
  if (ownerEmail && adminEmails.includes(ownerEmail)) {
    issues.push('BOOTSTRAP_ADMIN_EMAILS não deve repetir BOOTSTRAP_OWNER_EMAIL.');
  }
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    issues.push('BOOTSTRAP_OWNER_EMAIL deve ser um endereço de e-mail válido.');
  }
  if (isHosted && !ownerEmail) {
    issues.push('BOOTSTRAP_OWNER_EMAIL é obrigatório no ambiente hospedado.');
  }
  const demoAccess = booleanValue(
    env.ENABLE_DEMO_LOGIN,
    !isHosted,
    'ENABLE_DEMO_LOGIN',
    issues,
  );
  const demoRole = enumValue(
    env.DEMO_ROLE,
    DEMO_ROLES,
    isHosted ? 'student' : 'admin',
    'DEMO_ROLE',
    issues,
  );
  if (isHosted && demoRole !== 'student') {
    issues.push('DEMO_ROLE deve ser student em ambientes hospedados.');
  }
    const checkoutMode = enumValue(
    env.CHECKOUT_MODE,
    CHECKOUT_MODES,
    'disabled',
    'CHECKOUT_MODE',
    issues,
  );

  const mercadoPagoTestAccessToken = firstValue(env, [
    'MERCADO_PAGO_ACCESS_TOKEN_TEST',
  ]);

  const mercadoPagoProductionAccessToken = firstValue(env, [
    'MERCADO_PAGO_ACCESS_TOKEN_PROD',
  ]);

  const mercadoPagoAccessToken = checkoutMode === 'test'
    ? mercadoPagoTestAccessToken
    : checkoutMode === 'production'
      ? mercadoPagoProductionAccessToken
      : '';

  if (checkoutMode === 'test' && !mercadoPagoTestAccessToken) {
    issues.push(
      'CHECKOUT_MODE=test exige MERCADO_PAGO_ACCESS_TOKEN_TEST.',
    );
  }

  if (checkoutMode === 'production' && !mercadoPagoProductionAccessToken) {
    issues.push(
      'CHECKOUT_MODE=production exige MERCADO_PAGO_ACCESS_TOKEN_PROD.',
    );
  }

  const mercadoPagoTestWebhookSecret = firstValue(env, [
    'MERCADO_PAGO_WEBHOOK_SECRET_TEST',
  ]);

  const mercadoPagoProductionWebhookSecret = firstValue(env, [
    'MERCADO_PAGO_WEBHOOK_SECRET_PROD',
  ]);

  const mercadoPagoWebhookSecret = checkoutMode === 'test'
    ? mercadoPagoTestWebhookSecret
    : checkoutMode === 'production'
      ? mercadoPagoProductionWebhookSecret
      : '';

  const mercadoPagoTestPayerEmail = String(
    firstValue(env, ['MERCADO_PAGO_TEST_PAYER_EMAIL']) || 'test@testuser.com',
  ).trim().toLowerCase();

  if (checkoutMode === 'test' && !/^[^@\s]+@testuser\.com$/i.test(mercadoPagoTestPayerEmail)) {
    issues.push(
      'MERCADO_PAGO_TEST_PAYER_EMAIL deve usar o domínio @testuser.com.',
    );
  }

  if (checkoutMode === 'test' && !mercadoPagoTestWebhookSecret) {
    issues.push(
      'CHECKOUT_MODE=test exige MERCADO_PAGO_WEBHOOK_SECRET_TEST.',
    );
  }

  if (checkoutMode === 'production' && !mercadoPagoProductionWebhookSecret) {
    issues.push(
      'CHECKOUT_MODE=production exige MERCADO_PAGO_WEBHOOK_SECRET_PROD.',
    );
  }

  const mercadoPagoTimeoutMs = integerValue(
    env.MERCADO_PAGO_TIMEOUT_MS,
    10000,
    'MERCADO_PAGO_TIMEOUT_MS',
    issues,
    { min: 1000, max: 30000 },
  );
  const pdfMaxMb = integerValue(
    env.PDF_MAX_MB,
    railwayFreeVolumeMode ? 15 : 30,
    'PDF_MAX_MB',
    issues,
    { min: 1, max: 100 },
  );
  const imageMaxMb = integerValue(
    env.IMAGE_MAX_MB,
    railwayFreeVolumeMode ? 5 : 10,
    'IMAGE_MAX_MB',
    issues,
    { min: 1, max: 50 },
  );
  const videoMaxMb = integerValue(
    env.VIDEO_MAX_MB,
    railwayFreeVolumeMode ? 25 : 100,
    'VIDEO_MAX_MB',
    issues,
    { min: 1, max: 2048 },
  );
  const storageMaxMb = integerValue(
    env.STORAGE_MAX_MB,
    railwayFreeVolumeMode ? 400 : 0,
    'STORAGE_MAX_MB',
    issues,
    { min: railwayFreeVolumeMode ? 1 : 0, max: 10240 },
  );
  if (railwayFreeVolumeMode && pdfMaxMb > 15) {
    issues.push('No modo gratuito, PDF_MAX_MB não pode ultrapassar 15.');
  }
  if (railwayFreeVolumeMode && imageMaxMb > 5) {
    issues.push('No modo gratuito, IMAGE_MAX_MB não pode ultrapassar 5.');
  }
  if (railwayFreeVolumeMode && videoMaxMb > 25) {
    issues.push('No modo gratuito, VIDEO_MAX_MB não pode ultrapassar 25.');
  }
  if (railwayFreeVolumeMode && storageMaxMb > 400) {
    issues.push('No modo gratuito, STORAGE_MAX_MB não pode ultrapassar 400.');
  }

  if (issues.length) throw new ConfigurationError(issues);

  return deepFreeze({
    appEnv,
    nodeEnv,
    isRailway,
    isHosted,
    isProduction: appEnv === 'production',
    persistence: {
      railwayFreeVolumeMode,
      volumeMountPath,
    },
    host,
    port,
    appOrigin,
    allowedOrigins: [...new Set(allowedOrigins)],
    databaseUrl,
    logLevel,
    healthcheck: {
      timeoutMs: healthTimeoutMs,
    },
    session: {
      secret: sessionSecret,
      cookieName,
      cookieSecure,
      ttlSeconds: sessionTtlDays * 24 * 60 * 60,
    },
    authRateLimitMax,
    authRateLimitIpMax,
    authRateLimitWindowMs,
    bootstrap: {
      ownerEmail,
      adminEmails,
    },
    features: {
      registration: registrationEnabled,
      demoAccess,
      demoRole,
      paymentsMode: checkoutMode,
      emailVerificationRequired,
      passwordReset: passwordResetEnabled,
    },
    payments: {
      provider: 'mercado_pago',
      mode: checkoutMode,
      accessToken: mercadoPagoAccessToken,
      webhookSecret: mercadoPagoWebhookSecret,
      testPayerEmail: mercadoPagoTestPayerEmail,
      timeoutMs: mercadoPagoTimeoutMs,
    },
    email: {
      driver: emailDriver,
      from: emailFrom,
      replyTo: emailReplyTo,
      resendApiKey,
      tokenSecret: emailTokenSecret,
      registrationTokenTtlSeconds: registrationTokenTtlMinutes * 60,
      passwordResetTtlSeconds: passwordResetTtlMinutes * 60,
      timeoutMs: emailTimeoutMs,
    },
    storage: {
      driver: storageDriver,
      localPath,
      bucket,
      endpoint,
      region,
      accessKeyId,
      secretAccessKey,
      sessionToken,
      forcePathStyle,
      prefix,
      maxBytes: storageMaxMb > 0 ? storageMaxMb * 1024 * 1024 : 0,
      healthcheckTimeoutMs: healthTimeoutMs,
    },
    uploads: {
      pdfMaxBytes: pdfMaxMb * 1024 * 1024,
      imageMaxBytes: imageMaxMb * 1024 * 1024,
      videoMaxBytes: videoMaxMb * 1024 * 1024,
    },
  });
}

const config = loadConfig();

export default config;
