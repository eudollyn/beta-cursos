import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

import worker from '../worker.mjs';
import defaultConfig from './config.mjs';
import { canAccessCourseContent, handleApplicationApi, resolveSession } from './application-api.mjs';
import { close as closeDatabase, createDatabase } from './db.mjs';
import { createEmailSender } from './email.mjs';
import { createFullBackup } from './full-backup.mjs';
import { applyMigrations } from './migrate.mjs';
import { seedInitialCatalog } from './seed.mjs';
import { createMediaStore } from './storage.mjs';

const moduleDirectory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const projectRoot = resolve(moduleDirectory, '..');
const distClientRoot = resolve(projectRoot, 'dist', 'client');
const sourceClientRoot = projectRoot;
const TRUSTED_IDENTITY_PREFIX = 'oai-authenticated-user-';
const PRIVILEGED_ROLES = new Set(['owner', 'admin', 'facilitator']);
const PUBLIC_FILES = new Set([
  '/admin.css',
  '/admin.js',
  '/app.js',
  '/catalog.js',
  '/config.js',
  '/data.js',
  '/favicon.png',
  '/index.html',
  '/manifest.webmanifest',
  '/og.png',
  '/robots.txt',
  '/styles.css',
]);
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "object-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.youtube.com https://player.vimeo.com",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

function log(level, event, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

function logEmailEvent(level, entry = {}) {
  const event = String(entry.event || 'email_event');
  log(level, event, {
    driver: String(entry.driver || 'unknown'),
    type: String(entry.type || 'unknown'),
    ...(entry.code ? { code: String(entry.code) } : {}),
    ...(Number.isInteger(entry.providerStatus) ? { providerStatus: entry.providerStatus } : {}),
  });
}

const emailLogger = Object.freeze({
  info: entry => logEmailEvent('info', entry),
  error: entry => logEmailEvent('error', entry),
});

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

function withSecurityHeaders(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', CSP);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (requestId) headers.set('X-Request-Id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestUrl(request, config) {
  const path = String(request.url || '/');
  if (!config.isHosted) {
    const host = String(request.headers.host || '');
    if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/i.test(host)) {
      return new URL(path, `http://${host}`);
    }
  }
  return new URL(path, config.appOrigin);
}

function sanitizedHeaders(request) {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (name.toLowerCase().startsWith(TRUSTED_IDENTITY_PREFIX)) continue;
    if (rawValue === undefined) continue;
    if (Array.isArray(rawValue)) {
      rawValue.forEach(value => headers.append(name, value));
    } else {
      headers.set(name, rawValue);
    }
  }
  return headers;
}

function toWebRequest(request, config) {
  const headers = sanitizedHeaders(request);
  const init = {
    method: request.method,
    headers,
  };
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
    init.body = Readable.toWeb(request);
    init.duplex = 'half';
  }
  return new Request(requestUrl(request, config), init);
}

function injectTrustedIdentity(request, user) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(TRUSTED_IDENTITY_PREFIX)) headers.delete(name);
  }
  if (user) {
    headers.set('oai-authenticated-user-email', user.email);
    headers.set('oai-authenticated-user-full-name', encodeURIComponent(user.name || user.email));
    headers.set('oai-authenticated-user-full-name-encoding', 'percent-encoded-utf-8');
  }
  return new Request(request, { headers });
}

