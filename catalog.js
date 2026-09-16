// ============================================================
// BETA CURSOS — CATÁLOGO PERSISTENTE
// Mantém a experiência pública sincronizada com os cursos publicados pelo
// painel administrativo. Em desenvolvimento local, preserva o catálogo-base.
// ============================================================

'use strict';

(function createBetaCatalog() {
  const staticSeed = typeof structuredClone === 'function'
    ? structuredClone(COURSES_DATA)
    : JSON.parse(JSON.stringify(COURSES_DATA));

  const state = {
    source: 'static',
    initialized: false,
    lastLoadedAt: null,
    error: null,
  };

  function clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
  const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,95}$/;

  function requireId(value, label) {
    const id = String(value || '').trim();
    if (!ID_PATTERN.test(id)) throw new Error(`${label} possui identificador inválido ou ausente.`);
    return id;
  }

  function normalizeAssetUrl(value, label) {
    const url = String(value || '').trim();
    if (!url) return '';
    if (/^(?:assets\/|\/api\/media\/)[a-z0-9_./-]+$/i.test(url)) return url;
    if (/^https:\/\//i.test(url)) return url;
    throw new Error(`${label} possui URL não permitida.`);
  }

  const COURSE_CATEGORIES = new Set(['Alcançar', 'Adorar', 'Relacionar', 'Discipular', 'Engajar']);

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

  function normalizeAccessPolicy(value) {
    const policy = value && typeof value === 'object' ? value : {};
    const mode = policy.mode === 'restricted' ? 'restricted' : 'open';
    return {
      mode,
      prerequisiteCourseIds: mode === 'restricted' && Array.isArray(policy.prerequisiteCourseIds)
        ? [...new Set(policy.prerequisiteCourseIds.map(id => String(id || '').trim()).filter(id => ID_PATTERN.test(id)))]
        : [],
      prerequisiteMode: 'all',
      catalogVisibility: policy.catalogVisibility === 'hidden_until_eligible'
        ? 'hidden_until_eligible'
        : 'show_locked',
    };
  }

  function normalizeCourse(course) {
    const normalized = clone(course || {});
    normalized.id = requireId(normalized.id, 'Curso');
    normalized.slug = String(normalized.slug || '').trim().toLowerCase();
    if (!SLUG_PATTERN.test(normalized.slug)) throw new Error('Curso possui slug inválido ou ausente.');
    normalized.title = String(normalized.title || 'Curso sem título').trim();
    normalized.subtitle = String(normalized.subtitle || '').trim();
    normalized.description = String(normalized.description || '').trim();
    normalized.category = normalizeCourseCategory(normalized.category);
    normalized.level = String(normalized.level || 'Todos os níveis').trim();
    normalized.duration = String(normalized.duration || '').trim();
    normalized.coverImage = normalizeAssetUrl(normalized.coverImage, 'Capa do curso');
    normalized.status = ['draft', 'published', 'archived'].includes(normalized.status) ? normalized.status : 'draft';
    normalized.featured = Boolean(normalized.featured);
    normalized.accessPolicy = normalizeAccessPolicy(normalized.accessPolicy);
    normalized.access = normalized.access && typeof normalized.access === 'object'
      ? { ...normalized.access, allowed: normalized.access.allowed !== false, contentAvailable: Boolean(normalized.access.contentAvailable) }
      : { allowed: true, contentAvailable: false, missingPrerequisites: [] };
    normalized.version = Math.max(1, Number(normalized.version || 1));
    normalized.revision = Math.max(1, Number(normalized.revision || 1));
    normalized.pricing = {
      ...PRICING_CONFIG,
      ...(normalized.pricing || {}),
      fullPrice: Math.max(0, Number(normalized.pricing?.fullPrice ?? PRICING_CONFIG.fullPrice)),
      memberDiscount: Math.min(1, Math.max(0, Number(normalized.pricing?.memberDiscount ?? PRICING_CONFIG.memberDiscount))),
    };
    normalized.modules = Array.isArray(normalized.modules) ? normalized.modules : [];
    normalized.modules.forEach((module, moduleIndex) => {
      module.id = requireId(module.id, `Módulo ${moduleIndex + 1}`);
      module.order = Number(module.order || moduleIndex + 1);
      module.title = String(module.title || `Módulo ${moduleIndex + 1}`);
      module.description = String(module.description || '').trim();
      module.coverImage = normalizeAssetUrl(module.coverImage, `Capa do módulo ${moduleIndex + 1}`);
      module.lessons = Array.isArray(module.lessons) ? module.lessons : [];
      module.lessons.forEach((lesson, lessonIndex) => {
        lesson.id = requireId(lesson.id, `Lição ${lessonIndex + 1}`);
        lesson.order = Number(lesson.order || lessonIndex + 1);
        lesson.title = String(lesson.title || `Lição ${lessonIndex + 1}`);
        lesson.quiz = Array.isArray(lesson.quiz) ? lesson.quiz : [];
        lesson.pdfUrl = normalizeAssetUrl(lesson.pdfUrl, 'Apostila');
        lesson.videoProvider = ['youtube', 'vimeo', 'direct', 'upload', 's3'].includes(lesson.videoProvider)
          ? lesson.videoProvider
          : 'youtube';
        lesson.videoUrl = normalizeAssetUrl(lesson.videoUrl, 'Vídeo');
        if (lesson.videoProvider === 'youtube' && lesson.videoEmbedId && !/^[a-zA-Z0-9_-]{6,20}$/.test(lesson.videoEmbedId)) {
          throw new Error(`Lição ${lessonIndex + 1} possui vídeo do YouTube inválido.`);
        }
        lesson.quizConfig = {
          passingScore: Math.max(1, Number(lesson.quizConfig?.passingScore || QUIZ_CONFIG.passingScore)),
          maxAttempts: Math.min(10, Math.max(1, Number(lesson.quizConfig?.maxAttempts || QUIZ_CONFIG.maxAttempts))),
          shuffleQuestions: lesson.quizConfig?.shuffleQuestions ?? QUIZ_CONFIG.shuffleQuestions,
          shuffleOptions: lesson.quizConfig?.shuffleOptions ?? QUIZ_CONFIG.shuffleOptions,
        };
        const questionIds = new Set();
        lesson.quiz.forEach((question, questionIndex) => {
          question.id = requireId(question.id, `Questão ${questionIndex + 1}`);
          if (questionIds.has(question.id)) throw new Error(`Questão duplicada na lição ${lesson.title}.`);
          questionIds.add(question.id);
          question.question = String(question.question || '').trim();
          question.explanation = String(question.explanation || '').trim();
          question.options = Array.isArray(question.options) ? question.options : [];
          const optionIds = new Set();
          question.options.forEach((option, optionIndex) => {
            option.id = requireId(option.id, `Alternativa ${optionIndex + 1}`);
            if (optionIds.has(option.id)) throw new Error(`Alternativa duplicada na questão ${questionIndex + 1}.`);
            optionIds.add(option.id);
            option.text = String(option.text || '').trim();
          });
          if (question.correctOptionId && !optionIds.has(question.correctOptionId)) {
            throw new Error(`Gabarito inválido na questão ${questionIndex + 1}.`);
          }
        });
      });
    });
    return normalized;
  }

  function replaceCourses(courses) {
    const normalized = courses.map(normalizeCourse).filter(course => course.status === 'published');
    const courseIds = new Set();
    const slugs = new Set();
    normalized.forEach(course => {
      if (courseIds.has(course.id) || slugs.has(course.slug)) throw new Error('O catálogo contém cursos duplicados.');
      courseIds.add(course.id);
      slugs.add(course.slug);
      const nestedIds = new Set();
      course.modules.forEach(module => {
        if (nestedIds.has(module.id)) throw new Error(`Identificador duplicado no curso ${course.title}.`);
        nestedIds.add(module.id);
        module.lessons.forEach(lesson => {
          if (nestedIds.has(lesson.id)) throw new Error(`Identificador duplicado no curso ${course.title}.`);
          nestedIds.add(lesson.id);
        });
      });
    });
    COURSES_DATA.splice(0, COURSES_DATA.length, ...normalized);
  }

  async function hydrate(options = {}) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const endpoint = window.BetaConfig?.apiUrl('/api/courses') || '/api/courses';
      const response = await fetch(endpoint, {
        credentials: window.BetaConfig?.credentialsFor('/api/courses') || 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('application/json')) {
        throw new Error(`Catálogo remoto indisponível (${response.status}).`);
      }

      const payload = await response.json();
      const courses = Array.isArray(payload) ? payload : (payload.courses || payload.items || []);
      const initialized = Array.isArray(payload) ? true : payload.initialized !== false;

      if (!Array.isArray(courses)) throw new Error('Resposta de catálogo inválida.');
      if (courses.length || initialized || options.allowEmpty) {
        replaceCourses(courses);
      }

      state.source = 'server';
      state.initialized = initialized;
      state.lastLoadedAt = new Date().toISOString();
      state.error = null;
      window.dispatchEvent(new CustomEvent('beta:catalog-loaded', { detail: { ...state } }));
      return { ok: true, courses: clone(COURSES_DATA), ...state };
    } catch (error) {
      const allowStaticFallback = window.BetaConfig?.allowLocalFallback !== false;
      state.source = allowStaticFallback ? 'static' : 'unavailable';
      state.error = error instanceof Error ? error.message : String(error);
      if (allowStaticFallback) {
        if (!COURSES_DATA.length) replaceCourses(staticSeed);
      } else {
        COURSES_DATA.splice(0, COURSES_DATA.length);
      }
      return { ok: false, courses: clone(COURSES_DATA), ...state };
    }
  }

  function replace(courses, source = 'local') {
    if (!Array.isArray(courses)) throw new TypeError('A lista de cursos precisa ser um array.');
    replaceCourses(courses);
    state.source = source;
    state.initialized = true;
    state.lastLoadedAt = new Date().toISOString();
    state.error = null;
    window.dispatchEvent(new CustomEvent('beta:catalog-loaded', { detail: { ...state } }));
    return { ok: true, courses: clone(COURSES_DATA), ...state };
  }

  window.BetaCatalog = {
    hydrate,
    replace,
    getState: () => ({ ...state }),
    getStaticSeed: () => clone(staticSeed),
  };
})();
