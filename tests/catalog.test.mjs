import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const dataSource = await readFile(new URL('../data.js', import.meta.url), 'utf8');
const catalogSource = await readFile(new URL('../catalog.js', import.meta.url), 'utf8');

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function response(payload, { ok = true, status = 200, contentType = 'application/json' } = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    async json() {
      return jsonClone(payload);
    },
  };
}

function createLocalStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
    removeItem(key) {
      values.delete(String(key));
    },
    clear() {
      values.clear();
    },
  };
}

function createBrowserContext(fetchImpl) {
  const events = [];
  class CustomEventMock {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }

  const sandbox = {
    AbortController,
    CustomEvent: CustomEventMock,
    clearTimeout,
    console,
    fetch: fetchImpl,
    localStorage: createLocalStorage(),
    setTimeout,
    structuredClone,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
    __events: events,
  };
  sandbox.window = sandbox;

  const context = vm.createContext(sandbox);
  vm.runInContext(dataSource, context, { filename: 'data.js' });
  vm.runInContext('globalThis.__coursesReference = COURSES_DATA;', context);
  vm.runInContext(catalogSource, context, { filename: 'catalog.js' });
  return context;
}

function coursesFrom(context) {
  return jsonClone(vm.runInContext('COURSES_DATA', context));
}

