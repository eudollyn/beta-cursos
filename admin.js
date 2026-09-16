/* ============================================================
   BETA CURSOS — PAINEL ADMINISTRATIVO
   Módulo isolado. Inicialização: window.BetaAdmin.mount(element)
   ============================================================ */
(function () {
  'use strict';

  const LOCAL_STORAGE_KEY = 'betaAdmin.local.v1';
  const LOCAL_STORE_VERSION = 2;
  const LOCAL_FILE_LIMIT = 4 * 1024 * 1024;
  const STATUS_LABELS = {
    draft: 'Rascunho',
    published: 'Publicado',
    archived: 'Arquivado',
  };
  const LEVELS = ['Iniciante', 'Intermediário', 'Avançado'];
  const COURSE_CATEGORIES = ['Alcançar', 'Adorar', 'Relacionar', 'Discipular', 'Engajar'];
  const PASTORAL_PHASES = ['Atrair', 'Adorar', 'Relacionar', 'Discipular', 'Engajar'];
  const VIDEO_PROVIDERS = {
    youtube: 'YouTube',
    vimeo: 'Vimeo',
    direct: 'URL direta',
    upload: 'Vídeo enviado',
  };

  const state = {
    root: null,
    mode: 'loading',
    adapter: null,
    courses: [],
    media: [],
    students: [],
    team: [],
    studentsSource: 'api',
    bootstrap: {},
    view: 'overview',
    editorTab: 'details',
    editorCourse: null,
    editorOriginalId: null,
    editorIsNew: false,
    editorDirty: false,
    selectedModule: 0,
    selectedLesson: 0,
    validationErrors: [],
    courseSearch: '',
    courseStatus: 'all',
    courseCategory: 'all',
    mediaSearch: '',
    mediaKind: 'all',
    studentSearch: '',
    studentCourse: 'all',
    studentStatus: 'all',
    studentAccountStatus: 'active',
    teamSearch: '',
    loading: false,
    busy: false,
    mobileOpen: false,
    lastFocus: null,
    beforeUnload: null,
    eventController: null,
    initError: null,
  };

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload;
    }
  }

  function clone(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function currentRole() {
    if (state.mode === 'local') return 'owner';
    return String(state.bootstrap?.admin?.role || '').toLowerCase();
  }

  function canManageContent() {
    return ['owner', 'admin'].includes(currentRole());
  }

  function canManageStudents() {
    return ['owner', 'admin'].includes(currentRole());
  }

  function canDeleteStudents() {
    return currentRole() === 'owner';
  }

  function isOwner() {
    return currentRole() === 'owner';
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, '&#096;');
  }

  function safeUrl(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\/api(?:\/|$|\?)/i.test(raw)) raw = window.BetaConfig?.mediaUrl(raw) || raw;
    if (/^data:(?:image\/|video\/|application\/pdf)/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw, window.location.href);
      return ['http:', 'https:', 'blob:'].includes(parsed.protocol) ? parsed.href : '';
    } catch (_) {
      return '';
    }
  }

  function safeCssUrl(value) {
    return safeUrl(value).replace(/['"()\\\r\n]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  function slugify(value) {
    return String(value || 'curso')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'curso';
  }

  function uid(prefix) {
    const random = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function money(value) {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(Number(value) || 0);
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    return `${(size / 1024 ** 3).toFixed(1)} GB`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(date);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  }

  function getSeedCourses() {
    try {
      if (typeof COURSES_DATA !== 'undefined' && Array.isArray(COURSES_DATA)) {
        return clone(COURSES_DATA);
      }
    } catch (_) {
      // A constante pode não ter sido carregada na página de administração.
    }
    return [];
  }

  function newQuestion(index) {
    const optionIds = ['a', 'b', 'c', 'd'];
    return {
      id: uid(`q${index + 1}`),
      question: '',
      options: optionIds.map(id => ({ id, text: '' })),
      correctOptionId: 'a',
      explanation: '',
    };
  }

  function normalizeQuestion(question, index) {
    const value = clone(question || {});
    const optionIds = ['a', 'b', 'c', 'd'];
    const sourceOptions = Array.isArray(value.options) ? value.options.slice(0, 4) : [];
    while (sourceOptions.length < 4) sourceOptions.push({});
    value.id = value.id || uid(`q${index + 1}`);
    value.question = value.question || '';
    value.options = sourceOptions.map((option, optionIndex) => ({
      id: optionIds[optionIndex],
      text: option?.text || '',
    }));
    value.correctOptionId = optionIds.includes(value.correctOptionId)
      ? value.correctOptionId
      : 'a';
    value.explanation = value.explanation || '';
    return value;
  }

  function normalizeLesson(lesson, index) {
    const value = clone(lesson || {});
    value.id = value.id || uid('licao');
    value.order = index + 1;
    value.title = value.title || `Lição ${index + 1}`;
    value.description = value.description || '';
    value.pdfUrl = value.pdfUrl || '';
    value.pdfTitle = value.pdfTitle || '';
    value.pdfMediaId = value.pdfMediaId || null;
    value.videoProvider = value.videoProvider || 'youtube';
    value.videoUrl = value.videoUrl || '';
    value.videoEmbedId = value.videoEmbedId || '';
    value.videoMediaId = value.videoMediaId || null;
    value.videoTitle = value.videoTitle || '';
    value.quiz = Array.isArray(value.quiz)
      ? value.quiz.map(normalizeQuestion)
      : [];
    value.quizConfig = {
      passingScore: Number(value.quizConfig?.passingScore ?? 4),
      maxAttempts: Number(value.quizConfig?.maxAttempts ?? 3),
      shuffleQuestions: value.quizConfig?.shuffleQuestions !== false,
      shuffleOptions: value.quizConfig?.shuffleOptions !== false,
    };
    return value;
  }

  function normalizeModule(module, index) {
    const value = clone(module || {});
    value.id = value.id || uid('modulo');
    value.order = index + 1;
    value.title = value.title || `Módulo ${index + 1}`;
    value.description = value.description || '';
    value.coverImage = value.coverImage || '';
    value.coverMediaId = value.coverMediaId || null;
    value.lessons = Array.isArray(value.lessons)
      ? value.lessons.map(normalizeLesson)
      : [];
    return value;
  }

  function normalizeCourseCategory(value) {
    const raw = String(value || '').trim();
    if (COURSE_CATEGORIES.includes(raw)) return raw;
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
    const prerequisiteCourseIds = Array.isArray(policy.prerequisiteCourseIds)
      ? [...new Set(policy.prerequisiteCourseIds.map(id => String(id || '').trim()).filter(Boolean))]
      : [];
    return {
      mode,
      prerequisiteCourseIds: mode === 'restricted' ? prerequisiteCourseIds : [],
      prerequisiteMode: 'all',
      requiredPastoralPhase: mode === 'restricted' && PASTORAL_PHASES.includes(policy.requiredPastoralPhase)
        ? policy.requiredPastoralPhase : null,
      catalogVisibility: policy.catalogVisibility === 'hidden_until_eligible'
        ? 'hidden_until_eligible'
        : 'show_locked',
    };
  }

  function prerequisiteGraphHasCycle(currentCourse) {
    const graph = new Map();
    state.courses.forEach(course => {
      graph.set(course.id, course.id === currentCourse.id
        ? [...currentCourse.accessPolicy.prerequisiteCourseIds]
        : [...(course.accessPolicy?.prerequisiteCourseIds || [])]);
    });
    graph.set(currentCourse.id, [...currentCourse.accessPolicy.prerequisiteCourseIds]);
    const states = new Map();
    function visit(courseId) {
      if (states.get(courseId) === 'visiting') return true;
      if (states.get(courseId) === 'visited') return false;
      states.set(courseId, 'visiting');
      for (const prerequisiteId of graph.get(courseId) || []) {
        if (graph.has(prerequisiteId) && visit(prerequisiteId)) return true;
      }
      states.set(courseId, 'visited');
      return false;
    }
    return [...graph.keys()].some(visit);
  }

  function normalizeCourse(course, options) {
    const config = options || {};
    const value = clone(course || {});
    value.id = value.id || slugify(value.title) || uid('curso');
    value.title = value.title || 'Novo curso';
    value.slug = value.slug || slugify(value.title);
    value.subtitle = value.subtitle || '';
    value.description = value.description || '';
    value.status = value.status || (config.seedPublished ? 'published' : 'draft');
    if (!STATUS_LABELS[value.status]) value.status = 'draft';
    value.category = normalizeCourseCategory(value.category);
    value.level = value.level || 'Iniciante';
    value.duration = value.duration || '';
    value.coverImage = value.coverImage || '';
    value.coverMediaId = value.coverMediaId || null;
    value.featured = Boolean(value.featured);
    value.accessPolicy = normalizeAccessPolicy(value.accessPolicy);
    value.pricing = {
      fullPrice: Number(value.pricing?.fullPrice ?? 0),
      memberDiscount: Number(value.pricing?.memberDiscount ?? 0),
      discountPercent: Number(
        value.pricing?.discountPercent ?? ((value.pricing?.memberDiscount || 0) * 100),
      ),
      currency: value.pricing?.currency || 'BRL',
      mode: value.pricing?.mode || 'production',
      installments: Array.isArray(value.pricing?.installments)
        ? value.pricing.installments
        : [1, 2, 3, 6, 12],
      paymentMethods: Array.isArray(value.pricing?.paymentMethods)
        ? value.pricing.paymentMethods
        : ['credit_card', 'pix', 'boleto'],
    };
    value.modules = Array.isArray(value.modules)
      ? value.modules.map(normalizeModule)
      : [];
    value.createdAt = value.createdAt || new Date().toISOString();
    value.updatedAt = value.updatedAt || new Date().toISOString();
    return value;
  }

  function createBlankLesson(index) {
    return normalizeLesson({
      title: `Lição ${index + 1}`,
      quiz: [],
      quizConfig: {
        passingScore: 1,
        maxAttempts: 3,
        shuffleQuestions: true,
        shuffleOptions: true,
      },
    }, index);
  }

  function createBlankModule(index) {
    return normalizeModule({
      title: `Módulo ${index + 1}`,
      lessons: [createBlankLesson(0)],
    }, index);
  }

  function createBlankCourse() {
    return normalizeCourse({
      id: uid('curso'),
      title: 'Novo curso',
      status: 'draft',
      level: 'Iniciante',
      category: 'Discipular',
      accessPolicy: { mode: 'open', prerequisiteCourseIds: [], prerequisiteMode: 'all', requiredPastoralPhase: null, catalogVisibility: 'show_locked' },
      pricing: { fullPrice: 0, memberDiscount: 0, discountPercent: 0 },
      modules: [createBlankModule(0)],
    });
  }

  function renewNestedIds(course) {
    const value = clone(course);
    delete value.revision;
    value.id = `${slugify(value.title)}-copia-${Date.now().toString(36)}`;
    value.modules.forEach(module => {
      module.id = uid('modulo');
      module.lessons.forEach(lesson => {
        lesson.id = uid('licao');
        lesson.quiz.forEach((question, index) => {
          question.id = uid(`q${index + 1}`);
        });
      });
    });
    return value;
  }

  function getPath(object, path) {
    return String(path).split('.').reduce((current, key) => current?.[key], object);
  }

  function setPath(object, path, nextValue) {
    const parts = String(path).split('.');
    let current = object;
    parts.slice(0, -1).forEach(part => {
      current = current[part];
    });
    current[parts.at(-1)] = nextValue;
  }

  function reorder(items, from, to) {
    if (to < 0 || to >= items.length || from === to) return false;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    items.forEach((entry, index) => { entry.order = index + 1; });
    return true;
  }

  async function apiRequest(url, options) {
    let response;
    try {
      const endpoint = window.BetaConfig?.apiUrl(url) || url;
      const authorization = await (window.BetaConfig?.authorizationHeaders?.() || {});
      response = await fetch(endpoint, {
        ...(options || {}),
        credentials: window.BetaConfig?.credentialsFor(url) || 'same-origin',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'BetaCursosAdmin',
          ...authorization,
          ...(options?.headers || {}),
        },
      });
    } catch (error) {
      throw new ApiError('O servidor administrativo não está disponível.', 0, error);
    }

    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (response.status !== 204) {
      if (contentType.includes('application/json')) {
        payload = await response.json().catch(() => null);
      } else {
        payload = await response.text().catch(() => '');
      }
    }
    if (!response.ok) {
      const message = payload?.message
        || payload?.error?.message
        || (typeof payload?.error === 'string' ? payload.error : '')
        || `Não foi possível concluir a operação (${response.status}).`;
      throw new ApiError(message, response.status, payload);
    }
    return payload;
  }

  function unwrapCollection(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
  }

  function unwrapEntity(payload, key) {
    return payload?.[key] || payload?.data?.[key] || payload?.data || payload;
  }

  const remoteAdapter = {
    async bootstrap() {
      const payload = await apiRequest('/api/admin/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ApiError('O endpoint administrativo não está disponível nesta instalação.', 503, payload);
      }
      return payload;
    },
    async listCourses() {
      const payload = await apiRequest('/api/admin/courses');
      if (!Array.isArray(payload) && (!payload || typeof payload !== 'object')) {
        throw new ApiError('A resposta da lista de cursos é inválida.', 502, payload);
      }
      return unwrapCollection(payload, 'courses').map(course => normalizeCourse(course));
    },
    async listPublicCourses() {
      const payload = await apiRequest('/api/courses');
      return unwrapCollection(payload, 'courses').map(course => normalizeCourse(course));
    },
    async getCourse(id) {
      const payload = await apiRequest(`/api/admin/courses/${encodeURIComponent(id)}`);
      return normalizeCourse(unwrapEntity(payload, 'course'));
    },
    async createCourse(course) {
      const payload = await apiRequest('/api/admin/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(course),
      });
      return normalizeCourse(unwrapEntity(payload, 'course') || course);
    },
    async updateCourse(id, course) {
      const updatePayload = { ...course };
      if (Object.prototype.hasOwnProperty.call(course, 'revision')) {
        updatePayload.revision = course.revision;
      }
      const payload = await apiRequest(`/api/admin/courses/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload),
      });
      if (!payload) return remoteAdapter.getCourse(id);
      return normalizeCourse(unwrapEntity(payload, 'course') || course);
    },
    async deleteCourse(id) {
      return apiRequest(`/api/admin/courses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async uploadMedia(file, kind) {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind || mediaKindFromType(file.type));
      const payload = await apiRequest('/api/admin/media', { method: 'POST', body: form });
      return normalizeMedia(unwrapEntity(payload, 'media'), file);
    },
    async deleteMedia(id) {
      return apiRequest(`/api/admin/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    async listMedia() {
      const payload = await apiRequest('/api/admin/media');
      if (!Array.isArray(payload) && (!payload || typeof payload !== 'object')) {
        throw new ApiError('A resposta da biblioteca de mídia é inválida.', 502, payload);
      }
      return unwrapCollection(payload, 'media').map(item => normalizeMedia(item));
    },
    async listStudents() {
      const payload = await apiRequest('/api/admin/students');
      if (!Array.isArray(payload) && (!payload || typeof payload !== 'object')) {
        throw new ApiError('A resposta da lista de alunos é inválida.', 502, payload);
      }
      return unwrapCollection(payload, 'students');
    },
    async getStudentProgress(id) {
      const payload = await apiRequest(`/api/admin/students/${encodeURIComponent(id)}/progress`);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ApiError('O detalhamento do aluno é inválido.', 502, payload);
      }
      return payload;
    },
    async deactivateStudent(id) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}/deactivate`, { method: 'POST' });
    },
    async reactivateStudent(id) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}/reactivate`, { method: 'POST' });
    },
    async updateStudentPastoralPhase(id, pastoralPhase) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}/pastoral-phase`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pastoralPhase }),
      });
    },
    async grantStudentPastoralCourse(id, grant) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}/pastoral-grants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(grant),
      });
    },
    async revokeStudentPastoralCourse(id, grantId) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}/pastoral-grants/${encodeURIComponent(grantId)}/revoke`, { method: 'POST' });
    },
    async deleteStudent(id, confirmEmail) {
      return apiRequest(`/api/admin/students/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail }),
      });
    },
    async listTeam() {
      const payload = await apiRequest('/api/admin/team');
      return unwrapCollection(payload, 'members');
    },
    async updateTeamRole(id, role) {
      const payload = await apiRequest(`/api/admin/team/${encodeURIComponent(id)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      return unwrapEntity(payload, 'member');
    },
    async exportData() {
      return apiRequest('/api/admin/export');
    },
    async importData(data) {
      return apiRequest('/api/admin/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...data,
          mode: 'replace',
          confirm: 'SUBSTITUIR',
        }),
      });
    },
  };

  function readLocalStore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || 'null');
      if (parsed && Array.isArray(parsed.courses) && Array.isArray(parsed.media)) {
        if (Number(parsed.version || 1) < LOCAL_STORE_VERSION) {
          parsed.courses = parsed.courses.map(course => {
            const value = clone(course);
            const isLegacyLiderePrice = value.id === 'jornada-lidere'
              && Number(value.pricing?.fullPrice) === 19.90
              && (Number(value.pricing?.memberDiscount) === 0.30
                || Number(value.pricing?.discountPercent) === 30);
            if (isLegacyLiderePrice) {
              value.pricing.memberDiscount = 0;
              value.pricing.discountPercent = 0;
            }
            return value;
          });
          parsed.version = LOCAL_STORE_VERSION;
          writeLocalStore(parsed);
        }
        return parsed;
      }
    } catch (_) {
      // Um armazenamento local inválido é reiniciado sem afetar dados do servidor.
    }
    const initial = {
      version: LOCAL_STORE_VERSION,
      courses: getSeedCourses().map(course => normalizeCourse(course, { seedPublished: true })),
      media: [],
      updatedAt: new Date().toISOString(),
    };
    writeLocalStore(initial);
    return initial;
  }

  function writeLocalStore(data) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
      ...data,
      version: LOCAL_STORE_VERSION,
      updatedAt: new Date().toISOString(),
    }));
  }

  const localAdapter = {
    async bootstrap() {
      const data = readLocalStore();
      return { courses: data.courses, media: data.media, local: true };
    },
    async listCourses() {
      return readLocalStore().courses.map(course => normalizeCourse(course));
    },
    async getCourse(id) {
      const course = readLocalStore().courses.find(item => item.id === id);
      if (!course) throw new ApiError('Curso não encontrado.', 404);
      return normalizeCourse(course);
    },
    async createCourse(course) {
      const store = readLocalStore();
      const value = normalizeCourse(course);
      if (store.courses.some(item => item.id === value.id)) value.id = `${value.id}-${Date.now().toString(36)}`;
      value.revision = 1;
      value.createdAt = new Date().toISOString();
      value.updatedAt = value.createdAt;
      store.courses.push(value);
      writeLocalStore(store);
      return value;
    },
    async updateCourse(id, course) {
      const store = readLocalStore();
      const index = store.courses.findIndex(item => item.id === id);
      if (index < 0) throw new ApiError('Curso não encontrado.', 404);
      const value = normalizeCourse({ ...course, updatedAt: new Date().toISOString() });
      value.revision = Number(store.courses[index].revision || 0) + 1;
      store.courses[index] = value;
      writeLocalStore(store);
      return value;
    },
    async deleteCourse(id) {
      const store = readLocalStore();
      store.courses = store.courses.filter(item => item.id !== id);
      writeLocalStore(store);
      return { ok: true };
    },
    async uploadMedia(file, kind) {
      if (file.size > LOCAL_FILE_LIMIT) {
        throw new ApiError('No modo local, arquivos devem ter até 4 MB. Para vídeos maiores, use um link ou conecte o servidor.', 413);
      }
      const url = await fileToDataUrl(file);
      const store = readLocalStore();
      const media = normalizeMedia({
        id: uid('midia'),
        name: file.name,
        filename: file.name,
        type: file.type,
        kind: kind || mediaKindFromType(file.type),
        size: file.size,
        url,
        createdAt: new Date().toISOString(),
      }, file);
      store.media.unshift(media);
      writeLocalStore(store);
      return media;
    },
    async deleteMedia(id) {
      const store = readLocalStore();
      store.media = store.media.filter(item => item.id !== id);
      writeLocalStore(store);
      return { ok: true };
    },
    async listMedia() {
      return readLocalStore().media.map(item => normalizeMedia(item));
    },
    async listStudents() {
      return getAdminStudents() || [];
    },
    async exportData() {
      return readLocalStore();
    },
    async importData(data) {
      const normalized = normalizeBackup(data);
      writeLocalStore(normalized);
      return normalized;
    },
  };

  function mediaKindFromType(type) {
    if (String(type).includes('pdf')) return 'pdf';
    if (String(type).startsWith('video/')) return 'video';
    if (String(type).startsWith('image/')) return 'image';
    return 'document';
  }

  function normalizeMedia(media, file) {
    const value = media || {};
    return {
      id: value.id || uid('midia'),
      name: value.name || value.filename || file?.name || 'Arquivo',
      filename: value.filename || value.name || file?.name || 'arquivo',
      type: value.type || value.contentType || file?.type || 'application/octet-stream',
      kind: value.kind || mediaKindFromType(value.type || value.contentType || file?.type),
      size: Number(value.size ?? file?.size ?? 0),
      url: value.url || value.publicUrl || value.downloadUrl || '',
      createdAt: value.createdAt || new Date().toISOString(),
    };
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new ApiError('Não foi possível ler o arquivo.', 0));
      reader.readAsDataURL(file);
    });
  }

  function normalizeBackup(data) {
    const source = data?.data || data || {};
    const rawCourses = Array.isArray(source) ? source : source.courses;
    if (!Array.isArray(rawCourses)) {
      throw new ApiError('Backup inválido: a lista de cursos não foi encontrada.', 400);
    }
    return {
      version: 1,
      courses: rawCourses.map(course => normalizeCourse(course)),
      media: Array.isArray(source.media) ? source.media.map(item => normalizeMedia(item)) : [],
      updatedAt: new Date().toISOString(),
    };
  }

  function dispatchCoursesChanged() {
    window.dispatchEvent(new CustomEvent('beta:courses-changed', {
      detail: {
        courses: clone(state.courses),
        source: state.mode,
      },
    }));
  }

  function normalizeVideoUrl(rawValue, selectedProvider) {
    const raw = String(rawValue || '').trim();
    if (!raw) return { provider: selectedProvider || 'youtube', url: '', embedId: '' };
    if (/^\/api\/media\/[a-zA-Z0-9_-]{8,100}$/.test(raw)) {
      return { provider: 'upload', url: raw, embedId: '' };
    }
    let url;
    try {
      const candidate = /^(?:https?|data|blob):/i.test(raw)
        ? raw
        : /^(?:\/|\.\/|\.\.\/)/.test(raw)
          ? new URL(raw, window.location.href).href
          : `https://${raw}`;
      url = new URL(candidate);
    } catch (_) {
      return { provider: selectedProvider || 'direct', url: raw, embedId: '', invalid: true };
    }
    if (['data:', 'blob:'].includes(url.protocol)) {
      const isUploadedVideo = selectedProvider === 'upload' && (url.protocol === 'blob:' || /^data:video\//i.test(raw));
      return { provider: 'upload', url: raw, embedId: '', invalid: !isUploadedVideo };
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { provider: selectedProvider || 'direct', url: raw, embedId: '', invalid: true };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'youtu.be' || host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      let id = '';
      if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
      if (!id) id = url.searchParams.get('v') || '';
      if (!id) {
        const parts = url.pathname.split('/').filter(Boolean);
        const marker = parts.findIndex(part => ['embed', 'shorts', 'live'].includes(part));
        if (marker >= 0) id = parts[marker + 1] || '';
      }
      id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      const validId = /^[A-Za-z0-9_-]{11}$/.test(id);
      return {
        provider: 'youtube',
        url: validId ? `https://www.youtube.com/watch?v=${id}` : raw,
        embedId: validId ? id : '',
        invalid: !validId,
      };
    }

    if (host === 'vimeo.com' || host.endsWith('.vimeo.com')) {
      const id = (url.pathname.match(/(?:video\/)?(\d{6,15})/) || [])[1] || '';
      return {
        provider: 'vimeo',
        url: id ? `https://vimeo.com/${id}` : raw,
        embedId: id,
        invalid: !id,
      };
    }

    return { provider: selectedProvider === 'upload' ? 'upload' : 'direct', url: url.href, embedId: '' };
  }

  function validateCourse(course) {
    const errors = [];
    function add(path, message) { errors.push({ path, message }); }
    if (!course.title.trim()) add('title', 'Informe o nome do curso.');
    if (!course.description.trim()) add('description', 'Escreva a descrição do curso.');
    if (!COURSE_CATEGORIES.includes(course.category)) add('category', 'Selecione uma categoria válida.');
    if (course.accessPolicy.mode === 'restricted') {
      const prerequisites = course.accessPolicy.prerequisiteCourseIds;
      if (!prerequisites.length && !course.accessPolicy.requiredPastoralPhase) {
        add('accessPolicy', 'Defina uma fase pastoral, ao menos um pré-requisito, ou deixe o curso aberto.');
      }
      if (course.accessPolicy.requiredPastoralPhase && !PASTORAL_PHASES.includes(course.accessPolicy.requiredPastoralPhase)) {
        add('accessPolicy.requiredPastoralPhase', 'Selecione uma fase pastoral válida.');
      }
      if (prerequisites.includes(course.id)) add('accessPolicy.prerequisiteCourseIds', 'Um curso não pode exigir a própria conclusão.');
      const knownIds = new Set(state.courses.map(item => item.id));
      if (prerequisites.some(id => !knownIds.has(id))) {
        add('accessPolicy.prerequisiteCourseIds', 'Remova pré-requisitos que não existem mais no catálogo.');
      }
      if (prerequisiteGraphHasCycle(course)) {
        add('accessPolicy.prerequisiteCourseIds', 'Os pré-requisitos formam um ciclo entre cursos. Revise a sequência.');
      }
    }
    if (!course.level.trim()) add('level', 'Informe o nível.');
    if (!course.duration.trim()) add('duration', 'Informe a duração.');
    if (Number(course.pricing.fullPrice) < 0) add('pricing.fullPrice', 'O preço não pode ser negativo.');
    if (Number(course.pricing.discountPercent) < 0 || Number(course.pricing.discountPercent) > 100) {
      add('pricing.discountPercent', 'O desconto deve estar entre 0% e 100%.');
    }
    if (!course.modules.length) add('modules', 'Adicione ao menos um módulo.');

    course.modules.forEach((module, moduleIndex) => {
      const modulePrefix = `modules.${moduleIndex}`;
      if (!module.title.trim()) add(`${modulePrefix}.title`, `Dê um nome ao módulo ${moduleIndex + 1}.`);
      if (!module.lessons.length) add(`${modulePrefix}.lessons`, `O módulo ${moduleIndex + 1} precisa ter ao menos uma lição.`);
      module.lessons.forEach((lesson, lessonIndex) => {
        const lessonName = lesson.title || `Lição ${lessonIndex + 1}`;
        const prefix = `${modulePrefix}.lessons.${lessonIndex}`;
        if (!lesson.title.trim()) add(`${prefix}.title`, `Informe o título da lição ${lessonIndex + 1}.`);
        if (!lesson.description.trim()) add(`${prefix}.description`, `${lessonName}: escreva uma descrição.`);
        const normalizedVideo = normalizeVideoUrl(lesson.videoUrl, lesson.videoProvider);
        const hasConfiguredVideo = Boolean(lesson.videoUrl || lesson.videoEmbedId);
        const hasUploadedVideo = lesson.videoProvider === 'upload' && Boolean(lesson.videoUrl);
        if (hasConfiguredVideo && normalizedVideo.invalid && !hasUploadedVideo) {
          add(`${prefix}.videoUrl`, `${lessonName}: o vídeo informado é inválido.`);
        }
        if (lesson.quiz.length > 0) {
          if (Number(lesson.quizConfig.passingScore) < 1 || Number(lesson.quizConfig.passingScore) > lesson.quiz.length) {
            add(`${prefix}.quizConfig.passingScore`, `${lessonName}: a nota mínima deve estar entre 1 e ${lesson.quiz.length}.`);
          }
          if (Number(lesson.quizConfig.maxAttempts) < 1) {
            add(`${prefix}.quizConfig.maxAttempts`, `${lessonName}: informe ao menos uma tentativa.`);
          }
        }
        lesson.quiz.forEach((question, questionIndex) => {
          const questionPrefix = `${prefix}.quiz.${questionIndex}`;
          if (!question.question.trim()) add(`${questionPrefix}.question`, `${lessonName}, questão ${questionIndex + 1}: escreva o enunciado.`);
          if (!Array.isArray(question.options) || question.options.length !== 4) {
            add(`${questionPrefix}.options`, `${lessonName}, questão ${questionIndex + 1}: são necessárias 4 alternativas.`);
          } else if (question.options.some(option => !option.text.trim())) {
            add(`${questionPrefix}.options`, `${lessonName}, questão ${questionIndex + 1}: preencha as 4 alternativas.`);
          }
          if (!question.options.some(option => option.id === question.correctOptionId)) {
            add(`${questionPrefix}.correctOptionId`, `${lessonName}, questão ${questionIndex + 1}: marque a resposta correta.`);
          }
        });
      });
    });
    return errors;
  }

  function readiness(course) {
    const errors = validateCourse(course);
    const totalLessons = course.modules.reduce((sum, module) => sum + module.lessons.length, 0);
    const totalQuestions = course.modules.reduce(
      (sum, module) => sum + module.lessons.reduce((lessonSum, lesson) => lessonSum + lesson.quiz.length, 0),
      0,
    );
    return { errors, ready: errors.length === 0, totalLessons, totalQuestions };
  }

  function shellTemplate() {
    return `
      <div class="beta-admin" data-ba-app>
        <a class="ba-skip-link" href="#ba-main">Pular para o conteúdo</a>
        <header class="ba-mobile-header">
          <div class="ba-brand" aria-label="Beta Cursos">
            <span class="ba-brand__beta">Beta</span><span class="ba-brand__cursos">cursos</span>
          </div>
          <button class="ba-icon-button" type="button" data-action="toggle-menu" aria-expanded="false" aria-controls="ba-sidebar">Menu</button>
        </header>
        <div class="ba-layout">
          <aside id="ba-sidebar" class="ba-sidebar" aria-label="Navegação administrativa">
            <div class="ba-sidebar__brand">
              <div class="ba-brand"><span class="ba-brand__beta">Beta</span><span class="ba-brand__cursos">cursos</span></div>
              <span class="ba-sidebar__eyebrow">Administração</span>
            </div>
            <nav class="ba-nav">
              ${navButton('overview', '01', 'Visão geral', 'content')}
              ${navButton('courses', '02', 'Cursos', 'content')}
              ${navButton('media', '03', 'Mídia', 'content')}
              ${navButton('students', '04', 'Alunos')}
              ${navButton('team', '05', 'Equipe', 'owner')}
              ${navButton('backup', '06', 'Exportações e segurança', 'content')}
            </nav>
            <div class="ba-sidebar__footer">
              <span class="ba-connection" data-ba-connection><i></i> Conectando…</span>
              <button type="button" class="ba-link-button" data-action="leave-admin">Voltar ao site</button>
            </div>
          </aside>
          <button class="ba-backdrop" type="button" data-action="close-menu" aria-label="Fechar menu"></button>
          <main id="ba-main" class="ba-main" tabindex="-1">
            <div id="ba-mode-banner"></div>
            <div id="ba-view" aria-live="polite"></div>
          </main>
        </div>
        <div class="ba-toast-region" data-ba-toasts role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="ba-modal-layer" data-ba-modal></div>
      </div>
    `;
  }

  function navButton(view, number, label, permission = '') {
    return `<button type="button" class="ba-nav__item" data-view="${view}"${permission ? ` data-permission="${permission}"` : ''}>
      <span class="ba-nav__number" aria-hidden="true">${number}</span><span>${label}</span>
    </button>`;
  }

  function applyRoleVisibility() {
    state.root.querySelectorAll('[data-permission="content"]').forEach(element => {
      element.hidden = !canManageContent();
    });
    state.root.querySelectorAll('[data-permission="owner"]').forEach(element => {
      element.hidden = !isOwner();
    });
  }

  function renderModeBanner() {
    const banner = state.root.querySelector('#ba-mode-banner');
    const connection = state.root.querySelector('[data-ba-connection]');
    if (state.mode === 'local') {
      banner.innerHTML = `<div class="ba-banner ba-banner--warning" role="status">
        <strong>Modo local de desenvolvimento.</strong>
        As alterações ficam somente neste navegador porque o servidor administrativo não respondeu. Não use este modo para operar a plataforma com alunos reais.
      </div>`;
      connection.innerHTML = '<i></i> Modo local';
      connection.classList.add('is-local');
      connection.classList.remove('is-error');
    } else if (state.mode === 'api') {
      banner.innerHTML = '';
      connection.innerHTML = '<i></i> Servidor conectado';
      connection.classList.remove('is-local', 'is-error');
    } else if (state.mode === 'error' || state.mode === 'denied') {
      banner.innerHTML = '';
      connection.innerHTML = `<i></i> ${state.mode === 'denied' ? 'Acesso restrito' : 'Sem conexão'}`;
      connection.classList.remove('is-local');
      connection.classList.add('is-error');
    } else {
      banner.innerHTML = '';
      connection.innerHTML = '<i></i> Conectando…';
      connection.classList.remove('is-local', 'is-error');
    }
  }

  function pageHeader(eyebrow, title, description, actions) {
    return `<header class="ba-page-header">
      <div>
        <div class="ba-eyebrow">${escapeHtml(eyebrow)}</div>
        <h1>${escapeHtml(title)}</h1>
        ${description ? `<p>${escapeHtml(description)}</p>` : ''}
      </div>
      ${actions ? `<div class="ba-page-actions">${actions}</div>` : ''}
    </header>`;
  }

  function statusBadge(status) {
    const safeStatus = STATUS_LABELS[status] ? status : 'draft';
    return `<span class="ba-status ba-status--${safeStatus}"><i></i>${STATUS_LABELS[safeStatus]}</span>`;
  }

  function render() {
    if (!state.root) return;
    renderModeBanner();
    applyRoleVisibility();
    state.root.querySelectorAll('[data-view]').forEach(button => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const view = state.root.querySelector('#ba-view');
    if (state.loading) {
      view.innerHTML = `<div class="ba-loading" role="status"><span></span><p>Preparando o painel…</p></div>`;
      return;
    }
    if (state.initError) {
      const denied = state.mode === 'denied';
      view.innerHTML = `${pageHeader(denied ? 'Acesso restrito' : 'Serviço administrativo', 'Não foi possível abrir o painel', denied ? 'Sua sessão não tem permissão administrativa ou expirou.' : 'Não foi possível carregar os dados administrativos.')}<section class="ba-panel">${emptyState(denied ? 'Acesso administrativo necessário' : 'Painel temporariamente indisponível', state.initError.message || (denied ? 'Entre novamente com uma conta autorizada.' : 'Verifique a conexão e tente novamente.'))}</section>`;
      return;
    }
    switch (state.view) {
      case 'courses': view.innerHTML = coursesTemplate(); break;
      case 'editor': view.innerHTML = editorTemplate(); break;
      case 'media': view.innerHTML = mediaTemplate(); break;
      case 'students': view.innerHTML = studentsTemplate(); break;
      case 'team': view.innerHTML = isOwner() ? teamTemplate() : studentsTemplate(); break;
      case 'backup': view.innerHTML = backupTemplate(); break;
      default: view.innerHTML = overviewTemplate();
    }
    updateDirtyIndicator();
  }

  function overviewTemplate() {
    const published = state.courses.filter(course => course.status === 'published').length;
    const drafts = state.courses.filter(course => course.status === 'draft').length;
    const lessons = state.courses.reduce(
      (sum, course) => sum + course.modules.reduce((moduleSum, module) => moduleSum + module.lessons.length, 0),
      0,
    );
    const incomplete = state.courses.filter(course => !readiness(course).ready);
    const recent = [...state.courses]
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .slice(0, 5);
    return `
      ${pageHeader('Centro de formação', 'Visão geral', 'Acompanhe o conteúdo, a publicação e a preparação dos cursos.', '<button class="ba-button ba-button--primary" type="button" data-action="new-course">Criar curso</button>')}
      <section class="ba-stat-grid" aria-label="Resumo da plataforma">
        ${statCard('Cursos publicados', published, 'Disponíveis para os alunos')}
        ${statCard('Rascunhos', drafts, 'Em preparação')}
        ${statCard('Lições', lessons, 'Em todos os cursos')}
        ${statCard('Arquivos', state.media.length, 'Na biblioteca de mídia')}
      </section>
      <div class="ba-overview-grid">
        <section class="ba-panel">
          <div class="ba-panel__header"><div><span class="ba-eyebrow">Conteúdo</span><h2>Cursos recentes</h2></div><button class="ba-link-button" type="button" data-view="courses">Ver todos</button></div>
          ${recent.length ? `<div class="ba-compact-list">${recent.map(course => {
            const info = readiness(course);
            return `<button type="button" class="ba-compact-course" data-action="edit-course" data-course-id="${escapeAttr(course.id)}">
              <span class="ba-course-monogram">${escapeHtml(course.title.slice(0, 2).toUpperCase())}</span>
              <span class="ba-compact-course__body"><strong>${escapeHtml(course.title)}</strong><small>${info.totalLessons} lições · Atualizado em ${escapeHtml(formatDate(course.updatedAt))}</small></span>
              ${statusBadge(course.status)}
            </button>`;
          }).join('')}</div>` : emptyState('Nenhum curso criado', 'Crie o primeiro curso da plataforma para começar.')}
        </section>
        <aside class="ba-panel ba-readiness">
          <div class="ba-panel__header"><div><span class="ba-eyebrow">Qualidade</span><h2>Preparação para publicar</h2></div></div>
          ${incomplete.length ? `
            <p class="ba-muted">${incomplete.length} curso${incomplete.length > 1 ? 's precisam' : ' precisa'} de revisão antes da publicação.</p>
            <div class="ba-readiness-list">${incomplete.slice(0, 4).map(course => {
              const count = readiness(course).errors.length;
              return `<button type="button" data-action="edit-course" data-course-id="${escapeAttr(course.id)}"><span>${escapeHtml(course.title)}</span><strong>${count} pendência${count > 1 ? 's' : ''}</strong></button>`;
            }).join('')}</div>`
            : `<div class="ba-success-state"><span aria-hidden="true">✓</span><strong>Conteúdo em ordem</strong><p>Todos os cursos atendem aos critérios de publicação.</p></div>`}
        </aside>
      </div>
      <section class="ba-callout">
        <div><span class="ba-eyebrow">Próximo passo</span><h2>Construa uma jornada completa</h2><p>Use em cada lição apenas os recursos necessários: apostila, vídeo, teste ou uma combinação deles.</p></div>
        <button type="button" class="ba-button ba-button--outline" data-action="new-course">Novo curso</button>
      </section>`;
  }

  function statCard(label, value, detail) {
    return `<article class="ba-stat-card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span><small>${escapeHtml(detail)}</small></article>`;
  }

  function coursesTemplate() {
    const categories = [...new Set(state.courses.map(course => course.category).filter(Boolean))].sort();
    const term = state.courseSearch.trim().toLocaleLowerCase('pt-BR');
    const courses = state.courses.filter(course => {
      const matchesSearch = !term || `${course.title} ${course.subtitle} ${course.category}`.toLocaleLowerCase('pt-BR').includes(term);
      const matchesStatus = state.courseStatus === 'all' || course.status === state.courseStatus;
      const matchesCategory = state.courseCategory === 'all' || course.category === state.courseCategory;
      return matchesSearch && matchesStatus && matchesCategory;
    });
    return `
      ${pageHeader('Catálogo', 'Cursos', 'Crie, organize e publique as formações da igreja.', '<button class="ba-button ba-button--primary" type="button" data-action="new-course">Criar curso</button>')}
      <section class="ba-toolbar" aria-label="Filtros de cursos">
        <label class="ba-search"><span class="ba-sr-only">Buscar cursos</span><input type="search" data-filter="course-search" value="${escapeAttr(state.courseSearch)}" placeholder="Buscar por nome ou categoria…"><i aria-hidden="true">⌕</i></label>
        <label><span class="ba-sr-only">Filtrar por situação</span><select data-filter="course-status">
          ${selectOption('all', state.courseStatus, 'Todas as situações')}
          ${selectOption('draft', state.courseStatus, 'Rascunhos')}
          ${selectOption('published', state.courseStatus, 'Publicados')}
          ${selectOption('archived', state.courseStatus, 'Arquivados')}
        </select></label>
        <label><span class="ba-sr-only">Filtrar por categoria</span><select data-filter="course-category">
          ${selectOption('all', state.courseCategory, 'Todas as categorias')}
          ${categories.map(category => selectOption(category, state.courseCategory, category)).join('')}
        </select></label>
        <span class="ba-result-count">${courses.length} de ${state.courses.length}</span>
      </section>
      ${courses.length ? `<div class="ba-course-grid">${courses.map(courseCard).join('')}</div>` : emptyState('Nenhum curso encontrado', 'Ajuste os filtros ou crie uma nova formação.')}
    `;
  }

  function courseCard(course) {
    const info = readiness(course);
    return `<article class="ba-course-card">
      <div class="ba-course-card__cover" ${safeUrl(course.coverImage) ? `style="background-image:url('${escapeAttr(safeCssUrl(course.coverImage))}')"` : ''}>
        ${course.coverImage ? '' : `<span>${escapeHtml(course.title.slice(0, 2).toUpperCase())}</span>`}
        <div class="ba-course-card__status">${statusBadge(course.status)}</div>
      </div>
      <div class="ba-course-card__body">
        <div class="ba-course-card__meta"><span>${escapeHtml(course.category || 'Sem categoria')}</span><span>${escapeHtml(course.level)}</span></div>
        <h2>${escapeHtml(course.title)}</h2>
        <p>${escapeHtml(course.subtitle || course.description || 'Descrição ainda não informada.')}</p>
        <div class="ba-course-card__facts">
          <span>${info.totalLessons} lições</span><span>${info.totalQuestions} questões</span><span>${money(course.pricing.fullPrice)}</span>
        </div>
        <div class="ba-course-card__readiness ${info.ready ? 'is-ready' : ''}">
          <span>${info.ready ? '✓ Pronto para publicar' : `${info.errors.length} pendência${info.errors.length > 1 ? 's' : ''}`}</span>
        </div>
      </div>
      <footer class="ba-course-card__actions">
        <button type="button" class="ba-button ba-button--small ba-button--outline" data-action="edit-course" data-course-id="${escapeAttr(course.id)}">Editar</button>
        <div class="ba-menu-wrap">
          <button type="button" class="ba-icon-button" data-action="toggle-card-menu" aria-expanded="false" aria-label="Mais ações para ${escapeAttr(course.title)}">•••</button>
          <div class="ba-card-menu" hidden>
            <button type="button" data-action="duplicate-course" data-course-id="${escapeAttr(course.id)}">Duplicar</button>
            ${course.status === 'archived'
              ? `<button type="button" data-action="change-course-status" data-status="draft" data-course-id="${escapeAttr(course.id)}">Restaurar como rascunho</button>`
              : `<button type="button" data-action="change-course-status" data-status="archived" data-course-id="${escapeAttr(course.id)}">Arquivar</button>`}
            ${course.status === 'draft' ? `<button type="button" class="is-danger" data-action="delete-course" data-course-id="${escapeAttr(course.id)}">Excluir</button>` : ''}
          </div>
        </div>
      </footer>
    </article>`;
  }

  function editorTemplate() {
    const course = state.editorCourse;
    if (!course) return emptyState('Curso não carregado', 'Volte para a lista e selecione um curso.');
    const info = readiness(course);
    const title = state.editorIsNew ? 'Criar curso' : course.title;
    const actions = `
      <span class="ba-save-state" data-ba-save-state aria-live="polite">${state.editorDirty ? 'Alterações não salvas' : 'Tudo salvo'}</span>
      <button class="ba-button ba-button--ghost" type="button" data-action="validate-course">Verificar</button>
      <button class="ba-button ba-button--outline" type="button" data-action="save-course">Salvar</button>
      ${course.status === 'published'
        ? '<button class="ba-button ba-button--secondary" type="button" data-action="unpublish-course">Voltar a rascunho</button>'
        : '<button class="ba-button ba-button--primary" type="button" data-action="publish-course">Publicar</button>'}`;
    return `
      <div class="ba-editor-top">
        <button type="button" class="ba-back-button" data-action="back-to-courses">← Cursos</button>
        ${pageHeader(state.editorIsNew ? 'Novo conteúdo' : STATUS_LABELS[course.status], title, state.editorIsNew ? 'Preencha os dados e salve o rascunho.' : `Última atualização: ${formatDate(course.updatedAt)}`, actions)}
      </div>
      ${state.validationErrors.length ? validationSummary(state.validationErrors) : ''}
      <div class="ba-editor-tabs" role="tablist" aria-label="Seções do curso">
        ${editorTabButton('details', 'Informações')}
        ${editorTabButton('content', `Conteúdo (${info.totalLessons})`)}
        ${editorTabButton('settings', 'Publicação e preço')}
      </div>
      <div class="ba-editor-panel" role="tabpanel">
        ${state.editorTab === 'content' ? editorContentTemplate(course) : state.editorTab === 'settings' ? editorSettingsTemplate(course) : editorDetailsTemplate(course)}
      </div>`;
  }

  function editorTabButton(tab, label) {
    const active = state.editorTab === tab;
    return `<button type="button" role="tab" aria-selected="${active}" class="${active ? 'is-active' : ''}" data-editor-tab="${tab}">${escapeHtml(label)}</button>`;
  }

  function validationSummary(errors) {
    return `<section class="ba-validation" tabindex="-1" data-ba-validation role="alert">
      <div><strong>Revise ${errors.length} ${errors.length === 1 ? 'item' : 'itens'} antes de publicar</strong><p>Rascunhos incompletos podem ser salvos normalmente.</p></div>
      <ul>${errors.slice(0, 8).map(error => `<li>${escapeHtml(error.message)}</li>`).join('')}${errors.length > 8 ? `<li>Mais ${errors.length - 8} pendências.</li>` : ''}</ul>
    </section>`;
  }

  function editorDetailsTemplate(course) {
    return `<div class="ba-form-layout">
      <section class="ba-form-section">
        <div class="ba-section-heading"><span class="ba-eyebrow">Apresentação</span><h2>Informações do curso</h2><p>Esses dados aparecem no catálogo e na página de inscrição.</p></div>
        <div class="ba-form-grid">
          ${field('Nome do curso', 'title', course.title, { required: true, span: 2 })}
          ${field('Subtítulo', 'subtitle', course.subtitle, { span: 2, placeholder: 'Uma frase curta para apresentar a formação' })}
          ${textareaField('Descrição', 'description', course.description, { required: true, span: 2, rows: 6 })}
          ${selectField('Categoria', 'category', course.category, COURSE_CATEGORIES.map(value => ({ value, label: value })), { required: true })}
          ${selectField('Nível', 'level', course.level, LEVELS.map(value => ({ value, label: value })), { required: true })}
          ${field('Duração', 'duration', course.duration, { required: true, placeholder: 'Ex.: 6 lições ou 8 horas' })}
          ${field('Identificador do curso', 'id', course.id, { readonly: true, help: 'Gerado uma única vez. A ordem dos módulos e lições não altera seus identificadores.' })}
        </div>
      </section>
      <aside class="ba-form-section ba-cover-section">
        <div class="ba-section-heading"><span class="ba-eyebrow">Imagem</span><h2>Capa do curso</h2></div>
        <div class="ba-cover-preview" ${safeUrl(course.coverImage) ? `style="background-image:url('${escapeAttr(safeCssUrl(course.coverImage))}')"` : ''}>${safeUrl(course.coverImage) ? '' : `<span>${escapeHtml(course.title.slice(0, 2).toUpperCase())}</span>`}</div>
        ${field('Endereço da imagem', 'coverImage', course.coverImage, { type: 'url', placeholder: 'https://…' })}
        <label class="ba-upload-button"><span>Importar imagem</span><input type="file" accept="image/*" data-upload-target="cover"></label>
        ${mediaSelect('Usar imagem da biblioteca', 'cover', 'image', course.coverMediaId)}
        <label class="ba-check"><input type="checkbox" data-course-field="featured" ${course.featured ? 'checked' : ''}><span>Destacar este curso no catálogo</span></label>
      </aside>
    </div>`;
  }

  function editorSettingsTemplate(course) {
    return `<div class="ba-settings-grid">
      <section class="ba-form-section">
        <div class="ba-section-heading"><span class="ba-eyebrow">Comercial</span><h2>Preço e condições</h2><p>Configure o valor exibido e o modo de inscrição do curso.</p></div>
        <div class="ba-form-grid">
          ${field('Preço integral (R$)', 'pricing.fullPrice', course.pricing.fullPrice, { type: 'number', min: 0, step: '0.01', required: true })}
          ${selectField('Moeda', 'pricing.currency', course.pricing.currency, [{ value: 'BRL', label: 'Real brasileiro (BRL)' }])}
          ${selectField('Tipo de inscrição', 'pricing.mode', course.pricing.mode, [
            { value: 'production', label: 'Curso com contribuição' },
            { value: 'free', label: 'Curso gratuito' },
          ])}
        </div>
        <div class="ba-price-preview"><span>Valor exibido no catálogo</span><strong>${money(course.pricing.fullPrice)}</strong><small>A inscrição paga será liberada quando o provedor oficial estiver conectado.</small></div>
      </section>
      <section class="ba-form-section">
        <div class="ba-section-heading"><span class="ba-eyebrow">Disponibilidade</span><h2>Situação do curso</h2></div>
        <div class="ba-status-options">
          ${statusRadio('draft', course.status, 'Rascunho', 'Visível apenas na administração; pode ficar incompleto.')}
          ${statusRadio('published', course.status, 'Publicado', 'Disponível no catálogo após passar pela verificação.')}
          ${statusRadio('archived', course.status, 'Arquivado', 'Retirado do catálogo sem apagar o conteúdo.')}
        </div>
        <div class="ba-readiness-box ${readiness(course).ready ? 'is-ready' : ''}">
          <strong>${readiness(course).ready ? '✓ Curso pronto para publicação' : `${readiness(course).errors.length} pendência${readiness(course).errors.length > 1 ? 's' : ''}`}</strong>
          <p>${readiness(course).ready ? 'A estrutura obrigatória está configurada. Os recursos de cada lição são opcionais.' : 'Use o botão Verificar para consultar todos os itens.'}</p>
        </div>
      </section>
      ${coursePrerequisitesTemplate(course)}
    </div>`;
  }

  function coursePrerequisitesTemplate(course) {
    const restricted = course.accessPolicy.mode === 'restricted';
    const otherCourses = state.courses
      .filter(item => item.id !== course.id && item.status !== 'archived')
      .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
    return `<section class="ba-form-section ba-form-section--wide">
      <div class="ba-section-heading"><span class="ba-eyebrow">Sequência de formação</span><h2>Pré-requisitos</h2><p>Defina quais cursos precisam ser concluídos antes deste conteúdo.</p></div>
      <div class="ba-form-grid">
        ${selectField('Regra de acesso', 'accessPolicy.mode', course.accessPolicy.mode, [
          { value: 'open', label: 'Aberto para todos' },
          { value: 'restricted', label: 'Acesso pastoral ou pré-requisitos — Exigir conclusão de outros cursos quando configurado' },
        ])}
        ${selectField('Fase pastoral mínima', 'accessPolicy.requiredPastoralPhase', course.accessPolicy.requiredPastoralPhase || '', [
          { value: '', label: 'Não exigir fase específica' },
          ...PASTORAL_PHASES.map(value => ({ value, label: value })),
        ], { dataAttr: restricted ? '' : 'disabled aria-disabled="true"' })}
        ${selectField('Exibição no catálogo', 'accessPolicy.catalogVisibility', course.accessPolicy.catalogVisibility, [
          { value: 'show_locked', label: 'Mostrar bloqueado e explicar os requisitos' },
          { value: 'hidden_until_eligible', label: 'Ocultar até concluir os requisitos' },
        ], { dataAttr: restricted ? '' : 'disabled aria-disabled="true"' })}
      </div>
      <fieldset class="ba-prerequisites" ${restricted ? '' : 'disabled'}>
        <legend>Cursos obrigatórios (todos precisam ser concluídos)</legend>
        ${otherCourses.length
          ? `<div class="ba-prerequisite-grid">${otherCourses.map(item => `<label class="ba-prerequisite-option"><input type="checkbox" data-course-prerequisite value="${escapeAttr(item.id)}" ${course.accessPolicy.prerequisiteCourseIds.includes(item.id) ? 'checked' : ''}><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.category)} · ${STATUS_LABELS[item.status]}</small></span></label>`).join('')}</div>`
          : '<p class="ba-muted">Crie outro curso para configurá-lo como pré-requisito.</p>'}
      </fieldset>
    </section>`;
  }

  function statusRadio(value, selected, title, description) {
    return `<label class="ba-status-option ${value === selected ? 'is-selected' : ''}"><input type="radio" name="ba-course-status" data-course-field="status" value="${value}" ${value === selected ? 'checked' : ''}><span>${statusBadge(value)}<strong>${escapeHtml(title)}</strong><small>${escapeHtml(description)}</small></span></label>`;
  }

  function editorContentTemplate(course) {
    if (!course.modules.length) {
      return `${emptyState('Nenhum módulo adicionado', 'Comece criando o primeiro módulo do curso.')}<div class="ba-centered-action"><button class="ba-button ba-button--primary" data-action="add-module" type="button">Adicionar módulo</button></div>`;
    }
    state.selectedModule = Math.min(state.selectedModule, course.modules.length - 1);
    const module = course.modules[state.selectedModule];
    state.selectedLesson = Math.min(state.selectedLesson, Math.max(0, module.lessons.length - 1));
    const lesson = module.lessons[state.selectedLesson];
    return `<div class="ba-builder">
      <aside class="ba-builder-nav">
        <div class="ba-builder-nav__header"><div><span class="ba-eyebrow">Estrutura</span><h2>Módulos e lições</h2></div><button class="ba-icon-button" type="button" data-action="add-module" aria-label="Adicionar módulo">+</button></div>
        <div class="ba-module-list">${course.modules.map((item, moduleIndex) => moduleNavItem(item, moduleIndex)).join('')}</div>
      </aside>
      <section class="ba-builder-editor">
        ${moduleEditor(module, state.selectedModule)}
        ${lesson ? lessonEditor(lesson, state.selectedModule, state.selectedLesson) : `<div class="ba-inline-empty"><p>Este módulo ainda não tem lições.</p><button type="button" class="ba-button ba-button--primary" data-action="add-lesson">Adicionar lição</button></div>`}
      </section>
    </div>`;
  }

  function moduleNavItem(module, moduleIndex) {
    const selected = moduleIndex === state.selectedModule;
    return `<div class="ba-module-nav ${selected ? 'is-selected' : ''}">
      <button type="button" class="ba-module-nav__title" data-action="select-module" data-index="${moduleIndex}" aria-current="${selected ? 'true' : 'false'}"><span>${String(moduleIndex + 1).padStart(2, '0')}</span><strong>${escapeHtml(module.title)}</strong></button>
      ${selected ? `<div class="ba-lesson-nav">${module.lessons.map((lesson, lessonIndex) => `<button type="button" class="${lessonIndex === state.selectedLesson ? 'is-selected' : ''}" data-action="select-lesson" data-index="${lessonIndex}"><span>${lessonIndex + 1}</span>${escapeHtml(lesson.title)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function moduleEditor(module, moduleIndex) {
    return `<section class="ba-module-editor">
      <div class="ba-builder-heading">
        <div><span class="ba-eyebrow">Módulo ${moduleIndex + 1}</span><h2>${escapeHtml(module.title)}</h2></div>
        <div class="ba-order-actions" aria-label="Organizar módulo">
          <button type="button" class="ba-icon-button" data-action="move-module-up" ${moduleIndex === 0 ? 'disabled' : ''} aria-label="Mover módulo para cima">↑</button>
          <button type="button" class="ba-icon-button" data-action="move-module-down" ${moduleIndex === state.editorCourse.modules.length - 1 ? 'disabled' : ''} aria-label="Mover módulo para baixo">↓</button>
          <button type="button" class="ba-icon-button ba-icon-button--danger" data-action="delete-module" aria-label="Excluir módulo">Excluir</button>
        </div>
      </div>
      <div class="ba-form-grid">
        ${field('Título do módulo', `modules.${moduleIndex}.title`, module.title, { required: true })}
        ${textareaField('Descrição do módulo', `modules.${moduleIndex}.description`, module.description, { rows: 2 })}
      </div>
      <div class="ba-module-cover-editor">
        <div class="ba-module-cover-preview" ${safeUrl(module.coverImage || state.editorCourse.coverImage) ? `style="background-image:url('${escapeAttr(safeCssUrl(module.coverImage || state.editorCourse.coverImage))}')"` : ''}>
          ${safeUrl(module.coverImage || state.editorCourse.coverImage) ? '' : `<span>${String(moduleIndex + 1).padStart(2, '0')}</span>`}
        </div>
        <div class="ba-module-cover-fields">
          <div class="ba-section-heading ba-section-heading--compact"><span class="ba-eyebrow">Imagem opcional</span><h3>Capa do módulo</h3><p>Se ficar vazia, o módulo usará a capa principal do curso.</p></div>
          ${field('Endereço da imagem', `modules.${moduleIndex}.coverImage`, module.coverImage, { type: 'url', placeholder: 'https://…' })}
          <div class="ba-attach-row">
            <label class="ba-upload-button"><span>Importar imagem</span><input type="file" accept="image/*" data-upload-target="module-cover"></label>
            ${mediaSelect('Usar imagem da biblioteca', 'module-cover', 'image', module.coverMediaId)}
            ${module.coverImage ? '<button type="button" class="ba-link-button" data-action="remove-module-cover">Remover capa</button>' : ''}
          </div>
        </div>
      </div>
      <button type="button" class="ba-button ba-button--outline ba-button--small" data-action="add-lesson">+ Adicionar lição</button>
    </section>`;
  }

  function lessonEditor(lesson, moduleIndex, lessonIndex) {
    const prefix = `modules.${moduleIndex}.lessons.${lessonIndex}`;
    const normalized = normalizeVideoUrl(lesson.videoUrl, lesson.videoProvider);
    return `<section class="ba-lesson-editor">
      <div class="ba-builder-heading">
        <div><span class="ba-eyebrow">Lição ${lessonIndex + 1}</span><h2>${escapeHtml(lesson.title)}</h2></div>
        <div class="ba-order-actions" aria-label="Organizar lição">
          <button type="button" class="ba-icon-button" data-action="move-lesson-up" ${lessonIndex === 0 ? 'disabled' : ''} aria-label="Mover lição para cima">↑</button>
          <button type="button" class="ba-icon-button" data-action="move-lesson-down" ${lessonIndex === state.editorCourse.modules[moduleIndex].lessons.length - 1 ? 'disabled' : ''} aria-label="Mover lição para baixo">↓</button>
          <button type="button" class="ba-icon-button ba-icon-button--danger" data-action="delete-lesson" aria-label="Excluir lição">Excluir</button>
        </div>
      </div>
      <div class="ba-form-grid">
        ${field('Título da lição', `${prefix}.title`, lesson.title, { required: true, span: 2 })}
        ${textareaField('Descrição', `${prefix}.description`, lesson.description, { required: true, span: 2, rows: 3 })}
      </div>
      <div class="ba-content-block">
        <div class="ba-content-block__heading"><span class="ba-step-number">01</span><div><h3>Apostila <small>(opcional)</small></h3><p>Adicione um PDF somente quando esta lição precisar de material de leitura.</p></div></div>
        <div class="ba-form-grid">
          ${field('Título da apostila', `${prefix}.pdfTitle`, lesson.pdfTitle, { placeholder: `Apostila — ${lesson.title}` })}
          ${field('Endereço do PDF', `${prefix}.pdfUrl`, lesson.pdfUrl, { type: 'url', placeholder: 'https://… ou arquivo importado' })}
        </div>
        <div class="ba-attach-row">
          <label class="ba-upload-button"><span>Importar PDF</span><input type="file" accept="application/pdf" data-upload-target="pdf"></label>
          ${mediaSelect('Escolher da biblioteca', 'pdf', 'pdf', lesson.pdfMediaId)}
          ${safeUrl(lesson.pdfUrl) ? `<a class="ba-link-button" href="${escapeAttr(safeUrl(lesson.pdfUrl))}" target="_blank" rel="noopener">Visualizar apostila</a>` : ''}
        </div>
      </div>
      <div class="ba-content-block">
        <div class="ba-content-block__heading"><span class="ba-step-number">02</span><div><h3>Vídeo <small>(opcional)</small></h3><p>Use YouTube, Vimeo, endereço direto ou envie um arquivo quando necessário.</p></div></div>
        <div class="ba-form-grid">
          ${selectField('Origem do vídeo', `${prefix}.videoProvider`, lesson.videoProvider, Object.entries(VIDEO_PROVIDERS).map(([value, label]) => ({ value, label })), { dataAttr: 'data-video-provider' })}
          ${field('Título do vídeo', `${prefix}.videoTitle`, lesson.videoTitle, { placeholder: `Aula — ${lesson.title}` })}
          <label class="ba-field ba-field--span-2"><span>Link ou endereço do vídeo</span><div class="ba-inline-input"><input type="url" data-video-url="${escapeAttr(prefix)}" value="${escapeAttr(lesson.videoUrl)}" placeholder="Cole o link do YouTube, Vimeo ou arquivo"><button type="button" class="ba-button ba-button--small ba-button--outline" data-action="normalize-video">Reconhecer link</button></div><small>${normalized.embedId ? `${VIDEO_PROVIDERS[normalized.provider]} reconhecido · código ${escapeHtml(normalized.embedId)}` : 'Links do YouTube e Vimeo são convertidos automaticamente para o formato do player.'}</small></label>
        </div>
        <div class="ba-attach-row">
          <label class="ba-upload-button"><span>Importar vídeo</span><input type="file" accept="video/*" data-upload-target="video"></label>
          ${mediaSelect('Escolher vídeo da biblioteca', 'video', 'video', lesson.videoMediaId)}
        </div>
      </div>
      <div class="ba-content-block ba-quiz-builder">
        <div class="ba-content-block__heading"><span class="ba-step-number">03</span><div><h3>Teste da lição <small>(opcional)</small></h3><p>Adicione questões somente quando quiser avaliar o aluno. Cada questão continua usando 4 alternativas.</p></div></div>
        <div class="ba-quiz-settings">
          ${field(`Nota mínima (de 1 a ${Math.max(1, lesson.quiz.length)})`, `${prefix}.quizConfig.passingScore`, lesson.quizConfig.passingScore, { type: 'number', min: 1, max: Math.max(1, lesson.quiz.length) })}
          ${field('Tentativas permitidas', `${prefix}.quizConfig.maxAttempts`, lesson.quizConfig.maxAttempts, { type: 'number', min: 1, max: 20 })}
          <label class="ba-check"><input type="checkbox" data-course-field="${prefix}.quizConfig.shuffleQuestions" ${lesson.quizConfig.shuffleQuestions ? 'checked' : ''}><span>Embaralhar questões</span></label>
          <label class="ba-check"><input type="checkbox" data-course-field="${prefix}.quizConfig.shuffleOptions" ${lesson.quizConfig.shuffleOptions ? 'checked' : ''}><span>Embaralhar alternativas</span></label>
        </div>
        <div class="ba-question-list">${lesson.quiz.map((question, questionIndex) => questionEditor(question, prefix, questionIndex)).join('')}</div>
        <button type="button" class="ba-button ba-button--outline" data-action="add-question">+ Adicionar questão</button>
        <span class="ba-question-count ${lesson.quiz.length > 0 ? 'is-ready' : ''}"> ${lesson.quiz.length} ${lesson.quiz.length === 1 ? 'questão' : 'questões'}${lesson.quiz.length === 0 ? ' · opcional' : ''}</span>
      </div>
    </section>`;
  }

  function questionEditor(question, lessonPrefix, questionIndex) {
    const prefix = `${lessonPrefix}.quiz.${questionIndex}`;
    return `<fieldset class="ba-question-card">
      <legend><span>Questão ${String(questionIndex + 1).padStart(2, '0')}</span><button type="button" class="ba-link-button ba-link-button--danger" data-action="remove-question" data-question-index="${questionIndex}">Remover</button></legend>
      ${textareaField('Enunciado', `${prefix}.question`, question.question, { required: true, rows: 2, span: 2 })}
      <div class="ba-options" role="radiogroup" aria-label="Alternativas da questão ${questionIndex + 1}">
        ${question.options.map((option, optionIndex) => `<label class="ba-option ${option.id === question.correctOptionId ? 'is-correct' : ''}">
          <input type="radio" name="correct-${escapeAttr(question.id)}" data-correct-option="${escapeAttr(prefix)}" value="${escapeAttr(option.id)}" ${option.id === question.correctOptionId ? 'checked' : ''}>
          <span class="ba-option__letter">${String.fromCharCode(65 + optionIndex)}</span>
          <span class="ba-sr-only">Marcar como correta</span>
          <input type="text" data-course-field="${escapeAttr(prefix)}.options.${optionIndex}.text" value="${escapeAttr(option.text)}" placeholder="Alternativa ${String.fromCharCode(65 + optionIndex)}" aria-label="Texto da alternativa ${String.fromCharCode(65 + optionIndex)}">
        </label>`).join('')}
      </div>
      ${textareaField('Explicação após responder (opcional)', `${prefix}.explanation`, question.explanation, { rows: 2, span: 2 })}
    </fieldset>`;
  }

  function mediaTemplate() {
    const term = state.mediaSearch.trim().toLocaleLowerCase('pt-BR');
    const files = state.media.filter(item => {
      const matchesSearch = !term || `${item.name} ${item.filename}`.toLocaleLowerCase('pt-BR').includes(term);
      const matchesKind = state.mediaKind === 'all' || item.kind === state.mediaKind;
      return matchesSearch && matchesKind;
    });
    return `
      ${pageHeader('Arquivos', 'Biblioteca de mídia', 'Centralize apostilas, imagens e vídeos usados nos cursos.', '<label class="ba-button ba-button--primary ba-file-button"><span>Importar arquivos</span><input type="file" multiple accept="application/pdf,image/*,video/*" data-upload-target="library"></label>')}
      <section class="ba-toolbar" aria-label="Filtros de mídia">
        <label class="ba-search"><span class="ba-sr-only">Buscar arquivos</span><input type="search" data-filter="media-search" value="${escapeAttr(state.mediaSearch)}" placeholder="Buscar arquivos…"><i aria-hidden="true">⌕</i></label>
        <label><span class="ba-sr-only">Tipo de arquivo</span><select data-filter="media-kind">
          ${selectOption('all', state.mediaKind, 'Todos os tipos')}${selectOption('pdf', state.mediaKind, 'Apostilas PDF')}${selectOption('video', state.mediaKind, 'Vídeos')}${selectOption('image', state.mediaKind, 'Imagens')}${selectOption('document', state.mediaKind, 'Outros arquivos')}
        </select></label>
        <span class="ba-result-count">${files.length} arquivo${files.length === 1 ? '' : 's'}</span>
      </section>
      ${files.length ? `<div class="ba-media-grid">${files.map(mediaCard).join('')}</div>` : emptyState('Biblioteca vazia', 'Importe uma apostila, imagem ou vídeo para começar.')}
      ${state.mode === 'local' ? '<p class="ba-footnote">No modo local, arquivos são limitados a 4 MB. O servidor conectado aceita mídias maiores conforme a configuração de armazenamento.</p>' : ''}`;
  }

  function mediaCard(item) {
    const label = { pdf: 'PDF', video: 'Vídeo', image: 'Imagem', document: 'Arquivo' }[item.kind] || 'Arquivo';
    return `<article class="ba-media-card">
      <div class="ba-media-card__preview ${item.kind === 'image' ? 'is-image' : ''}" ${item.kind === 'image' && safeUrl(item.url) ? `style="background-image:url('${escapeAttr(safeCssUrl(item.url))}')"` : ''}>
        ${item.kind === 'image' && safeUrl(item.url) ? '' : `<span>${escapeHtml(label.slice(0, 3).toUpperCase())}</span>`}
      </div>
      <div class="ba-media-card__body"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong><span>${escapeHtml(label)} · ${formatBytes(item.size)}</span><small>${formatDate(item.createdAt)}</small></div>
      <div class="ba-media-card__actions">${safeUrl(item.url) ? `<a href="${escapeAttr(safeUrl(item.url))}" target="_blank" rel="noopener" class="ba-link-button">Abrir</a>` : ''}<button type="button" class="ba-link-button ba-link-button--danger" data-action="delete-media" data-media-id="${escapeAttr(item.id)}">Excluir</button></div>
    </article>`;
  }

  function getAdminStudents() {
    const source = window.BetaAdminStudents;
    if (Array.isArray(source)) return clone(source);
    if (Array.isArray(source?.students)) return clone(source.students);
    if (typeof source?.list === 'function') {
      try {
        const listed = source.list();
        if (Array.isArray(listed)) return clone(listed);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function studentProgressEntries(student) {
    const entries = Object.entries(student.progress || {});
    if (!entries.length) {
      return [{ student, courseId: null, progress: {
        percentage: 0,
        completedLessons: 0,
        totalLessons: 0,
        status: 'not_started',
      } }];
    }
    return entries.map(([courseId, progress]) => ({ student, courseId, progress: progress || {} }));
  }

  function progressStatusValue(progress) {
    if (['not_started', 'in_progress', 'completed'].includes(progress?.status)) {
      return progress.status;
    }
    const percentage = Number(progress?.percentage) || 0;
    return percentage >= 100 ? 'completed' : percentage > 0 ? 'in_progress' : 'not_started';
  }

  function progressStatusLabel(status) {
    return {
      completed: 'Concluído',
      in_progress: 'Em andamento',
      not_started: 'Ainda não iniciou',
      locked: 'Bloqueada',
      available: 'Disponível',
    }[status] || 'Não iniciado';
  }

  function courseLessonTitle(courseId, lessonId) {
    if (!courseId || !lessonId) return '';
    const course = state.courses.find(item => item.id === courseId);
    for (const module of course?.modules || []) {
      const lesson = (module.lessons || []).find(item => item.id === lessonId);
      if (lesson) return lesson.title || lessonId;
    }
    return lessonId;
  }

  function studentsTemplate() {
    const students = state.students;
    const usesDemoStudents = state.studentsSource === 'demo';
    if (!Array.isArray(students)) {
      return `${pageHeader('Acompanhamento pastoral', 'Progresso dos alunos', 'Consulte a evolução dos participantes em cada formação.')}
        <section class="ba-panel">${emptyState('Dados de alunos indisponíveis', 'Não foi possível carregar o acompanhamento neste momento. Atualize o painel para tentar novamente.')}</section>`;
    }
    const allRows = students.flatMap(studentProgressEntries);
    const term = state.studentSearch.trim().toLocaleLowerCase('pt-BR');
    const filtered = allRows.filter(row => {
      const haystack = `${row.student.name || ''} ${row.student.email || ''} ${row.student.memberCode || ''}`
        .toLocaleLowerCase('pt-BR');
      const matchesSearch = !term || haystack.includes(term);
      const matchesCourse = state.studentCourse === 'all' || row.courseId === state.studentCourse;
      const matchesStatus = state.studentStatus === 'all'
        || progressStatusValue(row.progress) === state.studentStatus;
      const accountStatus = row.student.accountStatus === 'disabled' ? 'disabled' : 'active';
      const matchesAccount = state.studentAccountStatus === 'all'
        || accountStatus === state.studentAccountStatus;
      return matchesSearch && matchesCourse && matchesStatus && matchesAccount;
    });
    const enabledStudents = students.filter(student => student.accountStatus !== 'disabled');
    const disabledStudents = students.filter(student => student.accountStatus === 'disabled').length;
    const activeStudents = enabledStudents.filter(student => Object.values(student.progress || {})
      .some(progress => progressStatusValue(progress) === 'in_progress')).length;
    return `${pageHeader('Acompanhamento pastoral', 'Progresso dos alunos', 'Acompanhe matrículas, lições concluídas, resultados dos testes e último acesso.')}
      ${usesDemoStudents ? '<div class="ba-banner ba-banner--warning" role="status"><strong>Dados demonstrativos.</strong> Estes nomes e progressos servem apenas para validar a aparência do painel e não representam a base real da igreja.</div>' : ''}
      <section class="ba-stat-grid ba-stat-grid--three" aria-label="Resumo dos alunos">
        ${statCard('Alunos ativos', enabledStudents.length, 'Com acesso liberado')}
        ${statCard('Em atividade', activeStudents, 'Com curso em andamento')}
        ${statCard('Desativados', disabledStudents, 'Histórico preservado')}
      </section>
      <section class="ba-table-panel">
        <div class="ba-toolbar">
          <label class="ba-search"><span class="ba-sr-only">Buscar alunos</span><input type="search" data-filter="student-search" value="${escapeAttr(state.studentSearch)}" placeholder="Buscar por nome, e-mail ou código…"><i aria-hidden="true">⌕</i></label>
          <label><span class="ba-sr-only">Filtrar por curso</span><select data-filter="student-course">${selectOption('all', state.studentCourse, 'Todos os cursos')}${state.courses.map(course => selectOption(course.id, state.studentCourse, course.title)).join('')}</select></label>
          <label><span class="ba-sr-only">Filtrar por situação</span><select data-filter="student-status">${selectOption('all', state.studentStatus, 'Todas as situações')}${selectOption('not_started', state.studentStatus, 'Ainda não iniciou')}${selectOption('in_progress', state.studentStatus, 'Em andamento')}${selectOption('completed', state.studentStatus, 'Concluído')}</select></label>
          <label><span class="ba-sr-only">Filtrar por acesso</span><select data-filter="student-account-status">${selectOption('active', state.studentAccountStatus, 'Alunos ativos')}${selectOption('disabled', state.studentAccountStatus, 'Alunos arquivados')}${selectOption('all', state.studentAccountStatus, 'Todos os acessos')}</select></label>
          <span class="ba-result-count">${filtered.length} registro${filtered.length === 1 ? '' : 's'}</span>
        </div>
        ${filtered.length
          ? `<div class="ba-table-scroll"><table class="ba-table"><caption class="ba-sr-only">Progresso dos alunos</caption><thead><tr><th scope="col">Aluno</th><th scope="col">Curso</th><th scope="col">Progresso</th><th scope="col">Situação</th><th scope="col">Última atividade</th><th scope="col"><span class="ba-sr-only">Ações</span></th></tr></thead><tbody>${filtered.map(studentRow).join('')}</tbody></table></div>`
          : emptyState('Nenhum resultado', 'Ajuste a busca ou os filtros para localizar outras matrículas.')}
      </section>`;
  }

  function studentRow(row) {
    const { student, courseId, progress } = row;
    const course = state.courses.find(item => item.id === courseId);
    const percentage = Math.max(0, Math.min(100, Number(progress.percentage) || 0));
    const completed = Number(progress.completedLessons) || 0;
    const total = Number(progress.totalLessons) || 0;
    const status = progressStatusValue(progress);
    const currentLesson = courseLessonTitle(courseId, progress.currentLesson);
    const activityAt = progress.updatedAt || student.lastAccess;
    const accountDisabled = student.accountStatus === 'disabled';
    return `<tr class="${accountDisabled ? 'is-account-disabled' : ''}">
      <td><strong>${escapeHtml(student.name || 'Sem nome')}</strong><small>${escapeHtml(student.email || '')}</small>${accountDisabled ? '<span class="ba-account-badge ba-account-badge--disabled">Acesso desativado</span>' : ''}</td>
      <td><strong>${escapeHtml(course?.title || courseId || 'Sem matrícula ativa')}</strong>${currentLesson && status === 'in_progress' ? `<small>Atual: ${escapeHtml(currentLesson)}</small>` : ''}</td>
      <td><div class="ba-progress" role="progressbar" aria-label="${percentage}% concluído" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percentage}"><span style="width:${percentage}%"></span></div><small>${percentage}%${total ? ` · ${completed}/${total} lições` : ''}</small></td>
      <td><span class="ba-student-state ba-student-state--${escapeAttr(status)}">${progressStatusLabel(status)}</span></td>
      <td>${formatDateTime(activityAt)}</td>
      <td class="ba-table__actions"><button type="button" class="ba-link-button" data-action="open-student-progress" data-student-id="${escapeAttr(student.id)}">Ver detalhes</button></td>
    </tr>`;
  }

  function lessonMaterialBadge(label, available, completed) {
    if (!available) return '';
    const status = completed ? 'is-complete' : 'is-pending';
    return `<span class="ba-progress-tag ${status}">${completed ? '✓' : '○'} ${escapeHtml(label)}</span>`;
  }

  function studentLessonDetail(lesson) {
    const quiz = lesson.quiz || {};
    const score = quiz.hasQuiz && quiz.score != null
      ? `${quiz.score}/${quiz.questionCount}`
      : quiz.hasQuiz ? 'Sem nota' : '';
    const attempts = quiz.hasQuiz
      ? `${Number(quiz.attemptsUsed || 0)}/${Number(quiz.maxAttempts || 0)} tentativa${Number(quiz.maxAttempts || 0) === 1 ? '' : 's'}`
      : '';
    return `<li class="ba-student-lesson ${lesson.completed ? 'is-complete' : ''}">
      <div class="ba-student-lesson__main">
        <span class="ba-student-lesson__mark" aria-hidden="true">${lesson.completed ? '✓' : lesson.status === 'locked' ? '×' : '•'}</span>
        <div><strong>${escapeHtml(lesson.title)}</strong><small>${progressStatusLabel(lesson.status)}</small></div>
      </div>
      <div class="ba-student-lesson__tracking">
        ${lessonMaterialBadge('PDF', lesson.materials?.hasPdf, lesson.materials?.pdfRead)}
        ${lesson.materials?.hasVideo ? lessonMaterialBadge(
          lesson.materials?.videoCompleted
            ? 'Vídeo'
            : `Vídeo · ${Math.floor(Number(lesson.materials?.videoTracking?.percentage || 0))}%`,
          true,
          lesson.materials?.videoCompleted,
        ) : ''}
        ${quiz.hasQuiz ? `<span class="ba-progress-tag ${quiz.status === 'passed' ? 'is-complete' : 'is-pending'}">Teste: ${escapeHtml(score)} · ${escapeHtml(attempts)}</span>` : ''}
      </div>
      ${Array.isArray(quiz.attempts) && quiz.attempts.length ? `<details class="ba-attempt-history"><summary>Histórico de tentativas</summary><ul>${quiz.attempts.map(attempt => `<li><span>${formatDateTime(attempt.createdAt)}</span><strong>${attempt.score}/${attempt.questionCount}</strong><em>${attempt.passed ? 'Aprovado' : 'Não aprovado'}</em></li>`).join('')}</ul></details>` : ''}
    </li>`;
  }

  function studentCourseDetail(course) {
    const status = progressStatusValue({ status: course.progressStatus, percentage: course.percentage });
    return `<article class="ba-student-course-detail">
      <header>
        <div><span class="ba-eyebrow">Curso</span><h3>${escapeHtml(course.title)}</h3><p>${course.currentLesson ? `Lição atual: ${escapeHtml(course.currentLesson.title)}` : progressStatusLabel(status)}</p></div>
        <div class="ba-student-course-score"><strong>${Number(course.percentage) || 0}%</strong><span>${Number(course.completedLessons) || 0}/${Number(course.totalLessons) || 0} lições</span></div>
      </header>
      <div class="ba-progress ba-progress--wide"><span style="width:${Math.max(0, Math.min(100, Number(course.percentage) || 0))}%"></span></div>
      <dl class="ba-student-course-meta"><div><dt>Matrícula</dt><dd>${formatDate(course.enrolledAt)}</dd></div><div><dt>Início</dt><dd>${formatDate(course.startedAt)}</dd></div><div><dt>Última atividade</dt><dd>${formatDateTime(course.updatedAt)}</dd></div><div><dt>Situação</dt><dd>${progressStatusLabel(status)}</dd></div></dl>
      <div class="ba-student-modules">${(course.modules || []).map(module => `<section class="ba-student-module"><header><div><span>Módulo ${Number(module.order) || ''}</span><h4>${escapeHtml(module.title)}</h4></div><strong>${Number(module.percentage) || 0}%</strong></header><ul>${(module.lessons || []).map(studentLessonDetail).join('')}</ul></section>`).join('')}</div>
    </article>`;
  }

  function studentProgressModal(payload) {
    const student = payload.student || {};
    const courses = Array.isArray(payload.courses) ? payload.courses : [];
    const pastoralGrants = Array.isArray(payload.pastoralGrants) ? payload.pastoralGrants : [];
    const disabled = student.accountStatus === 'disabled';
    const managementButtons = canManageStudents()
      ? `${disabled ? `<button type="button" class="ba-button ba-button--primary" data-student-account-action="reactivate" data-student-id="${escapeAttr(student.id)}" data-student-email="${escapeAttr(student.email)}">Reativar acesso</button>` : `<button type="button" class="ba-button ba-button--ghost" data-student-account-action="deactivate" data-student-id="${escapeAttr(student.id)}" data-student-email="${escapeAttr(student.email)}">Desativar acesso</button>`}${canDeleteStudents() ? `<button type="button" class="ba-button ba-button--danger" data-student-account-action="delete" data-student-id="${escapeAttr(student.id)}" data-student-email="${escapeAttr(student.email)}">Excluir definitivamente</button>` : ''}`
      : '';
    const managementDescription = canManageStudents()
      ? (disabled ? 'Matrículas, progresso e tentativas permanecem preservados.' : 'Desative temporariamente o acesso quando necessário.')
      : 'Seu acesso é somente para acompanhamento. Alterações de conta ficam com a administração.';
    const pastoralControls = canManageStudents()
      ? `<section class="ba-student-account-actions" aria-label="Acompanhamento pastoral"><div><span class="ba-eyebrow">Jornada pastoral</span><h3>Fase e liberações excepcionais</h3><p>A fase é alterada manualmente e a conclusão de cursos não muda esta informação automaticamente.</p></div>
        <div class="ba-pastoral-controls"><label>Fase atual<select data-student-pastoral-phase>${selectOption('', student.pastoralPhase || '', 'Ainda não definida')}${PASTORAL_PHASES.map(phase => selectOption(phase, student.pastoralPhase || '', phase)).join('')}</select></label><button type="button" class="ba-button ba-button--ghost" data-action="save-student-pastoral-phase" data-student-id="${escapeAttr(student.id)}">Salvar fase</button></div>
        <div class="ba-pastoral-controls"><label>Curso para liberar<select data-student-pastoral-course>${state.courses.filter(course => course.status !== 'archived').map(course => `<option value="${escapeAttr(course.id)}">${escapeHtml(course.title)}</option>`).join('')}</select></label><label>Motivo<input data-student-pastoral-reason maxlength="500" placeholder="Ex.: liberação aprovada pela liderança"></label><label>Expira em (opcional)<input data-student-pastoral-expiry type="datetime-local"></label><button type="button" class="ba-button ba-button--primary" data-action="grant-student-pastoral-course" data-student-id="${escapeAttr(student.id)}">Liberar curso</button></div>
        ${pastoralGrants.length ? `<ul class="ba-pastoral-grants">${pastoralGrants.map(grant => `<li><div><strong>${escapeHtml(grant.courseTitle)}</strong><small>${escapeHtml(grant.reason)} · ${escapeHtml(grant.status)}${grant.expiresAt ? ` · expira ${escapeHtml(formatDateTime(grant.expiresAt))}` : ''}</small></div>${grant.status === 'active' ? `<button type="button" class="ba-link-button" data-action="revoke-student-pastoral-course" data-student-id="${escapeAttr(student.id)}" data-grant-id="${escapeAttr(grant.id)}">Revogar</button>` : ''}</li>`).join('')}</ul>` : '<p class="ba-muted">Nenhuma liberação excepcional registrada.</p>'}</section>`
      : `<section class="ba-student-account-actions"><div><span class="ba-eyebrow">Jornada pastoral</span><h3>Fase atual: ${escapeHtml(student.pastoralPhase || 'Não definida')}</h3><p>Seu acesso é somente para acompanhamento.</p></div></section>`;
    return `<div class="ba-modal-backdrop" data-action="close-student-progress"></div><section class="ba-modal ba-modal--student" role="dialog" aria-modal="true" aria-labelledby="ba-student-modal-title" data-student-progress-modal>
      <header class="ba-student-modal__header"><div><span class="ba-eyebrow">Acompanhamento individual</span><h2 id="ba-student-modal-title">${escapeHtml(student.name || 'Aluno')}</h2><p>${escapeHtml(student.email || '')}</p>${disabled ? '<span class="ba-account-badge ba-account-badge--disabled">Acesso desativado</span>' : '<span class="ba-account-badge ba-account-badge--active">Acesso ativo</span>'}</div><button type="button" class="ba-icon-button" data-action="close-student-progress" aria-label="Fechar detalhes">×</button></header>
      <dl class="ba-student-profile"><div><dt>Cadastro</dt><dd>${formatDate(student.registeredAt)}</dd></div><div><dt>Último acesso</dt><dd>${formatDateTime(student.lastAccess)}</dd></div><div><dt>Cursos</dt><dd>${courses.length}</dd></div>${student.memberCode ? `<div><dt>Código de membro</dt><dd>${escapeHtml(student.memberCode)}</dd></div>` : ''}${disabled ? `<div><dt>Desativado em</dt><dd>${formatDateTime(student.disabledAt)}</dd></div>` : ''}</dl>
      <section class="ba-student-account-actions" aria-label="Gerenciamento da conta"><div><span class="ba-eyebrow">Acesso à plataforma</span><h3>${disabled ? 'Conta arquivada' : 'Conta ativa'}</h3><p>${managementDescription}</p></div><div class="ba-student-account-actions__buttons">${managementButtons}</div></section>
      ${pastoralControls}
      <div class="ba-student-course-list">${courses.length ? courses.map(studentCourseDetail).join('') : emptyState('Nenhuma matrícula', 'Este aluno ainda não possui cursos vinculados.')}</div>
    </section>`;
  }

  function closeStudentProgress() {
    const layer = state.root?.querySelector('[data-ba-modal]');
    if (!layer?.querySelector('[data-student-progress-modal]')) return;
    layer.classList.remove('is-open');
    layer.innerHTML = '';
    document.body.classList.remove('ba-modal-open');
    state.lastFocus?.focus?.();
    state.lastFocus = null;
  }

  async function openStudentProgress(studentId) {
    if (state.mode !== 'api' || typeof state.adapter?.getStudentProgress !== 'function') {
      toast('O detalhamento completo está disponível quando o servidor está conectado.', 'info');
      return;
    }
    const layer = state.root.querySelector('[data-ba-modal]');
    state.lastFocus = document.activeElement;
    layer.innerHTML = `<div class="ba-modal-backdrop" data-action="close-student-progress"></div><section class="ba-modal ba-modal--student ba-modal--student-loading" role="dialog" aria-modal="true" aria-label="Carregando progresso" data-student-progress-modal><div class="ba-loading" role="status"><span></span><p>Carregando progresso do aluno…</p></div></section>`;
    layer.classList.add('is-open');
    document.body.classList.add('ba-modal-open');
    try {
      const detail = await state.adapter.getStudentProgress(studentId);
      layer.innerHTML = studentProgressModal(detail);
      layer.querySelector('[data-action="close-student-progress"]')?.focus();
    } catch (error) {
      closeStudentProgress();
      toast(error.message || 'Não foi possível carregar o progresso do aluno.', 'error');
    }
  }

  async function refreshStudents() {
    if (state.mode === 'api') state.students = await remoteAdapter.listStudents();
    else state.students = await localAdapter.listStudents();
  }

  async function manageStudentAccount(button) {
    if (state.mode !== 'api') {
      toast('O gerenciamento de contas está disponível somente com o servidor conectado.', 'info');
      return;
    }
    const action = button.dataset.studentAccountAction;
    const studentId = button.dataset.studentId;
    const email = button.dataset.studentEmail || '';
    let confirmed = false;

    if (action === 'deactivate') {
      confirmed = await confirmDialog({
        title: 'Desativar acesso deste aluno?',
        message: 'O login será encerrado e bloqueado, mas matrículas, progresso, tentativas e histórico permanecerão preservados.',
        confirmLabel: 'Desativar acesso',
        danger: true,
      });
    } else if (action === 'reactivate') {
      confirmed = await confirmDialog({
        title: 'Reativar acesso deste aluno?',
        message: 'O aluno poderá entrar novamente usando o mesmo e-mail e a senha atual.',
        confirmLabel: 'Reativar acesso',
      });
    } else if (action === 'delete') {
      confirmed = await typedConfirmationDialog({
        title: 'Excluir esta conta definitivamente?',
        message: 'Esta ação apaga conta, matrículas, progresso, tentativas, sessões e registros de pagamento vinculados. O e-mail ficará livre para um novo cadastro, mas o histórico antigo não poderá ser recuperado.',
        expected: email,
        confirmLabel: 'Excluir definitivamente',
      });
    }
    if (!confirmed) return;

    setBusy(true);
    try {
      if (action === 'deactivate') await remoteAdapter.deactivateStudent(studentId);
      else if (action === 'reactivate') await remoteAdapter.reactivateStudent(studentId);
      else if (action === 'delete') await remoteAdapter.deleteStudent(studentId, confirmed);
      await refreshStudents();
      render();
      toast({
        deactivate: 'Acesso desativado. O histórico do aluno foi preservado.',
        reactivate: 'Acesso reativado com sucesso.',
        delete: 'Conta excluída definitivamente. O e-mail está livre para novo cadastro.',
      }[action] || 'Conta atualizada.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível alterar a conta do aluno.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function manageStudentPastoralAccess(button) {
    if (state.mode !== 'api' || !canManageStudents()) return;
    const modal = button.closest('[data-student-progress-modal]');
    const studentId = button.dataset.studentId;
    const action = button.dataset.action;
    setBusy(true);
    try {
      if (action === 'save-student-pastoral-phase') {
        const phase = modal.querySelector('[data-student-pastoral-phase]')?.value || null;
        await remoteAdapter.updateStudentPastoralPhase(studentId, phase);
        toast(phase ? `Fase atualizada para ${phase}.` : 'Fase pastoral removida.', 'success');
      } else if (action === 'grant-student-pastoral-course') {
        const courseId = modal.querySelector('[data-student-pastoral-course]')?.value;
        const reason = modal.querySelector('[data-student-pastoral-reason]')?.value || '';
        const rawExpiry = modal.querySelector('[data-student-pastoral-expiry]')?.value || '';
        if (!courseId || reason.trim().length < 3) throw new ApiError('Informe o curso e o motivo da liberação.', 422);
        await remoteAdapter.grantStudentPastoralCourse(studentId, {
          courseId, reason: reason.trim(), expiresAt: rawExpiry ? new Date(rawExpiry).toISOString() : null,
        });
        toast('Curso liberado excepcionalmente para este aluno.', 'success');
      } else if (action === 'revoke-student-pastoral-course') {
        const confirmed = await confirmDialog({ title: 'Revogar esta liberação?', message: 'O curso só permanecerá acessível se existir outra matrícula ou liberação válida.', confirmLabel: 'Revogar liberação', danger: true });
        if (!confirmed) return;
        await remoteAdapter.revokeStudentPastoralCourse(studentId, button.dataset.grantId);
        toast('Liberação excepcional revogada.', 'success');
      }
      await refreshStudents();
      await openStudentProgress(studentId);
      render();
    } catch (error) {
      toast(error.message || 'Não foi possível atualizar o acesso pastoral.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function teamRoleLabel(role) {
    return ({ owner: 'Proprietário', admin: 'Administrador', facilitator: 'Facilitador', student: 'Aluno' })[role] || 'Aluno';
  }

  function teamTemplate() {
    const term = state.teamSearch.trim().toLocaleLowerCase('pt-BR');
    const members = state.team.filter(member => !term
      || `${member.name || ''} ${member.email || ''}`.toLocaleLowerCase('pt-BR').includes(term));
    return `${pageHeader('Permissões', 'Equipe da plataforma', 'Defina quem administra conteúdos e quem acompanha o progresso dos alunos.')}
      <section class="ba-panel">
        <div class="ba-panel__header"><div><span class="ba-eyebrow">Acessos</span><h2>Contas e funções</h2></div>
          <label class="ba-search"><span class="ba-sr-only">Buscar conta</span><input type="search" data-filter="team-search" value="${escapeAttr(state.teamSearch)}" placeholder="Buscar por nome ou e-mail…"><i aria-hidden="true">⌕</i></label>
        </div>
        <div class="ba-banner ba-banner--warning" role="note"><strong>Como funciona:</strong> administradores gerenciam cursos, mídia e acessos de alunos; facilitadores apenas acompanham alunos; somente o proprietário altera funções, exclui contas e baixa o backup completo.</div>
        ${members.length ? `<div class="ba-table-scroll"><table class="ba-table"><caption class="ba-sr-only">Equipe e permissões</caption><thead><tr><th scope="col">Pessoa</th><th scope="col">Situação</th><th scope="col">Função</th></tr></thead><tbody>${members.map(member => {
          const protectedOwner = member.role === 'owner' || member.roleManagedByConfig;
          return `<tr><td><strong>${escapeHtml(member.name || 'Sem nome')}</strong><small>${escapeHtml(member.email || '')}</small></td><td>${member.emailVerified ? 'E-mail confirmado' : 'Confirmação pendente'}${member.accountStatus === 'disabled' ? '<small>Acesso desativado</small>' : ''}</td><td>${protectedOwner
            ? `<strong>${teamRoleLabel(member.role)}</strong>${member.roleManagedByConfig && member.role !== 'owner' ? '<small>Definido no servidor</small>' : ''}`
            : `<label><span class="ba-sr-only">Função de ${escapeHtml(member.name || member.email)}</span><select data-team-role data-member-id="${escapeAttr(member.id)}" data-previous-role="${escapeAttr(member.role)}">${selectOption('student', member.role, 'Aluno')}${selectOption('facilitator', member.role, 'Facilitador')}${selectOption('admin', member.role, 'Administrador')}</select></label>`}</td></tr>`;
        }).join('')}</tbody></table></div>` : emptyState('Nenhuma conta encontrada', 'Ajuste a busca para localizar a pessoa.')}
      </section>`;
  }

  async function updateTeamRole(select) {
    const memberId = select.dataset.memberId;
    const previousRole = select.dataset.previousRole || 'student';
    const role = select.value;
    const member = state.team.find(item => item.id === memberId);
    const confirmed = await confirmDialog({
      title: `Alterar função de ${member?.name || member?.email || 'esta pessoa'}?`,
      message: `${teamRoleLabel(previousRole)} será alterado para ${teamRoleLabel(role)}. O novo acesso passa a valer imediatamente.`,
      confirmLabel: 'Alterar função',
    });
    if (!confirmed) {
      select.value = previousRole;
      return;
    }
    setBusy(true);
    try {
      const updated = await remoteAdapter.updateTeamRole(memberId, role);
      state.team = state.team.map(item => item.id === memberId ? { ...item, ...updated } : item);
      render();
      toast('Função atualizada com sucesso.', 'success');
    } catch (error) {
      select.value = previousRole;
      toast(error.message || 'Não foi possível alterar a função.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function backupTemplate() {
    const endpoint = escapeAttr(window.BetaConfig?.apiUrl('/api/admin/system-backup') || '/api/admin/system-backup');
    const ownerBackup = isOwner() && state.mode === 'api' ? `
        <section class="ba-form-section">
          <div class="ba-section-heading"><span class="ba-eyebrow">Cópia completa</span><h2>Backup integral da plataforma</h2><p>Inclui contas, cursos, matrículas, progresso, histórico administrativo e os arquivos de mídia. Sessões ativas e links temporários ficam de fora por segurança.</p></div>
          <div class="ba-danger-note"><strong>Arquivo confidencial</strong><p>O backup contém dados pessoais e credenciais protegidas. Guarde-o em local seguro e restrito.</p></div>
          <a class="ba-button ba-button--primary" href="${endpoint}" download>Baixar backup completo</a>
        </section>` : `
        <section class="ba-form-section">
          <div class="ba-section-heading"><span class="ba-eyebrow">Cópia completa</span><h2>Backup integral protegido</h2><p>Somente o proprietário da plataforma pode baixar a cópia completa com dados de alunos e arquivos.</p></div>
        </section>`;
    const restoreCatalog = isOwner() ? `
        <section class="ba-form-section">
          <div class="ba-section-heading"><span class="ba-eyebrow">Restaurar catálogo</span><h2>Importar catálogo</h2><p>A importação substitui apenas cursos e suas configurações. Ela não restaura alunos, progresso nem os arquivos físicos.</p></div>
          <label class="ba-dropzone"><input type="file" accept="application/json,.json" data-upload-target="backup"><span>Selecionar exportação de catálogo</span><small>Formato aceito: .json</small></label>
          <div class="ba-danger-note"><strong>Atenção</strong><p>Faça uma exportação antes de substituir o catálogo atual.</p></div>
        </section>` : '';
    return `${pageHeader('Proteção de dados', 'Exportações e segurança', 'Gere cópias adequadas para cada necessidade e mantenha os dados protegidos.')}
      <div class="ba-settings-grid">
        ${ownerBackup}
        <section class="ba-form-section">
          <div class="ba-section-heading"><span class="ba-eyebrow">Conteúdo</span><h2>Exportar catálogo</h2><p>Gere um JSON portátil com cursos, módulos, lições, questões e referências de mídia. Este arquivo não é um backup completo.</p></div>
          <div class="ba-backup-illustration"><span>{ }</span><div><strong>${state.courses.length} cursos</strong><small>${state.media.length} arquivos registrados</small></div></div>
          <button type="button" class="ba-button ba-button--outline" data-action="export-backup">Exportar catálogo JSON</button>
        </section>
        ${restoreCatalog}
      </div>
      <section class="ba-panel ba-system-info"><div><span class="ba-eyebrow">Ambiente</span><h2>Informações da plataforma</h2></div><dl><div><dt>Fonte dos dados</dt><dd>${state.mode === 'api' ? 'Servidor Beta Cursos' : 'Navegador local — desenvolvimento'}</dd></div><div><dt>Versão do painel</dt><dd>1.0</dd></div><div><dt>Última atualização</dt><dd>${formatDate(new Date())}</dd></div></dl></section>`;
  }

  function field(label, path, value, options) {
    const config = options || {};
    const id = `ba-field-${slugify(path)}-${Math.abs(hash(path))}`;
    const attrs = [
      `id="${id}"`,
      `type="${config.type || 'text'}"`,
      `data-course-field="${escapeAttr(path)}"`,
      `value="${escapeAttr(value)}"`,
      config.required ? 'required' : '',
      config.min != null ? `min="${escapeAttr(config.min)}"` : '',
      config.max != null ? `max="${escapeAttr(config.max)}"` : '',
      config.step != null ? `step="${escapeAttr(config.step)}"` : '',
      config.placeholder ? `placeholder="${escapeAttr(config.placeholder)}"` : '',
      config.list ? `list="${escapeAttr(config.list)}"` : '',
      config.readonly ? 'readonly aria-readonly="true"' : '',
      config.dataAttr || '',
    ].filter(Boolean).join(' ');
    return `<label class="ba-field ${config.span === 2 ? 'ba-field--span-2' : ''}" for="${id}"><span>${escapeHtml(label)}${config.required ? ' <b aria-hidden="true">*</b>' : ''}</span><input ${attrs}>${config.help ? `<small>${escapeHtml(config.help)}</small>` : ''}</label>`;
  }

  function textareaField(label, path, value, options) {
    const config = options || {};
    const id = `ba-field-${slugify(path)}-${Math.abs(hash(path))}`;
    return `<label class="ba-field ${config.span === 2 ? 'ba-field--span-2' : ''}" for="${id}"><span>${escapeHtml(label)}${config.required ? ' <b aria-hidden="true">*</b>' : ''}</span><textarea id="${id}" data-course-field="${escapeAttr(path)}" rows="${config.rows || 4}" ${config.required ? 'required' : ''}>${escapeHtml(value)}</textarea>${config.help ? `<small>${escapeHtml(config.help)}</small>` : ''}</label>`;
  }

  function selectField(label, path, value, options, config) {
    const id = `ba-field-${slugify(path)}-${Math.abs(hash(path))}`;
    return `<label class="ba-field" for="${id}"><span>${escapeHtml(label)}${config?.required ? ' <b aria-hidden="true">*</b>' : ''}</span><select id="${id}" data-course-field="${escapeAttr(path)}" ${config?.dataAttr || ''}>${options.map(option => selectOption(option.value, value, option.label)).join('')}</select></label>`;
  }

  function selectOption(value, selected, label) {
    return `<option value="${escapeAttr(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }

  function mediaSelect(label, target, kind, selectedId) {
    const files = state.media.filter(item => item.kind === kind);
    return `<label class="ba-compact-select"><span class="ba-sr-only">${escapeHtml(label)}</span><select data-attach-media="${escapeAttr(target)}"><option value="">${escapeHtml(label)}</option>${files.map(item => `<option value="${escapeAttr(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}</select></label>`;
  }

  function emptyState(title, description) {
    return `<div class="ba-empty"><span aria-hidden="true">B/</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>`;
  }

  function hash(value) {
    return String(value).split('').reduce((acc, char) => ((acc << 5) - acc + char.charCodeAt(0)) | 0, 0);
  }

  function updateDirtyIndicator() {
    const indicator = state.root?.querySelector('[data-ba-save-state]');
    if (!indicator) return;
    indicator.textContent = state.editorDirty ? 'Alterações não salvas' : 'Tudo salvo';
    indicator.classList.toggle('is-dirty', state.editorDirty);
  }

  function markDirty() {
    state.editorDirty = true;
    state.validationErrors = [];
    updateDirtyIndicator();
  }

  function toast(message, type) {
    const region = state.root?.querySelector('[data-ba-toasts]');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `ba-toast ba-toast--${type || 'info'}`;
    item.textContent = message;
    region.appendChild(item);
    requestAnimationFrame(() => item.classList.add('is-visible'));
    setTimeout(() => {
      item.classList.remove('is-visible');
      setTimeout(() => item.remove(), 250);
    }, 4200);
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    state.root?.querySelector('[data-ba-app]')?.classList.toggle('is-busy', state.busy);
  }

  async function confirmDialog(options) {
    const layer = state.root.querySelector('[data-ba-modal]');
    state.lastFocus = document.activeElement;
    layer.innerHTML = `<div class="ba-modal-backdrop" data-action="cancel-modal"></div><section class="ba-modal" role="alertdialog" aria-modal="true" aria-labelledby="ba-modal-title" aria-describedby="ba-modal-description">
      <span class="ba-eyebrow">Confirmação</span><h2 id="ba-modal-title">${escapeHtml(options.title)}</h2><p id="ba-modal-description">${escapeHtml(options.message)}</p>
      <div class="ba-modal__actions"><button type="button" class="ba-button ba-button--ghost" data-action="cancel-modal">Cancelar</button><button type="button" class="ba-button ${options.danger ? 'ba-button--danger' : 'ba-button--primary'}" data-action="confirm-modal">${escapeHtml(options.confirmLabel || 'Confirmar')}</button></div>
    </section>`;
    layer.classList.add('is-open');
    document.body.classList.add('ba-modal-open');
    const confirm = layer.querySelector('[data-action="confirm-modal"]');
    confirm.focus();
    return new Promise(resolve => {
      function finish(result) {
        layer.removeEventListener('click', onClick);
        layer.removeEventListener('keydown', onKey);
        layer.classList.remove('is-open');
        layer.innerHTML = '';
        document.body.classList.remove('ba-modal-open');
        state.lastFocus?.focus?.();
        resolve(result);
      }
      function onClick(event) {
        if (event.target.closest('[data-action="confirm-modal"]')) finish(true);
        if (event.target.closest('[data-action="cancel-modal"]')) finish(false);
      }
      function onKey(event) {
        if (event.key === 'Escape') finish(false);
        if (event.key === 'Tab') {
          const focusable = [...layer.querySelectorAll('button:not([disabled])')];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      layer.addEventListener('click', onClick);
      layer.addEventListener('keydown', onKey);
    });
  }

  async function typedConfirmationDialog(options) {
    const layer = state.root.querySelector('[data-ba-modal]');
    state.lastFocus = document.activeElement;
    const expected = String(options.expected || '');
    layer.innerHTML = `<div class="ba-modal-backdrop" data-action="cancel-modal"></div><section class="ba-modal" role="alertdialog" aria-modal="true" aria-labelledby="ba-modal-title" aria-describedby="ba-modal-description">
      <span class="ba-eyebrow">Confirmação definitiva</span><h2 id="ba-modal-title">${escapeHtml(options.title)}</h2><p id="ba-modal-description">${escapeHtml(options.message)}</p>
      <label class="ba-confirm-field"><span>Digite <strong>${escapeHtml(expected)}</strong></span><input type="email" autocomplete="off" spellcheck="false" data-confirmation-input></label>
      <div class="ba-modal__actions"><button type="button" class="ba-button ba-button--ghost" data-action="cancel-modal">Cancelar</button><button type="button" class="ba-button ba-button--danger" data-action="confirm-modal" disabled>${escapeHtml(options.confirmLabel || 'Excluir definitivamente')}</button></div>
    </section>`;
    layer.classList.add('is-open');
    document.body.classList.add('ba-modal-open');
    const input = layer.querySelector('[data-confirmation-input]');
    const confirm = layer.querySelector('[data-action="confirm-modal"]');
    input.focus();
    return new Promise(resolve => {
      function finish(result) {
        layer.removeEventListener('click', onClick);
        layer.removeEventListener('keydown', onKey);
        input.removeEventListener('input', onInput);
        layer.classList.remove('is-open');
        layer.innerHTML = '';
        document.body.classList.remove('ba-modal-open');
        state.lastFocus?.focus?.();
        resolve(result);
      }
      function onInput() {
        confirm.disabled = input.value.trim().toLocaleLowerCase('pt-BR')
          !== expected.trim().toLocaleLowerCase('pt-BR');
      }
      function onClick(event) {
        if (event.target.closest('[data-action="confirm-modal"]') && !confirm.disabled) finish(input.value.trim());
        if (event.target.closest('[data-action="cancel-modal"]')) finish(null);
      }
      function onKey(event) {
        if (event.key === 'Escape') finish(null);
        if (event.key === 'Enter' && !confirm.disabled) {
          event.preventDefault();
          finish(input.value.trim());
        }
        if (event.key === 'Tab') {
          const focusable = [...layer.querySelectorAll('input, button:not([disabled])')];
          const first = focusable[0];
          const last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }
      input.addEventListener('input', onInput);
      layer.addEventListener('click', onClick);
      layer.addEventListener('keydown', onKey);
    });
  }

  async function openView(view) {
    if (['overview', 'courses', 'editor', 'media', 'backup'].includes(view) && !canManageContent()) return;
    if (view === 'team' && !isOwner()) return;
    if (state.view === 'editor' && state.editorDirty && view !== 'editor') {
      const discard = await confirmDialog({
        title: 'Descartar alterações?',
        message: 'As mudanças ainda não salvas neste curso serão perdidas.',
        confirmLabel: 'Descartar',
        danger: true,
      });
      if (!discard) return;
    }
    state.view = view;
    state.editorCourse = view === 'editor' ? state.editorCourse : null;
    state.editorDirty = false;
    state.mobileOpen = false;
    state.root.querySelector('[data-ba-app]').classList.remove('is-menu-open');
    render();
    state.root.querySelector('#ba-main')?.focus();
  }

  async function refreshCourses() {
    state.courses = await state.adapter.listCourses();
  }

  async function editCourse(id) {
    setBusy(true);
    try {
      state.editorCourse = await state.adapter.getCourse(id);
      state.editorOriginalId = id;
      state.editorIsNew = false;
      state.editorDirty = false;
      state.editorTab = 'details';
      state.selectedModule = 0;
      state.selectedLesson = 0;
      state.validationErrors = [];
      state.view = 'editor';
      render();
    } catch (error) {
      toast(error.message || 'Não foi possível abrir o curso.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function newCourse() {
    state.editorCourse = createBlankCourse();
    state.editorOriginalId = null;
    state.editorIsNew = true;
    state.editorDirty = true;
    state.editorTab = 'details';
    state.selectedModule = 0;
    state.selectedLesson = 0;
    state.validationErrors = [];
    state.view = 'editor';
    render();
    state.root.querySelector('[data-course-field="title"]')?.select();
  }

  async function saveCourse(options) {
    const config = options || {};
    if (!state.editorCourse) return;
    if (state.editorIsNew) {
      state.editorCourse.slug = slugify(state.editorCourse.title);
    }
    const course = normalizeCourse(state.editorCourse);
    if (config.publish) course.status = 'published';
    if (config.unpublish) course.status = 'draft';
    if (course.status === 'published') {
      const errors = validateCourse(course);
      if (errors.length) {
        state.editorCourse = course;
        state.validationErrors = errors;
        state.editorTab = errors.some(error => error.path.startsWith('modules')) ? 'content' : 'details';
        render();
        requestAnimationFrame(() => state.root.querySelector('[data-ba-validation]')?.focus());
        toast('O curso precisa de ajustes antes de ser publicado.', 'error');
        return;
      }
    }
    setBusy(true);
    try {
      course.updatedAt = new Date().toISOString();
      const saved = state.editorIsNew
        ? await state.adapter.createCourse(course)
        : await state.adapter.updateCourse(state.editorOriginalId, course);
      state.editorCourse = normalizeCourse(saved || course);
      state.editorOriginalId = state.editorCourse.id;
      state.editorIsNew = false;
      state.editorDirty = false;
      state.validationErrors = [];
      await refreshCourses();
      dispatchCoursesChanged();
      render();
      toast(config.publish ? 'Curso publicado com sucesso.' : config.unpublish ? 'Curso voltou para rascunho.' : 'Alterações salvas.', 'success');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast('Conflito de edição: outra pessoa salvou este curso. Suas alterações não foram sobrescritas; recarregue o curso antes de tentar novamente.', 'error');
      } else {
        toast(error.message || 'Não foi possível salvar o curso.', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function duplicateCourse(id) {
    const source = state.courses.find(course => course.id === id);
    if (!source) return;
    const copy = renewNestedIds(source);
    copy.title = `${source.title} — cópia`;
    copy.status = 'draft';
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    setBusy(true);
    try {
      const created = await state.adapter.createCourse(copy);
      await refreshCourses();
      dispatchCoursesChanged();
      render();
      toast('Cópia criada como rascunho.', 'success');
      await editCourse(created.id);
    } catch (error) {
      toast(error.message || 'Não foi possível duplicar o curso.', 'error');
    } finally { setBusy(false); }
  }

  async function deleteCourse(id) {
    const course = state.courses.find(item => item.id === id);
    if (!course) return;
    if (course.status !== 'draft') {
      toast('Somente rascunhos podem ser excluídos. Arquive cursos já publicados.', 'error');
      return;
    }
    const confirmed = await confirmDialog({
      title: `Excluir “${course.title}”?`,
      message: 'Esta ação remove módulos, lições e questões. Faça um backup antes se precisar manter uma cópia.',
      confirmLabel: 'Excluir curso',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await state.adapter.deleteCourse(id);
      await refreshCourses();
      dispatchCoursesChanged();
      render();
      toast('Curso excluído.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível excluir o curso.', 'error');
    } finally { setBusy(false); }
  }

  async function changeCourseStatus(id, status) {
    const source = state.courses.find(course => course.id === id);
    if (!source) return;
    if (status === 'published') {
      await editCourse(id);
      await saveCourse({ publish: true });
      return;
    }
    if (status === 'archived') {
      const confirmed = await confirmDialog({
        title: 'Arquivar este curso?',
        message: 'Ele deixará de aparecer no catálogo, mas todo o conteúdo será preservado.',
        confirmLabel: 'Arquivar',
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      await state.adapter.updateCourse(id, { ...source, status, updatedAt: new Date().toISOString() });
      await refreshCourses();
      dispatchCoursesChanged();
      render();
      toast(status === 'archived' ? 'Curso arquivado.' : 'Curso restaurado como rascunho.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível alterar a situação.', 'error');
    } finally { setBusy(false); }
  }

  function selectedLesson() {
    return state.editorCourse?.modules?.[state.selectedModule]?.lessons?.[state.selectedLesson] || null;
  }

  async function uploadFiles(fileList, target) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        if (target === 'pdf' && file.type !== 'application/pdf') throw new ApiError('Selecione um arquivo PDF para a apostila.', 400);
        const expectedKind = ['cover', 'module-cover'].includes(target) ? 'image' : target === 'pdf' ? 'pdf' : target === 'video' ? 'video' : mediaKindFromType(file.type);
        const media = await state.adapter.uploadMedia(file, expectedKind);
        state.media = [media, ...state.media.filter(item => item.id !== media.id)];
        if (target === 'cover' && state.editorCourse) {
          state.editorCourse.coverImage = media.url;
          state.editorCourse.coverMediaId = media.id;
          markDirty();
        } else if (target === 'module-cover' && state.editorCourse?.modules?.[state.selectedModule]) {
          const module = state.editorCourse.modules[state.selectedModule];
          module.coverImage = media.url;
          module.coverMediaId = media.id;
          markDirty();
        } else if (target === 'pdf' && selectedLesson()) {
          const lesson = selectedLesson();
          lesson.pdfUrl = media.url;
          lesson.pdfMediaId = media.id;
          lesson.pdfTitle ||= file.name.replace(/\.pdf$/i, '');
          markDirty();
        } else if (target === 'video' && selectedLesson()) {
          const lesson = selectedLesson();
          lesson.videoProvider = 'upload';
          lesson.videoUrl = media.url;
          lesson.videoEmbedId = '';
          lesson.videoMediaId = media.id;
          lesson.videoTitle ||= file.name.replace(/\.[^.]+$/, '');
          markDirty();
        }
      }
      render();
      toast(`${files.length} arquivo${files.length > 1 ? 's importados' : ' importado'} com sucesso.`, 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível importar o arquivo.', 'error');
    } finally { setBusy(false); }
  }

  async function deleteMedia(id) {
    const media = state.media.find(item => item.id === id);
    if (!media) return;
    const confirmed = await confirmDialog({
      title: `Excluir “${media.name}”?`,
      message: 'Cursos que usam este arquivo podem ficar sem apostila, vídeo ou imagem.',
      confirmLabel: 'Excluir arquivo',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await state.adapter.deleteMedia(id);
      state.media = state.media.filter(item => item.id !== id);
      render();
      toast('Arquivo excluído da biblioteca.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível excluir o arquivo.', 'error');
    } finally { setBusy(false); }
  }

  async function exportBackup() {
    setBusy(true);
    try {
      const data = await state.adapter.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `beta-cursos-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Backup baixado.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível gerar o backup.', 'error');
    } finally { setBusy(false); }
  }

  async function importBackup(file) {
    let data;
    try {
      data = normalizeBackup(JSON.parse(await file.text()));
    } catch (error) {
      toast(error.message || 'O arquivo selecionado não é um backup válido.', 'error');
      return;
    }
    const confirmed = await confirmDialog({
      title: 'Restaurar este backup?',
      message: 'A lista atual de cursos será substituída pelo conteúdo do arquivo selecionado.',
      confirmLabel: 'Restaurar backup',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await state.adapter.importData(data);
      await refreshCourses();
      if (Array.isArray(result?.media)) state.media = result.media.map(item => normalizeMedia(item));
      else state.media = await state.adapter.listMedia();
      dispatchCoursesChanged();
      render();
      toast('Backup restaurado com sucesso.', 'success');
    } catch (error) {
      toast(error.message || 'Não foi possível restaurar o backup.', 'error');
    } finally { setBusy(false); }
  }

  function attachSelectedMedia(target, mediaId) {
    const media = state.media.find(item => item.id === mediaId);
    if (!media || !state.editorCourse) return;
    const lesson = selectedLesson();
    if (target === 'cover') {
      state.editorCourse.coverImage = media.url;
      state.editorCourse.coverMediaId = media.id;
    } else if (target === 'module-cover' && state.editorCourse.modules?.[state.selectedModule]) {
      const module = state.editorCourse.modules[state.selectedModule];
      module.coverImage = media.url;
      module.coverMediaId = media.id;
    } else if (target === 'pdf' && lesson) {
      lesson.pdfUrl = media.url;
      lesson.pdfMediaId = media.id;
      lesson.pdfTitle ||= media.name.replace(/\.pdf$/i, '');
    } else if (target === 'video' && lesson) {
      lesson.videoProvider = 'upload';
      lesson.videoUrl = media.url;
      lesson.videoEmbedId = '';
      lesson.videoMediaId = media.id;
      lesson.videoTitle ||= media.name.replace(/\.[^.]+$/, '');
    }
    markDirty();
    render();
  }

  function onCourseFieldChange(element) {
    if (!state.editorCourse) return;
    const path = element.dataset.courseField;
    if (!path) return;
    let value;
    if (element.type === 'checkbox') value = element.checked;
    else if (element.type === 'number') value = element.value === '' ? 0 : Number(element.value);
    else value = element.value;
    setPath(state.editorCourse, path, value);
    if (path === 'pricing.discountPercent') {
      state.editorCourse.pricing.memberDiscount = Number(value) / 100;
    }
    if (path === 'accessPolicy.mode' && value === 'open') {
      state.editorCourse.accessPolicy.prerequisiteCourseIds = [];
      state.editorCourse.accessPolicy.requiredPastoralPhase = null;
    }
    if (path === 'title' && state.editorIsNew) {
      state.editorCourse.slug = slugify(value);
    }
    markDirty();
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    if (!action) return;
    if (action === 'toggle-menu') {
      state.mobileOpen = !state.mobileOpen;
      state.root.querySelector('[data-ba-app]').classList.toggle('is-menu-open', state.mobileOpen);
      button.setAttribute('aria-expanded', String(state.mobileOpen));
    } else if (action === 'close-menu') {
      state.mobileOpen = false;
      state.root.querySelector('[data-ba-app]').classList.remove('is-menu-open');
      state.root.querySelector('[data-action="toggle-menu"]')?.setAttribute('aria-expanded', 'false');
    } else if (action === 'leave-admin') {
      if (state.editorDirty) {
        const discard = await confirmDialog({
          title: 'Sair sem salvar?',
          message: 'As alterações ainda não salvas neste curso serão perdidas.',
          confirmLabel: 'Sair do painel',
          danger: true,
        });
        if (!discard) return;
        state.editorDirty = false;
      }
      if (window.Router?.navigate) window.Router.navigate('landing');
      else window.location.href = '/';
    } else if (action === 'new-course') newCourse();
    else if (action === 'edit-course') await editCourse(button.dataset.courseId);
    else if (action === 'duplicate-course') await duplicateCourse(button.dataset.courseId);
    else if (action === 'delete-course') await deleteCourse(button.dataset.courseId);
    else if (action === 'change-course-status') await changeCourseStatus(button.dataset.courseId, button.dataset.status);
    else if (action === 'toggle-card-menu') {
      const menu = button.nextElementSibling;
      const willOpen = menu.hidden;
      state.root.querySelectorAll('.ba-card-menu').forEach(item => { item.hidden = true; });
      state.root.querySelectorAll('[data-action="toggle-card-menu"]').forEach(item => item.setAttribute('aria-expanded', 'false'));
      menu.hidden = !willOpen;
      button.setAttribute('aria-expanded', String(willOpen));
    } else if (action === 'back-to-courses') await openView('courses');
    else if (action === 'save-course') await saveCourse();
    else if (action === 'publish-course') await saveCourse({ publish: true });
    else if (action === 'unpublish-course') await saveCourse({ unpublish: true });
    else if (action === 'validate-course') {
      state.validationErrors = validateCourse(state.editorCourse);
      render();
      if (state.validationErrors.length) {
        state.root.querySelector('[data-ba-validation]')?.focus();
        toast(`${state.validationErrors.length} pendências encontradas.`, 'error');
      } else toast('Curso pronto para publicação.', 'success');
    } else if (action === 'add-module') {
      state.editorCourse.modules.push(createBlankModule(state.editorCourse.modules.length));
      state.selectedModule = state.editorCourse.modules.length - 1;
      state.selectedLesson = 0;
      markDirty(); render();
    } else if (action === 'select-module') {
      state.selectedModule = Number(button.dataset.index);
      state.selectedLesson = 0;
      render();
    } else if (action === 'select-lesson') {
      state.selectedLesson = Number(button.dataset.index);
      render();
    } else if (action === 'move-module-up' || action === 'move-module-down') {
      const direction = action.endsWith('up') ? -1 : 1;
      if (reorder(state.editorCourse.modules, state.selectedModule, state.selectedModule + direction)) {
        state.selectedModule += direction; markDirty(); render();
      }
    } else if (action === 'delete-module') {
      const module = state.editorCourse.modules[state.selectedModule];
      const confirmed = await confirmDialog({ title: `Excluir “${module.title}”?`, message: 'Todas as lições e questões deste módulo serão removidas.', confirmLabel: 'Excluir módulo', danger: true });
      if (confirmed) {
        state.editorCourse.modules.splice(state.selectedModule, 1);
        state.editorCourse.modules.forEach((item, index) => { item.order = index + 1; });
        state.selectedModule = Math.max(0, state.selectedModule - 1); state.selectedLesson = 0; markDirty(); render();
      }
    } else if (action === 'remove-module-cover') {
      const module = state.editorCourse.modules?.[state.selectedModule];
      if (module) {
        module.coverImage = '';
        module.coverMediaId = null;
        markDirty();
        render();
      }
    } else if (action === 'add-lesson') {
      const lessons = state.editorCourse.modules[state.selectedModule].lessons;
      lessons.push(createBlankLesson(lessons.length)); state.selectedLesson = lessons.length - 1; markDirty(); render();
    } else if (action === 'move-lesson-up' || action === 'move-lesson-down') {
      const lessons = state.editorCourse.modules[state.selectedModule].lessons;
      const direction = action.endsWith('up') ? -1 : 1;
      if (reorder(lessons, state.selectedLesson, state.selectedLesson + direction)) {
        state.selectedLesson += direction; markDirty(); render();
      }
    } else if (action === 'delete-lesson') {
      const lesson = selectedLesson();
      const confirmed = await confirmDialog({ title: `Excluir “${lesson.title}”?`, message: 'A apostila, o vídeo e as questões deixarão de fazer parte deste curso.', confirmLabel: 'Excluir lição', danger: true });
      if (confirmed) {
        const lessons = state.editorCourse.modules[state.selectedModule].lessons;
        lessons.splice(state.selectedLesson, 1); lessons.forEach((item, index) => { item.order = index + 1; });
        state.selectedLesson = Math.max(0, state.selectedLesson - 1); markDirty(); render();
      }
    } else if (action === 'add-question') {
      const lesson = selectedLesson();
      lesson.quiz.push(newQuestion(lesson.quiz.length)); markDirty(); render();
    } else if (action === 'remove-question') {
      selectedLesson().quiz.splice(Number(button.dataset.questionIndex), 1); markDirty(); render();
    } else if (action === 'normalize-video') {
      const lesson = selectedLesson();
      const result = normalizeVideoUrl(lesson.videoUrl, lesson.videoProvider);
      lesson.videoProvider = result.provider;
      lesson.videoUrl = result.url;
      lesson.videoEmbedId = result.embedId;
      if (result.provider !== 'upload') lesson.videoMediaId = null;
      markDirty(); render();
      toast(result.invalid ? 'Não foi possível reconhecer esse link. Verifique o endereço.' : `${VIDEO_PROVIDERS[result.provider]} reconhecido.`, result.invalid ? 'error' : 'success');
    } else if (action === 'delete-media') await deleteMedia(button.dataset.mediaId);
    else if (action === 'open-student-progress') await openStudentProgress(button.dataset.studentId);
    else if (action === 'export-backup') await exportBackup();
  }

  function bindEvents() {
    const listenerOptions = state.eventController ? { signal: state.eventController.signal } : undefined;
    state.root.addEventListener('click', async event => {
      const studentAccountButton = event.target.closest('[data-student-account-action]');
      if (studentAccountButton) {
        event.preventDefault();
        await manageStudentAccount(studentAccountButton);
        return;
      }
      const pastoralButton = event.target.closest('[data-action="save-student-pastoral-phase"], [data-action="grant-student-pastoral-course"], [data-action="revoke-student-pastoral-course"]');
      if (pastoralButton) {
        event.preventDefault();
        await manageStudentPastoralAccess(pastoralButton);
        return;
      }
      const closeStudentButton = event.target.closest('[data-action="close-student-progress"]');
      if (closeStudentButton) {
        event.preventDefault();
        closeStudentProgress();
        return;
      }
      const viewButton = event.target.closest('[data-view]');
      if (viewButton) { event.preventDefault(); await openView(viewButton.dataset.view); return; }
      const tabButton = event.target.closest('[data-editor-tab]');
      if (tabButton) { state.editorTab = tabButton.dataset.editorTab; render(); return; }
      const actionButton = event.target.closest('[data-action]');
      if (actionButton && !actionButton.closest('[data-ba-modal]')) {
        event.preventDefault();
        await handleAction(actionButton);
      }
    }, listenerOptions);

    state.root.addEventListener('input', event => {
      const element = event.target;
      if (element.matches('[data-course-field]')) onCourseFieldChange(element);
      if (element.matches('[data-video-url]') && selectedLesson()) {
        selectedLesson().videoUrl = element.value; markDirty();
      }
      if (element.matches('[data-filter="course-search"]')) { state.courseSearch = element.value; render(); state.root.querySelector('[data-filter="course-search"]')?.focus(); }
      if (element.matches('[data-filter="media-search"]')) { state.mediaSearch = element.value; render(); state.root.querySelector('[data-filter="media-search"]')?.focus(); }
      if (element.matches('[data-filter="student-search"]')) { state.studentSearch = element.value; render(); state.root.querySelector('[data-filter="student-search"]')?.focus(); }
      if (element.matches('[data-filter="team-search"]')) { state.teamSearch = element.value; render(); state.root.querySelector('[data-filter="team-search"]')?.focus(); }
    }, listenerOptions);

    state.root.addEventListener('change', async event => {
      const element = event.target;
      if (element.matches('[data-course-field]')) {
        onCourseFieldChange(element);
        if (element.matches('[data-video-provider]') || element.name === 'ba-course-status'
          || element.dataset.courseField === 'accessPolicy.mode') render();
      }
      if (element.matches('[data-course-prerequisite]') && state.editorCourse) {
        const ids = new Set(state.editorCourse.accessPolicy.prerequisiteCourseIds);
        if (element.checked) ids.add(element.value);
        else ids.delete(element.value);
        state.editorCourse.accessPolicy.prerequisiteCourseIds = [...ids];
        markDirty();
      }
      if (element.matches('[data-video-url]') && selectedLesson()) {
        const lesson = selectedLesson();
        const result = normalizeVideoUrl(element.value, lesson.videoProvider);
        lesson.videoProvider = result.provider;
        lesson.videoUrl = result.url;
        lesson.videoEmbedId = result.embedId;
        lesson.videoMediaId = null;
        markDirty();
        render();
        if (result.invalid) toast('Não foi possível reconhecer esse link. Verifique o endereço.', 'error');
      }
      if (element.matches('[data-correct-option]')) {
        setPath(state.editorCourse, `${element.dataset.correctOption}.correctOptionId`, element.value);
        markDirty(); render();
      }
      if (element.matches('[data-filter="course-status"]')) { state.courseStatus = element.value; render(); }
      if (element.matches('[data-filter="course-category"]')) { state.courseCategory = element.value; render(); }
      if (element.matches('[data-filter="media-kind"]')) { state.mediaKind = element.value; render(); }
      if (element.matches('[data-filter="student-course"]')) { state.studentCourse = element.value; render(); }
      if (element.matches('[data-filter="student-status"]')) { state.studentStatus = element.value; render(); }
      if (element.matches('[data-filter="student-account-status"]')) { state.studentAccountStatus = element.value; render(); }
      if (element.matches('[data-team-role]')) await updateTeamRole(element);
      if (element.matches('[data-attach-media]') && element.value) attachSelectedMedia(element.dataset.attachMedia, element.value);
      if (element.matches('[data-upload-target]') && element.files?.length) {
        if (element.dataset.uploadTarget === 'backup') await importBackup(element.files[0]);
        else await uploadFiles(element.files, element.dataset.uploadTarget);
        element.value = '';
      }
    }, listenerOptions);

    state.root.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && state.view === 'editor') {
        event.preventDefault();
        saveCourse();
      }
      if (event.key === 'Escape') {
        if (state.root.querySelector('[data-student-progress-modal]')) {
          closeStudentProgress();
          return;
        }
        state.root.querySelectorAll('.ba-card-menu').forEach(menu => { menu.hidden = true; });
        state.root.querySelectorAll('[data-action="toggle-card-menu"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      }
    }, listenerOptions);

    window.addEventListener('beta:students-changed', async () => {
      if (state.mode === 'local') {
        state.students = await localAdapter.listStudents();
      } else if (state.mode === 'api') {
        try {
          state.students = await remoteAdapter.listStudents();
        } catch (_) {
          return;
        }
      }
      if (state.view === 'students') render();
    }, listenerOptions);
  }

  async function initializeData() {
    let bootstrap;
    try {
      bootstrap = await remoteAdapter.bootstrap();
    } catch (error) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        state.mode = 'denied';
        throw error;
      }
      const serverUnavailable = error instanceof ApiError
        && error.status === 503
        && error.payload?.localFallback === true;
      const filePreview = window.location.protocol === 'file:';
      if ((!serverUnavailable && !filePreview) || window.BetaConfig?.allowLocalFallback === false) throw error;
      state.mode = 'local';
      state.adapter = localAdapter;
      const bootstrap = await localAdapter.bootstrap();
      state.bootstrap = bootstrap;
      state.courses = bootstrap.courses.map(course => normalizeCourse(course));
      state.media = bootstrap.media.map(item => normalizeMedia(item));
      state.students = await localAdapter.listStudents();
      state.studentsSource = window.BetaAdminStudents?.source === 'demo' ? 'demo' : 'local';
      return;
    }

    // Após o bootstrap confirmar o servidor, falhas subsequentes não ativam o
    // modo local: assim nunca há duas fontes de verdade para o mesmo painel.
    state.mode = 'api';
    state.adapter = remoteAdapter;
    state.bootstrap = bootstrap || {};
    const facilitator = currentRole() === 'facilitator';
    [state.courses, state.media, state.students, state.team] = await Promise.all([
      facilitator ? remoteAdapter.listPublicCourses() : remoteAdapter.listCourses(),
      facilitator ? Promise.resolve([]) : remoteAdapter.listMedia(),
      remoteAdapter.listStudents(),
      isOwner() ? remoteAdapter.listTeam() : Promise.resolve([]),
    ]);
    if (facilitator) state.view = 'students';
    state.studentsSource = 'api';
  }

  async function mount(rootElement) {
    if (!(rootElement instanceof Element)) {
      throw new TypeError('BetaAdmin.mount precisa receber um elemento da página.');
    }
    if (!document.querySelector('link[data-beta-admin-style]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'admin.css';
      link.dataset.betaAdminStyle = '';
      document.head.appendChild(link);
    }
    if (state.beforeUnload) window.removeEventListener('beforeunload', state.beforeUnload);
    state.eventController?.abort();
    state.eventController = new AbortController();
    state.root = rootElement;
    state.root.innerHTML = shellTemplate();
    state.adapter = null;
    state.courses = [];
    state.media = [];
    state.students = [];
    state.team = [];
    state.studentsSource = 'api';
    state.bootstrap = {};
    state.initError = null;
    state.loading = true;
    state.busy = false;
    state.mode = 'loading';
    state.importedSeed = false;
    state.editorCourse = null;
    state.editorDirty = false;
    state.view = 'overview';
    bindEvents();
    render();
    state.beforeUnload = event => {
      if (!state.editorDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', state.beforeUnload);

    try {
      await initializeData();
      state.loading = false;
      render();
      if (state.importedSeed) toast('Jornada Lidere importada como curso inicial publicado.', 'success');
      if (state.mode === 'local') toast('Painel aberto em modo local de desenvolvimento.', 'info');
    } catch (error) {
      state.loading = false;
      if (state.mode !== 'denied') state.mode = 'error';
      state.initError = error;
      render();
    }
    return window.BetaAdmin;
  }

  window.BetaAdmin = Object.freeze({ mount });
})();
