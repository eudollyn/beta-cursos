// ============================================================
// BETA CURSOS — APPLICATION JAVASCRIPT
// Single-page frontend backed by the Beta Cursos API. Local storage is used
// only as a rendering cache and for the explicit offline demonstration mode.
// ============================================================

'use strict';

const Safe = {
  html(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  },

  id(value) {
    const id = String(value || '');
    return /^[a-z0-9][a-z0-9_-]{0,95}$/i.test(id) ? id : '';
  },

  mediaUrl(value) {
    const rawUrl = String(value || '').trim();

    if (/^\/api\/media\/[a-z0-9_-]{8,100}$/i.test(rawUrl)) {
      return window.BetaConfig?.mediaUrl(rawUrl) || rawUrl;
    }

    if (/^assets\/[a-z0-9_./-]+$/i.test(rawUrl)) {
      return rawUrl;
    }

    if (/^https:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s]*)?$/i.test(rawUrl)) {
      return rawUrl;
    }

    return '';
  },
};

const COOKIE_POLICY_VERSION = '2026-07-23';

// ============================================================
// SECTION 1: APPLICATION STATE
// ============================================================
const AppState = {
  currentPage: 'landing',
  currentUser: null,
  backendMode: 'loading',
  features: {
    demoAccess: false,
    registration: true,
    paymentsMode: 'disabled',
    emailVerificationRequired: false,
    passwordReset: false,
  },
  pendingAuthEmail: '',
  previewAuthUrl: '',
  authActionToken: null,
  currentCourseId: null,
  currentLessonId: null,
  currentStep: 'pdf', // 'pdf' | 'video' | 'quiz'
  quizState: {
    isActive: false,
    questions: [],
    selectedAnswers: {},
    submitted: false,
    submitting: false,
    score: null,
    passed: false,
    results: {},
    attemptKey: null,
  },
  checkout: {
    couponCode: null,
    couponValue: 0,
    paymentMethod: 'pix',
    idempotencyKey: null,
  },
  sidebarOpen: false,
};

// ============================================================
// SECTION 2: STORAGE HELPERS
// The API is authoritative in connected environments. These helpers keep a
// small client cache so the learning interface remains responsive.
// ============================================================
const Storage = {
  get(key) {
    try {
      const val = localStorage.getItem(`betacursos_${key}`);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(
        `betacursos_${key}`,
        JSON.stringify(value),
      );

      window.BetaStudentSync?.notifyChange?.(key, value);
    } catch {}
  },

  remove(key) {
    localStorage.removeItem(`betacursos_${key}`);
  },
};

const CookiePreferences = {
  storageKey: 'cookie_notice',
  returnFocusTo: null,

  currentRecord() {
    const record = Storage.get(this.storageKey);

    return (
      record?.acknowledged === true &&
      record.policyVersion === COOKIE_POLICY_VERSION
    )
      ? record
      : null;
  },

  open(trigger = null) {
    const banner = document.getElementById('cookie-banner');

    if (!banner) return;

    this.returnFocusTo =
      trigger instanceof HTMLElement
        ? trigger
        : document.activeElement;

    banner.hidden = false;

    requestAnimationFrame(() => {
      banner.querySelector('button')?.focus({
        preventScroll: true,
      });
    });
  },

  close({ restoreFocus = true } = {}) {
    const banner = document.getElementById('cookie-banner');

    if (!banner || banner.hidden) return;

    banner.hidden = true;

    if (
      restoreFocus &&
      this.returnFocusTo instanceof HTMLElement &&
      this.returnFocusTo.isConnected
    ) {
      this.returnFocusTo.focus({
        preventScroll: true,
      });
    }

    this.returnFocusTo = null;
  },

  acknowledge() {
    Storage.set(this.storageKey, {
      acknowledged: true,
      policyVersion: COOKIE_POLICY_VERSION,
      acknowledgedAt: new Date().toISOString(),
    });

    this.close();
  },

  initialize() {
    if (!this.currentRecord()) {
      this.open();
    }
  },
};

class ClientApiError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'ClientApiError';
    this.status = status;
    this.payload = payload;
  }
}

const ApiClient = {
  async request(path, options = {}) {
    const endpoint = window.BetaConfig?.apiUrl(path) || path;
    let response;
    try {
      response = await fetch(endpoint, {
        ...options,
        credentials: window.BetaConfig?.credentialsFor(path) || 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      throw new ClientApiError('Não foi possível conectar ao servidor.', 0, error);
    }

    const contentType = response.headers.get('content-type') || '';
    const payload = response.status === 204
      ? null
      : contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => '');
    if (!response.ok) {
      throw new ClientApiError(
        payload?.error?.message
          || payload?.message
          || (typeof payload?.error === 'string' ? payload.error : '')
          || `Não foi possível concluir a operação (${response.status}).`,
        response.status,
        payload,
      );
    }
    return payload;
  },
};

// ============================================================
// SECTION 3: LOCAL DEMONSTRATION ACCESS
// This keeps the prototype safe to test without pretending to be production
// authentication. Real launch must replace it with a managed server-side flow.
// ============================================================
const MINIMUM_REGISTRATION_AGE = 16;

const Security = {
  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  normalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  },

  createSalt() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  },

  async hashPassword(password, salt) {
    const payload = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest('SHA-256', payload);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  },
};

function formatDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function maximumBirthDate(minimumAge = MINIMUM_REGISTRATION_AGE) {
  const today = new Date();
  return formatDateInputValue(new Date(
    today.getFullYear() - minimumAge,
    today.getMonth(),
    today.getDate(),
  ));
}

function validateBirthDate(value) {
  const birthDate = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!match) {
    return { valid: false, error: 'Informe uma data de nascimento válida.' };
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
    return { valid: false, error: 'Informe uma data de nascimento válida.' };
  }

  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (parsed.getTime() > todayUtc) {
    return { valid: false, error: 'A data de nascimento não pode estar no futuro.' };
  }

  let age = today.getFullYear() - year;
  const birthdayHasPassed = today.getMonth() + 1 > month
    || (today.getMonth() + 1 === month && today.getDate() >= day);
  if (!birthdayHasPassed) age -= 1;
  if (age < MINIMUM_REGISTRATION_AGE) {
    return {
      valid: false,
      error: `É necessário ter pelo menos ${MINIMUM_REGISTRATION_AGE} anos para criar uma conta.`,
    };
  }

  return { valid: true, value: birthDate };
}

function configureBirthDateInput(input) {
  if (!input) return;
  input.min = '1900-01-01';
  input.max = maximumBirthDate();
}

function hasAdminAccess(user) {
  return Boolean(user && ['owner', 'admin', 'facilitator'].includes(user.role));
}

function mayUseLocalDemo(error) {
  if (window.location.protocol === 'file:') return true;
  return window.BetaConfig?.allowLocalFallback === true
    && error instanceof ClientApiError
    && error.status === 503
    && error.payload?.localFallback === true;
}

const LocalAuth = {
  async register(name, email, password, birthDate, memberCode, memberCodeValidated = false) {
    AppState.backendMode = 'local';
    const normalizedEmail = Security.normalizeEmail(email);
    const normalizedName = Security.normalizeName(name);
    const users = Storage.get('users') || {};

    if (users[normalizedEmail]) {
      return { success: false, error: 'Este e-mail já está cadastrado neste navegador.' };
    }

    const passwordSalt = Security.createSalt();
    const passwordHash = await Security.hashPassword(password, passwordSalt);
    const newUser = {
      id: `user_${Date.now()}`,
      name: normalizedName,
      email: normalizedEmail,
      birthDate,
      passwordSalt,
      passwordHash,
      memberCode: memberCode || null,
      memberCodeValidated: memberCode ? memberCodeValidated : false,
      role: 'student',
      isDemo: true,
      createdAt: new Date().toISOString(),
    };

    users[normalizedEmail] = newUser;
    Storage.set('users', users);
    return { success: true, user: newUser };
  },

  async login(email, password) {
    AppState.backendMode = 'local';
    const normalizedEmail = Security.normalizeEmail(email);
    const users = Storage.get('users') || {};
    const user = users[normalizedEmail];

    if (!user?.passwordHash || !user?.passwordSalt) {
      return { success: false, error: 'E-mail ou senha incorretos.' };
    }

    const candidateHash = await Security.hashPassword(password, user.passwordSalt);
    if (candidateHash !== user.passwordHash) {
      return { success: false, error: 'E-mail ou senha incorretos.' };
    }

    Storage.set('currentUserId', user.id);
    AppState.currentUser = user;
    return { success: true, user };
  },

  restoreSession() {
    const currentUserId = Storage.get('currentUserId');
    const users = Object.values(Storage.get('users') || {});
    const user = users.find(candidate => candidate.id === currentUserId) || null;
    AppState.currentUser = user;
    AppState.backendMode = 'local';
    return user;
  },
};

async function hydrateAuthenticatedState() {
  try {
    await window.BetaStudentSync?.hydrate?.();
    await window.BetaCatalog?.hydrate?.({ allowEmpty: true });
    return true;
  } catch (_) {
    Toast.show(
      'Sua conta foi acessada, mas os cursos ainda estão sendo atualizados. Tente novamente em instantes.',
      'info',
      5000,
    );
    return false;
  }
}

const Auth = {
  async register(name, email, password, birthDate, memberCode) {
    if (AppState.features.emailVerificationRequired) {
      return this.requestRegistration(email);
    }
    try {
      const payload = await ApiClient.request('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, email, password, birthDate, memberCode: memberCode || null }),
      });
      window.BetaStudentSync?.reset?.();
      AppState.backendMode = 'api';
      AppState.currentUser = payload.user;
      AppState.features = { ...AppState.features, ...(payload.features || {}) };
      await hydrateAuthenticatedState();
      return { success: true, user: payload.user };
    } catch (error) {
      if (mayUseLocalDemo(error)) {
        window.BetaStudentSync?.reset?.();
        return LocalAuth.register(name, email, password, birthDate, memberCode, false);
      }
      return { success: false, error: error.message || 'Não foi possível criar a conta.' };
    }
  },

  async requestRegistration(email, { resend = false } = {}) {
    try {
      const payload = await ApiClient.request(
        resend ? '/api/auth/email/resend' : '/api/auth/register',
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        },
      );
      AppState.backendMode = 'api';
      AppState.pendingAuthEmail = Security.normalizeEmail(email);
      AppState.previewAuthUrl = payload.previewUrl || '';
      if (payload.features) AppState.features = { ...AppState.features, ...payload.features };
      return {
        success: true,
        pending: true,
        message: payload.message,
        previewUrl: payload.previewUrl || '',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Não foi possível enviar o e-mail de confirmação.',
        code: error.payload?.error?.code || '',
      };
    }
  },

  async completeRegistration(token, name, birthDate, password) {
    try {
      const payload = await ApiClient.request('/api/auth/complete-registration', {
        method: 'POST',
        body: JSON.stringify({ token, name, birthDate, password }),
      });
      window.BetaStudentSync?.reset?.();
      AppState.backendMode = 'api';
      AppState.currentUser = payload.user;
      AppState.features = { ...AppState.features, ...(payload.features || {}) };
      AppState.authActionToken = null;
      AppState.previewAuthUrl = '';
      await hydrateAuthenticatedState();
      return { success: true, user: payload.user };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Não foi possível concluir o cadastro.',
        code: error.payload?.error?.code || '',
      };
    }
  },

  async forgotPassword(email) {
    try {
      const payload = await ApiClient.request('/api/auth/password/forgot', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      AppState.pendingAuthEmail = Security.normalizeEmail(email);
      AppState.previewAuthUrl = payload.previewUrl || '';
      return {
        success: true,
        message: payload.message,
        previewUrl: payload.previewUrl || '',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Não foi possível iniciar a recuperação de senha.',
        code: error.payload?.error?.code || '',
      };
    }
  },

  async resetPassword(token, password) {
    try {
      const payload = await ApiClient.request('/api/auth/password/reset', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      window.BetaStudentSync?.reset?.();
      AppState.currentUser = null;
      AppState.authActionToken = null;
      return { success: true, message: payload.message };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Não foi possível alterar a senha.',
        code: error.payload?.error?.code || '',
      };
    }
  },

  async login(email, password) {
    try {
      const payload = await ApiClient.request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      window.BetaStudentSync?.reset?.();
      AppState.backendMode = 'api';
      AppState.currentUser = payload.user;
      AppState.features = { ...AppState.features, ...(payload.features || {}) };
      await hydrateAuthenticatedState();
      return { success: true, user: payload.user };
    } catch (error) {
      if (mayUseLocalDemo(error)) {
        window.BetaStudentSync?.reset?.();
        return LocalAuth.login(email, password);
      }
      return {
        success: false,
        error: error.message || 'E-mail ou senha incorretos.',
        code: error.payload?.error?.code || '',
      };
    }
  },

  async logout() {
    window.BetaStudentSync?.reset?.();
    if (AppState.backendMode === 'api') {
      try {
        await ApiClient.request('/api/auth/logout', { method: 'POST', body: '{}' });
      } catch (_) {
        // A sessão local também é descartada quando o servidor já a encerrou.
      }
    }
    Storage.remove('currentUserId');
    AppState.currentUser = null;
    AppState.backendMode = window.location.protocol === 'file:' ? 'local' : 'api';
    await window.BetaCatalog?.hydrate?.({ allowEmpty: true });
    Router.navigate('landing');
  },

  async restoreSession() {
    if (window.location.protocol === 'file:') return LocalAuth.restoreSession();
    try {
      const payload = await ApiClient.request('/api/auth/session');
      AppState.backendMode = 'api';
      AppState.currentUser = payload.user;
      AppState.features = { ...AppState.features, ...(payload.features || {}) };
      return payload.user;
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 401) {
        window.BetaStudentSync?.reset?.();
        AppState.backendMode = 'api';
        AppState.currentUser = null;
        if (error.payload?.features) AppState.features = { ...AppState.features, ...error.payload.features };
        return null;
      }
      if (mayUseLocalDemo(error)) return LocalAuth.restoreSession();
      window.BetaStudentSync?.reset?.();
      AppState.backendMode = 'error';
      AppState.currentUser = null;
      return null;
    }
  },

  async validateMemberCode(code) {
    const valid = /^Beta\d{4}$/i.test(code);
    return {
      valid,
      message: valid
        ? 'Formato válido. A confirmação com o cadastro da igreja será feita pelo servidor.'
        : 'Use o formato Beta0000.',
    };
  },
};