function makePublishedCourse(overrides = {}) {
  return {
    id: 'curso-publicado',
    slug: 'curso-publicado',
    status: 'published',
    title: 'Curso publicado',
    modules: [
      {
        id: 'modulo-publicado',
        title: 'Módulo publicado',
        lessons: [
          {
            id: 'licao-publicada',
            title: 'Lição publicada',
            pdfUrl: 'assets/apostila-demo.pdf',
            videoProvider: 'youtube',
            videoEmbedId: 'abc123XYZ_-',
            quiz: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('o catálogo-base preserva os identificadores estáveis da Jornada Lidere', () => {
  const context = createBrowserContext(async () => {
    throw new Error('fetch não deveria ser chamado');
  });
  const courses = coursesFrom(context);

  assert.equal(courses.length, 1);
  assert.equal(courses[0].id, 'jornada-lidere');
  assert.equal(courses[0].modules[0].id, 'modulo-1');
  assert.deepEqual(
    courses[0].modules[0].lessons.map(lesson => lesson.id),
    ['licao-1', 'licao-2', 'licao-3', 'licao-4', 'licao-5', 'licao-6'],
  );
});

test('todo curso demonstrativo do catálogo-base usa a contribuição final de R$ 19,90', () => {
  const context = createBrowserContext(async () => {
    throw new Error('fetch não deveria ser chamado');
  });
  const courses = coursesFrom(context);
  const defaultPricing = jsonClone(vm.runInContext('PRICING_CONFIG', context));

  assert.equal(defaultPricing.fullPrice, 19.90);
  assert.equal(defaultPricing.memberDiscount, 0);
  assert.ok(courses.length > 0);
  courses.forEach(course => {
    if (course.pricing?.mode === 'demo') {
      assert.equal(course.pricing.fullPrice, 19.90, course.id);
      assert.equal(course.pricing.memberDiscount, 0, course.id);
    }
  });
});

test('uma API válida substitui o conteúdo publicado preservando a referência do array', async () => {
  const remoteCourse = makePublishedCourse();
  const context = createBrowserContext(async () => response({ initialized: true, courses: [remoteCourse] }));

  const result = await context.BetaCatalog.hydrate();
  const courses = coursesFrom(context);

  assert.equal(result.ok, true);
  assert.equal(result.source, 'server');
  assert.equal(courses.length, 1);
  assert.equal(courses[0].id, remoteCourse.id);
  assert.equal(vm.runInContext('COURSES_DATA === globalThis.__coursesReference', context), true);
  assert.equal(context.__events.length, 1);
  assert.equal(context.__events[0].type, 'beta:catalog-loaded');
});

test('falha da API mantém intacto o catálogo-base', async () => {
  const context = createBrowserContext(async () => {
    throw new Error('serviço indisponível');
  });
  const before = coursesFrom(context);

  const result = await context.BetaCatalog.hydrate();

  assert.equal(result.ok, false);
  assert.equal(result.source, 'static');
  assert.match(result.error, /serviço indisponível/);
  assert.deepEqual(coursesFrom(context), before);
});

test('payload inicializado e vazio esvazia o catálogo', async () => {
  const context = createBrowserContext(async () => response({ initialized: true, courses: [] }));

  const result = await context.BetaCatalog.hydrate();

  assert.equal(result.ok, true);
  assert.equal(result.initialized, true);
  assert.deepEqual(coursesFrom(context), []);
});

test('cursos em rascunho são filtrados da experiência pública', async () => {
  const published = makePublishedCourse();
  const draft = makePublishedCourse({ id: 'curso-rascunho', slug: 'curso-rascunho', status: 'draft' });
  const context = createBrowserContext(async () => response({ initialized: true, courses: [published, draft] }));

  const result = await context.BetaCatalog.hydrate();

  assert.equal(result.ok, true);
  assert.deepEqual(coursesFrom(context).map(course => course.id), ['curso-publicado']);
});

test('módulo ou lição sem ID rejeita a hidratação e preserva o catálogo-base', async t => {
  const invalidCourses = [
    {
      name: 'módulo sem ID',
      course: makePublishedCourse({ modules: [{ title: 'Módulo inválido', lessons: [] }] }),
    },
    {
      name: 'lição sem ID',
      course: makePublishedCourse({
        modules: [{ id: 'modulo-valido', title: 'Módulo válido', lessons: [{ title: 'Lição inválida', quiz: [] }] }],
      }),
    },
  ];

  for (const invalid of invalidCourses) {
    await t.test(invalid.name, async () => {
      const context = createBrowserContext(async () => response({ initialized: true, courses: [invalid.course] }));
      const before = coursesFrom(context);

      const result = await context.BetaCatalog.hydrate();

      assert.equal(result.ok, false);
      assert.match(result.error, /identificador inválido|identificador invÃ¡lido/);
      assert.deepEqual(coursesFrom(context), before);
    });
  }
});

test('URLs javascript e outros esquemas maliciosos são rejeitados', async t => {
  const cases = [
    { name: 'apostila javascript', field: 'pdfUrl', value: 'javascript:alert(1)' },
    { name: 'vídeo data URL', field: 'videoUrl', value: 'data:text/html,<script>alert(1)</script>' },
  ];

  for (const malicious of cases) {
    await t.test(malicious.name, async () => {
      const course = makePublishedCourse();
      course.modules[0].lessons[0][malicious.field] = malicious.value;
      const context = createBrowserContext(async () => response({ initialized: true, courses: [course] }));
      const before = coursesFrom(context);

      const result = await context.BetaCatalog.hydrate();

      assert.equal(result.ok, false);
      assert.match(result.error, /URL/);
      assert.deepEqual(coursesFrom(context), before);
    });
  }
});

test('identificadores duplicados são rejeitados sem alteração parcial do seed', async t => {
  const duplicateCourses = [
    {
      name: 'ID de curso duplicado',
      courses: [
        makePublishedCourse(),
        makePublishedCourse({ slug: 'outro-slug', title: 'Outro curso' }),
      ],
    },
    {
      name: 'ID aninhado duplicado',
      courses: [
        makePublishedCourse({
          modules: [
            { id: 'id-repetido', title: 'Módulo', lessons: [{ id: 'id-repetido', title: 'Lição', quiz: [] }] },
          ],
        }),
      ],
    },
    {
      name: 'ID de questão duplicado',
      courses: [
        makePublishedCourse({
          modules: [
            {
              id: 'modulo-questoes',
              lessons: [
                {
                  id: 'licao-questoes',
                  quiz: [
                    { id: 'questao-repetida', options: [] },
                    { id: 'questao-repetida', options: [] },
                  ],
                },
              ],
            },
          ],
        }),
      ],
    },
  ];

  for (const duplicate of duplicateCourses) {
    await t.test(duplicate.name, async () => {
      const context = createBrowserContext(async () => response({ initialized: true, courses: duplicate.courses }));
      const before = coursesFrom(context);

      const result = await context.BetaCatalog.hydrate();

      assert.equal(result.ok, false);
      assert.match(result.error, /duplicad/i);
      assert.deepEqual(coursesFrom(context), before);
    });
  }
});

test('provider upload preserva URLs válidas servidas por /api/media', async () => {
  const uploadedCourse = makePublishedCourse();
  const lesson = uploadedCourse.modules[0].lessons[0];
  lesson.pdfUrl = '/api/media/apostilas/apostila-lideranca.pdf';
  lesson.videoProvider = 'upload';
  lesson.videoEmbedId = null;
  lesson.videoUrl = '/api/media/videos/aula-lideranca.mp4';
  const context = createBrowserContext(async () => response({ initialized: true, courses: [uploadedCourse] }));

  const result = await context.BetaCatalog.hydrate();
  const hydratedLesson = coursesFrom(context)[0].modules[0].lessons[0];

  assert.equal(result.ok, true);
  assert.equal(hydratedLesson.videoProvider, 'upload');
  assert.equal(hydratedLesson.pdfUrl, '/api/media/apostilas/apostila-lideranca.pdf');
  assert.equal(hydratedLesson.videoUrl, '/api/media/videos/aula-lideranca.mp4');
});

test("BetaCatalog.replace publica somente cursos published e mantém a referência de COURSES_DATA", () => {
  const context = createBrowserContext(async () => {
    throw new Error('fetch não deveria ser chamado');
  });
  const published = makePublishedCourse();
  const draft = makePublishedCourse({ id: 'curso-local-draft', slug: 'curso-local-draft', status: 'draft' });

  const result = context.BetaCatalog.replace([published, draft], 'local-admin');

  assert.equal(result.ok, true);
  assert.equal(result.source, 'local-admin');
  assert.equal(result.initialized, true);
  assert.deepEqual(coursesFrom(context).map(course => course.id), ['curso-publicado']);
  assert.equal(vm.runInContext('COURSES_DATA === globalThis.__coursesReference', context), true);
  assert.equal(context.BetaCatalog.getState().source, 'local-admin');
  assert.equal(context.__events.at(-1).detail.source, 'local-admin');
});

test('BetaCatalog.replace rejeita IDs e URLs inválidas sem alteração parcial', async t => {
  const invalidCases = [
    {
      name: 'ID inválido',
      course: makePublishedCourse({ id: 'curso com espaços' }),
      error: /identificador inválido|identificador invÃ¡lido/,
    },
    {
      name: 'URL inválida',
      course: (() => {
        const course = makePublishedCourse();
        course.modules[0].lessons[0].videoProvider = 'upload';
        course.modules[0].lessons[0].videoUrl = 'javascript:alert(document.cookie)';
        return course;
      })(),
      error: /URL/,
    },
  ];

  for (const invalid of invalidCases) {
    await t.test(invalid.name, () => {
      const context = createBrowserContext(async () => {
        throw new Error('fetch não deveria ser chamado');
      });
      const before = coursesFrom(context);

      assert.throws(
        () => context.BetaCatalog.replace([makePublishedCourse(), invalid.course], 'local-admin'),
        invalid.error,
      );
      assert.deepEqual(coursesFrom(context), before);
      assert.equal(vm.runInContext('COURSES_DATA === globalThis.__coursesReference', context), true);
      assert.equal(context.BetaCatalog.getState().source, 'static');
    });
  }
});
test('capas do curso e do módulo são preservadas no catálogo público', async () => {
  const remoteCourse = makePublishedCourse({
    coverImage: '/api/media/capa-curso-1234',
    modules: [{
      id: 'modulo-publicado',
      title: 'Módulo publicado',
      description: 'Descrição do módulo',
      coverImage: 'https://cdn.example.com/capa-modulo.webp',
      lessons: [{
        id: 'licao-publicada',
        title: 'Lição publicada',
        pdfUrl: 'assets/apostila-demo.pdf',
        videoProvider: 'youtube',
        videoEmbedId: 'abc123XYZ_-',
        quiz: [],
      }],
    }],
  });
  const context = createBrowserContext(async () => response({ initialized: true, courses: [remoteCourse] }));
  const result = await context.BetaCatalog.hydrate();
  const [course] = coursesFrom(context);
  assert.equal(result.ok, true);
  assert.equal(course.coverImage, '/api/media/capa-curso-1234');
  assert.equal(course.modules[0].coverImage, 'https://cdn.example.com/capa-modulo.webp');
  assert.equal(course.modules[0].description, 'Descrição do módulo');
});

test('capas com esquema malicioso são rejeitadas sem alterar o catálogo', async t => {
  for (const target of ['course', 'module']) {
    await t.test(target, async () => {
      const course = makePublishedCourse();
      if (target === 'course') course.coverImage = 'javascript:alert(1)';
      else course.modules[0].coverImage = 'data:text/html,<script>alert(1)</script>';
      const context = createBrowserContext(async () => response({ initialized: true, courses: [course] }));
      const before = coursesFrom(context);
      const result = await context.BetaCatalog.hydrate();
      assert.equal(result.ok, false);
      assert.match(result.error, /Capa/);
      assert.deepEqual(coursesFrom(context), before);
    });
  }
});