async function enforceBootstrapPolicy(request, context, user) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/admin/bootstrap' || request.method !== 'POST') return null;
  if (!user) {
    return json({
      error: {
        code: 'authentication_required',
        message: 'Entre com a conta responsável para configurar a administração.',
      },
    }, 401);
  }

  if (user.role === 'facilitator') {
    return json({
      admin: {
        email: user.email,
        fullName: user.name || user.email,
        role: 'facilitator',
        createdAt: user.createdAt || null,
      },
      created: false,
    });
  }

  const existing = await context.database.prepare(
    'SELECT email FROM admins WHERE email = ? LIMIT 1',
  ).bind(user.email).first();
  if (existing) return null;

  const expectedOwner = context.config.bootstrap.ownerEmail;
  const configuredAdmins = new Set(context.config.bootstrap.adminEmails || []);
  const owner = await context.database.prepare(
    "SELECT email FROM admins WHERE role = 'owner' LIMIT 1",
  ).first();

  if (owner && user.role === 'admin' && configuredAdmins.has(user.email)) {
    const timestamp = new Date().toISOString();
    const created = await context.database.prepare(`INSERT INTO admins
      (email, full_name, role, created_at, updated_at, created_by)
      SELECT ?, ?, 'admin', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM admins WHERE email = ?)`)
      .bind(
        user.email,
        user.name || user.email,
        timestamp,
        timestamp,
        'system:BOOTSTRAP_ADMIN_EMAILS',
        user.email,
      )
      .run();

    if (Number(created?.meta?.changes || 0) > 0) {
      try {
        await context.database.prepare(`INSERT INTO audit_log
          (actor_email, action, entity_type, entity_id, details_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(
            'system:BOOTSTRAP_ADMIN_EMAILS',
            'bootstrap_admin',
            'admin',
            user.email,
            JSON.stringify({ role: 'admin' }),
            timestamp,
          )
          .run();
      } catch {
        // A concessão não deve falhar apenas porque o registro de auditoria falhou.
      }
    }
    return null;
  }

  if (owner) return null;

  const localFirstUser = !context.config.isHosted && !expectedOwner;
  if (localFirstUser || expectedOwner === user.email) return null;
  return json({
    error: {
      code: 'bootstrap_owner_required',
      message: 'A administração inicial deve ser aberta pelo e-mail definido em BOOTSTRAP_OWNER_EMAIL.',
    },
  }, 403);
}

function containsMediaReference(value, expectedUrl) {
  if (value === expectedUrl) return true;
  if (Array.isArray(value)) return value.some(item => containsMediaReference(item, expectedUrl));
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(item => containsMediaReference(item, expectedUrl));
}

async function enforceMediaPolicy(request, context, user) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/media\/([a-z0-9_-]{8,100})$/i);
  if (!match || !['GET', 'HEAD'].includes(request.method)) return null;
  const mediaId = match[1];
  const media = await context.database.prepare(
    'SELECT id, kind FROM media WHERE id = ? LIMIT 1',
  ).bind(mediaId).first();
  if (!media || media.kind === 'image' || PRIVILEGED_ROLES.has(user?.role)) return null;
  if (!user) {
    return json({
      error: {
        code: 'authentication_required',
        message: 'Entre na sua conta para acessar este material.',
      },
    }, 401);
  }

  const result = await context.database.prepare(`SELECT c.id, c.data_json
    FROM app_enrollments e
    INNER JOIN courses c ON c.id = e.course_id
    WHERE e.user_id = ? AND e.status = 'active' AND c.status = 'published'`)
    .bind(user.id)
    .all();
  const expectedUrl = `/api/media/${mediaId}`;
  for (const row of result.results || []) {
    try {
      const course = typeof row.data_json === 'string'
        ? JSON.parse(row.data_json)
        : row.data_json;
      if (!containsMediaReference(course, expectedUrl)) continue;
      if (await canAccessCourseContent(context.database, user, row.id)) return null;
    } catch {
      // Continue procurando outro curso matriculado que referencie a mídia.
    }
  }
  return json({
    error: {
      code: 'enrollment_required',
      message: 'Uma matrícula ativa neste curso é necessária para acessar o material.',
    },
  }, 403);
}

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} excedeu o tempo limite.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readiness(context) {
  const timeout = context.config.healthcheck.timeoutMs;
  const emailRequired = Boolean(
    context.config.features.emailVerificationRequired
    || context.config.features.passwordReset,
  );
  const emailCheck = typeof context.emailSender?.healthcheck === 'function'
    ? context.emailSender.healthcheck()
    : Promise.resolve({
      ok: Boolean(context.emailSender) && (!emailRequired || context.emailSender.driver !== 'disabled'),
      driver: String(context.emailSender?.driver || 'unavailable'),
      enabled: context.emailSender?.driver !== 'disabled',
      required: emailRequired,
      configured: Boolean(context.emailSender),
      status: context.emailSender ? 'ready' : 'misconfigured',
      providerProbe: 'not_performed',
    });
  const [database, storage, email] = await Promise.allSettled([
    withTimeout(context.database.healthcheck(), timeout, 'Banco de dados'),
    withTimeout(context.media.healthcheck(), timeout, 'Armazenamento'),
    withTimeout(emailCheck, timeout, 'E-mail'),
  ]);
  const databaseValue = database.status === 'fulfilled'
    ? database.value
    : { ok: false, error: database.reason?.message || 'Falha no banco.' };
  const storageValue = storage.status === 'fulfilled'
    ? storage.value
    : { ok: false, error: storage.reason?.message || 'Falha no armazenamento.' };
  const emailValue = email.status === 'fulfilled'
    ? email.value
    : {
      ok: false,
      driver: String(context.emailSender?.driver || 'unavailable'),
      required: emailRequired,
      status: 'misconfigured',
      providerProbe: 'not_performed',
      error: email.reason?.message || 'Falha na configuração de e-mail.',
    };
  return {
    ok: Boolean(databaseValue.ok && storageValue.ok && emailValue.ok),
    service: 'beta-cursos',
    environment: context.config.appEnv,
    database: databaseValue,
    storage: storageValue,
    email: emailValue,
  };
}

function safeClientPath(pathname, root) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const normalizedPath = normalize(decoded).replaceAll('\\', '/');
  const allowed = PUBLIC_FILES.has(normalizedPath) || normalizedPath.startsWith('/assets/');
  if (!allowed) return null;
  const target = resolve(root, `.${normalizedPath}`);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return null;
  return target;
}

async function staticResponse(request, root) {
  const url = new URL(request.url);
  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = safeClientPath(requestedPath, root);
  let htmlFallback = false;
  if (!file || !existsSync(file)) {
    if (extname(requestedPath)) {
      return json({ error: { code: 'not_found', message: 'Arquivo não encontrado.' } }, 404);
    }
    file = join(root, 'index.html');
    htmlFallback = true;
  }

  let details;
  try {
    details = await stat(file);
  } catch {
    return json({ error: { code: 'not_found', message: 'Arquivo não encontrado.' } }, 404);
  }
  if (!details.isFile()) return json({ error: { code: 'not_found', message: 'Arquivo não encontrado.' } }, 404);
  const headers = new Headers({
    'Cache-Control': extname(file) === '.html' || htmlFallback
      ? 'no-cache'
      : 'public, max-age=300',
    'Content-Length': String(details.size),
    'Content-Type': MIME_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
  });
  return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file)), {
    status: 200,
    headers,
  });
}

async function dispatch(request, context) {
  const url = new URL(request.url);
  if (url.pathname === '/health/live') {
    return json({
      ok: true,
      service: 'beta-cursos',
      environment: context.config.appEnv,
    });
  }
  if (url.pathname === '/health/ready') {
    const status = await readiness(context);
    const body = context.config.isHosted
      ? {
        ok: status.ok,
        service: status.service,
        environment: status.environment,
        dependencies: {
          database: Boolean(status.database?.ok),
          storage: Boolean(status.storage?.ok),
          email: {
            ok: Boolean(status.email?.ok),
            driver: String(status.email?.driver || 'unavailable'),
            enabled: Boolean(status.email?.enabled),
            required: Boolean(status.email?.required),
            configured: Boolean(status.email?.configured),
            status: String(status.email?.status || 'unknown'),
            providerProbe: 'not_performed',
          },
        },
      }
      : status;
    return json(body, status.ok ? 200 : 503);
  }
  if (!url.pathname.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json({ error: { code: 'method_not_allowed', message: 'Método não permitido.' } }, 405, {
        Allow: 'GET, HEAD',
      });
    }
    return staticResponse(request, context.clientRoot);
  }
  const isMercadoPagoWebhook = url.pathname === '/api/webhooks/mercado-pago'
    && request.method === 'POST';
  if (
    context.config.isHosted
    && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
    && !request.headers.get('origin')
    && !isMercadoPagoWebhook
  ) {
    return json({
      error: {
        code: 'origin_required',
        message: 'A origem da solicitação não foi informada.',
      },
    }, 403);
  }

  const session = await resolveSession(request, {
    DB: context.database,
    config: context.config,
  });
  if (url.pathname === '/api/admin/system-backup') {
    if (request.method !== 'GET') {
      return json({ error: { code: 'method_not_allowed', message: 'Método não permitido.' } }, 405, {
        Allow: 'GET',
      });
    }
    if (!session) {
      return json({ error: { code: 'authentication_required', message: 'Entre para continuar.' } }, 401);
    }
    if (session.role !== 'owner') {
      return json({ error: { code: 'owner_required', message: 'Somente o proprietário pode gerar o backup completo.' } }, 403);
    }
    const backup = await createFullBackup({
      database: context.database,
      mediaStore: context.media,
      exportedBy: session.email,
    });
    return new Response(backup.body, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${backup.filename}"`,
        'Content-Type': backup.contentType,
      },
    });
  }
  const mediaPolicyResponse = await enforceMediaPolicy(request, context, session);
  if (mediaPolicyResponse) return mediaPolicyResponse;
  const applicationResponse = await handleApplicationApi(request, {
    DB: context.database,
    config: context.config,
    session,
    emailSender: context.emailSender,
  });
  if (applicationResponse) return applicationResponse;

  const bootstrapResponse = await enforceBootstrapPolicy(request, context, session);
  if (bootstrapResponse) return bootstrapResponse;
  const trustedRequest = injectTrustedIdentity(request, session);
  return worker.fetch(trustedRequest, {
    DB: context.database,
    MEDIA: context.media,
    UPLOADS: context.config.uploads,
  });
}

