const SECURITY_HEADERS = {
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
};

const COURSE_STATUSES = new Set(['draft', 'published', 'archived']);
const COURSE_CATEGORIES = ['Alcançar', 'Adorar', 'Relacionar', 'Discipular', 'Engajar'];
const COURSE_CATEGORY_SET = new Set(COURSE_CATEGORIES);
const COURSE_ACCESS_MODES = new Set(['open', 'restricted']);
const COURSE_CATALOG_VISIBILITIES = new Set(['show_locked', 'hidden_until_eligible']);
const COURSE_BODY_LIMIT = 1024 * 1024;
const IMPORT_BODY_LIMIT = 5 * 1024 * 1024;
const PDF_LIMIT = 30 * 1024 * 1024;
const VIDEO_LIMIT = 100 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const MULTIPART_OVERHEAD_LIMIT = 2 * 1024 * 1024;
const MAX_IMPORT_COURSES = 100;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,100}$/;
const NESTED_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const IMAGE_TYPES = new Map([
  ['image/png', new Set(['png'])],
  ['image/jpeg', new Set(['jpg', 'jpeg'])],
  ['image/webp', new Set(['webp'])],
]);
const SYSTEM_COURSE_FIELDS = new Set([
  'id', 'version', 'revision', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy',
]);

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admins (
    email TEXT PRIMARY KEY NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
    data_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS courses_slug_unique ON courses (slug)',
  'CREATE INDEX IF NOT EXISTS courses_status_updated_idx ON courses (status, updated_at)',
  `CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pdf', 'video', 'image')),
    size INTEGER NOT NULL CHECK (size > 0),
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS media_storage_key_unique ON media (storage_key)',
  'CREATE INDEX IF NOT EXISTS media_kind_created_idx ON media (kind, created_at)',
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    actor_email TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  'CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at)',
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT INTO app_meta (key, value, updated_at)
   VALUES ('schema_version', '5', CURRENT_TIMESTAMP)
   ON CONFLICT (key) DO UPDATE SET
     value = CASE
       WHEN CAST(app_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER) THEN excluded.value
       ELSE app_meta.value
     END,
     updated_at = CASE
       WHEN CAST(app_meta.value AS INTEGER) < CAST(excluded.value AS INTEGER) THEN excluded.updated_at
       ELSE app_meta.updated_at
     END`,
];

const MEDIA_IMAGE_MIGRATION = [
  'ALTER TABLE media RENAME TO media_before_images',
  `CREATE TABLE media (
    id TEXT PRIMARY KEY NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pdf', 'video', 'image')),
    size INTEGER NOT NULL CHECK (size > 0),
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT NOT NULL
  )`,
  `INSERT INTO media (id, storage_key, filename, content_type, kind, size, sha256, created_at, created_by)
   SELECT id, storage_key, filename, content_type, kind, size, sha256, created_at, created_by
   FROM media_before_images`,
  'DROP TABLE media_before_images',
  'CREATE UNIQUE INDEX IF NOT EXISTS media_storage_key_unique ON media (storage_key)',
  'CREATE INDEX IF NOT EXISTS media_kind_created_idx ON media (kind, created_at)',
];

const initializedDatabases = new WeakSet();
const dataRepositories = new WeakMap();
const mediaStores = new WeakMap();

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function secure(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200, headersInit = {}) {
  const headers = new Headers(headersInit);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function apiErrorResponse(error, requestId) {
  const known = error instanceof ApiError;
  const status = known ? error.status : 500;
  const body = {
    error: {
      code: known ? error.code : 'internal_error',
      message: known ? error.message : 'Não foi possível concluir a solicitação.',
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
    requestId,
  };
  return json(body, status);
}

function methodNotAllowed(allowed) {
  return json({ error: { code: 'method_not_allowed', message: 'Método não permitido.' } }, 405, {
    Allow: allowed.join(', '),
  });
}

function requireBinding(env, name) {
  if (!env?.[name]) {
    throw new ApiError(503, 'service_not_configured', `O serviço ${name} ainda não está configurado.`);
  }
  return env[name];
}

// Persistence port: route handlers use only these small interfaces. Replacing
// D1/R2 later does not change the course JSON or the HTTP API consumed by the UI.
function dataRepository(binding) {
  let repository = dataRepositories.get(binding);
  if (repository) return repository;
  repository = Object.freeze({
    prepare(statement) {
      return binding.prepare(statement);
    },
    batch(statements) {
      return binding.batch(statements);
    },
  });
  dataRepositories.set(binding, repository);
  return repository;
}

function mediaStore(env) {
  const binding = requireBinding(env, 'MEDIA');
  let store = mediaStores.get(binding);
  if (store) return store;
  store = Object.freeze({
    put(key, body, options) {
      return binding.put(key, body, options);
    },
    get(key, options) {
      return binding.get(key, options);
    },
    head(key) {
      return binding.head(key);
    },
    delete(key) {
      return binding.delete(key);
    },
  });
  mediaStores.set(binding, store);
  return store;
}

async function ensureSchema(env) {
  const binding = requireBinding(env, 'DB');
  if (!initializedDatabases.has(binding)) {
    await binding.batch(SCHEMA_STATEMENTS.map((statement) => binding.prepare(statement)));
    const [mediaSchemaResult] = await binding.batch([
      binding.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media' LIMIT 1"),
    ]);
    const mediaSchema = String(mediaSchemaResult?.results?.[0]?.sql || '');
    if (mediaSchema && !mediaSchema.includes("'image'")) {
      await binding.batch(MEDIA_IMAGE_MIGRATION.map((statement) => binding.prepare(statement)));
    }
    initializedDatabases.add(binding);
  }
  return dataRepository(binding);
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'invalid_path', 'Identificador inválido.');
  }
}

function assertSafeId(id, field = 'id') {
  if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'invalid_id', `${field} inválido.`);
  }
  return id;
}

function decodeDisplayName(request, fallback) {
  const encoding = request.headers.get('oai-authenticated-user-full-name-encoding');
  const encoded = request.headers.get('oai-authenticated-user-full-name');
  if (encoding !== 'percent-encoded-utf-8' || !encoded) return fallback;
  try {
    const value = decodeURIComponent(encoded).trim();
    return value ? value.slice(0, 160) : fallback;
  } catch {
    return fallback;
  }
}

function readIdentity(request) {
  const email = (request.headers.get('oai-authenticated-user-email') || '').trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ApiError(401, 'authentication_required', 'Entre com uma conta autorizada para continuar.');
  }
  return { email, fullName: decodeDisplayName(request, email) };
}

function serializeAdmin(row) {
  return {
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

async function requireAdmin(request, env, role) {
  const database = await ensureSchema(env);
  const identity = readIdentity(request);
  const row = await database.prepare(
    'SELECT email, full_name, role, created_at FROM admins WHERE email = ? LIMIT 1',
  ).bind(identity.email).first();
  if (!row) throw new ApiError(403, 'admin_required', 'Esta conta não tem acesso ao painel administrativo.');
  if (role === 'owner' && row.role !== 'owner') {
    throw new ApiError(403, 'owner_required', 'Somente o administrador proprietário pode realizar esta ação.');
  }
  return { database, identity, admin: serializeAdmin(row) };
}

function enforceSameOrigin(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, 'cross_origin_denied', 'Solicitação de outra origem bloqueada.');
  }
}