// ============================================================
// SECTION 4: ENROLLMENT & PAYMENT MODULE
// Checkout decisions are made by the server in connected environments.
// ============================================================
function createCheckoutAttemptKey() {
  if (typeof crypto?.randomUUID === 'function') {
    return `checkout-${crypto.randomUUID()}`;
  }
  return `checkout-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const Enrollment = {
  isEnrolled(userId, courseId) {
    const enrollments = Storage.get(`enrollments_${userId}`) || [];
    return enrollments.includes(courseId);
  },

  // Atualiza o cache somente depois que o servidor confirma a matrícula.
  enroll(userId, courseId) {
    const enrollments = Storage.get(`enrollments_${userId}`) || [];
    if (!enrollments.includes(courseId)) {
      enrollments.push(courseId);
      Storage.set(`enrollments_${userId}`, enrollments);
    }
    // Initialize progress for this course
    Progress.initializeCourse(userId, courseId);
  },

  getPricingConfig(courseId) {
    const config = COURSES_DATA.find(course => course.id === courseId)?.pricing || PRICING_CONFIG;
    if (config.mode === 'demo' && Number(config.fullPrice) === 197) {
      return { ...config, fullPrice: PRICING_CONFIG.fullPrice };
    }
    return config;
  },

  async createMercadoPagoCheckout({
    courseId,
    couponCode,
    paymentMethod,
    idempotencyKey,
  } = {}) {
    if (AppState.backendMode === 'api') {
      return ApiClient.request('/api/checkouts', {
        method: 'POST',
        headers: {
          'Idempotency-Key': idempotencyKey || createCheckoutAttemptKey(),
        },
        body: JSON.stringify({
          courseId,
          couponCode: couponCode || null,
          paymentMethod: paymentMethod || 'pix',
        }),
      });
    }
    if (this.getPricingConfig(courseId).mode !== 'demo') {
      throw new Error('Checkout oficial ainda não configurado.');
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    return {
      success: true,
      simulation: true,
      simulationId: `demo_${Date.now()}`,
    };
  },

  calculatePrice(courseId, hasMemberCode) {
    const config = this.getPricingConfig(courseId);
    const base = config.fullPrice;
    const memberDiscount = Math.max(0, Number(config.memberDiscount) || 0);
    if (hasMemberCode && memberDiscount > 0) {
      const discount = base * memberDiscount;
      return {
        fullPrice: base,
        discount,
        finalPrice: base - discount,
        hasMemberDiscount: true,
        memberDiscount,
      };
    }
    return {
      fullPrice: base,
      discount: 0,
      finalPrice: base,
      hasMemberDiscount: false,
      memberDiscount,
    };
  },
};

// ============================================================
// SECTION 4.1: COURSE-SPECIFIC LEARNING RULES
// The editor may configure quiz rules per course or per lesson. Existing
// courses continue to inherit the specification defaults from data.js.
// ============================================================
const CourseRules = {
  getQuizConfig(courseId, lessonId) {
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules
      .flatMap(module => module.lessons)
      .find(item => item.id === lessonId);
    const configured = {
      ...(course?.quizConfig || {}),
      ...(lesson?.quizConfig || {}),
    };
    const questionCount = Array.isArray(lesson?.quiz) ? lesson.quiz.length : 0;
    if (questionCount === 0) {
      return {
        questionsPerLesson: 0,
        passingScore: 0,
        maxAttempts: 0,
        shuffleQuestions: false,
        shuffleOptions: false,
      };
    }
    return {
      questionsPerLesson: questionCount,
      passingScore: Math.min(questionCount, Math.max(1, Number(configured.passingScore || Math.min(4, questionCount)))),
      maxAttempts: Math.min(10, Math.max(1, Number(configured.maxAttempts || QUIZ_CONFIG.maxAttempts))),
      shuffleQuestions: configured.shuffleQuestions ?? QUIZ_CONFIG.shuffleQuestions,
      shuffleOptions: configured.shuffleOptions ?? QUIZ_CONFIG.shuffleOptions,
    };
  },
};

const LessonContent = {
  requirements(lesson) {
    return {
      hasPdf: Boolean(Safe.mediaUrl(lesson?.pdfUrl)),
      hasVideo: Boolean(
        String(lesson?.videoEmbedId || '').trim()
        || Safe.mediaUrl(lesson?.videoUrl),
      ),
      hasQuiz: Array.isArray(lesson?.quiz) && lesson.quiz.length > 0,
    };
  },

  firstPendingStep(lesson, progress) {
    const requirements = this.requirements(lesson);
    if (requirements.hasPdf && !progress?.pdfRead) return 'pdf';
    if (requirements.hasVideo && !progress?.videoCompleted) return 'video';
    return 'quiz';
  },

  nextStep(lesson, currentStep) {
    const requirements = this.requirements(lesson);
    if (currentStep === 'pdf' && requirements.hasVideo) return 'video';
    return 'quiz';
  },
};

function createLessonProgressState(lesson, unlocked = false) {
  const requirements = LessonContent.requirements(lesson);
  const prerequisitesComplete = !requirements.hasPdf && !requirements.hasVideo;
  return {
    lessonId: lesson.id,
    unlocked,
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
}

// ============================================================
// SECTION 5: PROGRESS MODULE
// Mutations are reflected immediately in the local cache and synchronized with
// the authenticated API by BetaStudentSync.
// ============================================================
const Progress = {
  getKey(userId, courseId) {
    return `progress_${userId}_${courseId}`;
  },

  initializeCourse(userId, courseId) {
    const course = COURSES_DATA.find(c => c.id === courseId);
    if (!course) return;
    const existing = Storage.get(this.getKey(userId, courseId));
    if (existing) return;

    const progress = {
      courseId,
      startedAt: new Date().toISOString(),
      lessons: {},
    };

    course.modules.forEach((mod, moduleIndex) => {
      mod.lessons.forEach((lesson, lessonIndex) => {
        progress.lessons[lesson.id] = createLessonProgressState(
          lesson,
          moduleIndex === 0 && lessonIndex === 0,
        );
      });
    });

    Storage.set(this.getKey(userId, courseId), progress);
  },

  reconcileCourse(userId, courseId) {
    const course = COURSES_DATA.find(item => item.id === courseId);
    if (!course) return null;
    let progress = this.get(userId, courseId);
    if (!progress) {
      this.initializeCourse(userId, courseId);
      return this.get(userId, courseId);
    }

    progress.lessons = progress.lessons && typeof progress.lessons === 'object'
      ? progress.lessons
      : {};
    const orderedLessons = course.modules.flatMap(module => module.lessons);
    orderedLessons.forEach((lesson, index) => {
      const requirements = LessonContent.requirements(lesson);
      const previousState = progress.lessons[lesson.id] || {};
      const state = {
        ...createLessonProgressState(lesson, index === 0),
        ...previousState,
        lessonId: lesson.id,
      };
      state.pdfRead = !requirements.hasPdf || Boolean(previousState.pdfRead);
      state.videoCompleted = !requirements.hasVideo || Boolean(previousState.videoCompleted);
      if (!requirements.hasQuiz) {
        state.quizStatus = 'passed';
        state.quizAttemptsUsed = 0;
        state.quizScore = null;
      } else if (state.pdfRead && state.videoCompleted && state.quizStatus === 'locked') {
        state.quizStatus = 'available';
      }
      state.reReadAfterExhaustion = !requirements.hasPdf || Boolean(previousState.reReadAfterExhaustion);
      state.reWatchedAfterExhaustion = !requirements.hasVideo || Boolean(previousState.reWatchedAfterExhaustion);
      const previous = orderedLessons[index - 1];
      state.unlocked = index === 0 || Boolean(previous && progress.lessons[previous.id]?.lessonCompleted);
      progress.lessons[lesson.id] = state;
    });
    progress.courseRevision = Number(course.revision || progress.courseRevision || 1);
    progress.reconciledAt = new Date().toISOString();
    Storage.set(this.getKey(userId, courseId), progress);
    return progress;
  },

  get(userId, courseId) {
    return Storage.get(this.getKey(userId, courseId));
  },

  getLessonProgress(userId, courseId, lessonId) {
    const p = this.get(userId, courseId);
    return p?.lessons[lessonId] || null;
  },

  markPdfRead(userId, courseId, lessonId) {
    const p = this.get(userId, courseId);
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
    if (!p || !lesson || !p.lessons[lessonId]) return;
    const lp = p.lessons[lessonId];
    if (!lp.unlocked) return;

    lp.pdfRead = true;
    if (lp.quizStatus === 'exhausted') {
      lp.reReadAfterExhaustion = true;
      this._checkAttemptReset(p, courseId, lessonId);
    }
    const requirements = LessonContent.requirements(lesson);
    if (requirements.hasQuiz && lp.videoCompleted && lp.quizStatus === 'locked') {
      lp.quizStatus = 'available';
    }

    Storage.set(this.getKey(userId, courseId), p);
    return p;
  },

  markVideoCompleted(userId, courseId, lessonId) {
    const p = this.get(userId, courseId);
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
    if (!p || !lesson || !p.lessons[lessonId]) return;
    const lp = p.lessons[lessonId];
    const requirements = LessonContent.requirements(lesson);
    if (!lp.unlocked || (requirements.hasPdf && !lp.pdfRead)) return;

    lp.videoCompleted = true;
    if (lp.quizStatus === 'exhausted') {
      lp.reWatchedAfterExhaustion = true;
      this._checkAttemptReset(p, courseId, lessonId);
    }
    if (requirements.hasQuiz && lp.quizStatus === 'locked') {
      lp.quizStatus = 'available';
    }

    Storage.set(this.getKey(userId, courseId), p);
    return p;
  },

  completeLesson(userId, courseId, lessonId) {
    const p = this.get(userId, courseId);
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
    if (!p || !lesson || !p.lessons[lessonId]) return;
    const requirements = LessonContent.requirements(lesson);
    const lp = p.lessons[lessonId];
    if (
      !lp.unlocked
      || requirements.hasQuiz
      || (requirements.hasPdf && !lp.pdfRead)
      || (requirements.hasVideo && !lp.videoCompleted)
    ) return;
    lp.quizStatus = 'passed';
    lp.lessonCompleted = true;
    this._unlockNextLesson(p, courseId, lessonId);
    Storage.set(this.getKey(userId, courseId), p);
    return p;
  },

  _checkAttemptReset(p, courseId, lessonId) {
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
    if (!lesson) return;
    const requirements = LessonContent.requirements(lesson);
    const lp = p.lessons[lessonId];
    if (
      lp.quizStatus === 'exhausted'
      && (!requirements.hasPdf || lp.reReadAfterExhaustion)
      && (!requirements.hasVideo || lp.reWatchedAfterExhaustion)
    ) {
      lp.quizStatus = 'available';
      lp.quizAttemptsUsed = 0;
      lp.attemptRound += 1;
      lp.reReadAfterExhaustion = !requirements.hasPdf;
      lp.reWatchedAfterExhaustion = !requirements.hasVideo;
    }
  },

  recordQuizAttempt(userId, courseId, lessonId, score) {
    const p = this.get(userId, courseId);
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
    if (!p || !lesson || !p.lessons[lessonId]) return null;
    const requirements = LessonContent.requirements(lesson);
    if (!requirements.hasQuiz) return null;
    const lp = p.lessons[lessonId];
    const quizConfig = CourseRules.getQuizConfig(courseId, lessonId);

    const allowedStatuses = new Set(['available', 'failed']);
    const validScore = Number.isInteger(score) && score >= 0 && score <= quizConfig.questionsPerLesson;
    if (
      !lp.unlocked
      || (requirements.hasPdf && !lp.pdfRead)
      || (requirements.hasVideo && !lp.videoCompleted)
      || !allowedStatuses.has(lp.quizStatus)
      || lp.quizAttemptsUsed >= quizConfig.maxAttempts
      || !validScore
    ) {
      return null;
    }

    const passed = score >= quizConfig.passingScore;
    lp.quizAttemptsUsed += 1;
    lp.quizScore = score;

    if (passed) {
      lp.quizStatus = 'passed';
      lp.lessonCompleted = true;
      this._unlockNextLesson(p, courseId, lessonId);
    } else if (lp.quizAttemptsUsed >= quizConfig.maxAttempts) {
      lp.quizStatus = 'exhausted';
      lp.reReadAfterExhaustion = !requirements.hasPdf;
      lp.reWatchedAfterExhaustion = !requirements.hasVideo;
    } else {
      lp.quizStatus = 'failed';
    }

    Storage.set(this.getKey(userId, courseId), p);
    return { passed, attemptsUsed: lp.quizAttemptsUsed, status: lp.quizStatus };
  },

  _unlockNextLesson(p, courseId, currentLessonId) {
    const course = COURSES_DATA.find(c => c.id === courseId);
    if (!course) return;

    let foundCurrent = false;
    let unlocked = false;

    for (const mod of course.modules) {
      for (const lesson of mod.lessons) {
        if (foundCurrent && !unlocked) {
          p.lessons[lesson.id].unlocked = true;
          unlocked = true;
        }
        if (lesson.id === currentLessonId) foundCurrent = true;
      }
    }
  },

  getCompletionPercentage(userId, courseId) {
    const p = this.reconcileCourse(userId, courseId) || this.get(userId, courseId);
    if (!p) return 0;
    const course = COURSES_DATA.find(c => c.id === courseId);
    if (!course) return 0;
    const allLessons = course.modules.flatMap(m => m.lessons);
    if (allLessons.length === 0) return 0;
    const completed = allLessons.filter(l => p.lessons[l.id]?.lessonCompleted).length;
    return Math.round((completed / allLessons.length) * 100);
  },

  isModuleComplete(userId, courseId, moduleId) {
    const p = this.get(userId, courseId);
    if (!p) return false;
    const course = COURSES_DATA.find(c => c.id === courseId);
    const mod = course?.modules.find(m => m.id === moduleId);
    if (!mod) return false;
    return mod.lessons.every(l => p.lessons[l.id]?.lessonCompleted);
  },
};

// ============================================================
// SECTION 5.1: AUTHENTICATED STUDENT STATE SYNCHRONIZATION
// ============================================================
const BetaStudentSync = {
  muted: false,
  generation: 0,
  queues: new Map(),
  activeCourses: new Map(),

  clone(value) {
    return typeof structuredClone === 'function'
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  },

  queueKey(userId, courseId) {
    return `${userId}:${courseId}`;
  },

  reset() {
    this.generation += 1;
    for (const record of this.queues.values()) {
      if (record.timer) clearTimeout(record.timer);
    }
    this.queues.clear();
    this.activeCourses.clear();
    this.muted = false;
  },

  async hydrate() {
    const user = AppState.currentUser;
    if (AppState.backendMode !== 'api' || !user) return;
    const userId = user.id;
    const generation = this.generation;
    const payload = await ApiClient.request('/api/me/state');
    if (
      generation !== this.generation
      || AppState.backendMode !== 'api'
      || AppState.currentUser?.id !== userId
    ) return;
    const enrollments = Array.isArray(payload?.enrollments) ? payload.enrollments : [];
    const progress = payload?.progress && typeof payload.progress === 'object' ? payload.progress : {};

    this.muted = true;
    try {
      Storage.set(`enrollments_${userId}`, enrollments);
      Object.entries(progress).forEach(([courseId, value]) => {
        if (value && typeof value === 'object') {
          Storage.set(Progress.getKey(userId, courseId), value);
        }
      });
    } finally {
      this.muted = false;
    }
  },

  notifyChange(key, value) {
    if (this.muted || AppState.backendMode !== 'api' || !AppState.currentUser) return;
    const userId = AppState.currentUser.id;
    const prefix = `progress_${userId}_`;
    if (!String(key).startsWith(prefix)) return;
    const courseId = String(key).slice(prefix.length);
    if (!Safe.id(courseId) || !value || typeof value !== 'object') return;

    const queueKey = this.queueKey(userId, courseId);
    let record = this.queues.get(queueKey);
    if (!record || record.generation !== this.generation) {
      record = {
        userId,
        courseId,
        generation: this.generation,
        items: [],
        retryCount: 0,
        timer: null,
      };
      this.queues.set(queueKey, record);
    }
    record.items.push(this.clone(value));
    if (!record.timer && record.retryCount > 5) record.retryCount = 0;
    void this.flush(queueKey);
  },

  acceptServerProgress(userId, courseId, progress) {
    const queueKey = this.queueKey(userId, courseId);
    const record = this.queues.get(queueKey);
    if (record?.timer) clearTimeout(record.timer);
    this.queues.delete(queueKey);
    if (
      !progress
      || AppState.backendMode !== 'api'
      || AppState.currentUser?.id !== userId
    ) return;
    this.muted = true;
    try {
      Storage.set(Progress.getKey(userId, courseId), progress);
    } finally {
      this.muted = false;
    }
    const course = COURSES_DATA.find(item => item.id === courseId);
    const lessons = course?.modules?.flatMap(module => module.lessons) || [];
    if (lessons.length && lessons.every(lesson => progress.lessons?.[lesson.id]?.lessonCompleted === true)) {
      void window.BetaCatalog?.hydrate?.({ allowEmpty: true });
    }
  },

  hasPending(userId, courseId) {
    const queueKey = this.queueKey(userId, courseId);
    const record = this.queues.get(queueKey);
    return Boolean(record?.items.length || record?.timer || this.activeCourses.has(queueKey));
  },

  async flushCourse(userId, courseId) {
    const queueKey = this.queueKey(userId, courseId);
    await this.flush(queueKey);
    const record = this.queues.get(queueKey);
    if (record?.timer && record.generation === this.generation) {
      clearTimeout(record.timer);
      record.timer = null;
      record.retryCount = 0;
      await this.flush(queueKey);
    }
    return !this.hasPending(userId, courseId);
  },

  flush(queueKey) {
    const active = this.activeCourses.get(queueKey);
    if (active) return active;
    const operation = this.drain(queueKey).finally(() => {
      if (this.activeCourses.get(queueKey) !== operation) return;
      this.activeCourses.delete(queueKey);
      const pending = this.queues.get(queueKey);
      if (pending?.items.length && !pending.timer && pending.retryCount === 0) {
        void this.flush(queueKey);
      }
    });
    this.activeCourses.set(queueKey, operation);
    return operation;
  },

  async drain(queueKey) {
    const record = this.queues.get(queueKey);
    if (!record?.items.length) return;
    const isCurrent = () => (
      this.queues.get(queueKey) === record
      && record.generation === this.generation
      && AppState.backendMode === 'api'
      && AppState.currentUser?.id === record.userId
    );

    try {
      while (record.items.length && isCurrent()) {
        const snapshot = record.items[0];
        const payload = await ApiClient.request(`/api/me/progress/${encodeURIComponent(record.courseId)}`, {
          method: 'PUT',
          body: JSON.stringify({ progress: snapshot }),
        });
        if (!isCurrent()) return;
        record.items.shift();
        record.retryCount = 0;
        if (payload?.progress) {
          this.muted = true;
          try {
            Storage.set(Progress.getKey(record.userId, record.courseId), payload.progress);
          } finally {
            this.muted = false;
          }
        }
      }
      if (isCurrent() && !record.items.length) this.queues.delete(queueKey);
    } catch (error) {
      if (!isCurrent()) return;
      const status = Number(error?.status || 0);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (status === 409 || !retryable) {
        this.queues.delete(queueKey);
        try {
          await this.hydrate();
        } catch (_) {
          // O cache atual permanece disponível enquanto a conexão é restabelecida.
        }
        Toast.show(
          status === 409
            ? 'Seu progresso mudou em outra sessão. Carregamos a versão mais recente.'
            : 'Não foi possível validar essa alteração. Atualizamos o progresso salvo no servidor.',
          'info',
          5000,
        );
        return;
      }

      record.retryCount += 1;
      if (record.retryCount <= 5) {
        const delay = Math.min(30_000, 1_000 * (2 ** (record.retryCount - 1)));
        record.timer = setTimeout(() => {
          if (this.queues.get(queueKey) !== record) return;
          record.timer = null;
          void this.flush(queueKey);
        }, delay);
      }
      if (record.retryCount === 1 || record.retryCount === 6) {
        Toast.show(
          'Seu avanço ficou pendente de sincronização. Vamos tentar novamente sem descartar os dados.',
          'info',
          5000,
        );
      }
    }
  },
};

window.BetaStudentSync = BetaStudentSync;

// ============================================================
// SECTION 6: VIDEO PROVIDER AND AUTOMATIC WATCH TRACKING
// YouTube, Vimeo and HTML5 videos share one progress model. Only continuous
// playback intervals are counted; seeking directly to the end does not count.
// ============================================================
const VIDEO_COMPLETION_THRESHOLD = 0.95;
const VIDEO_TRACKING_SAVE_INTERVAL_MS = 15_000;
const VIDEO_TRACKING_MAX_SEGMENT_SECONDS = 10;

const VideoProvider = {
  elementId(lesson) {
    return `video-player-${Safe.id(lesson?.id)}`;
  },

  getEmbedHtml(lesson) {
    const hasConfiguredMedia = lesson.videoEmbedId || lesson.videoUrl;
    if (!hasConfiguredMedia) {
      return `
        <div class="video-demo-placeholder">
          <span class="section-header__label">Conteúdo demonstrativo</span>
          <strong>${Safe.html(lesson.videoTitle)}</strong>
          <p>A aula oficial será incorporada aqui quando a equipe da igreja entregar o vídeo aprovado.</p>
        </div>
      `;
    }

    const playerId = this.elementId(lesson);
    switch (lesson.videoProvider) {
      case 'youtube': {
        if (!/^[a-zA-Z0-9_-]{6,20}$/.test(lesson.videoEmbedId || '')) {
          return '<div class="video-demo-placeholder"><strong>Vídeo inválido</strong></div>';
        }
        const origin = /^https?:$/i.test(window.location.protocol)
          ? `&origin=${encodeURIComponent(window.location.origin)}`
          : '';
        return `<iframe
          id="${playerId}"
          data-video-provider="youtube"
          src="https://www.youtube-nocookie.com/embed/${lesson.videoEmbedId}?enablejsapi=1${origin}&rel=0&playsinline=1&color=white"
          title="${Safe.html(lesson.videoTitle)}"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen
        ></iframe>`;
      }
      case 'vimeo':
        if (!/^\d{6,15}$/.test(lesson.videoEmbedId || '')) {
          return '<div class="video-demo-placeholder"><strong>Vídeo inválido</strong></div>';
        }
        return `<iframe
          id="${playerId}"
          data-video-provider="vimeo"
          src="https://player.vimeo.com/video/${lesson.videoEmbedId}?dnt=1&playsinline=1"
          title="${Safe.html(lesson.videoTitle)}"
          frameborder="0"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
        ></iframe>`;
      case 's3':
      case 'direct':
      case 'upload':
        return `<video
          id="${playerId}"
          data-video-provider="html5"
          controls
          playsinline
          preload="metadata"
          aria-label="${Safe.html(lesson.videoTitle)}"
          style="width:100%;height:100%;"
        >
          <source src="${Safe.html(Safe.mediaUrl(lesson.videoUrl))}" />
          ${lesson.captionUrl ? `<track kind="captions" src="${Safe.html(Safe.mediaUrl(lesson.captionUrl))}" srclang="pt-BR" label="Português" default />` : ''}
          Seu navegador não oferece suporte a vídeo HTML5.
        </video>`;
      default:
        return `<div class="video-demo-placeholder"><strong>Vídeo indisponível</strong><p>Revise a configuração desta lição.</p></div>`;
    }
  },
};

const VideoTracking = {
  current: null,
  scriptPromises: new Map(),

  sourceKey(lesson) {
    return [
      String(lesson?.videoProvider || 'unknown'),
      String(lesson?.videoEmbedId || lesson?.videoUrl || ''),
    ].join(':');
  },

  cycleFor(progress) {
    const round = Math.max(1, Number(progress?.attemptRound || 1));
    return progress?.quizStatus === 'exhausted' && !progress?.reWatchedAfterExhaustion
      ? round + 1
      : round;
  },

  shouldTrack(progress) {
    return !progress?.videoCompleted
      || (progress?.quizStatus === 'exhausted' && !progress?.reWatchedAfterExhaustion);
  },

  cacheKey(session) {
    return `video_tracking_${session.userId}_${session.courseId}_${session.lessonId}`;
  },

  finiteSeconds(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  },

  normalizeIntervals(value, duration = Infinity) {
    if (!Array.isArray(value)) return [];
    const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
    return value.slice(0, 2_000).flatMap(interval => {
      const start = this.finiteSeconds(Array.isArray(interval) ? interval[0] : interval?.start, -1);
      const end = this.finiteSeconds(Array.isArray(interval) ? interval[1] : interval?.end, -1);
      if (start < 0 || end <= start) return [];
      const boundedStart = Math.max(0, Math.min(limit, start));
      const boundedEnd = Math.max(0, Math.min(limit, end));
      return boundedEnd - boundedStart >= 0.1 ? [[boundedStart, boundedEnd]] : [];
    });
  },

  mergeIntervals(value, duration = Infinity) {
    const sorted = this.normalizeIntervals(value, duration)
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
  },

  watchedSeconds(intervals) {
    return intervals.reduce((total, interval) => total + Math.max(0, interval[1] - interval[0]), 0);
  },

  percentage(session) {
    if (!(session.duration > 0)) return 0;
    return Math.min(100, this.watchedSeconds(session.intervals) / session.duration * 100);
  },

  splitInterval(start, end) {
    const parts = [];
    let cursor = start;
    while (cursor < end) {
      const next = Math.min(end, cursor + VIDEO_TRACKING_MAX_SEGMENT_SECONDS);
      parts.push([cursor, next]);
      cursor = next;
    }
    return parts;
  },

  persistLocal(session) {
    if (!session || !session.userId) return;
    Storage.set(this.cacheKey(session), {
      sourceKey: session.sourceKey,
      trackingCycle: session.trackingCycle,
      durationSeconds: session.duration,
      lastPositionSeconds: session.position,
      intervals: session.intervals,
      pendingIntervals: session.pendingIntervals,
      updatedAt: new Date().toISOString(),
    });
  },

  restoreLocal(session) {
    const cached = Storage.get(this.cacheKey(session));
    if (
      !cached
      || cached.sourceKey !== session.sourceKey
      || Number(cached.trackingCycle || 1) !== session.trackingCycle
    ) return;
    session.duration = Math.max(session.duration, this.finiteSeconds(cached.durationSeconds));
    session.position = Math.max(session.position, this.finiteSeconds(cached.lastPositionSeconds));
    session.resumePosition = Math.max(session.resumePosition, session.position);
    session.intervals = this.mergeIntervals(
      [...session.intervals, ...(cached.intervals || [])],
      session.duration || Infinity,
    );
    session.pendingIntervals = this.normalizeIntervals(cached.pendingIntervals, session.duration || Infinity);
  },

  loadScript(key, src, ready) {
    if (ready()) return Promise.resolve();
    if (this.scriptPromises.has(key)) return this.scriptPromises.get(key);
    const promise = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-video-sdk="${key}"]`);
      const script = existing || document.createElement('script');
      const timeout = setTimeout(() => reject(new Error(`Tempo esgotado ao carregar ${key}.`)), 12_000);
      const finish = () => {
        if (!ready()) return;
        clearTimeout(timeout);
        resolve();
      };
      script.addEventListener('load', finish, { once: true });
      script.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error(`Não foi possível carregar ${key}.`));
      }, { once: true });
      if (!existing) {
        script.src = src;
        script.async = true;
        script.dataset.videoSdk = key;
        document.head.appendChild(script);
      }
      const poll = setInterval(() => {
        if (!ready()) return;
        clearInterval(poll);
        finish();
      }, 100);
      setTimeout(() => clearInterval(poll), 12_500);
    }).catch(error => {
      this.scriptPromises.delete(key);
      throw error;
    });
    this.scriptPromises.set(key, promise);
    return promise;
  },

  async start(courseId, lesson, progress) {
    this.stop({ flush: true });
    if (!AppState.currentUser || !this.shouldTrack(progress)) return;
    const provider = String(lesson?.videoProvider || '').toLowerCase();
    if (!['youtube', 'vimeo', 'direct', 'upload', 's3'].includes(provider)) return;

    const session = {
      userId: AppState.currentUser.id,
      courseId,
      lessonId: lesson.id,
      lesson,
      provider,
      sourceKey: this.sourceKey(lesson),
      trackingCycle: this.cycleFor(progress),
      duration: 0,
      position: 0,
      resumePosition: 0,
      resumeApplied: false,
      intervals: [],
      pendingIntervals: [],
      playing: false,
      lastMediaTime: null,
      lastWallTime: null,
      playbackRate: 1,
      saving: false,
      flushAgain: false,
      pendingEnded: false,
      failureCount: 0,
      completionHandled: false,
      destroy: null,
      timer: null,
    };
    this.current = session;
    this.restoreLocal(session);
    this.updateUi(session, 'Preparando a detecção automática…');

    session.timer = setInterval(() => {
      if (this.current === session) void this.flush(session);
    }, VIDEO_TRACKING_SAVE_INTERVAL_MS);

    void this.attachProvider(session).catch(error => {
      if (this.current !== session) return;
      this.markUnavailable(session, error?.message || 'A detecção automática não pôde ser iniciada.');
    });
    void this.loadServerState(session);
  },

  stop({ flush = false } = {}) {
    const session = this.current;
    if (!session) return;
    this.current = null;
    if (session.timer) clearInterval(session.timer);
    try { session.destroy?.(); } catch {}
    this.persistLocal(session);
    if (flush) void this.flush(session, { force: true });
  },

  async loadServerState(session) {
    if (AppState.backendMode !== 'api') {
      this.updateUi(session);
      return;
    }
    try {
      await BetaStudentSync.flushCourse(session.userId, session.courseId);
      if (this.current !== session) return;
      const payload = await ApiClient.request(
        `/api/me/video-progress/${encodeURIComponent(session.courseId)}/${encodeURIComponent(session.lessonId)}?cycle=${session.trackingCycle}`,
      );
      if (this.current !== session) return;
      const tracking = payload?.tracking || {};
      session.duration = Math.max(session.duration, this.finiteSeconds(tracking.durationSeconds));
      session.position = Math.max(session.position, this.finiteSeconds(tracking.lastPositionSeconds));
      session.resumePosition = Math.max(session.resumePosition, session.position);
      session.intervals = this.mergeIntervals(
        [...session.intervals, ...(tracking.intervals || [])],
        session.duration || Infinity,
      );
      this.persistLocal(session);
      this.updateUi(session);
      if (tracking.completed === true) await this.complete(session);
    } catch (error) {
      if (this.current !== session) return;
      session.failureCount += 1;
      this.updateUi(session, 'O acompanhamento ficará salvo neste dispositivo até a conexão normalizar.');
    }
  },

  setPlaying(session, playing, currentTime, playbackRate = 1) {
    if (this.current !== session) return;
    session.playing = Boolean(playing);
    session.playbackRate = Math.max(0.25, Math.min(4, Number(playbackRate || 1)));
    session.lastMediaTime = this.finiteSeconds(currentTime, session.position);
    session.position = session.lastMediaTime;
    session.lastWallTime = performance.now();
  },

  sample(session, currentTime, duration, playbackRate = session.playbackRate) {
    if (this.current !== session) return;
    const current = this.finiteSeconds(currentTime, session.position);
    const knownDuration = this.finiteSeconds(duration);
    if (knownDuration > 0 && Number.isFinite(knownDuration)) session.duration = Math.max(session.duration, knownDuration);
    session.position = current;

    const now = performance.now();
    const previousMedia = session.lastMediaTime;
    const previousWall = session.lastWallTime;
    session.lastMediaTime = current;
    session.lastWallTime = now;
    if (!session.playing || previousMedia == null || previousWall == null) {
      this.updateUi(session);
      return;
    }

    const wallDelta = Math.max(0, (now - previousWall) / 1_000);
    const mediaDelta = current - previousMedia;
    const rate = Math.max(0.25, Math.min(4, Number(playbackRate || 1)));
    const maximumContinuousDelta = Math.max(3, wallDelta * (rate + 1.25) + 1);
    const continuous = wallDelta <= 12
      && mediaDelta >= 0.1
      && mediaDelta <= maximumContinuousDelta;
    if (continuous) {
      const parts = this.splitInterval(previousMedia, current);
      session.pendingIntervals.push(...parts);
      session.intervals = this.mergeIntervals(
        [...session.intervals, ...parts],
        session.duration || Infinity,
      );
      this.persistLocal(session);
    }
    this.updateUi(session);
  },

  resetSample(session, currentTime = session.position) {
    if (this.current !== session) return;
    session.lastMediaTime = this.finiteSeconds(currentTime, session.position);
    session.position = session.lastMediaTime;
    session.lastWallTime = performance.now();
  },

  maybeResume(session, seek) {
    if (session.resumeApplied) return;
    const target = this.finiteSeconds(session.resumePosition);
    if (!(target >= 5) || (session.duration > 0 && target >= session.duration - 3)) {
      session.resumeApplied = true;
      return;
    }
    session.resumeApplied = true;
    try {
      const result = seek(target);
      if (result?.catch) result.catch(() => {});
      this.resetSample(session, target);
      this.updateUi(session, `Retomando de ${this.formatTime(target)}.`);
    } catch {}
  },

  async attachProvider(session) {
    const element = document.getElementById(VideoProvider.elementId(session.lesson));
    if (!element || this.current !== session) throw new Error('O player do vídeo não foi encontrado.');
    if (session.provider === 'youtube') return this.attachYouTube(session, element);
    if (session.provider === 'vimeo') return this.attachVimeo(session, element);
    return this.attachHtml5(session, element);
  },

  async attachYouTube(session, iframe) {
    await this.loadScript(
      'youtube',
      'https://www.youtube.com/iframe_api',
      () => Boolean(window.YT?.Player),
    );
    if (this.current !== session) return;
    let poll = null;
    const player = new window.YT.Player(iframe, {
      events: {
        onReady: event => {
          if (this.current !== session) return;
          session.duration = Math.max(session.duration, this.finiteSeconds(event.target.getDuration?.()));
          this.updateUi(session, 'Acompanhamento automático ativo.');
        },
        onStateChange: event => {
          if (this.current !== session) return;
          const current = this.finiteSeconds(event.target.getCurrentTime?.(), session.position);
          const duration = this.finiteSeconds(event.target.getDuration?.(), session.duration);
          const rate = Number(event.target.getPlaybackRate?.() || 1);
          if (event.data === window.YT.PlayerState.PLAYING) {
            this.maybeResume(session, target => event.target.seekTo(target, true));
            this.setPlaying(session, true, event.target.getCurrentTime?.(), rate);
            if (!poll) {
              poll = setInterval(() => {
                if (this.current !== session || !session.playing) return;
                this.sample(
                  session,
                  event.target.getCurrentTime?.(),
                  event.target.getDuration?.(),
                  event.target.getPlaybackRate?.(),
                );
              }, 1_000);
            }
          } else {
            if (session.playing) this.sample(session, current, duration, rate);
            this.setPlaying(session, false, current, rate);
            if (event.data === window.YT.PlayerState.ENDED) {
              void this.flush(session, { force: true, ended: true });
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              void this.flush(session, { force: true });
            }
          }
        },
        onError: () => this.markUnavailable(session, 'O YouTube não permitiu iniciar a detecção automática.'),
      },
    });
    session.destroy = () => {
      if (poll) clearInterval(poll);
      try { player.destroy(); } catch {}
    };
  },

  async attachVimeo(session, iframe) {
    await this.loadScript(
      'vimeo',
      'https://player.vimeo.com/api/player.js',
      () => Boolean(window.Vimeo?.Player),
    );
    if (this.current !== session) return;
    const player = new window.Vimeo.Player(iframe);
    const handlers = {
      loaded: async () => {
        session.duration = Math.max(session.duration, this.finiteSeconds(await player.getDuration().catch(() => 0)));
        this.updateUi(session, 'Acompanhamento automático ativo.');
      },
      play: async () => {
        this.maybeResume(session, target => player.setCurrentTime(target));
        const current = await player.getCurrentTime().catch(() => session.position);
        const rate = await player.getPlaybackRate().catch(() => 1);
        this.setPlaying(session, true, current, rate);
      },
      timeupdate: data => this.sample(session, data?.seconds, data?.duration, session.playbackRate),
      seeking: data => this.resetSample(session, data?.seconds),
      pause: async data => {
        if (session.playing) this.sample(session, data?.seconds, data?.duration, session.playbackRate);
        this.setPlaying(session, false, data?.seconds, session.playbackRate);
        void this.flush(session, { force: true });
      },
      ended: data => {
        if (session.playing) this.sample(session, data?.seconds, data?.duration, session.playbackRate);
        this.setPlaying(session, false, data?.seconds, session.playbackRate);
        void this.flush(session, { force: true, ended: true });
      },
      error: () => this.markUnavailable(session, 'O Vimeo não permitiu iniciar a detecção automática.'),
    };
    Object.entries(handlers).forEach(([event, handler]) => player.on(event, handler));
    session.destroy = () => {
      Object.entries(handlers).forEach(([event, handler]) => player.off(event, handler));
      void player.unload().catch(() => {});
    };
  },

  attachHtml5(session, video) {
    const listeners = {
      loadedmetadata: () => {
        session.duration = Math.max(session.duration, this.finiteSeconds(video.duration));
        this.updateUi(session, 'Acompanhamento automático ativo.');
      },
      play: () => {
        this.maybeResume(session, target => { video.currentTime = target; });
        this.setPlaying(session, true, video.currentTime, video.playbackRate);
      },
      timeupdate: () => this.sample(session, video.currentTime, video.duration, video.playbackRate),
      seeking: () => this.resetSample(session, video.currentTime),
      ratechange: () => { session.playbackRate = Number(video.playbackRate || 1); },
      pause: () => {
        if (session.playing) this.sample(session, video.currentTime, video.duration, video.playbackRate);
        this.setPlaying(session, false, video.currentTime, video.playbackRate);
        void this.flush(session, { force: true });
      },
      ended: () => {
        if (session.playing) this.sample(session, video.currentTime, video.duration, video.playbackRate);
        this.setPlaying(session, false, video.currentTime, video.playbackRate);
        void this.flush(session, { force: true, ended: true });
      },
      error: () => this.markUnavailable(session, 'O navegador não permitiu iniciar a detecção automática.'),
    };
    Object.entries(listeners).forEach(([event, listener]) => video.addEventListener(event, listener));
    session.destroy = () => Object.entries(listeners)
      .forEach(([event, listener]) => video.removeEventListener(event, listener));
    if (video.readyState >= 1) listeners.loadedmetadata();
  },

  async flush(session, { force = false, ended = false } = {}) {
    if (!session) return null;
    if (ended) session.pendingEnded = true;
    this.persistLocal(session);
    if (session.saving) {
      session.flushAgain = true;
      return null;
    }
    if (AppState.backendMode !== 'api') {
      if (session.pendingEnded && this.percentage(session) >= VIDEO_COMPLETION_THRESHOLD * 100) {
        session.pendingEnded = false;
        await this.complete(session);
      } else if (session.pendingEnded) {
        session.pendingEnded = false;
        this.updateUi(session, 'Você chegou ao fim, mas ainda há trechos não assistidos. Continue assistindo ou use a confirmação manual.');
      }
      return null;
    }
    if (!session.pendingIntervals.length && !force) return null;

    const outgoing = session.pendingIntervals.splice(0, 500);
    session.saving = true;
    try {
      await BetaStudentSync.flushCourse(session.userId, session.courseId);
      const payload = await ApiClient.request(
        `/api/me/video-progress/${encodeURIComponent(session.courseId)}/${encodeURIComponent(session.lessonId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            trackingCycle: session.trackingCycle,
            durationSeconds: session.duration,
            lastPositionSeconds: session.position,
            intervals: outgoing,
            ended: session.pendingEnded === true,
          }),
        },
      );
      const tracking = payload?.tracking || {};
      session.failureCount = 0;
      session.duration = Math.max(session.duration, this.finiteSeconds(tracking.durationSeconds));
      session.position = Math.max(session.position, this.finiteSeconds(tracking.lastPositionSeconds));
      session.intervals = this.mergeIntervals(tracking.intervals || session.intervals, session.duration || Infinity);
      this.persistLocal(session);
      const endedWasSent = session.pendingEnded === true;
      session.pendingEnded = false;
      this.updateUi(
        session,
        tracking.completed
          ? 'Vídeo concluído automaticamente.'
          : endedWasSent
            ? 'Você chegou ao fim, mas ainda há trechos não assistidos. Continue assistindo ou use a confirmação manual.'
            : 'Acompanhamento automático ativo.',
      );
      if (tracking.completed === true) await this.complete(session);
      return payload;
    } catch (error) {
      session.pendingIntervals.unshift(...outgoing);
      session.failureCount += 1;
      this.persistLocal(session);
      if (session.failureCount >= 2) {
        this.markUnavailable(session, 'A conexão não confirmou o progresso. Você pode continuar assistindo ou usar a opção manual.');
      } else {
        this.updateUi(session, 'Seu avanço ficou salvo neste dispositivo e será sincronizado novamente.');
      }
      return null;
    } finally {
      session.saving = false;
      if (session.flushAgain || session.pendingIntervals.length >= 20 || session.pendingEnded) {
        session.flushAgain = false;
        void this.flush(session, { ended: session.pendingEnded });
      }
    }
  },

  async complete(session) {
    if (session.completionHandled) return;
    session.completionHandled = true;
    Storage.remove(this.cacheKey(session));
    const progress = Progress.markVideoCompleted(
      session.userId,
      session.courseId,
      session.lessonId,
    );
    if (!progress) return;
    const lessonProgress = progress.lessons[session.lessonId];
    const course = COURSES_DATA.find(item => item.id === session.courseId);
    const lesson = course?.modules.flatMap(module => module.lessons)
      .find(item => item.id === session.lessonId);
    if (!course || !lesson) return;
    const activeLesson = this.current === session
      && AppState.currentPage === 'lesson'
      && AppState.currentCourseId === session.courseId
      && AppState.currentLessonId === session.lessonId;
    if (!activeLesson) return;
    Toast.show('Vídeo concluído automaticamente!', 'success');
    renderLessonSidebar(session.courseId, session.lessonId, course, progress);
    setTimeout(() => {
      const stillActive = AppState.currentPage === 'lesson'
        && AppState.currentCourseId === session.courseId
        && AppState.currentLessonId === session.lessonId;
      if (stillActive) renderStepContent(session.courseId, lesson, lessonProgress, 'video');
    }, 0);
  },

  updateUi(session, explicitMessage = '') {
    const root = document.getElementById('step-video');
    if (!root || (this.current && this.current !== session)) return;
    const percentage = Math.floor(this.percentage(session));
    const label = root.querySelector('[data-video-progress-label]');
    const bar = root.querySelector('[data-video-progress-bar]');
    const message = root.querySelector('[data-video-tracking-message]');
    const resume = root.querySelector('[data-video-resume]');
    if (label) label.textContent = `${percentage}%`;
    if (bar) bar.style.width = `${percentage}%`;
    if (message) {
      message.textContent = explicitMessage
        || (percentage >= VIDEO_COMPLETION_THRESHOLD * 100
          ? 'Continue até o vídeo terminar. A próxima etapa será liberada somente após o fim da reprodução.'
          : percentage > 0
            ? 'Continue assistindo. Saltos na linha do tempo não entram no percentual.'
            : 'O avanço será registrado automaticamente enquanto o vídeo estiver reproduzindo.');
    }
    if (resume) {
      resume.textContent = session.resumePosition >= 5
        ? `Último ponto salvo: ${this.formatTime(session.resumePosition)}`
        : '';
      resume.hidden = session.resumePosition < 5;
    }
  },

  markUnavailable(session, message) {
    if (this.current !== session) return;
    this.updateUi(session, message);
    const root = document.getElementById('step-video');
    root?.querySelector('[data-video-manual-fallback]')?.setAttribute('open', '');
    root?.querySelector('[data-video-tracking-status]')?.classList.add('has-error');
  },

  formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds || 0)));
    const hours = Math.floor(total / 3_600);
    const minutes = Math.floor(total % 3_600 / 60);
    const remaining = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  },
};

window.VideoTracking = VideoTracking;

// ============================================================
// SECTION 7: QUIZ MODULE
// ============================================================
const Quiz = {
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  },

  prepareQuestions(rawQuestions, quizConfig = QUIZ_CONFIG) {
    let questions = quizConfig.shuffleQuestions
      ? this.shuffle([...rawQuestions])
      : [...rawQuestions];

    return questions.map(q => ({
      ...q,
      options: quizConfig.shuffleOptions ? this.shuffle([...q.options]) : [...q.options],
    }));
  },

  grade(questions, selectedAnswers) {
    let correct = 0;
    const results = {};
    questions.forEach(q => {
      const chosen = selectedAnswers[q.id];
      const isCorrect = chosen === q.correctOptionId;
      if (isCorrect) correct++;
      results[q.id] = { chosen, isCorrect, correctOptionId: q.correctOptionId };
    });
    return { score: correct, total: questions.length, results };
  },
};

// ============================================================
// COURSE ACCESS AND PREREQUISITES
// ============================================================
const CourseAccess = {
  decision(course) {
    if (!course) return { allowed: false, reasonCode: 'course_not_found', nextStep: 'Curso não encontrado.' };
    if (course.accessPolicy?.mode !== 'restricted') {
      return { allowed: true, reasonCode: null, nextStep: '', missingPrerequisites: [] };
    }
    if (course.access && typeof course.access === 'object') return course.access;
    if (!AppState.currentUser) {
      return {
        allowed: false,
        reasonCode: 'authentication_required',
        nextStep: 'Entre ou crie sua conta para verificar os pré-requisitos.',
        missingPrerequisites: this.prerequisites(course),
      };
    }
    const missingPrerequisites = this.prerequisites(course).filter(item => !this.localCourseCompleted(item.id));
    return {
      allowed: missingPrerequisites.length === 0,
      reasonCode: missingPrerequisites.length ? 'prerequisite_incomplete' : null,
      nextStep: missingPrerequisites.length
        ? `Conclua primeiro: ${missingPrerequisites.map(item => item.title).join(', ')}.`
        : '',
      missingPrerequisites,
    };
  },

  prerequisites(course) {
    const ids = Array.isArray(course?.accessPolicy?.prerequisiteCourseIds)
      ? course.accessPolicy.prerequisiteCourseIds
      : [];
    return ids.map(id => ({ id, title: COURSES_DATA.find(item => item.id === id)?.title || id }));
  },

  localCourseCompleted(courseId) {
    const user = AppState.currentUser;
    const course = COURSES_DATA.find(item => item.id === courseId);
    const progress = user ? Progress.get(user.id, courseId) : null;
    const lessons = course?.modules?.flatMap(module => module.lessons) || [];
    return lessons.length > 0 && lessons.every(lesson => progress?.lessons?.[lesson.id]?.lessonCompleted === true);
  },

  requirementText(course) {
    const decision = this.decision(course);
    return decision.nextStep || decision.reason || 'Conclua os pré-requisitos para continuar.';
  },

  canOpenContent(course) {
    const decision = this.decision(course);
    return decision.allowed !== false && decision.contentAvailable !== false;
  },
};

// ============================================================
// SECTION 8: ROUTER
// ============================================================
const Router = {
  titles: {
    landing: 'Beta Cursos | Formação que transforma',
    catalog: 'Cursos | Beta Cursos',
    course: 'Detalhes do curso | Beta Cursos',
    login: 'Entrar | Beta Cursos',
    register: 'Criar conta | Beta Cursos',
    'check-email': 'Confira seu e-mail | Beta Cursos',
    'complete-registration': 'Concluir cadastro | Beta Cursos',
    'forgot-password': 'Recuperar senha | Beta Cursos',
    'reset-password': 'Definir nova senha | Beta Cursos',
    privacy: 'Política de Privacidade | Beta Cursos',
    terms: 'Termos de Uso | Beta Cursos',
    cookies: 'Política de Cookies | Beta Cursos',
    checkout: 'Confirmar inscrição | Beta Cursos',
    dashboard: 'Meu painel | Beta Cursos',
    lesson: 'Minha lição | Beta Cursos',
    admin: 'Facilitador | Beta Cursos',
  },

  toHash(page, params = {}) {
    if (page === 'course') return `#course/${encodeURIComponent(params.courseId || '')}`;
    if (page === 'checkout') return `#checkout/${encodeURIComponent(params.courseId || '')}`;
    if (page === 'lesson') return `#lesson/${encodeURIComponent(params.courseId || '')}/${encodeURIComponent(params.lessonId || '')}`;
    if (['complete-registration', 'reset-password'].includes(page) && params.token) {
      return `#${page}/${encodeURIComponent(params.token)}`;
    }
    return page === 'landing' ? '#inicio' : `#${page}`;
  },

  fromHash() {
    const [page, first, second] = window.location.hash.replace(/^#/, '').split('/');
    const safeDecode = value => {
      try { return decodeURIComponent(value || ''); }
      catch { return ''; }
    };
    if (!page || page === 'inicio') return { page: 'landing', params: {} };
    if (page === 'course') return { page, params: { courseId: safeDecode(first) } };
    if (page === 'checkout') return { page, params: { courseId: safeDecode(first) } };
    if (page === 'lesson') return { page, params: { courseId: safeDecode(first), lessonId: safeDecode(second) } };
    if (['complete-registration', 'reset-password'].includes(page)) {
      return { page, params: { token: safeDecode(first) } };
    }
    return { page, params: {} };
  },

  navigate(page, params = {}, options = {}) {
    if (['complete-registration', 'reset-password'].includes(page)) {
      AppState.authActionToken = params.token || null;
      params = {};
      if (window.location.hash.includes('/')) {
        history.replaceState({ page, params: {} }, '', `#${page}`);
      }
    }
    const protectedPages = new Set(['dashboard', 'lesson', 'checkout', 'admin']);
    if (protectedPages.has(page) && !AppState.currentUser) {
      page = 'login';
      params = {};
    }
    if (page === 'admin' && !hasAdminAccess(AppState.currentUser)) {
      page = 'dashboard';
      params = {};
    }

    if (['checkout', 'lesson'].includes(page) && params.courseId) {
      const protectedCourse = COURSES_DATA.find(course => course.id === params.courseId);
      const decision = CourseAccess.decision(protectedCourse);
      if (protectedCourse && decision.allowed === false) {
        Toast.show(CourseAccess.requirementText(protectedCourse), 'info', 5500);
        page = 'course';
        params = { courseId: protectedCourse.id };
      }
    }

    const firstCourse = COURSES_DATA[0];
    if (page === 'course' || page === 'checkout') {
      params.courseId = params.courseId || firstCourse?.id;
    }
    if (page === 'lesson') {
      params.courseId = params.courseId || firstCourse?.id;
      params.lessonId = params.lessonId || firstCourse?.modules?.[0]?.lessons?.[0]?.id;
    }

    if (['course', 'checkout'].includes(page) && !COURSES_DATA.some(course => course.id === params.courseId)) {
      page = 'catalog';
      params = {};
    }
    if (page === 'lesson') {
      const targetCourse = COURSES_DATA.find(course => course.id === params.courseId);
      const targetLesson = targetCourse?.modules.flatMap(module => module.lessons).find(lesson => lesson.id === params.lessonId);
      if (!targetCourse || !targetLesson) {
        page = 'dashboard';
        params = {};
      }
    }

    if (page === 'lesson' && (params.courseId !== AppState.currentCourseId || params.lessonId !== AppState.currentLessonId)) {
      AppState.quizState = {
        isActive: false,
        questions: [],
        selectedAnswers: {},
        submitted: false,
        score: null,
        passed: false,
      };
    }

    if (AppState.currentPage === 'lesson' && page !== 'lesson') {
      VideoTracking.stop({ flush: true });
    }

    document.querySelectorAll('.page').forEach(item => {
      item.classList.remove('active');
      item.setAttribute('aria-hidden', 'true');
    });
    closeMobileMenu();

    AppState.currentPage = page;
    Object.assign(AppState, params);
    document.body.classList.toggle('is-admin-route', page === 'admin');

    const pageEl = document.getElementById(`page-${page}`);
    if (!pageEl) {
      return this.navigate('landing', {}, { replace: true });
    }
    pageEl.classList.add('active');
    pageEl.setAttribute('aria-hidden', 'false');

    const targetHash = this.toHash(page, params);
    if (!options.fromHistory && window.location.hash !== targetHash) {
      history[options.replace ? 'replaceState' : 'pushState']({ page, params }, '', targetHash);
    }

    window.scrollTo({ top: 0, behavior: 'auto' });

    switch (page) {
      case 'landing':   renderLanding(); break;
      case 'catalog':   renderCatalog(); break;
      case 'course':    renderCourseDetail(params.courseId); break;
      case 'login':     renderLogin(); break;
      case 'register':  renderRegister(); break;
      case 'check-email': renderCheckEmail(); break;
      case 'complete-registration': renderCompleteRegistration(); break;
      case 'forgot-password': renderForgotPassword(); break;
      case 'reset-password': renderResetPassword(); break;
      case 'checkout':  renderCheckout(params.courseId); break;
      case 'dashboard': renderDashboard(); break;
      case 'lesson':    renderLesson(params.courseId, params.lessonId); break;
      case 'admin':     renderAdmin(); break;
    }

    document.title = this.titles[page] || this.titles.landing;
    updateNavUI();

    document.querySelectorAll('.nav__link[data-route]').forEach(link => {
      if (link.dataset.route === page || (page === 'course' && link.dataset.route === 'catalog')) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });

    requestAnimationFrame(() => {
      const heading = pageEl.querySelector('h1');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    });
  },
};

window.addEventListener('popstate', () => {
  const route = Router.fromHash();
  Router.navigate(route.page, route.params, { fromHistory: true });
});

// ============================================================
// SECTION 9: TOAST NOTIFICATIONS
// ============================================================
const Toast = {
  show(message, type = 'info', duration = 3500) {
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    const icon = document.createElement('span');
    const text = document.createElement('span');
    icon.className = 'toast__icon';
    text.className = 'toast__text';
    icon.textContent = icons[type] || icons.info;
    text.textContent = String(message);
    toast.append(icon, text);
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
};

// ============================================================
// SECTION 10: NAV UI
// ============================================================
function updateNavUI() {
  const user = AppState.currentUser;
  const navAuth = document.getElementById('nav-auth');
  const navUser = document.getElementById('nav-user');
  const mobileAuth = document.getElementById('mobile-menu-auth');
  const mobileUser = document.getElementById('mobile-menu-user');
  const navAdmin = document.getElementById('nav-admin-link');
  const mobileAdmin = document.getElementById('mobile-admin-link');

  if (user) {
    navAuth.classList.add('hidden');
    navUser.classList.remove('hidden');
    mobileAuth?.classList.add('hidden');
    mobileUser?.classList.remove('hidden');
    const initials = user.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    document.getElementById('nav-avatar').textContent = initials;
    document.getElementById('nav-user-name').textContent = user.name.split(' ')[0];
    navAdmin?.classList.toggle('hidden', !hasAdminAccess(user));
    mobileAdmin?.classList.toggle('hidden', !hasAdminAccess(user));
  } else {
    navAuth.classList.remove('hidden');
    navUser.classList.add('hidden');
    mobileAuth?.classList.remove('hidden');
    mobileUser?.classList.add('hidden');
    navAdmin?.classList.add('hidden');
    mobileAdmin?.classList.add('hidden');
  }
}

window.toggleMobileMenu = function() {
  const menu = document.getElementById('mobile-menu');
  const hamburger = document.querySelector('.nav__hamburger');
  const open = menu.classList.toggle('open');
  hamburger.classList.toggle('open', open);
  hamburger.setAttribute('aria-expanded', String(open));
  hamburger.setAttribute('aria-label', open ? 'Fechar menu' : 'Abrir menu');
  menu.setAttribute('aria-hidden', String(!open));
};

window.closeMobileMenu = function() {
  document.getElementById('mobile-menu').classList.remove('open');
  document.getElementById('mobile-menu').setAttribute('aria-hidden', 'true');
  const hamburger = document.querySelector('.nav__hamburger');
  hamburger.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  hamburger.setAttribute('aria-label', 'Abrir menu');
};

window.closeMobileMenuAndNavigate = function(page, params) {
  closeMobileMenu();
  Router.navigate(page, params);
};

// ============================================================
// SECTION 11: PAGE RENDERERS
// ============================================================

// --- LANDING PAGE ---
function renderLanding() {
  const featured = COURSES_DATA.find(course => course.featured) || COURSES_DATA[0] || null;
  const featureSection = document.querySelector('.course-feature');
  if (featureSection) featureSection.hidden = !featured;
  const statRow = document.querySelector('.hero__stat-row');
  if (statRow) statRow.hidden = !featured;
  const heroButton = document.getElementById('hero-cta-btn');
  if (heroButton) heroButton.textContent = featured ? 'Conhecer o curso' : 'Ver catálogo';

  if (featured) {
    document.getElementById('featured-course-title').textContent = featured.title;
    document.getElementById('featured-course-description').textContent = featured.description;
    document.getElementById('featured-course-category').textContent = featured.category;
    document.getElementById('featured-course-level').textContent = featured.level;
    document.getElementById('featured-course-duration').textContent = featured.duration || `${featured.modules.flatMap(module => module.lessons).length} lições`;
    const featureButton = document.getElementById('featured-course-button');
    featureButton.onclick = () => Router.navigate('course', { courseId: featured.id });

    const landingButton = document.getElementById('landing-course-cta');
    if (landingButton) {
      landingButton.textContent = 'Ver detalhes do curso →';
      landingButton.onclick = () => Router.navigate('course', { courseId: featured.id });
    }

    const lessonList = document.getElementById('featured-course-lessons');
    lessonList.replaceChildren(...featured.modules.flatMap(module => module.lessons).slice(0, 6).map((lesson, index) => {
      const item = document.createElement('div');
      item.className = 'lesson-list__item';
      const number = document.createElement('div');
      number.className = 'lesson-list__num';
      number.textContent = String(index + 1);
      const title = document.createElement('div');
      title.className = 'lesson-list__title';
      title.textContent = lesson.title.replace(/^Lição \d+ — /, '');
      item.append(number, title);
      return item;
    }));
  }

  if (!featured) {
    const landingButton = document.getElementById('landing-course-cta');
    if (landingButton) {
      landingButton.textContent = 'Ver catálogo →';
      landingButton.onclick = () => Router.navigate('catalog');
    }
  }

  const ctaBtn = document.getElementById('hero-cta-btn');
  if (ctaBtn) {
    ctaBtn.onclick = () => {
      if (AppState.currentUser) {
        const enrolled = featured && Enrollment.isEnrolled(AppState.currentUser.id, featured.id);
        if (enrolled) {
          Router.navigate('dashboard');
        } else if (featured) {
          Router.navigate('course', { courseId: featured.id });
        } else {
          Router.navigate('catalog');
        }
      } else if (featured) {
        Router.navigate('register');
      } else {
        Router.navigate('catalog');
      }
    };
  }
}

// --- CATALOG ---
function renderCatalog() {
  const grid = document.getElementById('catalog-grid');
  if (!grid) return;
  if (!COURSES_DATA.length) {
    grid.innerHTML = `
      <div class="catalog-empty" role="status">
        <span class="section-header__label">Novas formações em preparação</span>
        <h2>Nenhum curso publicado agora</h2>
        <p>A equipe da Igreja Beta está preparando os próximos conteúdos. Volte em breve.</p>
      </div>
    `;
    return;
  }
  grid.innerHTML = COURSES_DATA.map((course, courseIndex) => {
    const pricing = Enrollment.calculatePrice(course.id, false);
    const coverImage = Safe.mediaUrl(course.coverImage);
    const access = CourseAccess.decision(course);
    const locked = access.allowed === false;
    return `
      <article class="course-grid-card ${locked ? 'is-locked' : ''}">
        <button type="button" class="course-grid-card__hit" aria-label="Ver detalhes de ${Safe.html(course.title)}" onclick="Router.navigate('course', {courseId:'${Safe.id(course.id)}'})"></button>
        <div class="course-grid-card__thumb ${coverImage ? 'has-image' : ''}" ${coverImage ? `style="background-image:url(&quot;${Safe.html(coverImage)}&quot;)"` : ''}>
          ${coverImage ? '<span class="sr-only">Capa do curso</span>' : `<div class="course-grid-card__thumb-icon" aria-hidden="true">${String(courseIndex + 1).padStart(2, '0')}</div>`}
        </div>
        <div class="course-grid-card__body">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
            <span class="badge badge--petrol">${Safe.html(course.category)}</span>
            <span class="badge badge--gray">${Safe.html(course.level)}</span>
            ${locked ? '<span class="badge badge--locked">Requisitos pendentes</span>' : ''}
          </div>
          <div class="course-grid-card__title">${Safe.html(course.title)}</div>
          <div class="course-grid-card__desc">${Safe.html(course.subtitle)}</div>
          ${locked ? `<p class="course-grid-card__requirement">${Safe.html(CourseAccess.requirementText(course))}</p>` : ''}
          <div class="course-grid-card__footer">
            <div class="course-grid-card__price">${locked ? 'Bloqueado' : `R$ ${pricing.finalPrice.toFixed(2).replace('.', ',')}`}</div>
            <span class="btn btn--primary btn--sm" aria-hidden="true">${locked ? 'Ver requisitos' : 'Ver curso'}</span>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

// --- COURSE DETAIL ---
function renderCourseDetail(courseId) {
  const course = COURSES_DATA.find(c => c.id === courseId);
  if (!course) return;

  const pricing = Enrollment.calculatePrice(courseId, false);
  const access = CourseAccess.decision(course);
  const enrolled = AppState.currentUser
    ? Enrollment.isEnrolled(AppState.currentUser.id, courseId)
    : false;

  // Header
  document.getElementById('course-detail-title').textContent = course.title;
  document.getElementById('course-detail-subtitle').textContent = course.subtitle;
  document.getElementById('course-detail-desc').textContent = course.description;
  document.getElementById('course-detail-eyebrow').textContent = course.category || 'Curso Beta';

  // Enroll card
  const priceEl = document.getElementById('course-price-display');
  const priceNoteEl = document.getElementById('course-price-note');
  const enrollBtn = document.getElementById('course-enroll-btn');

  if (access.allowed === false) {
    priceEl.textContent = 'Bloqueado';
    priceNoteEl.textContent = CourseAccess.requirementText(course);
    enrollBtn.className = 'btn btn--primary btn--block btn--lg mt-4';
    if (access.reasonCode === 'authentication_required') {
      enrollBtn.textContent = 'Entrar para verificar';
      enrollBtn.disabled = false;
      enrollBtn.onclick = () => Router.navigate('login');
    } else {
      enrollBtn.textContent = 'Requisitos pendentes';
      enrollBtn.disabled = true;
      enrollBtn.onclick = null;
    }
  } else if (enrolled) {
    priceEl.textContent = 'Inscrito';
    priceNoteEl.textContent = 'Você já tem acesso a este curso.';
    enrollBtn.textContent = 'Ir para o curso →';
    enrollBtn.className = 'btn btn--primary btn--block btn--lg mt-4';
    enrollBtn.disabled = false;
    enrollBtn.onclick = () => Router.navigate('dashboard');
  } else {
    priceEl.textContent = `R$ ${pricing.fullPrice.toFixed(2).replace('.', ',')}`;
    const paymentsDisabled = AppState.features.paymentsMode === 'disabled';
    priceNoteEl.textContent = paymentsDisabled
      ? 'As inscrições serão abertas quando a forma de pagamento oficial estiver disponível.'
      : 'Contribuição para esta formação.';
    enrollBtn.textContent = paymentsDisabled ? 'Inscrições em breve' : 'Confirmar inscrição';
    enrollBtn.className = 'btn btn--primary btn--block btn--lg mt-4';
    enrollBtn.disabled = paymentsDisabled;
    enrollBtn.onclick = () => {
      if (paymentsDisabled) return;
      if (!AppState.currentUser) {
        Router.navigate('register');
        return;
      }
      Router.navigate('checkout', { courseId });
    };
  }

  // Lessons list
  const lessonsContainer = document.getElementById('course-detail-lessons');
  const courseCover = Safe.mediaUrl(course.coverImage);
  lessonsContainer.innerHTML = course.modules.map((mod, moduleIndex) => {
    const moduleCover = Safe.mediaUrl(mod.coverImage) || courseCover;
    return `
    <div class="module-section">
      <div class="module-section__header ${moduleCover ? 'has-image' : ''}" ${moduleCover ? `style="background-image:url(&quot;${Safe.html(moduleCover)}&quot;)"` : ''}>
        <div class="module-section__header-overlay">
          <span class="module-section__number">Módulo ${String(moduleIndex + 1).padStart(2, '0')}</span>
          <div class="module-section__title">${Safe.html(mod.title)}</div>
          ${mod.description ? `<p class="module-section__description">${Safe.html(mod.description)}</p>` : ''}
        </div>
      </div>
      <div class="lesson-list-detail">
        ${mod.lessons.map((lesson, i) => `
          <div class="lesson-list-detail__item">
            <div class="lesson-list-detail__num">${i + 1}</div>
            <div class="lesson-list-detail__title">${Safe.html(lesson.title)}</div>
            <div class="lesson-list-detail__icons">
              <span class="lesson-list-detail__icon" title="Apostila PDF">PDF</span>
              <span class="lesson-list-detail__icon" title="Vídeo">PLAY</span>
              <span class="lesson-list-detail__icon" title="Teste">QUIZ</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  }).join('');
}

// --- LOGIN ---
function renderLogin() {
  document.getElementById('login-error').textContent = '';
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
  const recoveryLink = document.getElementById('login-forgot-password');
  if (recoveryLink) recoveryLink.hidden = AppState.features.passwordReset !== true;
  const resendLink = document.getElementById('login-resend-verification');
  if (resendLink) resendLink.hidden = true;
}

// --- REGISTER ---
function renderRegister() {
  document.getElementById('register-error').textContent = '';
  const verificationRequired = AppState.features.emailVerificationRequired === true;
  const details = document.querySelectorAll('[data-registration-details]');
  details.forEach(element => { element.hidden = verificationRequired; });
  const nameInput = document.getElementById('register-name');
  const birthDateInput = document.getElementById('register-birth-date');
  const passwordInput = document.getElementById('register-password');
  const passwordConfirmationInput = document.getElementById('register-password-confirm');
  nameInput.disabled = verificationRequired;
  birthDateInput.disabled = verificationRequired;
  passwordInput.disabled = verificationRequired;
  passwordConfirmationInput.disabled = verificationRequired;
  birthDateInput.value = '';
  configureBirthDateInput(birthDateInput);
  const title = document.getElementById('register-title');
  const description = document.getElementById('register-description');
  const submit = document.querySelector('#register-form button[type="submit"]');
  title.textContent = verificationRequired ? 'Comece pelo seu e-mail' : 'Crie sua conta';
  description.textContent = verificationRequired
    ? 'Enviaremos um link seguro. Seu nome e sua senha serão definidos somente depois da confirmação.'
    : 'Seu acesso e seu progresso ficarão vinculados ao seu e-mail.';
  submit.textContent = verificationRequired ? 'Enviar link de confirmação' : 'Criar conta';
}

function renderCheckEmail() {
  const email = document.getElementById('check-email-address');
  const preview = document.getElementById('check-email-preview');
  const error = document.getElementById('check-email-error');
  email.textContent = AppState.pendingAuthEmail || 'o endereço informado';
  error.textContent = '';
  preview.hidden = !AppState.previewAuthUrl;
  preview.href = AppState.previewAuthUrl || '#';
}

function renderCompleteRegistration() {
  const form = document.getElementById('complete-registration-form');
  const error = document.getElementById('complete-registration-error');
  const unavailable = document.getElementById('complete-registration-unavailable');
  error.textContent = '';
  document.getElementById('complete-registration-name').value = '';
  const birthDateInput = document.getElementById('complete-registration-birth-date');
  birthDateInput.value = '';
  configureBirthDateInput(birthDateInput);
  document.getElementById('complete-registration-password').value = '';
  document.getElementById('complete-registration-password-confirm').value = '';
  const available = Boolean(AppState.authActionToken);
  form.hidden = !available;
  unavailable.hidden = available;
}

function renderForgotPassword() {
  document.getElementById('forgot-password-error').textContent = '';
  document.getElementById('forgot-password-success').hidden = true;
  document.getElementById('forgot-password-form').hidden = false;
  document.getElementById('forgot-password-email').value = '';
  const preview = document.getElementById('forgot-password-preview');
  preview.hidden = true;
  preview.href = '#';
}

function renderResetPassword() {
  const form = document.getElementById('reset-password-form');
  const error = document.getElementById('reset-password-error');
  const unavailable = document.getElementById('reset-password-unavailable');
  error.textContent = '';
  document.getElementById('reset-password-value').value = '';
  document.getElementById('reset-password-confirm').value = '';
  const available = Boolean(AppState.authActionToken);
  form.hidden = !available;
  unavailable.hidden = available;
}

function configureCheckoutAvailability() {
  const notice = document.getElementById('checkout-environment-notice');
  const badge = document.getElementById('checkout-environment-badge');
  const methods = document.getElementById('checkout-payment-methods');
  const coupon = document.getElementById('checkout-coupon-group');
  const submit = document.getElementById('checkout-submit-btn');
  const mode = AppState.features.paymentsMode;
  const disabled = mode === 'disabled';
  const testMode = mode === 'test';

  if (notice) {
    notice.hidden = !disabled && !testMode;
    const title = notice.querySelector('strong');
    const description = notice.querySelector('span');
    if (title) title.textContent = disabled ? 'Inscrições em breve' : 'Ambiente de testes';
    if (description) {
      description.textContent = disabled
        ? 'A forma de pagamento oficial ainda está sendo conectada. Nenhuma inscrição paga está disponível neste momento.'
        : 'Nenhuma cobrança real será realizada neste ambiente.';
    }
  }
  if (methods) methods.hidden = disabled;
  if (coupon) coupon.hidden = disabled;
  document.querySelectorAll('.payment-method-btn').forEach(button => {
    button.disabled = disabled;
  });
  if (submit) {
    submit.disabled = disabled;
    submit.textContent = disabled
      ? 'Inscrições em breve'
      : testMode
        ? 'Ir para pagamento de teste'
        : 'Ir para o Mercado Pago';
  }
  if (badge) {
    badge.hidden = !testMode;
    badge.textContent = testMode ? 'Ambiente de testes · sem transação financeira' : '';
  }
}

// --- CHECKOUT ---
function renderCheckout(courseId) {
  const course = COURSES_DATA.find(c => c.id === courseId);
  if (!course || !AppState.currentUser) {
    Router.navigate('login');
    return;
  }
  AppState.currentCourseId = courseId;

  document.getElementById('checkout-course-title').textContent = course.title;
  document.getElementById('checkout-course-sub').textContent = course.subtitle;

  const checkoutPage = document.getElementById('page-checkout');
  checkoutPage.querySelector('h1.checkout-section-title').textContent = 'Confirmar inscrição';
  checkoutPage.querySelector('.payment-methods__label').textContent = 'Forma de contribuição';
  checkoutPage.querySelector('.payment-methods').setAttribute('aria-label', 'Forma de contribuição');
  checkoutPage.querySelector('label[for="coupon-input"]').textContent = 'Código Beta';
  checkoutPage.querySelector('#coupon-input').setAttribute('placeholder', 'Digite o código informado pela igreja');
  checkoutPage.querySelector('#coupon-btn').textContent = 'Validar código';
  checkoutPage.querySelector('.order-summary .checkout-section-title').textContent = 'Sua inscrição';
  checkoutPage.querySelector('#checkout-price-full').closest('.price-row').querySelector('.price-row__label').textContent = 'Contribuição';
  checkoutPage.querySelector('#checkout-coupon-discount-row .price-row__label').textContent = 'Benefício do Código Beta';
  checkoutPage.querySelector('.price-total__label').textContent = 'Contribuição total';

  AppState.checkout = {
    couponCode: null,
    couponValue: 0,
    paymentMethod: 'pix',
    idempotencyKey: createCheckoutAttemptKey(),
  };
  const couponInput = document.getElementById('coupon-input');
  const couponMessage = document.getElementById('coupon-message');
  couponInput.value = '';
  couponMessage.textContent = '';
  document.querySelectorAll('.payment-method-btn').forEach(button => {
    const active = button.dataset.method === 'pix';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const submitButton = document.getElementById('checkout-submit-btn');
  submitButton.disabled = false;

  // Initialize pricing
  updateCheckoutPricing(0);
  configureCheckoutAvailability();
}

function updateCheckoutPricing(couponValue = 0) {
  const pricing = Enrollment.calculatePrice(AppState.currentCourseId, false);

  const fullEl = document.getElementById('checkout-price-full');
  const couponRow = document.getElementById('checkout-coupon-discount-row');
  const couponEl = document.getElementById('checkout-coupon-discount');
  const totalEl = document.getElementById('checkout-total');

  fullEl.textContent = `R$ ${pricing.fullPrice.toFixed(2).replace('.', ',')}`;
  const finalPrice = pricing.fullPrice - couponValue;
  if (couponValue > 0) {
    couponRow.classList.remove('hidden');
    couponEl.textContent = `- R$ ${couponValue.toFixed(2).replace('.', ',')}`;
  } else {
    couponRow.classList.add('hidden');
  }
  totalEl.textContent = `R$ ${Math.max(0, finalPrice).toFixed(2).replace('.', ',')}`;
}

// --- DASHBOARD ---
function renderDashboard() {
  const user = AppState.currentUser;
  if (!user) { Router.navigate('login'); return; }

  document.getElementById('dashboard-name').textContent = user.name.split(' ')[0];

  // Stats
  const enrollments = Storage.get(`enrollments_${user.id}`) || [];
  document.getElementById('stat-enrolled').textContent = enrollments.length;

  let completedLessons = 0;
  let currentLessonTitle = '—';

  enrollments.forEach(courseId => {
    const p = Progress.reconcileCourse(user.id, courseId) || Progress.get(user.id, courseId);
    if (p) {
      Object.values(p.lessons).forEach(lp => {
        if (lp.lessonCompleted) completedLessons++;
      });
    }
  });

  document.getElementById('stat-lessons').textContent = completedLessons;
  const totalLessons = enrollments.reduce((total, courseId) => {
    const course = COURSES_DATA.find(item => item.id === courseId);
    return total + (course ? course.modules.flatMap(module => module.lessons).length : 0);
  }, 0);
  document.getElementById('stat-total-lessons').textContent = totalLessons;
  const configuredAttempts = enrollments
    .flatMap(courseId => {
      const course = COURSES_DATA.find(item => item.id === courseId);
      return (course?.modules || [])
        .flatMap(module => module.lessons || [])
        .filter(lesson => LessonContent.requirements(lesson).hasQuiz)
        .map(lesson => CourseRules.getQuizConfig(courseId, lesson.id).maxAttempts);
    })
    .filter(Boolean);
  document.getElementById('stat-max-attempts').textContent = configuredAttempts.length
    ? `${configuredAttempts[0]}x`
    : '—';

  // Enrolled courses
  const coursesContainer = document.getElementById('dashboard-courses');
  if (enrollments.length === 0) {
    coursesContainer.innerHTML = `
      <div style="text-align:center;padding:60px 20px;color:rgba(245,231,215,0.4);">
        <div class="empty-state__mark" aria-hidden="true">Beta /cursos</div>
        <div style="font-size:1.1rem;font-weight:600;margin-bottom:8px;color:var(--color-cream);">Nenhum curso ainda</div>
        <div style="margin-bottom:24px;">Comece sua jornada de liderança agora.</div>
        <button class="btn btn--primary" onclick="Router.navigate('catalog')">Ver cursos disponíveis</button>
      </div>
    `;
    return;
  }

  coursesContainer.innerHTML = enrollments.map(courseId => {
    const course = COURSES_DATA.find(c => c.id === courseId);
    if (!course) return '';
    const pct = Progress.getCompletionPercentage(user.id, courseId);
    const p = Progress.reconcileCourse(user.id, courseId) || Progress.get(user.id, courseId);
    const allLessons = course.modules.flatMap(m => m.lessons);

    return `
      <div class="course-card">
        <div class="course-card__header">
          <div>
            <div class="course-card__title">${Safe.html(course.title)}</div>
            <div class="course-card__module">${Safe.html(course.modules[0]?.title || 'Formação')}</div>
          </div>
          <span class="badge ${pct === 100 ? 'badge--green' : 'badge--orange'}">${pct === 100 ? '✓ Concluído' : 'Em progresso'}</span>
        </div>
        <div class="course-card__progress-section">
          <div class="course-card__progress-header">
            <span class="course-card__progress-label">Progresso</span>
            <span class="course-card__progress-pct">${pct}%</span>
          </div>
          <div class="progress-bar progress-bar--lg">
            <div class="progress-bar__fill" style="width:${pct}%"></div>
          </div>
        </div>
        <div class="lesson-rows">
          ${allLessons.map(lesson => {
            if (!p) return '';
            const lp = p.lessons[lesson.id];
            let icon, status, rowClass;
            if (!lp || !lp.unlocked) {
              icon = '🔒'; status = 'Bloqueada'; rowClass = 'locked';
            } else if (lp.lessonCompleted) {
              icon = '✓'; status = 'Concluída'; rowClass = 'done';
            } else {
              icon = '▶'; status = _getLessonCurrentStep(lp, courseId, lesson.id); rowClass = 'current';
            }
            const iconClass = lp?.lessonCompleted ? 'lesson-row__icon--done' : (!lp?.unlocked ? 'lesson-row__icon--locked' : 'lesson-row__icon--current');

            return `
              <button type="button" class="lesson-row ${rowClass}" ${lp?.unlocked ? `onclick="Router.navigate('lesson',{courseId:'${Safe.id(courseId)}',lessonId:'${Safe.id(lesson.id)}'})"` : 'disabled'}>
                <div class="lesson-row__icon ${iconClass}">${icon}</div>
                <div class="lesson-row__info">
                  <div class="lesson-row__title">${Safe.html(lesson.title)}</div>
                  <div class="lesson-row__status">${Safe.html(status)}</div>
                </div>
                ${lp?.unlocked && !lp.lessonCompleted ? `<span class="btn btn--sm btn--outline-orange">Continuar →</span>` : ''}
              </button>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function _getLessonCurrentStep(lp, courseId, lessonId) {
  const course = COURSES_DATA.find(item => item.id === courseId);
  const lesson = course?.modules.flatMap(module => module.lessons).find(item => item.id === lessonId);
  if (!lesson) return 'Em andamento';
  const requirements = LessonContent.requirements(lesson);
  if (requirements.hasPdf && !lp.pdfRead) return 'Apostila';
  if (requirements.hasVideo && !lp.videoCompleted) return 'Vídeo';
  if (!requirements.hasQuiz) return lp.lessonCompleted ? 'Concluída' : 'Pronta para concluir';
  if (lp.quizStatus === 'passed') return 'Concluída';
  if (lp.quizStatus === 'exhausted') return 'Teste — Tentativas esgotadas';
  if (lp.quizStatus === 'failed') {
    const remaining = CourseRules.getQuizConfig(courseId, lessonId).maxAttempts - lp.quizAttemptsUsed;
    return `Teste (${remaining} tentativa${remaining > 1 ? 's' : ''} restante${remaining > 1 ? 's' : ''})`;
  }
  return 'Teste disponível';
}

// --- LESSON PLAYER ---
function renderLesson(courseId, lessonId) {
  const user = AppState.currentUser;
  if (!user) { Router.navigate('login'); return; }
  if (!Enrollment.isEnrolled(user.id, courseId)) { Router.navigate('catalog'); return; }

  const course = COURSES_DATA.find(c => c.id === courseId);
  if (!course) return;
  if (!CourseAccess.canOpenContent(course)) {
    Toast.show(CourseAccess.requirementText(course), 'info', 5500);
    Router.navigate('course', { courseId });
    return;
  }
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  if (!lesson) return;

  AppState.currentCourseId = courseId;
  AppState.currentLessonId = lessonId;

  const p = Progress.reconcileCourse(user.id, courseId) || Progress.get(user.id, courseId);
  const lp = p?.lessons[lessonId];

  if (!lp?.unlocked) {
    Toast.show('Esta lição ainda está bloqueada.', 'error');
    Router.navigate('dashboard');
    return;
  }

  AppState.currentStep = LessonContent.firstPendingStep(lesson, lp);

  renderLessonSidebar(courseId, lessonId, course, p);
  renderLessonMain(courseId, lesson, lp);
  renderStepContent(courseId, lesson, lp, AppState.currentStep);
}

function renderLessonSidebar(courseId, lessonId, course, p) {
  const sidebar = document.getElementById('lesson-sidebar');
  const allLessons = course.modules.flatMap(m => m.lessons);

  sidebar.querySelector('.lesson-sidebar__course').textContent = 'Beta Cursos';
  const currentModule = course.modules.find(module => module.lessons.some(item => item.id === lessonId)) || course.modules[0];
  sidebar.querySelector('.lesson-sidebar__module').textContent = currentModule?.title || 'Jornada de formação';

  // Progress
  const pct = Progress.getCompletionPercentage(AppState.currentUser.id, courseId);
  const progressEl = sidebar.querySelector('.lesson-sidebar__progress');
  progressEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
      <span class="sidebar-progress__label">Progresso</span>
      <span class="sidebar-progress__value">${pct}%</span>
    </div>
    <div class="progress-bar" role="progressbar" aria-label="Progresso no curso" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="progress-bar__fill" style="width:${pct}%"></div></div>
  `;

  // Lesson nav
  const nav = sidebar.querySelector('.lesson-sidebar__nav');
  nav.innerHTML = allLessons.map(lesson => {
    const lp = p?.lessons[lesson.id];
    const isActive = lesson.id === lessonId;
    const isLocked = !lp?.unlocked;
    const isDone = lp?.lessonCompleted;

    let dotClass = 'sidebar-lesson__dot--locked';
    let dotIcon = '•';
    let rowClass = 'locked';

    if (isDone) { dotClass = 'sidebar-lesson__dot--done'; dotIcon = '✓'; rowClass = ''; }
    else if (isActive) { dotClass = 'sidebar-lesson__dot--current'; dotIcon = String(lesson.order); rowClass = 'active'; }
    else if (!isLocked) { dotClass = 'sidebar-lesson__dot--locked'; dotIcon = String(lesson.order); rowClass = ''; }

    const requirements = LessonContent.requirements(lesson);
    const substeps = [];
    if (requirements.hasPdf) {
      const pdfClass = lp?.pdfRead
        ? 'substep-dot--done'
        : (isActive && !isLocked ? 'substep-dot--current' : 'substep-dot--locked');
      substeps.push(`<div class="substep-dot ${pdfClass}" title="Apostila"></div>`);
    }
    if (requirements.hasVideo) {
      const videoAvailable = !requirements.hasPdf || lp?.pdfRead;
      const videoClass = lp?.videoCompleted
        ? 'substep-dot--done'
        : (isActive && videoAvailable && !isLocked ? 'substep-dot--current' : 'substep-dot--locked');
      substeps.push(`<div class="substep-dot ${videoClass}" title="Vídeo"></div>`);
    }
    const finalAvailable = (!requirements.hasPdf || lp?.pdfRead)
      && (!requirements.hasVideo || lp?.videoCompleted);
    const finalDone = requirements.hasQuiz ? lp?.quizStatus === 'passed' : lp?.lessonCompleted;
    const finalClass = finalDone
      ? 'substep-dot--done'
      : (isActive && finalAvailable && !isLocked ? 'substep-dot--current' : 'substep-dot--locked');
    substeps.push(`<div class="substep-dot ${finalClass}" title="${requirements.hasQuiz ? 'Teste' : 'Conclusão'}"></div>`);

    const clickHandler = (!isLocked && !isActive)
      ? `Router.navigate('lesson',{courseId:'${Safe.id(AppState.currentCourseId)}',lessonId:'${Safe.id(lesson.id)}'})`
      : '';

    return `
      <button type="button" class="sidebar-lesson ${rowClass}" ${clickHandler ? `onclick="${clickHandler}"` : ''} ${isLocked ? 'disabled' : ''} ${isActive ? 'aria-current="step"' : ''} title="${Safe.html(lesson.title)}">
        <div class="sidebar-lesson__dot ${dotClass}">${dotIcon}</div>
        <div class="sidebar-lesson__title">${Safe.html(lesson.title.replace('Lição ' + lesson.order + ' — ', ''))}</div>
        <div class="sidebar-lesson__substeps">${substeps.join('')}</div>
      </button>
    `;
  }).join('');
}

function renderLessonMain(courseId, lesson, lp) {
  const header = document.getElementById('lesson-main-header');
  header.innerHTML = `
    <nav class="lesson-main__breadcrumb" aria-label="Caminho da lição">
      <button type="button" onclick="Router.navigate('dashboard')">Meu painel</button>
      <span>›</span>
      <span>${Safe.html(COURSES_DATA.find(course => course.id === courseId)?.title || 'Curso')}</span>
      <span>›</span>
      <span aria-current="page">${Safe.html(lesson.title)}</span>
    </nav>
    <h1 class="lesson-main__title">${Safe.html(lesson.title)}</h1>
    ${lesson.description ? `<p class="lesson-main__description">${Safe.html(lesson.description)}</p>` : ''}
  `;
}

function renderStepContent(courseId, lesson, lp, step) {
  VideoTracking.stop({ flush: true });
  const requirements = LessonContent.requirements(lesson);
  const availableSteps = [
    ...(requirements.hasPdf ? ['pdf'] : []),
    ...(requirements.hasVideo ? ['video'] : []),
    'quiz',
  ];
  let effectiveStep = availableSteps.includes(step)
    ? step
    : LessonContent.firstPendingStep(lesson, lp);

  const stepAvailable = current => {
    if (current === 'pdf') return requirements.hasPdf;
    if (current === 'video') return requirements.hasVideo && (!requirements.hasPdf || lp.pdfRead);
    return (!requirements.hasPdf || lp.pdfRead)
      && (!requirements.hasVideo || lp.videoCompleted);
  };
  if (!stepAvailable(effectiveStep)) effectiveStep = LessonContent.firstPendingStep(lesson, lp);
  AppState.currentStep = effectiveStep;

  const tabs = document.querySelectorAll('.step-tab');
  tabs.forEach(tab => {
    const tabStep = tab.dataset.step;
    const present = tabStep === 'pdf'
      ? requirements.hasPdf
      : tabStep === 'video'
        ? requirements.hasVideo
        : true;
    tab.hidden = !present;
    if (tabStep === 'quiz') {
      const label = tab.querySelector('span:first-child');
      if (label) label.textContent = requirements.hasQuiz ? 'Teste' : 'Concluir';
    }
    tab.classList.remove('active', 'done', 'locked');
    if (!present) {
      tab.disabled = true;
      tab.tabIndex = -1;
      return;
    }

    const available = stepAvailable(tabStep);
    const done = tabStep === 'pdf'
      ? lp.pdfRead
      : tabStep === 'video'
        ? lp.videoCompleted
        : requirements.hasQuiz
          ? lp.quizStatus === 'passed'
          : lp.lessonCompleted;
    if (done) {
      tab.querySelector('.step-tab__check').textContent = '✓';
      tab.classList.add('done');
    } else {
      tab.querySelector('.step-tab__check').textContent = '';
    }

    const selected = tabStep === effectiveStep;
    if (selected) tab.classList.add('active');
    if (!available) tab.classList.add('locked');
    tab.setAttribute('aria-selected', String(selected));
    tab.setAttribute('aria-disabled', String(!available));
    tab.tabIndex = selected ? 0 : -1;
    tab.disabled = !available;

    tab.onclick = () => {
      if (!available) {
        Toast.show('Complete a etapa anterior primeiro.', 'error');
        return;
      }
      renderStepContent(courseId, lesson, lp, tabStep);
    };

    tab.onkeydown = event => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const enabledTabs = [...tabs].filter(item => !item.hidden && !item.disabled);
      const currentIndex = enabledTabs.indexOf(tab);
      let target = null;
      if (event.key === 'Home') target = enabledTabs[0];
      else if (event.key === 'End') target = enabledTabs.at(-1);
      else {
        const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
        target = enabledTabs[(currentIndex + direction + enabledTabs.length) % enabledTabs.length];
      }
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.click();
    };
  });

  document.querySelectorAll('.step-content').forEach(el => {
    const active = el.id === `step-${effectiveStep}`;
    el.classList.toggle('active', active);
    el.hidden = !active;
  });

  if (effectiveStep === 'pdf') renderPdfStep(courseId, lesson, lp);
  else if (effectiveStep === 'video') renderVideoStep(courseId, lesson, lp);
  else renderQuizStep(courseId, lesson, lp);
}

function renderPdfStep(courseId, lesson, lp) {
  const container = document.getElementById('step-pdf');
  const pdfUrl = Safe.mediaUrl(lesson.pdfUrl);
  const nextStep = LessonContent.nextStep(lesson, 'pdf');
  const nextLabel = nextStep === 'video' ? 'Ir para o vídeo →' : 'Continuar →';

  // PDF toolbar
  const pdfViewerHtml = `
    <div class="pdf-viewer">
      <div class="pdf-viewer__toolbar">
        <span class="pdf-viewer__title">PDF · ${Safe.html(lesson.pdfTitle || lesson.title)}</span>
        <div class="pdf-viewer__actions">
          <a href="${Safe.html(pdfUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn--ghost btn--sm">Abrir em nova aba</a>
          <a href="${Safe.html(pdfUrl)}" download class="btn btn--outline btn--sm">Baixar</a>
        </div>
      </div>
      <iframe
        class="pdf-viewer__embed"
        src="${Safe.html(pdfUrl)}#view=FitH"
        title="Apostila ${Safe.html(lesson.title)}"
      ></iframe>
    </div>
  `;

  let actionBarHtml;
  if (lp.pdfRead && !(lp.quizStatus === 'exhausted' && !lp.reReadAfterExhaustion)) {
    actionBarHtml = `
      <div class="pdf-action-bar">
        <div class="pdf-action-bar__info">
          <span class="badge badge--green">✓ Apostila concluída</span>
          <div style="margin-top:8px;font-size:13px;">Você já marcou esta apostila como lida. Continue para a próxima etapa disponível.</div>
        </div>
        <button class="btn btn--primary" onclick="switchToStep('${courseId}', '${lesson.id}', '${nextStep}')">
          ${nextLabel}
        </button>
      </div>
    `;
  } else if (lp.quizStatus === 'exhausted' && !lp.reReadAfterExhaustion) {
    actionBarHtml = `
      <div class="pdf-action-bar" style="border-color:rgba(191,83,26,0.4);background:rgba(191,83,26,0.06);">
        <div class="pdf-action-bar__info">
          <div style="font-size:13px;color:var(--color-orange);font-weight:600;margin-bottom:4px;">Suas tentativas foram esgotadas</div>
          <div style="font-size:13px;opacity:0.7;">Revise os materiais disponíveis e tente novamente.</div>
        </div>
        <button class="btn btn--outline-orange" onclick="handleMarkPdfRead('${courseId}', '${lesson.id}')">
          ✓ Já reli a apostila
        </button>
      </div>
    `;
  } else {
    actionBarHtml = `
      <div class="pdf-action-bar">
        <div class="pdf-action-bar__info">
          Leia a apostila na íntegra antes de avançar para o vídeo da aula.
        </div>
        <button class="btn btn--primary" onclick="handleMarkPdfRead('${courseId}', '${lesson.id}')">
          ✓ Já li a apostila
        </button>
      </div>
    `;
  }

  container.innerHTML = pdfViewerHtml + actionBarHtml;
}

function renderVideoStep(courseId, lesson, lp) {
  const container = document.getElementById('step-video');
  const requirements = LessonContent.requirements(lesson);
  const finalLabel = requirements.hasQuiz ? 'Ir para o teste →' : 'Concluir lição →';

  if (requirements.hasPdf && !lp.pdfRead) {
    container.innerHTML = `
      <div class="video-wrapper" style="position:relative;padding-bottom:56.25%;height:0;background:#000;border-radius:20px;overflow:hidden;">
        <div class="video-locked-overlay">
          <div class="video-locked-overlay__icon" aria-hidden="true">02</div>
          <div class="video-locked-overlay__text">Leia a apostila desta lição e marque como concluída para liberar o vídeo.</div>
          <button class="btn btn--outline" onclick="switchToStep('${courseId}', '${lesson.id}', 'pdf')">Ir para a apostila</button>
        </div>
      </div>
    `;
    return;
  }

  let actionBarHtml;
  if (lp.videoCompleted && !(lp.quizStatus === 'exhausted' && !lp.reWatchedAfterExhaustion)) {
    actionBarHtml = `
      <div class="video-action-bar">
        <div>
          <span class="badge badge--green">✓ Vídeo concluído</span>
          <div style="margin-top:8px;font-size:13px;opacity:0.6;">Continue para a etapa final da lição.</div>
        </div>
        <button class="btn btn--primary" onclick="switchToStep('${courseId}', '${lesson.id}', 'quiz')">
          ${finalLabel}
        </button>
      </div>
    `;
  } else {
    const rewatch = lp.quizStatus === 'exhausted' && !lp.reWatchedAfterExhaustion;
    actionBarHtml = `
      <div class="video-action-bar video-action-bar--tracking">
        <div class="video-tracking-status" data-video-tracking-status>
          <div class="video-tracking-status__header">
            <div>
              <strong>${rewatch ? 'Progresso da revisão' : 'Progresso do vídeo'}</strong>
              <span data-video-resume hidden></span>
            </div>
            <b data-video-progress-label>0%</b>
          </div>
          <div class="video-tracking-progress" role="progressbar" aria-label="Progresso assistido do vídeo" aria-valuemin="0" aria-valuemax="100">
            <span data-video-progress-bar></span>
          </div>
          <p data-video-tracking-message>${rewatch
            ? 'Reassista ao conteúdo. A revisão será confirmada automaticamente.'
            : 'O avanço será registrado automaticamente enquanto o vídeo estiver reproduzindo.'}</p>
          <details class="video-manual-fallback" data-video-manual-fallback>
            <summary>Problemas com a detecção automática?</summary>
            <div>
              <p>Use a confirmação manual somente quando o player ou a conexão não registrar o vídeo corretamente.</p>
              <button class="btn btn--outline-orange" onclick="handleMarkVideoCompleted('${courseId}', '${lesson.id}')">
                ${rewatch ? 'Marcar revisão manualmente' : 'Marcar vídeo como assistido'}
              </button>
            </div>
          </details>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="video-wrapper">
      ${VideoProvider.getEmbedHtml(lesson)}
    </div>
    ${actionBarHtml}
  `;

  if (VideoTracking.shouldTrack(lp)) {
    requestAnimationFrame(() => VideoTracking.start(courseId, lesson, lp));
  }
}
function renderLessonCompletionStep(courseId, lesson, lp) {
  const container = document.getElementById('step-quiz');
  const course = COURSES_DATA.find(item => item.id === courseId);
  const allLessons = course?.modules.flatMap(module => module.lessons) || [];
  const currentIndex = allLessons.findIndex(item => item.id === lesson.id);
  const nextLesson = allLessons[currentIndex + 1] || null;

  if (lp.lessonCompleted) {
    container.innerHTML = `
      <div class="module-complete">
        <div class="module-complete__icon">✓</div>
        <div class="module-complete__title">Lição concluída</div>
        <div class="module-complete__desc">Seu progresso foi salvo. ${nextLesson ? 'A próxima lição já está disponível.' : 'Você concluiu todas as lições deste curso.'}</div>
        <div class="module-complete__actions">
          ${nextLesson
            ? `<button class="btn btn--primary btn--lg" onclick="Router.navigate('lesson',{courseId:'${Safe.id(courseId)}',lessonId:'${Safe.id(nextLesson.id)}'})">Ir para a próxima lição →</button>`
            : '<button class="btn btn--primary btn--lg" onclick="Router.navigate(\'dashboard\')">Ver meu progresso</button>'}
        </div>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="quiz-start-state">
      <div class="quiz-start-state__icon">✓</div>
      <div class="quiz-start-state__title">Concluir esta lição</div>
      <div class="quiz-start-state__desc">
        ${lesson.description ? Safe.html(lesson.description) : 'Confirme a conclusão para registrar seu avanço no curso.'}
      </div>
      <button class="btn btn--primary btn--lg" onclick="handleCompleteLesson('${Safe.id(courseId)}', '${Safe.id(lesson.id)}')">
        Marcar lição como concluída
      </button>
    </div>
  `;
}

function renderQuizStep(courseId, lesson, lp) {
  const requirements = LessonContent.requirements(lesson);
  if (!requirements.hasQuiz) {
    renderLessonCompletionStep(courseId, lesson, lp);
    return;
  }
  const container = document.getElementById('step-quiz');
  const quizConfig = CourseRules.getQuizConfig(courseId, lesson.id);

  const attemptsRemaining = quizConfig.maxAttempts - lp.quizAttemptsUsed;

  // Quiz header (always visible)
  const headerHtml = `
    <div class="quiz-header">
      <div class="quiz-header__title">Teste · ${Safe.html(lesson.title.replace(/^Lição \d+ — /, ''))}</div>
      <div class="quiz-header__meta">
        <span class="badge badge--gray">${quizConfig.questionsPerLesson} perguntas</span>
        <span class="badge badge--petrol">Nota mínima: ${quizConfig.passingScore}/${quizConfig.questionsPerLesson}</span>
        ${lp.quizStatus !== 'passed' ? `<span class="badge ${attemptsRemaining > 1 ? 'badge--orange' : 'badge--red'}">${attemptsRemaining} tentativa${attemptsRemaining > 1 ? 's' : ''} restante${attemptsRemaining > 1 ? 's' : ''}</span>` : ''}
      </div>
    </div>
  `;

  // Locked: video not watched
  if (!lp.videoCompleted) {
    container.innerHTML = headerHtml + `
      <div class="quiz-locked-state">
        <div class="quiz-locked-state__icon">🔒</div>
        <div class="quiz-locked-state__title">Teste bloqueado</div>
        <div class="quiz-locked-state__desc">Assista ao vídeo desta lição e marque como concluído para liberar o teste.</div>
        <button class="btn btn--outline" onclick="switchToStep('${courseId}', '${lesson.id}', 'video')">Ir para o vídeo</button>
      </div>
    `;
    return;
  }

  // Passed
  if (lp.quizStatus === 'passed') {
    const course = COURSES_DATA.find(c => c.id === courseId);
    const allLessons = course.modules.flatMap(m => m.lessons);
    const isLastLesson = allLessons[allLessons.length - 1].id === lesson.id;

    if (isLastLesson) {
      container.innerHTML = headerHtml + `
        <div class="module-complete">
          <div class="module-complete__icon">🏆</div>
          <div class="module-complete__title">Módulo Concluído!</div>
          <div class="module-complete__desc">Parabéns! Você completou o Módulo 1 da Jornada Lidere. Seu crescimento como líder começou.</div>
          <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
            <button class="btn btn--primary btn--lg" onclick="Router.navigate('dashboard')">Ver meu progresso</button>
          </div>
        </div>
      `;
    } else {
      const nextLesson = allLessons[allLessons.findIndex(l => l.id === lesson.id) + 1];
      container.innerHTML = headerHtml + `
        <div class="lesson-complete">
          <div class="lesson-complete__icon">🎉</div>
          <div class="lesson-complete__title">Lição concluída!</div>
          <div class="lesson-complete__desc">Você acertou ${lp.quizScore} de ${quizConfig.questionsPerLesson} e avançou para a próxima lição.</div>
          <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
            <button class="btn btn--primary btn--lg" onclick="Router.navigate('lesson',{courseId:'${Safe.id(courseId)}',lessonId:'${Safe.id(nextLesson.id)}'})">
              Ir para ${Safe.html(nextLesson.title.replace(/^Lição \d+ — /, ''))} →
            </button>
            <button class="btn btn--outline" onclick="Router.navigate('dashboard')">Painel do aluno</button>
          </div>
        </div>
      `;
    }
    return;
  }

  // Exhausted: need to re-read & re-watch
  if (lp.quizStatus === 'exhausted') {
    const needRead = !lp.reReadAfterExhaustion;
    const needWatch = !lp.reWatchedAfterExhaustion;
    container.innerHTML = headerHtml + `
      <div class="quiz-locked-state" style="border-color:rgba(191,83,26,0.3);">
        <div class="quiz-locked-state__icon">⏸️</div>
        <div class="quiz-locked-state__title">Tentativas esgotadas por enquanto</div>
        <div class="quiz-locked-state__desc">
          Não se preocupe! Para liberar mais tentativas, volte e revise o material:
          ${needRead ? '<br>📄 Releia a apostila e marque como lida' : '<br>📄 ✓ Apostila relida'}
          ${needWatch ? '<br>▶️ Reassista o vídeo completo e marque como concluído' : '<br>▶️ ✓ Vídeo reassistido'}
          <br><br>Depois de completar os dois, você terá mais ${quizConfig.maxAttempts} tentativa${quizConfig.maxAttempts > 1 ? 's' : ''}.
        </div>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          ${needRead ? `<button class="btn btn--outline-orange" onclick="switchToStep('${courseId}', '${lesson.id}', 'pdf')">Reler apostila</button>` : ''}
          ${needWatch ? `<button class="btn btn--outline-orange" onclick="switchToStep('${courseId}', '${lesson.id}', 'video')">Reassistir vídeo</button>` : ''}
        </div>
      </div>
    `;
    return;
  }

  // Quiz not started yet, or can retry
  if (!AppState.quizState.isActive) {
    container.innerHTML = headerHtml + `
      <div class="quiz-start-state">
        <div class="quiz-start-state__icon">📝</div>
        <div class="quiz-start-state__title">${lp.quizAttemptsUsed > 0 ? 'Tentar novamente' : 'Pronto para o teste?'}</div>
        <div class="quiz-start-state__desc">
          ${lp.quizAttemptsUsed > 0
            ? `Você tentou ${lp.quizAttemptsUsed} vez${lp.quizAttemptsUsed > 1 ? 'es' : ''}. Restam ${attemptsRemaining} tentativa${attemptsRemaining > 1 ? 's' : ''}.`
            : `${quizConfig.questionsPerLesson} perguntas de múltipla escolha. Você precisa acertar ${quizConfig.passingScore} para avançar. Você tem ${quizConfig.maxAttempts} tentativa${quizConfig.maxAttempts > 1 ? 's' : ''}.`
          }
        </div>
        <button class="btn btn--primary btn--lg" onclick="startQuiz('${courseId}', '${lesson.id}')">
          ${lp.quizAttemptsUsed > 0 ? 'Tentar novamente' : 'Iniciar teste'}
        </button>
      </div>
    `;
    return;
  }

  // Quiz is active — render questions
  renderActiveQuiz(courseId, lesson);
}

function renderActiveQuiz(courseId, lesson) {
  const container = document.getElementById('step-quiz');
  const { questions, selectedAnswers, submitted } = AppState.quizState;
  const lp = Progress.getLessonProgress(AppState.currentUser.id, courseId, lesson.id);
  const quizConfig = CourseRules.getQuizConfig(courseId, lesson.id);
  const attemptsRemaining = quizConfig.maxAttempts - lp.quizAttemptsUsed;

  const headerHtml = `
    <div class="quiz-header">
      <div class="quiz-header__title">📝 Teste — ${Safe.html(lesson.title.replace(/^Lição \d+ — /, ''))}</div>
      <div class="quiz-header__meta">
        <span class="badge badge--gray">${quizConfig.questionsPerLesson} perguntas</span>
        <span class="badge badge--petrol">Nota mínima: ${quizConfig.passingScore}/${quizConfig.questionsPerLesson}</span>
        <span class="badge ${attemptsRemaining > 1 ? 'badge--orange' : 'badge--red'}">${attemptsRemaining} tentativa${attemptsRemaining > 1 ? 's' : ''} restante${attemptsRemaining > 1 ? 's' : ''}</span>
      </div>
    </div>
  `;

  if (submitted) {
    const score = Number(AppState.quizState.score || 0);
    const results = AppState.quizState.results || {};
    const passed = AppState.quizState.passed === true;

    // Build results display
    const questionsHtml = questions.map((q, idx) => {
      const result = results[q.id] || {
        chosen: selectedAnswers[q.id],
        isCorrect: false,
        correctOptionId: null,
      };
      return `
        <div class="question-card">
          <div class="question-card__header">
            <div class="question-card__num">Q${idx + 1}</div>
            <div class="question-card__text" id="result-question-${Safe.id(q.id)}">${Safe.html(q.question)}</div>
          </div>
          <div class="question-card__options" role="radiogroup" aria-labelledby="result-question-${Safe.id(q.id)}">
            ${q.options.map((opt, optionIndex) => {
              let cls = '';
              if (opt.id === result.correctOptionId) cls = 'correct-answer';
              if (opt.id === result.chosen && !result.isCorrect) cls = 'incorrect';
              if (opt.id === result.chosen && result.isCorrect) cls = 'correct';
              return `
                <button class="option-btn ${cls}" type="button" role="radio" aria-checked="${opt.id === result.chosen}" disabled>
                  <span class="option-label">${String.fromCharCode(65 + optionIndex)}</span>
                  <span class="option-text">${Safe.html(opt.text)}</span>
                  ${opt.id === result.correctOptionId ? '<span style="margin-left:auto;font-size:12px;color:#4CAF74;">✓ correta</span>' : ''}
                  ${opt.id === result.chosen && !result.isCorrect ? '<span style="margin-left:auto;font-size:12px;color:#E74C3C;">✕ sua resposta</span>' : ''}
                </button>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');

    // Get updated lp after recording attempt
    const updatedLp = Progress.getLessonProgress(AppState.currentUser.id, courseId, lesson.id);
    const attemptsLeft = quizConfig.maxAttempts - (updatedLp?.quizAttemptsUsed || 0);
    const showAnswerReview = passed || updatedLp?.quizStatus === 'exhausted';
    const answerReviewHtml = showAnswerReview
      ? `
        <div style="margin-top:24px;">
          <div style="font-size:13px;font-weight:600;color:rgba(245,231,215,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:16px;">Revisão das respostas</div>
          ${questionsHtml}
        </div>
      `
      : `
        <div class="quiz-review-note" role="note">
          O gabarito será exibido após a aprovação ou ao final desta rodada de tentativas.
        </div>
      `;

    let resultActions = '';
    if (passed) {
      resultActions = `<button class="btn btn--primary btn--lg" onclick="AppState.quizState.isActive=false;renderLesson('${courseId}','${lesson.id}')">Ver próxima etapa →</button>`;
    } else if (updatedLp?.quizStatus === 'exhausted') {
      resultActions = `<button class="btn btn--outline-orange" onclick="AppState.quizState.isActive=false;renderLesson('${courseId}','${lesson.id}')">Revisar material</button>`;
    } else {
      resultActions = `
        <button class="btn btn--primary" onclick="startQuiz('${courseId}','${lesson.id}')">Tentar novamente (${attemptsLeft} restante${attemptsLeft > 1 ? 's' : ''})</button>
        <button class="btn btn--outline" onclick="AppState.quizState.isActive=false;renderLesson('${courseId}','${lesson.id}')">Cancelar</button>
      `;
    }

    container.innerHTML = headerHtml + `
      <div class="quiz-result">
        <div class="quiz-result__score quiz-result__score--${passed ? 'pass' : 'fail'}">${score}/${questions.length}</div>
        <div class="quiz-result__label">${passed ? 'Aprovado' : 'Ainda não foi desta vez'}</div>
        <div class="quiz-result__desc">
          ${passed
            ? 'Excelente! Você demonstrou domínio do conteúdo e pode avançar para a próxima lição.'
            : `Você acertou ${score} de ${questions.length}. A nota mínima é ${quizConfig.passingScore}. ${updatedLp?.quizStatus === 'exhausted' ? 'Você esgotou suas tentativas. Revise o material e tente novamente.' : `Tente mais uma vez!`}`
          }
        </div>
        <div class="quiz-result__actions">${resultActions}</div>
      </div>
      ${answerReviewHtml}
    `;
    return;
  }

  // Active: render questions for answering
  const questionsHtml = questions.map((q, idx) => `
    <div class="question-card" id="question-${Safe.id(q.id)}">
      <div class="question-card__header">
        <div class="question-card__num">Q${idx + 1}</div>
        <div class="question-card__text" id="question-label-${Safe.id(q.id)}">${Safe.html(q.question)}</div>
      </div>
      <div class="question-card__options" role="radiogroup" aria-labelledby="question-label-${Safe.id(q.id)}">
        ${q.options.map((opt, optionIndex) => `
          <button
            type="button"
            role="radio"
            aria-checked="${selectedAnswers[q.id] === opt.id}"
            class="option-btn ${selectedAnswers[q.id] === opt.id ? 'selected' : ''}"
            data-question-id="${Safe.id(q.id)}"
            data-option-id="${Safe.id(opt.id)}"
            onclick="selectAnswer('${Safe.id(q.id)}', '${Safe.id(opt.id)}', '${Safe.id(courseId)}', '${Safe.id(lesson.id)}')"
          >
            <span class="option-label">${String.fromCharCode(65 + optionIndex)}</span>
            <span class="option-text">${Safe.html(opt.text)}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `).join('');

  const answeredCount = Object.keys(selectedAnswers).length;
  const allAnswered = answeredCount === questions.length;

  container.innerHTML = headerHtml + `
    <div class="quiz-questions">${questionsHtml}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;padding:20px;background:var(--color-black-mid);border:1px solid var(--color-cream-border);border-radius:20px;">
      <div style="font-size:13px;color:rgba(245,231,215,0.5);">
        ${answeredCount} de ${questions.length} respostas selecionadas
      </div>
      <div style="display:flex;gap:12px;align-items:center;">
        <button class="btn btn--ghost" onclick="AppState.quizState.isActive=false;renderLesson('${courseId}','${lesson.id}')">Cancelar</button>
        <button
          class="btn btn--primary ${!allAnswered ? '' : ''}"
          onclick="${allAnswered ? `submitQuiz('${courseId}', '${lesson.id}')` : `Toast.show('Responda todas as ${questions.length} perguntas antes de enviar.','error')`}"
          ${!allAnswered ? '' : ''}
          title="${!allAnswered ? 'Responda todas as perguntas' : ''}"
        >
          Enviar respostas ${allAnswered ? '' : `(${questions.length - answeredCount} pendentes)`}
        </button>
      </div>
    </div>
  `;
}

// ============================================================
// SECTION 12: QUIZ EVENT HANDLERS
// ============================================================
window.startQuiz = function(courseId, lessonId) {
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course?.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  const lp = Progress.getLessonProgress(AppState.currentUser.id, courseId, lessonId);
  const quizConfig = CourseRules.getQuizConfig(courseId, lessonId);

  if (!course || !lesson || !lp?.unlocked || !lp.pdfRead || !lp.videoCompleted) {
    Toast.show('Complete o vídeo antes de iniciar o teste.', 'error');
    return;
  }

  if (!['available', 'failed'].includes(lp.quizStatus) || lp.quizAttemptsUsed >= quizConfig.maxAttempts) {
    Toast.show('Revise o material antes de iniciar uma nova rodada de tentativas.', 'error');
    return;
  }

  const preparedQuestions = Quiz.prepareQuestions(lesson.quiz, quizConfig);
  AppState.quizState = {
    isActive: true,
    questions: preparedQuestions,
    selectedAnswers: {},
    submitted: false,
    submitting: false,
    score: null,
    passed: false,
    results: {},
    attemptKey: null,
  };

  renderActiveQuiz(courseId, lesson);
};

window.selectAnswer = function(questionId, optionId, courseId, lessonId) {
  if (AppState.quizState.submitted) return;
  AppState.quizState.selectedAnswers[questionId] = optionId;

  // Re-render just the question card options
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  renderActiveQuiz(courseId, lesson);
  document.querySelector(`[data-question-id="${questionId}"][data-option-id="${optionId}"]`)?.focus();
};

window.submitQuiz = async function(courseId, lessonId) {
  const { questions, selectedAnswers } = AppState.quizState;
  const quizConfig = CourseRules.getQuizConfig(courseId, lessonId);
  if (
    !AppState.quizState.isActive ||
    AppState.quizState.submitted ||
    AppState.quizState.submitting ||
    courseId !== AppState.currentCourseId ||
    lessonId !== AppState.currentLessonId ||
    !Array.isArray(questions) ||
    questions.length !== quizConfig.questionsPerLesson
  ) {
    Toast.show('Este teste não está disponível para envio.', 'error');
    return;
  }

  if (Object.keys(selectedAnswers).length < questions.length) {
    Toast.show('Responda todas as perguntas antes de enviar.', 'error');
    return;
  }

  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  AppState.quizState.submitting = true;
  const submitButton = document.querySelector('#step-quiz .quiz-questions + div .btn--primary');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = 'Corrigindo no servidor...';
  }

  try {
    let result;
    if (AppState.backendMode === 'api') {
      const userId = AppState.currentUser?.id;
      const synchronized = userId
        ? await BetaStudentSync.flushCourse(userId, courseId)
        : false;
      if (!synchronized) {
        throw new ClientApiError(
          'Ainda estamos salvando a conclusão do material. Verifique a conexão e tente novamente.',
          0,
        );
      }
      AppState.quizState.attemptKey ||= globalThis.crypto?.randomUUID?.()
        || `quiz-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      const payload = await ApiClient.request(
        `/api/me/quiz/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}/attempt`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': AppState.quizState.attemptKey },
          body: JSON.stringify({ answers: selectedAnswers }),
        },
      );
      BetaStudentSync.acceptServerProgress(userId, courseId, payload.progress);
      AppState.quizState.score = Number(payload.score || 0);
      AppState.quizState.passed = payload.passed === true;
      AppState.quizState.results = payload.results || {};
      result = {
        passed: payload.passed === true,
        attemptsUsed: Number(payload.attemptsUsed || 0),
        status: payload.status,
      };
    } else {
      const graded = Quiz.grade(questions, selectedAnswers);
      AppState.quizState.score = graded.score;
      AppState.quizState.passed = graded.score >= quizConfig.passingScore;
      AppState.quizState.results = graded.results;
      result = Progress.recordQuizAttempt(
        AppState.currentUser.id,
        courseId,
        lessonId,
        graded.score,
      );
      if (!result) {
        throw new ClientApiError(
          'Não foi possível registrar esta tentativa. Atualize a lição e tente novamente.',
          409,
        );
      }
    }

    AppState.quizState.submitted = true;
    if (result.passed) {
      Toast.show('🎉 Aprovado! Próxima lição desbloqueada.', 'success');
    } else if (result.status === 'exhausted') {
      Toast.show('Tentativas esgotadas. Revise o material e tente novamente.', 'error', 5000);
    } else {
      const remaining = quizConfig.maxAttempts - result.attemptsUsed;
      Toast.show(`Não aprovado. Você tem mais ${remaining} tentativa${remaining > 1 ? 's' : ''}.`, 'error');
    }
    renderActiveQuiz(courseId, lesson);
  } catch (error) {
    AppState.quizState.submitted = false;
    Toast.show(
      error.message || 'Não foi possível corrigir o teste. Suas respostas continuam selecionadas.',
      'error',
      5000,
    );
    renderActiveQuiz(courseId, lesson);
  } finally {
    AppState.quizState.submitting = false;
  }
};

window.switchToStep = function(courseId, lessonId, step) {
  const lp = Progress.getLessonProgress(AppState.currentUser.id, courseId, lessonId);
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  AppState.quizState.isActive = false;
  renderStepContent(courseId, lesson, lp, step);
};

window.handleMarkPdfRead = function(courseId, lessonId) {
  const p = Progress.markPdfRead(AppState.currentUser.id, courseId, lessonId);
  if (!p) return;
  const lp = p.lessons[lessonId];
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  const nextStep = LessonContent.nextStep(lesson, 'pdf');
  Toast.show('Apostila marcada como lida!', 'success');
  renderLessonSidebar(courseId, lessonId, course, p);
  renderStepContent(courseId, lesson, lp, nextStep);
};

window.handleMarkVideoCompleted = function(courseId, lessonId) {
  VideoTracking.stop({ flush: true });
  const p = Progress.markVideoCompleted(AppState.currentUser.id, courseId, lessonId);
  if (!p) return;
  const lp = p.lessons[lessonId];
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  Toast.show('Vídeo marcado como concluído!', 'success');
  renderLessonSidebar(courseId, lessonId, course, p);
  renderStepContent(courseId, lesson, lp, 'quiz');
};

window.handleCompleteLesson = function(courseId, lessonId) {
  const p = Progress.completeLesson(AppState.currentUser.id, courseId, lessonId);
  if (!p) {
    Toast.show('Conclua os materiais existentes antes de finalizar a lição.', 'error');
    return;
  }
  const lp = p.lessons[lessonId];
  const course = COURSES_DATA.find(c => c.id === courseId);
  const lesson = course.modules.flatMap(m => m.lessons).find(l => l.id === lessonId);
  Toast.show('Lição concluída! Progresso salvo.', 'success');
  renderLessonSidebar(courseId, lessonId, course, p);
  renderStepContent(courseId, lesson, lp, 'quiz');
};

// ============================================================
// SECTION 13: AUTH EVENT HANDLERS
// ============================================================
window.handleLogin = async function(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const resendLink = document.getElementById('login-resend-verification');
  errEl.textContent = '';
  resendLink.hidden = true;

  if (!email || !password) {
    errEl.textContent = 'Preencha todos os campos.';
    return;
  }

  const submitButton = e.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = 'Entrando...';
  const result = await Auth.login(email, password);
  submitButton.disabled = false;
  submitButton.textContent = 'Entrar';
  if (result.success) {
    Toast.show(`Bem-vindo, ${result.user.name.split(' ')[0]}!`, 'success');
    const enrollments = Storage.get(`enrollments_${result.user.id}`) || [];
    if (enrollments.length > 0) {
      Router.navigate('dashboard');
    } else {
      Router.navigate('catalog');
    }
  } else {
    errEl.textContent = result.error;
    if (result.code === 'email_not_verified') {
      AppState.pendingAuthEmail = Security.normalizeEmail(email);
      resendLink.hidden = false;
    }
  }
};

window.handleLoginResendVerification = async function() {
  if (!AppState.pendingAuthEmail) return;
  const result = await Auth.requestRegistration(AppState.pendingAuthEmail, { resend: true });
  if (result.success) Router.navigate('check-email');
  else document.getElementById('login-error').textContent = result.error;
};

window.handleRegister = async function(e) {
  e.preventDefault();
  const name = document.getElementById('register-name').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const birthDate = document.getElementById('register-birth-date').value;
  const password = document.getElementById('register-password').value;
  const confirmation = document.getElementById('register-password-confirm').value;
  const errEl = document.getElementById('register-error');
  const submitBtn = document.querySelector('#register-form button[type="submit"]');
  errEl.textContent = '';

  const verificationRequired = AppState.features.emailVerificationRequired === true;
  if (!email || (!verificationRequired && (!name || !birthDate || !password))) {
    errEl.textContent = verificationRequired
      ? 'Informe seu e-mail.'
      : 'Nome, data de nascimento, e-mail e senha são obrigatórios.';
    return;
  }
  if (!verificationRequired) {
    const birthDateValidation = validateBirthDate(birthDate);
    if (!birthDateValidation.valid) {
      errEl.textContent = birthDateValidation.error;
      return;
    }
  }
  if (!verificationRequired && password.length < 10) {
    errEl.textContent = 'A senha deve ter ao menos 10 caracteres.';
    return;
  }
  if (!verificationRequired && password !== confirmation) {
    errEl.textContent = 'As senhas não coincidem.';
    return;
  }
  submitBtn.textContent = verificationRequired ? 'Enviando...' : 'Criando conta...';
  submitBtn.disabled = true;
  const result = verificationRequired
    ? await Auth.requestRegistration(email)
    : await Auth.register(name, email, password, birthDate, null);
  submitBtn.textContent = verificationRequired ? 'Enviar link de confirmação' : 'Criar conta';
  submitBtn.disabled = false;
  if (result.success) {
    if (verificationRequired) {
      Router.navigate('check-email');
      return;
    }
    if (!AppState.currentUser) {
      await LocalAuth.login(email, password);
    }
    Toast.show('Conta criada com sucesso.', 'success');
    Router.navigate('catalog');
  } else {
    errEl.textContent = result.error;
  }
};

window.handleResendVerification = async function() {
  if (!AppState.pendingAuthEmail) {
    Router.navigate('register');
    return;
  }
  const button = document.getElementById('check-email-resend');
  const error = document.getElementById('check-email-error');
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Reenviando...';
  const result = await Auth.requestRegistration(AppState.pendingAuthEmail, { resend: true });
  button.disabled = false;
  button.textContent = 'Reenviar confirmação';
  if (!result.success) {
    error.textContent = result.error;
    return;
  }
  renderCheckEmail();
  Toast.show('Se o endereço estiver disponível, um novo link foi enviado.', 'success', 5000);
};

window.handleCompleteRegistration = async function(e) {
  e.preventDefault();
  const name = document.getElementById('complete-registration-name').value.trim();
  const birthDate = document.getElementById('complete-registration-birth-date').value;
  const password = document.getElementById('complete-registration-password').value;
  const confirmation = document.getElementById('complete-registration-password-confirm').value;
  const error = document.getElementById('complete-registration-error');
  const button = e.currentTarget.querySelector('button[type="submit"]');
  error.textContent = '';
  if (!AppState.authActionToken) {
    error.textContent = 'Abra novamente o link recebido por e-mail.';
    return;
  }
  if (name.length < 2) {
    error.textContent = 'Informe seu nome completo.';
    return;
  }
  const birthDateValidation = validateBirthDate(birthDate);
  if (!birthDateValidation.valid) {
    error.textContent = birthDateValidation.error;
    return;
  }
  if (password.length < 10) {
    error.textContent = 'A senha deve ter ao menos 10 caracteres.';
    return;
  }
  if (password !== confirmation) {
    error.textContent = 'As senhas não coincidem.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Ativando conta...';
  const result = await Auth.completeRegistration(AppState.authActionToken, name, birthDate, password);
  button.disabled = false;
  button.textContent = 'Ativar minha conta';
  if (!result.success) {
    error.textContent = result.error;
    return;
  }
  Toast.show('E-mail confirmado e conta criada com segurança.', 'success', 5000);
  Router.navigate(hasAdminAccess(result.user) ? 'admin' : 'catalog');
};

window.handleForgotPassword = async function(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-password-email').value.trim();
  const error = document.getElementById('forgot-password-error');
  const button = e.currentTarget.querySelector('button[type="submit"]');
  error.textContent = '';
  if (!email) {
    error.textContent = 'Informe seu e-mail.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Enviando...';
  const result = await Auth.forgotPassword(email);
  button.disabled = false;
  button.textContent = 'Enviar link de recuperação';
  if (!result.success) {
    error.textContent = result.error;
    return;
  }
  document.getElementById('forgot-password-form').hidden = true;
  document.getElementById('forgot-password-success').hidden = false;
  const preview = document.getElementById('forgot-password-preview');
  preview.hidden = !result.previewUrl;
  preview.href = result.previewUrl || '#';
};

window.handleResetPassword = async function(e) {
  e.preventDefault();
  const password = document.getElementById('reset-password-value').value;
  const confirmation = document.getElementById('reset-password-confirm').value;
  const error = document.getElementById('reset-password-error');
  const button = e.currentTarget.querySelector('button[type="submit"]');
  error.textContent = '';
  if (!AppState.authActionToken) {
    error.textContent = 'Abra novamente o link recebido por e-mail.';
    return;
  }
  if (password.length < 10) {
    error.textContent = 'A senha deve ter ao menos 10 caracteres.';
    return;
  }
  if (password !== confirmation) {
    error.textContent = 'As senhas não coincidem.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Alterando senha...';
  const result = await Auth.resetPassword(AppState.authActionToken, password);
  button.disabled = false;
  button.textContent = 'Salvar nova senha';
  if (!result.success) {
    error.textContent = result.error;
    return;
  }
  Toast.show(result.message || 'Senha alterada com sucesso.', 'success', 5000);
  Router.navigate('login');
};

window.enterDemoMode = async function() {
  if (AppState.backendMode === 'api') {
    try {
      const payload = await ApiClient.request('/api/auth/demo', {
        method: 'POST',
        body: '{}',
      });
      BetaStudentSync.reset();
      AppState.currentUser = payload.user;
      AppState.features = { ...AppState.features, ...(payload.features || {}) };
      await hydrateAuthenticatedState();
      applyRuntimeFeatures();
      Toast.show('Ambiente de demonstração iniciado.', 'success');
      Router.navigate('dashboard');
    } catch (error) {
      Toast.show(error.message || 'A demonstração não está habilitada neste ambiente.', 'error');
    }
    return;
  }

  const email = 'demo@beta.local';
  const users = Storage.get('users') || {};
  const user = users[email] || {
    id: 'user_demo',
    name: 'Aluno Demo',
    email,
    memberCode: null,
    memberCodeValidated: false,
    role: 'admin',
    isDemo: true,
    createdAt: new Date().toISOString(),
  };
  user.role = 'admin';
  users[email] = user;
  Storage.set('users', users);
  Storage.set('currentUserId', user.id);
  AppState.currentUser = user;
  AppState.backendMode = 'local';
  const featuredCourse = COURSES_DATA.find(course => course.featured) || COURSES_DATA[0];
  if (featuredCourse) Enrollment.enroll(user.id, featuredCourse.id);
  Toast.show('Demonstração liberada. Explore o curso e a administração.', 'success', 4500);
  Router.navigate('dashboard');
};

// ============================================================
// SECTION 14: CHECKOUT HANDLERS
// ============================================================
window.applyCoupon = async function() {
  const couponInput = document.getElementById('coupon-input');
  const code = couponInput.value.trim().toUpperCase();
  const btnEl = document.getElementById('coupon-btn');
  const msgEl = document.getElementById('coupon-message');

  if (!code) return;

  btnEl.textContent = 'Verificando...';
  btnEl.disabled = true;
  if (AppState.backendMode === 'local') await new Promise(r => setTimeout(r, 350));
  btnEl.textContent = 'Validar código';
  btnEl.disabled = false;
  if (AppState.backendMode === 'api') {
    AppState.checkout.couponCode = code;
    AppState.checkout.couponValue = 0;
    msgEl.textContent = 'O código será validado pelo servidor ao confirmar a inscrição.';
    msgEl.style.color = '';
    updateCheckoutPricing(0);
    return;
  }
  AppState.checkout.couponCode = null;
  AppState.checkout.couponValue = 0;
  msgEl.textContent = 'Nenhum código promocional está ativo para este curso.';
  msgEl.style.color = '';
  updateCheckoutPricing(0);
};

window.resetCouponIfChanged = function() {
  const input = document.getElementById('coupon-input');
  if (input.value.trim().toUpperCase() === AppState.checkout.couponCode) return;
  AppState.checkout.couponCode = null;
  AppState.checkout.couponValue = 0;
  document.getElementById('coupon-message').textContent = '';
  updateCheckoutPricing(0);
};

window.selectPaymentMethod = function(method) {
  AppState.checkout.paymentMethod = method;
  document.querySelectorAll('.payment-method-btn').forEach(btn => {
    const active = btn.dataset.method === method;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
};

window.handleCheckoutSubmit = async function() {
  const btn = document.getElementById('checkout-submit-btn');
  const course = COURSES_DATA.find(item => item.id === AppState.currentCourseId);
  if (CourseAccess.decision(course).allowed === false) {
    Toast.show(CourseAccess.requirementText(course), 'info', 5500);
    Router.navigate('course', { courseId: AppState.currentCourseId });
    return;
  }
  if (AppState.features.paymentsMode === 'disabled') {
    Toast.show('As inscrições ainda não estão abertas.', 'info');
    configureCheckoutAvailability();
    return;
  }
  btn.textContent = 'Preparando pagamento...';
  btn.disabled = true;

  try {
    const result = await Enrollment.createMercadoPagoCheckout({
      courseId: AppState.currentCourseId,
      couponCode: AppState.checkout.couponCode,
      paymentMethod: AppState.checkout.paymentMethod,
      idempotencyKey: AppState.checkout.idempotencyKey,
    });

    if (result.success) {
      Enrollment.enroll(AppState.currentUser.id, AppState.currentCourseId);
      await window.BetaCatalog?.hydrate?.({ allowEmpty: true });
      Toast.show(
        result.testMode
          ? 'Inscrição liberada no ambiente de testes.'
          : 'Inscrição confirmada com sucesso.',
        'success',
        4500,
      );
      Router.navigate('dashboard');
      return;
    }

    const checkoutUrl = result.checkout?.checkoutUrl;
    if (checkoutUrl) {
      window.location.assign(checkoutUrl);
      return;
    }

    if (result.status === 'pending' || result.status === 'creating') {
      Toast.show('O pagamento ainda está sendo preparado. Tente novamente em alguns segundos.', 'info');
      return;
    }

    throw new Error('Não foi possível iniciar o pagamento.');
  } catch (err) {
    AppState.checkout.idempotencyKey = createCheckoutAttemptKey();
    Toast.show(err.message || 'Não foi possível iniciar o pagamento.', 'error');
  } finally {
    if (document.body.contains(btn)) {
      btn.disabled = false;
      configureCheckoutAvailability();
    }
  }
};

async function handleMercadoPagoReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkoutId = params.get('checkout');
  if (!checkoutId) return false;

  const orderId = params.get('order_id') || '';
  const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
  window.history.replaceState(null, '', cleanUrl);

  if (!AppState.currentUser || AppState.backendMode !== 'api') {
    Toast.show('Entre na sua conta para confirmar o resultado do pagamento.', 'info', 5000);
    Router.navigate('login');
    return true;
  }

  try {
    const query = orderId
      ? `?order_id=${encodeURIComponent(orderId)}`
      : '';
    const result = await ApiClient.request(
      `/api/checkouts/${encodeURIComponent(checkoutId)}${query}`,
    );

    if (result.status === 'approved') {
      Enrollment.enroll(AppState.currentUser.id, result.checkout.courseId || AppState.currentCourseId);
      await window.BetaCatalog?.hydrate?.({ allowEmpty: true });
      await window.BetaStudentSync?.hydrate?.();
      Toast.show(
        result.testMode
          ? 'Pagamento de teste aprovado. Sua inscrição foi liberada.'
          : 'Pagamento aprovado. Sua inscrição foi liberada.',
        'success',
        5000,
      );
      Router.navigate('dashboard');
      return true;
    }

    if (result.status === 'pending') {
      Toast.show(
        'O pagamento está pendente. A inscrição será liberada automaticamente após a aprovação.',
        'info',
        6000,
      );
      Router.navigate('dashboard');
      return true;
    }

    Toast.show(
      'O pagamento não foi aprovado. Você pode tentar novamente.',
      'error',
      5000,
    );
    Router.navigate('dashboard');
    return true;
  } catch (error) {
    Toast.show(
      error.message || 'Não foi possível confirmar o pagamento agora.',
      'error',
      5000,
    );
    Router.navigate('dashboard');
    return true;
  }
}

// ============================================================
// SECTION 15: ADMIN DASHBOARD
// ============================================================
function renderAdmin() {
  const user = AppState.currentUser;
  if (!user) { Router.navigate('login'); return; }
  if (!hasAdminAccess(user)) { Router.navigate('dashboard'); return; }

  const root = document.getElementById('beta-admin-root');
  if (!root) return;

  if (!window.BetaAdmin?.mount) {
    root.innerHTML = '<div class="admin-loading"><h1>Administração indisponível</h1><p>Atualize a página para carregar novamente o painel.</p></div>';
    return;
  }

  window.BetaAdmin.mount(root);
}

function renderStudentTable(students) {
  const tbody = document.getElementById('students-tbody');
  const adminCourse = COURSES_DATA[0];
  const adminCourseId = adminCourse?.id;
  const lessonTotal = adminCourse?.modules.flatMap(module => module.lessons).length || 0;
  tbody.innerHTML = students.map(s => {
    const prog = s.progress[adminCourseId];
    const pct = prog?.percentage || 0;
    const completedCount = prog?.completedLessons || 0;
    const isBehind = completedCount < 2;

    return `
      <tr>
        <td>
          <div style="font-weight:600;color:var(--color-cream);">${s.name}</div>
          <div style="font-size:11px;color:rgba(245,231,215,0.4);">${s.email}</div>
        </td>
        <td>
          <div class="progress-cell">
            <div class="progress-cell__bar"><div class="progress-cell__fill" style="width:${pct}%"></div></div>
            <span class="progress-cell__pct">${pct}%</span>
          </div>
        </td>
        <td>
          <span style="font-size:13px;color:var(--color-cream);">${completedCount}/${lessonTotal}</span>
        </td>
        <td>
          ${prog?.currentLesson
            ? `<span style="font-size:12px;color:rgba(245,231,215,0.5);">Lição ${prog.currentLesson.replace('licao-', '')}</span>`
            : `<span style="font-size:12px;color:#4CAF74;">✓ Concluído</span>`
          }
        </td>
        <td>
          ${isBehind
            ? `<span class="badge badge--red">Atrasado</span>`
            : `<span class="badge badge--green">Em dia</span>`
          }
        </td>
        <td style="font-size:12px;color:rgba(245,231,215,0.4);">${s.lastAccess}</td>
      </tr>
    `;
  }).join('');
}

window.adminSearchStudents = function(value) {
  const filtered = MOCK_STUDENTS.filter(s =>
    s.name.toLowerCase().includes(value.toLowerCase()) ||
    s.email.toLowerCase().includes(value.toLowerCase())
  );
  renderStudentTable(filtered);
};

// ============================================================
// SECTION 16: MOBILE SIDEBAR TOGGLE
// ============================================================
window.toggleSidebar = function() {
  const sidebar = document.getElementById('lesson-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const trigger = document.querySelector('.lesson-mobile-nav-btn');
  AppState.sidebarOpen = !AppState.sidebarOpen;
  sidebar.classList.toggle('open', AppState.sidebarOpen);
  overlay.classList.toggle('visible', AppState.sidebarOpen);
  trigger?.setAttribute('aria-expanded', String(AppState.sidebarOpen));
};

window.closeSidebar = function(returnFocus = false) {
  const sidebar = document.getElementById('lesson-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const trigger = document.querySelector('.lesson-mobile-nav-btn');
  AppState.sidebarOpen = false;
  sidebar.classList.remove('open');
  overlay.classList.remove('visible');
  trigger?.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger?.focus();
};

document.addEventListener('keydown', event => {
  const cookieBanner = document.getElementById('cookie-banner');

  if (
    event.key === 'Escape' &&
    cookieBanner &&
    !cookieBanner.hidden
  ) {
    CookiePreferences.close();
    return;
  }
  if (event.key === 'Escape' && AppState.sidebarOpen) {
    closeSidebar(true);
  }
});

window.addEventListener('pagehide', () => {
  VideoTracking.stop({ flush: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && VideoTracking.current) {
    void VideoTracking.flush(VideoTracking.current, { force: true });
  }
});

// ============================================================
// SECTION 17: INITIALIZATION
// ============================================================
function applyRuntimeFeatures() {
  const demoButton = document.getElementById('demo-access-button');
  const allowDemo = AppState.backendMode === 'local' || AppState.features.demoAccess === true;
  if (demoButton) demoButton.hidden = !allowDemo;

  const registrationLinks = document.querySelectorAll('[data-registration-link]');
  registrationLinks.forEach(element => {
    element.hidden = AppState.backendMode === 'api' && AppState.features.registration === false;
  });

  configureCheckoutAvailability();
}

document.addEventListener('DOMContentLoaded', async () => {
  const legacyUsers = Storage.get('users') || {};
  if (Object.values(legacyUsers).some(user => Object.prototype.hasOwnProperty.call(user, 'password'))) {
    Storage.remove('users');
    Storage.remove('currentUser');
    Storage.remove('currentUserId');
  }

  await Auth.restoreSession();
  if (AppState.currentUser && AppState.backendMode === 'api') {
    try {
      await BetaStudentSync.hydrate();
    } catch (_) {
      Toast.show('Não foi possível atualizar seus cursos agora. Tente novamente em instantes.', 'info');
    }
  }
  if (window.BetaCatalog) {
    await window.BetaCatalog.hydrate();
  }
  applyRuntimeFeatures();
  updateNavUI();
    const paymentReturnHandled = await handleMercadoPagoReturn();

  if (!paymentReturnHandled) {
    const route = Router.fromHash();
    Router.navigate(route.page, route.params, { replace: true });
  }

  CookiePreferences.initialize();
});

window.addEventListener('beta:courses-changed', async event => {
  if (!window.BetaCatalog) return;
  try {
    if (event.detail?.source === 'local' && Array.isArray(event.detail.courses)) {
      window.BetaCatalog.replace(event.detail.courses, 'local-admin');
    } else {
      await window.BetaCatalog.hydrate({ allowEmpty: true });
    }
  } catch (error) {
    Toast.show('O curso foi salvo, mas a prévia pública precisa de materiais enviados ao servidor.', 'info', 5000);
    return;
  }
  const user = AppState.currentUser;
  if (user) {
    const enrollments = Storage.get(`enrollments_${user.id}`) || [];
    enrollments.forEach(courseId => Progress.reconcileCourse(user.id, courseId));
  }
  if (AppState.currentPage === 'admin') return;
  Router.navigate(AppState.currentPage, {
    courseId: AppState.currentCourseId,
    lessonId: AppState.currentLessonId,
  }, { replace: true });
});

// Make Router and Auth global for onclick handlers
window.Router = Router;
window.Auth = Auth;
window.AppState = AppState;
window.Toast = Toast;
window.CookiePreferences = CookiePreferences;
window.CourseAccess = CourseAccess;