async function sendWebResponse(nodeResponse, response, method) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== 'set-cookie') headers[name] = value;
  }
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : response.headers.get('set-cookie')
      ? [response.headers.get('set-cookie')]
      : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  nodeResponse.writeHead(response.status, response.statusText, headers);
  if (method === 'HEAD' || !response.body) {
    nodeResponse.end();
    return;
  }
  await new Promise((resolvePromise, reject) => {
    const stream = Readable.fromWeb(response.body);
    stream.once('error', reject);
    nodeResponse.once('error', reject);
    nodeResponse.once('finish', resolvePromise);
    stream.pipe(nodeResponse);
  });
}

export async function createBetaServer(options = {}) {
  const config = options.config || defaultConfig;
  const database = options.database || await createDatabase({
    databaseUrl: config.databaseUrl,
  });
  const ownsDatabase = !options.database;
  let media;
  let emailSender;
  try {
    if (options.applyMigrations !== false) await applyMigrations(database);
    // Hosted environments always start with the database as the only source
    // of truth. The bundled course exists only for local development.
    if (options.seedCatalog !== false && !config.isHosted) {
      await seedInitialCatalog(database);
    }
    media = options.media || await createMediaStore(config.storage);
    emailSender = options.emailSender || createEmailSender({
      ...config.email,
      required: Boolean(
        config.features.emailVerificationRequired
        || config.features.passwordReset,
      ),
    }, { logger: emailLogger });
  } catch (error) {
    if (emailSender && !options.emailSender) await emailSender.close();
    if (media && !options.media) await media.close();
    if (ownsDatabase) await closeDatabase(database);
    throw error;
  }
  const ownsMedia = !options.media;
  const ownsEmailSender = !options.emailSender;
  const builtClientAvailable = existsSync(join(distClientRoot, 'index.html'));
  if (config.isHosted && !builtClientAvailable) {
    if (ownsEmailSender) await emailSender.close();
    if (ownsMedia) await media.close();
    if (ownsDatabase) await closeDatabase(database);
    throw new Error('O build público sanitizado não foi encontrado em dist/client.');
  }
  const built = builtClientAvailable && (config.isHosted || config.nodeEnv === 'production');
  const context = {
    config,
    database,
    media,
    emailSender,
    clientRoot: options.clientRoot || (built ? distClientRoot : sourceClientRoot),
  };

  const httpServer = createServer(async (nodeRequest, nodeResponse) => {
    const requestId = crypto.randomUUID();
    const startedAt = performance.now();
    try {
      const request = toWebRequest(nodeRequest, config);
      const response = withSecurityHeaders(await dispatch(request, context), requestId);
      await sendWebResponse(nodeResponse, response, nodeRequest.method);
      log('info', 'http_request', {
        requestId,
        method: nodeRequest.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      log('error', 'http_request_failed', {
        requestId,
        method: nodeRequest.method,
        path: String(nodeRequest.url || '/').split('?')[0],
        durationMs: Math.round(performance.now() - startedAt),
        error: error?.message || String(error),
      });
      if (!nodeResponse.headersSent) {
        const response = withSecurityHeaders(json({
          error: {
            code: 'internal_error',
            message: 'Não foi possível concluir a solicitação.',
          },
          requestId,
        }, 500), requestId);
        await sendWebResponse(nodeResponse, response, nodeRequest.method);
      } else {
        nodeResponse.destroy();
      }
    }
  });
  httpServer.headersTimeout = 30_000;
  httpServer.requestTimeout = 120_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 100;

  async function listen() {
    if (httpServer.listening) return httpServer.address();
    await new Promise((resolvePromise, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.off('error', reject);
        resolvePromise();
      });
    });
    return httpServer.address();
  }

  async function close() {
    if (httpServer.listening) {
      await new Promise((resolvePromise, reject) => {
        httpServer.close(error => error ? reject(error) : resolvePromise());
      });
    }
    if (ownsMedia) await media.close();
    if (ownsEmailSender) await emailSender.close();
    if (ownsDatabase) await closeDatabase(database);
  }

  return Object.freeze({
    config,
    context,
    server: httpServer,
    listen,
    close,
  });
}