async function readJson(request, limit = COURSE_BODY_LIMIT) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    throw new ApiError(415, 'json_required', 'Envie os dados no formato JSON.');
  }
  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  if (declaredLength > limit) throw new ApiError(413, 'payload_too_large', 'O arquivo de dados é grande demais.');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new ApiError(413, 'payload_too_large', 'O arquivo de dados é grande demais.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', 'O JSON enviado não é válido.');
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeJson(value, path = 'curso', depth = 0) {
  if (depth > 16) throw new ApiError(422, 'invalid_course', `${path} ultrapassa o limite de níveis.`);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertSafeJson(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new ApiError(422, 'invalid_course', `${path}.${key} não é permitido.`);
    }
    assertSafeJson(child, `${path}.${key}`, depth + 1);
  }
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isYouTubeUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return /^[A-Za-z0-9_-]{11}$/.test(url.pathname.slice(1));
    if (!['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) return false;
    return url.pathname === '/watch'
      ? /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') || '')
      : /^\/(embed|shorts|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isVimeoUrl(value) {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return false;
  return /\/(?:video\/)?\d{6,15}(?:\/|$)/.test(url.pathname);
}

function validateVideoLinks(value, path = 'curso') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateVideoLinks(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(youtubeUrl|videoUrl|externalVideoUrl|videoLink)$/i.test(key) && child) {
      const validMediaUrl = typeof child === 'string' && /^\/api\/media\/[a-zA-Z0-9_-]{8,100}$/.test(child);
      if (!validMediaUrl && !isYouTubeUrl(child) && !isVimeoUrl(child) && !isHttpsUrl(child)) {
        throw new ApiError(422, 'invalid_video_url', `${path}.${key} deve ser uma mídia interna ou um link HTTPS válido.`);
      }
    }
    validateVideoLinks(child, `${path}.${key}`);
  }
}

function questionText(question) {
  return question.prompt ?? question.question ?? question.text ?? question.title;
}

function optionText(option) {
  return typeof option === 'string' ? option : option?.text ?? option?.label ?? option?.title;
}

function identityRegistry() {
  return { modules: new Set(), lessons: new Set(), questions: new Set() };
}

function registerNestedId(value, used, path, label) {
  if (typeof value !== 'string' || !NESTED_ID_PATTERN.test(value)) {
    throw new ApiError(422, 'invalid_nested_id', `${path}.id é obrigatório e deve usar somente letras, números, hífen ou sublinhado.`);
  }
  if (used.has(value)) {
    throw new ApiError(422, 'duplicate_nested_id', `${label} com id "${value}" está duplicado.`);
  }
  used.add(value);
  return value;
}

function answerIndex(answer, options) {
  if (Number.isInteger(answer)) return answer >= 0 && answer < options.length ? answer : -1;
  if (typeof answer !== 'string') return -1;
  return options.findIndex((option) => answer === option.id || answer === option.text);
}

function validateQuestions(questions, path, published, registry = identityRegistry()) {
  if (!Array.isArray(questions) || questions.length > 100) {
    throw new ApiError(422, 'invalid_questions', `${path} deve ter no máximo 100 questões.`);
  }
  questions.forEach((question, index) => {
    const currentPath = `${path}[${index}]`;
    if (!isRecord(question)) throw new ApiError(422, 'invalid_question', `${currentPath} deve ser uma questão.`);
    registerNestedId(question.id, registry.questions, currentPath, 'Questão');
    const prompt = questionText(question);
    if (typeof prompt !== 'string' || prompt.trim().length < 3 || prompt.length > 1500) {
      throw new ApiError(422, 'invalid_question', `${currentPath} precisa de um enunciado entre 3 e 1.500 caracteres.`);
    }
    const requiredOptions = published ? 4 : null;
    if (!Array.isArray(question.options)
      || (published && question.options.length !== requiredOptions)
      || (!published && (question.options.length < 2 || question.options.length > 8))) {
      throw new ApiError(
        422,
        'invalid_question_options',
        published ? `${currentPath} precisa ter exatamente 4 alternativas.` : `${currentPath} precisa ter de 2 a 8 alternativas.`,
      );
    }
    const optionIds = new Set();
    const options = question.options.map((option, optionIndex) => {
      const optionPath = `${currentPath}.options[${optionIndex}]`;
      if (!isRecord(option)) {
        throw new ApiError(422, 'invalid_option', `${optionPath} precisa ter id imutável e texto.`);
      }
      const id = registerNestedId(option.id, optionIds, optionPath, 'Alternativa');
      const text = optionText(option);
      if (typeof text !== 'string' || !text.trim() || text.length > 500) {
        throw new ApiError(422, 'invalid_option', `${optionPath} precisa ter texto completo.`);
      }
      return { id, text, markedCorrect: option.correct === true || option.isCorrect === true };
    });
    const answerKeys = ['correctOption', 'correctAnswer', 'answer', 'correctIndex', 'correctOptionId'];
    const correctIndexes = new Set();
    for (const key of answerKeys) {
      if (question[key] === undefined || question[key] === null || question[key] === '') continue;
      const indexForAnswer = answerIndex(question[key], options);
      if (indexForAnswer < 0) {
        throw new ApiError(422, 'invalid_correct_answer', `${currentPath}.${key} não corresponde a uma alternativa.`);
      }
      correctIndexes.add(indexForAnswer);
    }
    options.forEach((option, optionIndex) => {
      if (option.markedCorrect) correctIndexes.add(optionIndex);
    });
    if (published && correctIndexes.size !== 1) {
      throw new ApiError(422, 'invalid_correct_answer', `${currentPath} precisa ter exatamente uma alternativa correta.`);
    }
    if (!published && correctIndexes.size > 1) {
      throw new ApiError(422, 'invalid_correct_answer', `${currentPath} não pode ter respostas corretas conflitantes.`);
    }
  });
}

function validateQuiz(quiz, path, published, registry = identityRegistry()) {
  if (!isRecord(quiz)) throw new ApiError(422, 'invalid_quiz', `${path} deve ser um teste válido.`);
  if (quiz.passingScore !== undefined) {
    const score = Number(quiz.passingScore);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new ApiError(422, 'invalid_quiz', `${path}.passingScore deve estar entre 0 e 100.`);
    }
  }
  if (quiz.maxAttempts !== undefined) {
    const attempts = Number(quiz.maxAttempts);
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
      throw new ApiError(422, 'invalid_quiz', `${path}.maxAttempts deve estar entre 1 e 20.`);
    }
  }
  if (quiz.questions !== undefined) validateQuestions(quiz.questions, `${path}.questions`, published, registry);
}

function isInternalMediaUrl(value) {
  return typeof value === 'string' && /^\/api\/media\/[a-zA-Z0-9_-]{8,100}$/.test(value);
}

function isInternalPdfUrl(value) {
  if (isInternalMediaUrl(value)) return true;
  if (typeof value !== 'string' || !/^assets\/[a-zA-Z0-9_./-]+\.pdf$/i.test(value)) return false;
  return !value.split('/').includes('..');
}

function isValidYouTubeEmbedId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}

function isValidVimeoEmbedId(value) {
  return typeof value === 'string' && /^\d{6,15}$/.test(value);
}

function lessonQuestionCollections(lesson) {
  const collections = [];
  if (Array.isArray(lesson.questions)) collections.push({ path: 'questions', questions: lesson.questions });
  if (Array.isArray(lesson.quiz)) collections.push({ path: 'quiz', questions: lesson.quiz });
  if (isRecord(lesson.quiz) && Array.isArray(lesson.quiz.questions)) {
    collections.push({ path: 'quiz.questions', questions: lesson.quiz.questions });
  }
  return collections;
}

function validatePublishedLesson(lesson, lessonPath, allowLegacyDemoVideo) {
  const hasPdf = typeof lesson.pdfUrl === 'string' && lesson.pdfUrl.trim() !== '';
  if (hasPdf && !isInternalPdfUrl(lesson.pdfUrl)) {
    throw new ApiError(422, 'published_lesson_invalid_pdf', `${lessonPath}.pdfUrl precisa apontar para um PDF interno em assets/ ou /api/media/.`);
  }

  const hasVideo = Boolean(
    String(lesson.videoUrl || '').trim()
    || String(lesson.videoEmbedId || '').trim(),
  );
  const validVideo = isInternalMediaUrl(lesson.videoUrl)
    || (String(lesson.videoProvider || 'youtube').toLowerCase() === 'youtube'
      && (isYouTubeUrl(lesson.videoUrl) || isValidYouTubeEmbedId(lesson.videoEmbedId)))
    || (String(lesson.videoProvider || '').toLowerCase() === 'vimeo'
      && (isVimeoUrl(lesson.videoUrl) || isValidVimeoEmbedId(lesson.videoEmbedId)))
    || (['direct', 's3', 'upload'].includes(String(lesson.videoProvider || '').toLowerCase()) && isHttpsUrl(lesson.videoUrl));
  if (hasVideo && !validVideo && !allowLegacyDemoVideo) {
    throw new ApiError(422, 'published_lesson_invalid_video', `${lessonPath} possui um vídeo configurado, mas o endereço é inválido.`);
  }

  const populatedCollections = lessonQuestionCollections(lesson)
    .filter(collection => collection.questions.length > 0);
  if (populatedCollections.length > 1) {
    throw new ApiError(422, 'published_lesson_multiple_quizzes', `${lessonPath} deve usar somente um formato de teste por lição.`);
  }
}

function validateModules(modules, published, registry = identityRegistry(), allowLegacyDemoVideo = false) {
  if (!Array.isArray(modules) || modules.length > 50) {
    throw new ApiError(422, 'invalid_modules', 'modules deve ter no máximo 50 módulos.');
  }
  if (published && modules.length === 0) {
    throw new ApiError(422, 'empty_published_course', 'Um curso publicado precisa ter pelo menos um módulo.');
  }
  let totalLessons = 0;
  modules.forEach((module, moduleIndex) => {
    const modulePath = `modules[${moduleIndex}]`;
    if (!isRecord(module)) throw new ApiError(422, 'invalid_module', `${modulePath} é inválido.`);
    registerNestedId(module.id, registry.modules, modulePath, 'Módulo');
    if (typeof module.title !== 'string' || module.title.trim().length < 2 || module.title.length > 180) {
      throw new ApiError(422, 'invalid_module', `${modulePath}.title é obrigatório.`);
    }
    if (module.lessons !== undefined) {
      if (!Array.isArray(module.lessons) || module.lessons.length > 100) {
        throw new ApiError(422, 'invalid_lessons', `${modulePath}.lessons deve ter no máximo 100 aulas.`);
      }
      if (published && module.lessons.length === 0) {
        throw new ApiError(422, 'empty_published_module', `${modulePath} precisa ter pelo menos uma aula.`);
      }
      totalLessons += module.lessons.length;
      module.lessons.forEach((lesson, lessonIndex) => {
        const lessonPath = `${modulePath}.lessons[${lessonIndex}]`;
        if (!isRecord(lesson)) throw new ApiError(422, 'invalid_lesson', `${lessonPath} é inválida.`);
        registerNestedId(lesson.id, registry.lessons, lessonPath, 'Lição');
        if (typeof lesson.title !== 'string' || lesson.title.trim().length < 2 || lesson.title.length > 180) {
          throw new ApiError(422, 'invalid_lesson', `${lessonPath}.title é obrigatório.`);
        }
        if (published) validatePublishedLesson(lesson, lessonPath, allowLegacyDemoVideo);
        if (lesson.questions !== undefined) validateQuestions(lesson.questions, `${lessonPath}.questions`, published, registry);
        if (lesson.quiz !== undefined) {
          if (Array.isArray(lesson.quiz)) validateQuestions(lesson.quiz, `${lessonPath}.quiz`, published, registry);
          else validateQuiz(lesson.quiz, `${lessonPath}.quiz`, published, registry);
        }
        if (lesson.quizConfig !== undefined) validateQuiz(lesson.quizConfig, `${lessonPath}.quizConfig`, published, registry);
      });
    }
    if (module.questions !== undefined) validateQuestions(module.questions, `${modulePath}.questions`, published, registry);
  });
  if (totalLessons > 500) throw new ApiError(422, 'too_many_lessons', 'O curso ultrapassa o limite de 500 aulas.');
}

function normalizeCourseCategory(value) {
  const raw = String(value || '').trim();
  if (COURSE_CATEGORY_SET.has(raw)) return raw;
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');
  if (/(evangel|miss|alcanc|atrair)/.test(normalized)) return 'Alcançar';
  if (/(ador|espiritual)/.test(normalized)) return 'Adorar';
  if (/(famil|relacion)/.test(normalized)) return 'Relacionar';
  if (/(lider|minister|engaj)/.test(normalized)) return 'Engajar';
  return 'Discipular';
}

function normalizeCourseAccessPolicy(document, fallback = {}) {
  const policy = isRecord(document.accessPolicy) ? document.accessPolicy : {};
  const fallbackPolicy = isRecord(fallback.accessPolicy) ? fallback.accessPolicy : {};
  const mode = String(
    policy.mode ?? document.accessMode ?? fallbackPolicy.mode ?? fallback.accessMode ?? 'open',
  ).trim().toLowerCase();
  if (!COURSE_ACCESS_MODES.has(mode)) {
    throw new ApiError(422, 'invalid_access_mode', 'O acesso do curso deve ser open ou restricted.');
  }
  const visibility = String(
    policy.catalogVisibility ?? fallbackPolicy.catalogVisibility ?? 'show_locked',
  ).trim().toLowerCase();
  if (!COURSE_CATALOG_VISIBILITIES.has(visibility)) {
    throw new ApiError(422, 'invalid_catalog_visibility', 'A visibilidade do curso bloqueado é inválida.');
  }
  const source = policy.prerequisiteCourseIds ?? document.prerequisiteCourseIds
    ?? fallbackPolicy.prerequisiteCourseIds ?? fallback.prerequisiteCourseIds ?? [];
  if (!Array.isArray(source) || source.length > 100) {
    throw new ApiError(422, 'invalid_prerequisites', 'Os pré-requisitos devem ser uma lista com no máximo 100 cursos.');
  }
  const prerequisiteCourseIds = source.map((value, index) => {
    const id = String(value || '').trim();
    if (!NESTED_ID_PATTERN.test(id)) {
      throw new ApiError(422, 'invalid_prerequisite', `O pré-requisito ${index + 1} tem um identificador inválido.`);
    }
    return id;
  });
  if (new Set(prerequisiteCourseIds).size !== prerequisiteCourseIds.length) {
    throw new ApiError(422, 'duplicate_prerequisite', 'Um curso não pode aparecer duas vezes nos pré-requisitos.');
  }
  const courseId = String(document.id ?? fallback.id ?? '').trim();
  if (courseId && prerequisiteCourseIds.includes(courseId)) {
    throw new ApiError(422, 'self_prerequisite', 'Um curso não pode ser pré-requisito dele mesmo.');
  }
  return {
    mode,
    prerequisiteCourseIds: mode === 'restricted' ? prerequisiteCourseIds : [],
    prerequisiteMode: 'all',
    catalogVisibility: mode === 'restricted' ? visibility : 'show_locked',
  };
}