export async function startBetaServer(options = {}) {
  const application = await createBetaServer(options);
  const address = await application.listen();
  const emailStatus = typeof application.context.emailSender.status === 'function'
    ? application.context.emailSender.status()
    : {
      driver: application.context.emailSender.driver,
      required: Boolean(
        application.config.features.emailVerificationRequired
        || application.config.features.passwordReset,
      ),
      configured: true,
      status: 'ready',
    };
  log('info', 'server_started', {
    environment: application.config.appEnv,
    host: application.config.host,
    port: typeof address === 'object' && address ? address.port : application.config.port,
    database: application.context.database.dialect,
    storage: application.context.media.driver,
    email: {
      driver: emailStatus.driver,
      required: Boolean(emailStatus.required),
      configured: Boolean(emailStatus.configured),
      status: emailStatus.status,
    },
  });
  return application;
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const application = await startBetaServer().catch((error) => {
    log('error', 'startup_failed', { error: error?.message || String(error) });
    process.exitCode = 1;
    return null;
  });
  if (application) {
    let shuttingDown = false;
    const shutdown = async signal => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('info', 'shutdown_started', { signal });
      try {
        await application.close();
        log('info', 'shutdown_completed', { signal });
      } catch (error) {
        log('error', 'shutdown_failed', { signal, error: error?.message || String(error) });
        process.exitCode = 1;
      }
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  }
}