function coursePolicyFromStored(row) {
  const data = parseStoredJson(row?.data_json);
  return normalizeCourseAccessPolicy({ ...data, id: row?.id });
}

function validatePrerequisiteGraph(catalog) {
  for (const [courseId, course] of catalog) {
    for (const prerequisiteId of course.accessPolicy.prerequisiteCourseIds) {
      if (!catalog.has(prerequisiteId)) {
        throw new ApiError(
          422,
          'prerequisite_not_found',
          `O pré-requisito "${prerequisiteId}" não existe no catálogo.`,
          { courseId, prerequisiteCourseId: prerequisiteId },
        );
      }
    }
  }
  const states = new Map();
  function visit(courseId, path = []) {
    if (states.get(courseId) === 'visited') return;
    if (states.get(courseId) === 'visiting') {
      throw new ApiError(
        422,
        'prerequisite_cycle',
        'Os pré-requisitos formam um ciclo. Revise a sequência dos cursos.',
        { courseIds: [...path, courseId] },
      );
    }
    states.set(courseId, 'visiting');
    const course = catalog.get(courseId);
    for (const prerequisiteId of course?.accessPolicy?.prerequisiteCourseIds || []) {
      visit(prerequisiteId, [...path, courseId]);
    }
    states.set(courseId, 'visited');
  }
  [...catalog.keys()].forEach(id => visit(id));
}

async function validateCoursePrerequisitesForWrite(database, candidate, { replace = false } = {}) {
  const existing = replace ? [] : ((await database.prepare('SELECT id, data_json FROM courses').all()).results || []);
  const catalog = new Map(existing.map(row => [row.id, {
    id: row.id,
    accessPolicy: coursePolicyFromStored(row),
  }]));
  catalog.set(candidate.id, {
    id: candidate.id,
    accessPolicy: candidate.data.accessPolicy,
  });
  validatePrerequisiteGraph(catalog);
}

function stripSystemCourseFields(document) {
  const clean = {};
  for (const [key, value] of Object.entries(document)) {
    if (!SYSTEM_COURSE_FIELDS.has(key) && !['slug', 'title', 'status'].includes(key)) clean[key] = value;
  }
  return clean;
}

function normalizeCourse(document, fallback = {}) {
  if (!isRecord(document)) throw new ApiError(422, 'invalid_course', 'O curso deve ser um objeto JSON.');
  assertSafeJson(document);
  const title = String(document.title ?? fallback.title ?? '').trim();
  const slug = String(document.slug ?? fallback.slug ?? slugify(title)).trim().toLowerCase();
  const status = String(document.status ?? fallback.status ?? 'draft').trim().toLowerCase();
  if (title.length < 3 || title.length > 180) {
    throw new ApiError(422, 'invalid_title', 'O título deve ter entre 3 e 180 caracteres.');
  }
  if (slug.length < 3 || slug.length > 80 || !SLUG_PATTERN.test(slug)) {
    throw new ApiError(422, 'invalid_slug', 'O endereço do curso deve usar letras minúsculas, números e hífens.');
  }
  if (!COURSE_STATUSES.has(status)) {
    throw new ApiError(422, 'invalid_status', 'O status deve ser draft, published ou archived.');
  }
  if (document.description !== undefined && (typeof document.description !== 'string' || document.description.length > 20000)) {
    throw new ApiError(422, 'invalid_description', 'A descrição pode ter no máximo 20.000 caracteres.');
  }
  if (document.summary !== undefined && (typeof document.summary !== 'string' || document.summary.length > 800)) {
    throw new ApiError(422, 'invalid_summary', 'O resumo pode ter no máximo 800 caracteres.');
  }
  if (document.price !== undefined && typeof document.price === 'number'
    && (!Number.isFinite(document.price) || document.price < 0 || document.price > 1000000)) {
    throw new ApiError(422, 'invalid_price', 'O preço informado é inválido.');
  }
  const registry = identityRegistry();
  const legacyJornadaDemo = status === 'published'
    && document.contentStatus === 'demo'
    && (document.id === 'jornada-lidere' || slug === 'jornada-lidere');
  if (document.modules !== undefined) validateModules(document.modules, status === 'published', registry, legacyJornadaDemo);
  else if (status === 'published') throw new ApiError(422, 'empty_published_course', 'Um curso publicado precisa ter pelo menos um módulo.');
  if (document.questions !== undefined) validateQuestions(document.questions, 'questions', status === 'published', registry);
  validateVideoLinks(document);
  const clean = stripSystemCourseFields(document);
  clean.category = normalizeCourseCategory(document.category ?? fallback.category);
  clean.accessPolicy = normalizeCourseAccessPolicy(document, fallback);
  delete clean.accessMode;
  delete clean.prerequisiteCourseIds;
  return { title, slug, status, data: clean };
}

function immutableSignature(value, fields) {
  if (!isRecord(value)) return '';
  return fields
    .map((field) => String(value[field] ?? '').trim().toLocaleLowerCase('pt-BR'))
    .join('\u001f');
}

function immutablePairs(currentItems, nextItems, label, signatureFields) {
  const before = Array.isArray(currentItems) ? currentItems : [];
  const after = Array.isArray(nextItems) ? nextItems : [];
  const beforeIds = new Set(before.map((item) => item?.id).filter(Boolean));
  const afterById = new Map(after.map((item) => [item?.id, item]));
  const removed = before.filter((item) => item?.id && !afterById.has(item.id));
  const added = after.filter((item) => item?.id && !beforeIds.has(item.id));

  if (before.length === after.length && removed.length === 1 && added.length === 1) {
    throw new ApiError(422, 'immutable_nested_id', `O id de ${label} é imutável. Remova e salve antes de criar outro registro.`);
  }
  for (const previous of removed) {
    const signature = immutableSignature(previous, signatureFields);
    if (!signature) continue;
    const replacements = added.filter((item) => immutableSignature(item, signatureFields) === signature);
    if (replacements.length === 1) {
      throw new ApiError(422, 'immutable_nested_id', `O id de ${label} é imutável.`);
    }
  }
  return before
    .filter((item) => item?.id && afterById.has(item.id))
    .map((item) => [item, afterById.get(item.id)]);
}

function firstLessonQuestions(lesson) {
  return lessonQuestionCollections(lesson)[0]?.questions || [];
}

function assertNestedIdsImmutable(current, next) {
  const modulePairs = immutablePairs(current?.modules, next?.modules, 'módulo', ['title']);
  for (const [previousModule, nextModule] of modulePairs) {
    const lessonPairs = immutablePairs(previousModule.lessons, nextModule.lessons, 'lição', ['title']);
    for (const [previousLesson, nextLesson] of lessonPairs) {
      const questionPairs = immutablePairs(
        firstLessonQuestions(previousLesson),
        firstLessonQuestions(nextLesson),
        'questão',
        ['question', 'prompt', 'text'],
      );
      for (const [previousQuestion, nextQuestion] of questionPairs) {
        immutablePairs(previousQuestion.options, nextQuestion.options, 'alternativa', ['text', 'label', 'title']);
      }
    }
  }
}

function parseStoredJson(value) {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeCourse(row) {
  return {
    ...parseStoredJson(row.data_json),
    id: row.id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    version: Number(row.version),
    revision: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at || null,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

const PUBLIC_QUIZ_SECRET_FIELDS = new Set([
  'answer',
  'correct',
  'correctAnswer',
  'correctIndex',
  'correctOption',
  'correctOptionId',
  'isCorrect',
]);

function stripPublicQuizSecrets(value) {
  if (Array.isArray(value)) return value.map(stripPublicQuizSecrets);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PUBLIC_QUIZ_SECRET_FIELDS.has(key))
      .map(([key, nested]) => [key, stripPublicQuizSecrets(nested)]),
  );
}

function serializePublicCourse(row) {
  const course = stripPublicQuizSecrets(serializeCourse(row));
  course.modules = (Array.isArray(course.modules) ? course.modules : []).map(module => ({
    ...module,
    lessons: (Array.isArray(module.lessons) ? module.lessons : []).map(lesson => {
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

function serializeMedia(row) {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    kind: row.kind,
    size: Number(row.size),
    sha256: row.sha256,
    url: `/api/media/${encodeURIComponent(row.id)}`,
    adminUrl: `/api/admin/media/${encodeURIComponent(row.id)}`,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

async function audit(database, actorEmail, action, entityType, entityId, details = {}) {
  try {
    const value = JSON.stringify(details).slice(0, 10000);
    await database.prepare(
      'INSERT INTO audit_log (actor_email, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(actorEmail, action, entityType, entityId || null, value, new Date().toISOString()).run();
  } catch {
    // The primary operation must not be rolled back only because its audit entry failed.
  }
}

async function handlePublicCourses(env) {
  const database = await ensureSchema(env);
  const [courseResult, adminResult] = await database.batch([
    database.prepare('SELECT * FROM courses WHERE status = ? ORDER BY updated_at DESC').bind('published'),
    database.prepare('SELECT COUNT(*) AS count FROM admins'),
  ]);
  const courses = (courseResult.results || []).map(serializePublicCourse);
  const initialized = Number(adminResult.results?.[0]?.count || 0) > 0;
  return json({ courses, initialized });
}

async function handleBootstrap(request, env) {
  const database = await ensureSchema(env);
  const identity = readIdentity(request);
  const now = new Date().toISOString();
  const existing = await database.prepare(
    'SELECT email, full_name, role, created_at FROM admins WHERE email = ? LIMIT 1',
  ).bind(identity.email).first();
  if (existing) return json({ admin: serializeAdmin(existing), created: false });

  const result = await database.prepare(
    `INSERT INTO admins (email, full_name, role, created_at, updated_at, created_by)
     SELECT ?, ?, 'owner', ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM admins)`,
  ).bind(identity.email, identity.fullName, now, now, identity.email).run();
  if (!Number(result.meta?.changes || 0)) {
    throw new ApiError(403, 'bootstrap_closed', 'O administrador inicial já foi definido. Peça acesso ao proprietário.');
  }
  const created = await database.prepare(
    'SELECT email, full_name, role, created_at FROM admins WHERE email = ? LIMIT 1',
  ).bind(identity.email).first();
  await audit(database, identity.email, 'bootstrap', 'admin', identity.email);
  return json({ admin: serializeAdmin(created), created: true }, 201);
}

async function handleAdminMe(request, env) {
  const { admin } = await requireAdmin(request, env);
  return json({ admin });
}

async function listAdminCourses(request, env) {
  const { database } = await requireAdmin(request, env);
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  if (status && !COURSE_STATUSES.has(status)) throw new ApiError(400, 'invalid_status', 'Filtro de status inválido.');

  const clauses = [];
  const bindings = [];
  if (status) { clauses.push('status = ?'); bindings.push(status); }
  if (query) { clauses.push('(title LIKE ? OR slug LIKE ?)'); bindings.push(`%${query}%`, `%${query}%`); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const result = await database.prepare(
    `SELECT * FROM courses${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(...bindings, limit, offset).all();
  return json({ courses: (result.results || []).map(serializeCourse), limit, offset });
}

async function createCourse(request, env) {
  const { database, identity } = await requireAdmin(request, env);
  const payload = await readJson(request);
  const normalized = normalizeCourse(payload);
  const id = payload.id === undefined ? crypto.randomUUID() : assertSafeId(String(payload.id), 'id');
  if (normalized.data.accessPolicy.prerequisiteCourseIds.includes(id)) {
    throw new ApiError(422, 'self_prerequisite', 'Um curso não pode ser pré-requisito dele mesmo.');
  }
  await validateCoursePrerequisitesForWrite(database, { id, ...normalized });
  const now = new Date().toISOString();
  const publishedAt = normalized.status === 'published' ? now : null;
  try {
    await database.prepare(
      `INSERT INTO courses
       (id, slug, title, status, data_json, version, created_at, updated_at, published_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id, normalized.slug, normalized.title, normalized.status, JSON.stringify(normalized.data),
      now, now, publishedAt, identity.email, identity.email,
    ).run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      throw new ApiError(409, 'course_conflict', 'Já existe um curso com esse identificador ou endereço.');
    }
    throw error;
  }
  const row = await database.prepare('SELECT * FROM courses WHERE id = ? LIMIT 1').bind(id).first();
  await audit(database, identity.email, 'create', 'course', id, { slug: normalized.slug, status: normalized.status });
  return json({ course: serializeCourse(row) }, 201, { Location: `/api/admin/courses/${encodeURIComponent(id)}` });
}

async function findCourse(database, identifier) {
  return database.prepare('SELECT * FROM courses WHERE id = ? OR slug = ? LIMIT 1').bind(identifier, identifier).first();
}

async function getAdminCourse(request, env, identifier) {
  const { database } = await requireAdmin(request, env);
  const row = await findCourse(database, identifier);
  if (!row) throw new ApiError(404, 'course_not_found', 'Curso não encontrado.');
  return json({ course: serializeCourse(row) });
}

async function updateCourse(request, env, identifier) {
  const { database, identity } = await requireAdmin(request, env);
  const current = await findCourse(database, identifier);
  if (!current) throw new ApiError(404, 'course_not_found', 'Curso não encontrado.');
  const payload = await readJson(request);
  if (!isRecord(payload)) throw new ApiError(422, 'invalid_course', 'O curso deve ser um objeto JSON.');
  if (payload.id !== undefined && String(payload.id) !== current.id) {
    throw new ApiError(422, 'immutable_course_id', 'O id do curso é imutável.');
  }
  const expectedVersion = payload.version ?? payload.revision;
  if (expectedVersion === undefined) {
    throw new ApiError(428, 'revision_required', 'Envie version ou revision para salvar o curso com segurança.');
  }
  if (expectedVersion !== undefined && Number(expectedVersion) !== Number(current.version)) {
    throw new ApiError(409, 'version_conflict', 'Este curso foi alterado em outra sessão. Atualize a página antes de salvar.');
  }
  const merged = { ...serializeCourse(current), ...payload };
  assertNestedIdsImmutable(serializeCourse(current), merged);
  const normalized = normalizeCourse({ ...merged, id: current.id }, current);
  await validateCoursePrerequisitesForWrite(database, { id: current.id, ...normalized });
  const now = new Date().toISOString();
  const publishedAt = normalized.status === 'published' && !current.published_at ? now : current.published_at;
  let result;
  try {
    result = await database.prepare(
      `UPDATE courses
       SET slug = ?, title = ?, status = ?, data_json = ?, version = version + 1,
           updated_at = ?, published_at = ?, updated_by = ?
       WHERE id = ? AND version = ?`,
    ).bind(
      normalized.slug, normalized.title, normalized.status, JSON.stringify(normalized.data),
      now, publishedAt, identity.email, current.id, current.version,
    ).run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      throw new ApiError(409, 'course_conflict', 'Já existe outro curso com esse endereço.');
    }
    throw error;
  }
  if (!Number(result.meta?.changes || 0)) {
    throw new ApiError(409, 'version_conflict', 'Este curso foi alterado em outra sessão. Atualize a página antes de salvar.');
  }
  const row = await database.prepare('SELECT * FROM courses WHERE id = ? LIMIT 1').bind(current.id).first();
  await audit(database, identity.email, 'update', 'course', current.id, { slug: normalized.slug, status: normalized.status });
  return json({ course: serializeCourse(row) });
}

async function deleteCourse(request, env, identifier) {
  const { database, identity } = await requireAdmin(request, env);
  const current = await findCourse(database, identifier);
  if (!current) throw new ApiError(404, 'course_not_found', 'Curso não encontrado.');
  if (current.status !== 'draft') {
    throw new ApiError(
      409,
      'course_delete_requires_draft',
      'Cursos publicados ou arquivados preservam histórico e não podem ser excluídos. Para retirá-lo do catálogo, mantenha-o arquivado; somente rascunhos podem ser excluídos.',
      { status: current.status },
    );
  }
  const allCourses = (await database.prepare('SELECT id, title, data_json FROM courses WHERE id <> ?').bind(current.id).all()).results || [];
  const references = allCourses
    .filter(row => coursePolicyFromStored(row).prerequisiteCourseIds.includes(current.id))
    .map(row => ({ id: row.id, title: row.title }));
  if (references.length) {
    throw new ApiError(409, 'course_is_prerequisite', 'Remova este curso dos pré-requisitos antes de excluí-lo.', { courses: references });
  }
  await database.prepare('DELETE FROM courses WHERE id = ?').bind(current.id).run();
  await audit(database, identity.email, 'delete', 'course', current.id, { slug: current.slug });
  return json({ deleted: true, id: current.id });
}

function normalizeFilename(value) {
  const filename = String(value || 'arquivo').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!filename || filename.length > 180) throw new ApiError(422, 'invalid_filename', 'O nome do arquivo é inválido.');
  return filename;
}

function fileExtension(filename) {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function configuredUploadLimit(env, field, fallback) {
  const value = Number(env?.UPLOADS?.[field]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function mediaUploadLimits(env) {
  return {
    pdf: configuredUploadLimit(env, 'pdfMaxBytes', PDF_LIMIT),
    video: configuredUploadLimit(env, 'videoMaxBytes', VIDEO_LIMIT),
    image: configuredUploadLimit(env, 'imageMaxBytes', IMAGE_LIMIT),
  };
}

function maximumMediaRequestBytes(env) {
  return Math.max(...Object.values(mediaUploadLimits(env))) + MULTIPART_OVERHEAD_LIMIT;
}

async function cancelRequestBody(body) {
  if (!body || typeof body.cancel !== 'function') return;
  try {
    await body.cancel('request_body_rejected');
  } catch {
    // The response must keep the validation error even if the transport cannot be cancelled.
  }
}

function requestBodyChunk(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new ApiError(400, 'invalid_request_body', 'O corpo do envio é inválido.');
}

async function readMediaRequestBody(request, limit) {
  const rawLength = request.headers.get('Content-Length');
  if (rawLength !== null) {
    const normalizedLength = rawLength.trim();
    if (!/^\d+$/.test(normalizedLength)) {
      await cancelRequestBody(request.body);
      throw new ApiError(400, 'invalid_content_length', 'O cabeçalho Content-Length é inválido.');
    }
    const declaredLength = Number(normalizedLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > limit) {
      await cancelRequestBody(request.body);
      throw new ApiError(413, 'media_too_large', 'O envio ultrapassa o limite permitido.');
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = requestBodyChunk(value);
      total += chunk.byteLength;
      if (total > limit) {
        try {
          await reader.cancel('request_body_too_large');
        } catch {
          // The 413 response is authoritative even if the transport cannot be cancelled.
        }
        throw new ApiError(413, 'media_too_large', 'O envio ultrapassa o limite permitido.');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_request_body', 'Não foi possível ler o corpo do envio.');
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readMediaFormData(request, limit) {
  const body = await readMediaRequestBody(request, limit);
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  const boundedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body,
  });
  try {
    return await boundedRequest.formData();
  } catch {
    throw new ApiError(400, 'invalid_multipart', 'O formulário de envio é inválido.');
  }
}

function validateMediaFile(file, requestedKind, env) {
  if (!file || typeof file.arrayBuffer !== 'function' || typeof file.size !== 'number') {
    throw new ApiError(422, 'file_required', 'Selecione uma apostila PDF, imagem ou vídeo.');
  }
  const filename = normalizeFilename(file.name);
  const contentType = String(file.type || '').toLowerCase().split(';')[0];
  const extension = fileExtension(filename);
  const inferredKind = contentType === 'application/pdf' ? 'pdf' : VIDEO_TYPES.has(contentType) ? 'video' : null;
  const resolvedKind = inferredKind || (IMAGE_TYPES.has(contentType) ? 'image' : null);
  const kind = String(requestedKind || resolvedKind || '').toLowerCase();
  if (!['pdf', 'video', 'image'].includes(kind)) throw new ApiError(415, 'unsupported_media', 'Use PDF, imagem ou vídeo compatível.');
  if (kind === 'pdf' && (contentType !== 'application/pdf' || extension !== 'pdf')) {
    throw new ApiError(415, 'invalid_pdf', 'A apostila precisa ser um arquivo PDF válido.');
  }
  if (kind === 'video' && (!VIDEO_TYPES.has(contentType) || !VIDEO_EXTENSIONS.has(extension))) {
    throw new ApiError(415, 'invalid_video', 'Use vídeo MP4, WebM, MOV ou M4V.');
  }
  if (kind === 'image' && (!IMAGE_TYPES.has(contentType) || !IMAGE_TYPES.get(contentType).has(extension))) {
    throw new ApiError(415, 'invalid_image', 'Use imagem PNG, JPEG ou WebP.');
  }
  const limit = mediaUploadLimits(env)[kind];
  if (file.size <= 0) throw new ApiError(422, 'empty_file', 'O arquivo está vazio.');
  if (file.size > limit) {
    const label = kind === 'pdf' ? 'A apostila' : kind === 'image' ? 'A imagem' : 'O vídeo';
    throw new ApiError(413, 'media_too_large', `${label} ultrapassa o limite de ${Math.round(limit / 1024 / 1024)} MB.`);
  }
  return { filename, contentType, kind, size: file.size, extension };
}

function storageCapacityExceeded(error) {
  const candidates = [
    error?.code,
    error?.name,
    error?.Code,
    error?.cause?.code,
    error?.cause?.name,
    error?.cause?.Code,
  ];
  return candidates.some(value => String(value || '').toUpperCase() === 'STORAGE_CAPACITY_EXCEEDED');
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function uploadMedia(request, env) {
  const { database, identity } = await requireAdmin(request, env);
  const bucket = mediaStore(env);
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('multipart/form-data')) {
    throw new ApiError(415, 'multipart_required', 'Envie o arquivo pelo formulário de importação.');
  }
  const form = await readMediaFormData(request, maximumMediaRequestBytes(env));
  const file = form.get('file');
  const metadata = validateMediaFile(file, form.get('kind'), env);
  const id = crypto.randomUUID();
  const storageKey = `${metadata.kind}/${id}.${metadata.extension}`;
  const contents = await file.arrayBuffer();
  const sha256 = bytesToHex(await crypto.subtle.digest('SHA-256', contents));
  const now = new Date().toISOString();
  try {
    await bucket.put(storageKey, contents, {
      httpMetadata: {
        contentType: metadata.contentType,
        contentDisposition: `inline; filename="${metadata.filename.replace(/["\\]/g, '_')}"`,
      },
      customMetadata: { mediaId: id, kind: metadata.kind, sha256 },
    });
  } catch (error) {
    if (storageCapacityExceeded(error)) {
      throw new ApiError(
        507,
        'storage_capacity_exceeded',
        'O armazenamento de mídias atingiu a capacidade disponível. Libere espaço ou amplie o Bucket antes de tentar novamente.',
      );
    }
    throw error;
  }
  try {
    await database.prepare(
      `INSERT INTO media
       (id, storage_key, filename, content_type, kind, size, sha256, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, storageKey, metadata.filename, metadata.contentType, metadata.kind,
      metadata.size, sha256, now, identity.email,
    ).run();
  } catch (error) {
    await bucket.delete(storageKey);
    throw error;
  }
  const row = await database.prepare('SELECT * FROM media WHERE id = ? LIMIT 1').bind(id).first();
  await audit(database, identity.email, 'upload', 'media', id, { filename: metadata.filename, kind: metadata.kind, size: metadata.size });
  return json({ media: serializeMedia(row) }, 201, { Location: `/api/media/${encodeURIComponent(id)}` });
}

async function listMedia(request, env) {
  const { database } = await requireAdmin(request, env);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 200);
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
  if (kind && !['pdf', 'video', 'image'].includes(kind)) throw new ApiError(400, 'invalid_media_kind', 'Tipo de mídia inválido.');
  const clauses = [];
  const values = [];
  if (kind) { clauses.push('kind = ?'); values.push(kind); }
  if (query) { clauses.push('filename LIKE ?'); values.push(`%${query}%`); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const result = await database.prepare(
    `SELECT * FROM media${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...values, limit, offset).all();
  return json({ media: (result.results || []).map(serializeMedia), limit, offset });
}

function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    throw new ApiError(416, 'invalid_range', 'Faixa de reprodução inválida.', { size });
  }
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new ApiError(416, 'invalid_range', 'Faixa de reprodução inválida.', { size });
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      throw new ApiError(416, 'invalid_range', 'Faixa de reprodução inválida.', { size });
    }
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function serveMedia(request, env, id) {
  const database = await ensureSchema(env);
  const bucket = mediaStore(env);
  const row = await database.prepare('SELECT * FROM media WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) throw new ApiError(404, 'media_not_found', 'Mídia não encontrada.');
  const totalSize = Number(row.size);
  const etag = `"sha256-${row.sha256}"`;
  const range = parseByteRange(request.headers.get('Range'), totalSize);
  if (!range && request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, max-age=86400' } });
  }
  const object = request.method === 'HEAD'
    ? await bucket.head(row.storage_key)
    : await bucket.get(row.storage_key, range ? { range: { offset: range.start, length: range.length } } : undefined);
  if (!object) throw new ApiError(404, 'media_object_missing', 'O arquivo desta mídia não está disponível.');
  const headers = new Headers({
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=86400',
    'Content-Type': row.content_type,
    'Content-Disposition': contentDisposition(row.filename),
    'Content-Length': String(range?.length ?? totalSize),
    ETag: etag,
  });
  if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
  return new Response(request.method === 'HEAD' ? null : object.body, { status: range ? 206 : 200, headers });
}

function documentContainsMediaId(value, mediaId) {
  if (value === mediaId || value === `/api/media/${encodeURIComponent(mediaId)}`) return true;
  if (Array.isArray(value)) return value.some((item) => documentContainsMediaId(item, mediaId));
  if (isRecord(value)) return Object.values(value).some((item) => documentContainsMediaId(item, mediaId));
  return false;
}

async function deleteMedia(request, env, id) {
  const { database, identity } = await requireAdmin(request, env);
  const bucket = mediaStore(env);
  const row = await database.prepare('SELECT * FROM media WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) throw new ApiError(404, 'media_not_found', 'Mídia não encontrada.');
  const courseResult = await database.prepare('SELECT id, title, data_json FROM courses').all();
  const references = (courseResult.results || [])
    .filter((course) => documentContainsMediaId(parseStoredJson(course.data_json), id))
    .map((course) => ({ id: course.id, title: course.title }));
  const force = new URL(request.url).searchParams.get('force') === 'true';
  if (references.length && !force) {
    throw new ApiError(409, 'media_in_use', 'Esta mídia ainda está vinculada a um curso.', { courses: references });
  }
  await bucket.delete(row.storage_key);
  await database.prepare('DELETE FROM media WHERE id = ?').bind(id).run();
  await audit(database, identity.email, 'delete', 'media', id, { filename: row.filename, forced: force, references });
  return json({ deleted: true, id, referencesRemoved: force ? references : [] });
}

async function exportData(request, env) {
  const { database, admin } = await requireAdmin(request, env);
  const [courseResult, mediaResult] = await database.batch([
    database.prepare('SELECT * FROM courses ORDER BY created_at ASC'),
    database.prepare('SELECT * FROM media ORDER BY created_at ASC'),
  ]);
  const exportedAt = new Date().toISOString();
  const body = {
    format: 'beta-cursos-admin-export',
    version: 1,
    exportedAt,
    exportedBy: admin.email,
    courses: (courseResult.results || []).map(serializeCourse),
    media: (mediaResult.results || []).map(serializeMedia),
    mediaFilesIncluded: false,
  };
  const date = exportedAt.slice(0, 10);
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="beta-cursos-backup-${date}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}

function collectReferencedMediaIds(value, result = new Set(), key = '') {
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferencedMediaIds(item, result, key));
  } else if (isRecord(value)) {
    for (const [childKey, child] of Object.entries(value)) collectReferencedMediaIds(child, result, childKey);
  } else if (typeof value === 'string') {
    const mediaUrlMatch = /^\/api\/media\/([a-zA-Z0-9_-]{8,100})$/.exec(value);
    if (mediaUrlMatch) result.add(mediaUrlMatch[1]);
    else if (/(?:media|pdf|video).*id/i.test(key) && SAFE_ID_PATTERN.test(value)) result.add(value);
  }
  return result;
}

function importedTimestamp(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

async function importData(request, env) {
  const { database, identity, admin } = await requireAdmin(request, env);
  const payload = await readJson(request, IMPORT_BODY_LIMIT);
  if (!isRecord(payload) || !Array.isArray(payload.courses)) {
    throw new ApiError(422, 'invalid_import', 'O backup precisa conter uma lista courses.');
  }
  if (payload.courses.length > MAX_IMPORT_COURSES) {
    throw new ApiError(413, 'too_many_courses', `Importe no máximo ${MAX_IMPORT_COURSES} cursos por vez.`);
  }
  const mode = payload.mode || 'merge';
  if (!['merge', 'replace'].includes(mode)) throw new ApiError(422, 'invalid_import_mode', 'Use o modo merge ou replace.');
  if (mode === 'replace' && (admin.role !== 'owner' || payload.confirm !== 'SUBSTITUIR')) {
    throw new ApiError(403, 'replace_confirmation_required', 'Somente o proprietário pode substituir o catálogo, confirmando com SUBSTITUIR.');
  }

  const existingResult = await database.prepare('SELECT * FROM courses').all();
  const existing = existingResult.results || [];
  const byId = new Map(existing.map((row) => [row.id, row]));
  const bySlug = new Map(existing.map((row) => [row.slug, row]));
  const seenIds = new Set();
  const seenSlugs = new Set();
  const now = new Date().toISOString();
  const rows = payload.courses.map((incoming, index) => {
    if (!isRecord(incoming)) throw new ApiError(422, 'invalid_import', `courses[${index}] é inválido.`);
    const normalized = normalizeCourse(incoming);
    const providedId = incoming.id === undefined ? null : assertSafeId(String(incoming.id), `courses[${index}].id`);
    const idMatch = mode === 'merge' && providedId ? byId.get(providedId) : null;
    const slugMatch = mode === 'merge' ? bySlug.get(normalized.slug) : null;
    if (idMatch && slugMatch && idMatch.id !== slugMatch.id) {
      throw new ApiError(409, 'import_conflict', `courses[${index}] conflita com dois cursos existentes.`);
    }
    const current = idMatch || slugMatch || null;
    if (current) assertNestedIdsImmutable(serializeCourse(current), incoming);
    const id = current?.id || providedId || crypto.randomUUID();
    if (seenIds.has(id) || seenSlugs.has(normalized.slug)) {
      throw new ApiError(409, 'duplicate_import_course', `courses[${index}] repete um id ou endereço do próprio arquivo.`);
    }
    seenIds.add(id);
    seenSlugs.add(normalized.slug);
    const createdAt = current?.created_at || importedTimestamp(incoming.createdAt, now);
    const publishedAt = normalized.status === 'published'
      ? current?.published_at || importedTimestamp(incoming.publishedAt, now)
      : current?.published_at || null;
    return {
      id,
      ...normalized,
      version: current ? Number(current.version) + 1 : Math.max(Number(incoming.version ?? incoming.revision) || 1, 1),
      createdAt,
      publishedAt,
      createdBy: current?.created_by || identity.email,
    };
  });

  const catalog = new Map();
  if (mode !== 'replace') {
    existing.forEach(row => catalog.set(row.id, {
      id: row.id,
      accessPolicy: coursePolicyFromStored(row),
    }));
  }
  rows.forEach(row => catalog.set(row.id, { id: row.id, accessPolicy: row.data.accessPolicy }));
  validatePrerequisiteGraph(catalog);

  const statements = [];
  if (mode === 'replace') statements.push(database.prepare('DELETE FROM courses'));
  for (const row of rows) {
    statements.push(database.prepare(
      `INSERT INTO courses
       (id, slug, title, status, data_json, version, created_at, updated_at, published_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         slug = excluded.slug, title = excluded.title, status = excluded.status,
         data_json = excluded.data_json, version = excluded.version,
         updated_at = excluded.updated_at, published_at = excluded.published_at,
         updated_by = excluded.updated_by`,
    ).bind(
      row.id, row.slug, row.title, row.status, JSON.stringify(row.data), row.version,
      row.createdAt, now, row.publishedAt, row.createdBy, identity.email,
    ));
  }
  if (statements.length) {
    try {
      await database.batch(statements);
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
        throw new ApiError(409, 'import_conflict', 'O backup contém um endereço de curso que já está em uso.');
      }
      throw error;
    }
  }

  const mediaResult = await database.prepare('SELECT id FROM media').all();
  const availableMedia = new Set((mediaResult.results || []).map((row) => row.id));
  const referencedMedia = new Set();
  rows.forEach((row) => collectReferencedMediaIds(row.data, referencedMedia));
  const missingMediaIds = [...referencedMedia].filter((id) => !availableMedia.has(id));
  await audit(database, identity.email, 'import', 'catalog', null, { mode, courses: rows.length, missingMediaIds });
  return json({ imported: rows.length, mode, missingMediaIds });
}

async function handleApi(request, env) {
  enforceSameOrigin(request);
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (path === '/api/courses') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handlePublicCourses(env);
  }

  const publicMediaMatch = path.match(/^\/api\/media\/([^/]+)$/);
  if (publicMediaMatch) {
    if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed(['GET', 'HEAD']);
    const id = assertSafeId(decodePathPart(publicMediaMatch[1]), 'id');
    return serveMedia(request, env, id);
  }

  if (path === '/api/admin/bootstrap') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return handleBootstrap(request, env);
  }
  if (path === '/api/admin/me') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return handleAdminMe(request, env);
  }
  if (path === '/api/admin/courses') {
    if (request.method === 'GET') return listAdminCourses(request, env);
    if (request.method === 'POST') return createCourse(request, env);
    return methodNotAllowed(['GET', 'POST']);
  }

  const courseMatch = path.match(/^\/api\/admin\/courses\/([^/]+)$/);
  if (courseMatch) {
    const identifier = assertSafeId(decodePathPart(courseMatch[1]), 'id');
    if (request.method === 'GET') return getAdminCourse(request, env, identifier);
    if (request.method === 'PUT') return updateCourse(request, env, identifier);
    if (request.method === 'DELETE') return deleteCourse(request, env, identifier);
    return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  }

  if (path === '/api/admin/media') {
    if (request.method === 'GET') return listMedia(request, env);
    if (request.method === 'POST') return uploadMedia(request, env);
    return methodNotAllowed(['GET', 'POST']);
  }

  const adminMediaMatch = path.match(/^\/api\/admin\/media\/([^/]+)$/);
  if (adminMediaMatch) {
    const id = assertSafeId(decodePathPart(adminMediaMatch[1]), 'id');
    await requireAdmin(request, env);
    if (['GET', 'HEAD'].includes(request.method)) return serveMedia(request, env, id);
    if (request.method === 'DELETE') return deleteMedia(request, env, id);
    return methodNotAllowed(['GET', 'HEAD', 'DELETE']);
  }

  if (path === '/api/admin/export') {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    return exportData(request, env);
  }
  if (path === '/api/admin/import') {
    if (request.method !== 'POST') return methodNotAllowed(['POST']);
    return importData(request, env);
  }
  throw new ApiError(404, 'api_not_found', 'Endpoint não encontrado.');
}

export const __test = {
  ensureSchema,
  isYouTubeUrl,
  normalizeCourse,
  normalizeCourseCategory,
  normalizeCourseAccessPolicy,
  validatePrerequisiteGraph,
  parseByteRange,
  readIdentity,
  serializeMedia,
  maximumMediaRequestBytes,
  mediaUploadLimits,
  storageCapacityExceeded,
  validateMediaFile,
};

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    try {
      const url = new URL(request.url);
      let response;
      if (url.pathname.startsWith('/api/')) {
        response = await handleApi(request, env);
      } else {
        response = await requireBinding(env, 'ASSETS').fetch(request);
        const headers = new Headers(response.headers);
        if (/\.(?:css|js|png|pdf|webmanifest)$/.test(url.pathname)) {
          headers.set('Cache-Control', 'public, max-age=3600');
        }
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return secure(response);
    } catch (error) {
      return secure(apiErrorResponse(error, requestId));
    }
  },
};
