import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { __test } from '../worker.mjs';

function questions(prefix = 'question') {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    prompt: `Pergunta completa número ${index + 1}?`,
    options: [
      { id: 'a', text: 'Alternativa correta' },
      { id: 'b', text: 'Alternativa dois' },
      { id: 'c', text: 'Alternativa três' },
      { id: 'd', text: 'Alternativa quatro' },
    ],
    correctOptionId: 'a',
  }));
}

const validPublishedCourse = {
  title: 'Formação de Líderes',
  slug: 'formacao-de-lideres',
  status: 'published',
  description: 'Uma jornada de formação para novos líderes.',
  modules: [{
    id: 'module-1',
    title: 'Fundamentos',
    lessons: [{
      id: 'lesson-1',
      title: 'Chamado e propósito',
      pdfUrl: 'assets/apostila-demo.pdf',
      videoUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
      quiz: {
        passingScore: 80,
        maxAttempts: 3,
        questions: questions(),
      },
    }],
  }],
};

test('normaliza um curso publicado completo', () => {
  const normalized = __test.normalizeCourse(validPublishedCourse);
  assert.equal(normalized.title, 'Formação de Líderes');
  assert.equal(normalized.slug, 'formacao-de-lideres');
  assert.equal(normalized.status, 'published');
  assert.equal(normalized.data.modules.length, 1);
});

test('aceita também o formato de teste usado pelo player atual', () => {
  const course = {
    ...validPublishedCourse,
    modules: [{
      id: 'module-1',
      title: 'Fundamentos',
      lessons: [{
        id: 'lesson-1',
        title: 'Chamado e propósito',
        pdfUrl: 'assets/apostila-demo.pdf',
        videoEmbedId: 'abcdefghijk',
        quizConfig: { passingScore: 80, maxAttempts: 3 },
        quiz: questions('player-question').map(question => ({
          ...question,
          question: question.prompt,
          prompt: undefined,
        })),
      }],
    }],
  };
  assert.equal(__test.normalizeCourse(course).data.modules[0].lessons[0].quiz.length, 5);
});

test('gera slug para rascunho e rejeita status, slug e vídeo inválidos', () => {
  const normalized = __test.normalizeCourse({ title: 'Curso de Oração', modules: [] });
  assert.equal(normalized.slug, 'curso-de-oracao');
  assert.equal(normalized.status, 'draft');
  assert.throws(
    () => __test.normalizeCourse({ ...validPublishedCourse, slug: 'Slug Inválido' }),
    /endereço do curso/,
  );
  assert.throws(
    () => __test.normalizeCourse({ ...validPublishedCourse, status: 'online' }),
    /status deve ser/,
  );
  assert.throws(
    () => __test.normalizeCourse({
      ...validPublishedCourse,
      modules: [{
        id: 'module-1',
        title: 'Módulo',
        lessons: [{
          id: 'lesson-1',
          title: 'Aula',
          pdfUrl: 'assets/apostila-demo.pdf',
          videoUrl: 'http://youtube.com/watch?v=abcdefghijk',
          quiz: questions(),
        }],
      }],
    }),
    /vídeo configurado/,
  );
});

test('exige ids válidos e únicos em toda a estrutura acadêmica', () => {
  assert.throws(
    () => __test.normalizeCourse({
      title: 'Rascunho sem IDs',
      modules: [{ title: 'Módulo', lessons: [] }],
    }),
    /id é obrigatório/,
  );
  const duplicatedLesson = structuredClone(validPublishedCourse);
  duplicatedLesson.modules.push({
    id: 'module-2',
    title: 'Outro módulo',
    lessons: [{
      ...structuredClone(duplicatedLesson.modules[0].lessons[0]),
      title: 'Outra aula',
    }],
  });
  assert.throws(() => __test.normalizeCourse(duplicatedLesson), /Lição com id "lesson-1" está duplicado/);

  const duplicatedOption = structuredClone(validPublishedCourse);
  duplicatedOption.modules[0].lessons[0].quiz.questions[0].options[1].id = 'a';
  assert.throws(() => __test.normalizeCourse(duplicatedOption), /Alternativa com id "a" está duplicado/);
});

test('publica lições sem PDF, vídeo ou teste e valida somente os recursos informados', () => {
  const optionalContent = structuredClone(validPublishedCourse);
  const lesson = optionalContent.modules[0].lessons[0];
  lesson.pdfUrl = '';
  lesson.videoUrl = '';
  lesson.quiz = { passingScore: 0, maxAttempts: 3, questions: [] };
  assert.doesNotThrow(() => __test.normalizeCourse(optionalContent));

  const invalidPdf = structuredClone(validPublishedCourse);
  invalidPdf.modules[0].lessons[0].pdfUrl = 'https://example.com/apostila.pdf';
  assert.throws(() => __test.normalizeCourse(invalidPdf), /PDF interno/);

  const invalidVideo = structuredClone(validPublishedCourse);
  invalidVideo.modules[0].lessons[0].videoUrl = 'http://youtube.com/watch?v=abcdefghijk';
  assert.throws(() => __test.normalizeCourse(invalidVideo), /vídeo configurado/);

  const threeOptions = structuredClone(validPublishedCourse);
  threeOptions.modules[0].lessons[0].quiz.questions[0].options.pop();
  assert.throws(() => __test.normalizeCourse(threeOptions), /exatamente 4 alternativas/);

  const noAnswer = structuredClone(validPublishedCourse);
  delete noAnswer.modules[0].lessons[0].quiz.questions[0].correctOptionId;
  assert.throws(() => __test.normalizeCourse(noAnswer), /exatamente uma alternativa correta/);
});

test('aceita Vimeo e link HTTPS direto conforme o player administrativo', () => {
  const vimeo = structuredClone(validPublishedCourse);
  Object.assign(vimeo.modules[0].lessons[0], {
    videoProvider: 'vimeo',
    videoUrl: 'https://vimeo.com/123456789',
    videoEmbedId: '123456789',
  });
  assert.equal(__test.normalizeCourse(vimeo).status, 'published');

  const direct = structuredClone(validPublishedCourse);
  Object.assign(direct.modules[0].lessons[0], {
    videoProvider: 'direct',
    videoUrl: 'https://cdn.example.com/aulas/aula-1.mp4',
    videoEmbedId: '',
  });
  assert.equal(__test.normalizeCourse(direct).status, 'published');
});

test('mantém compatibilidade com o seed demonstrativo Jornada Lidere', () => {
  const seed = structuredClone(validPublishedCourse);
  seed.id = 'jornada-lidere';
  seed.slug = 'jornada-lidere';
  seed.title = 'Jornada Lidere';
  seed.contentStatus = 'demo';
  seed.modules[0].id = 'modulo-1';
  seed.modules[0].lessons[0].id = 'licao-1';
  seed.modules[0].lessons[0].videoUrl = '';
  seed.modules[0].lessons[0].videoEmbedId = null;
  seed.modules[0].lessons[0].quiz.questions.forEach((question, index) => {
    question.id = `licao-1-q${index + 1}`;
  });
  assert.equal(__test.normalizeCourse(seed).status, 'published');
});

test('interpreta intervalos HTTP para reprodução de vídeo', () => {
  assert.deepEqual(__test.parseByteRange(null, 1000), null);
  assert.deepEqual(__test.parseByteRange('bytes=100-199', 1000), { start: 100, end: 199, length: 100 });
  assert.deepEqual(__test.parseByteRange('bytes=900-', 1000), { start: 900, end: 999, length: 100 });
  assert.deepEqual(__test.parseByteRange('bytes=-50', 1000), { start: 950, end: 999, length: 50 });
  assert.throws(() => __test.parseByteRange('bytes=1000-1200', 1000), /Faixa de reprodução inválida/);
  assert.throws(() => __test.parseByteRange('bytes=0-1,4-5', 1000), /Faixa de reprodução inválida/);
});

test('lê a identidade encaminhada pela plataforma e decodifica o nome', () => {
  const request = new Request('https://example.com/api/admin/me', {
    headers: {
      'oai-authenticated-user-email': 'Pastor@Example.com ',
      'oai-authenticated-user-full-name': 'Pr.%20Andr%C3%A9',
      'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
    },
  });
  assert.deepEqual(__test.readIdentity(request), { email: 'pastor@example.com', fullName: 'Pr. André' });
});

test('valida os tipos e limites de apostilas e vídeos', () => {
  const pdf = { name: 'apostila.pdf', type: 'application/pdf', size: 1024, arrayBuffer() {} };
  assert.deepEqual(__test.validateMediaFile(pdf), {
    filename: 'apostila.pdf', contentType: 'application/pdf', kind: 'pdf', size: 1024, extension: 'pdf',
  });
  const video = { name: 'aula.mp4', type: 'video/mp4', size: 2048, arrayBuffer() {} };
  assert.equal(__test.validateMediaFile(video).kind, 'video');
  assert.throws(
    () => __test.validateMediaFile({ ...pdf, name: 'apostila.txt' }, 'pdf'),
    /arquivo PDF válido/,
  );
  assert.throws(
    () => __test.validateMediaFile({ ...video, size: 101 * 1024 * 1024 }),
    /limite de 100 MB/,
  );
  const image = { name: 'capa.webp', type: 'image/webp', size: 4096, arrayBuffer() {} };
  assert.deepEqual(__test.validateMediaFile(image), {
    filename: 'capa.webp', contentType: 'image/webp', kind: 'image', size: 4096, extension: 'webp',
  });
  assert.throws(
    () => __test.validateMediaFile({ ...image, name: 'capa.png' }, 'image'),
    /PNG, JPEG ou WebP/,
  );
  assert.throws(
    () => __test.validateMediaFile({ ...image, size: 11 * 1024 * 1024 }),
    /limite de 10 MB/,
  );
});

class MockStatement {
  constructor(sql) {
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }
}

test('catálogo público retorna somente os registros fornecidos e informa inicialização', async () => {
  const publishedRow = {
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'formacao-de-lideres',
    title: 'Formação de Líderes',
    status: 'published',
    data_json: JSON.stringify({ description: 'Curso publicado' }),
    version: 1,
    created_at: '2026-07-13T10:00:00.000Z',
    updated_at: '2026-07-13T10:00:00.000Z',
    published_at: '2026-07-13T10:00:00.000Z',
    created_by: 'pastor@example.com',
    updated_by: 'pastor@example.com',
  };
  const DB = {
    prepare(sql) { return new MockStatement(sql); },
    async batch(statements) {
      if (statements.some((statement) => statement.sql.includes('CREATE TABLE'))) {
        return statements.map(() => ({ results: [], success: true }));
      }
      return [
        { results: [publishedRow], success: true },
        { results: [{ count: 1 }], success: true },
      ];
    },
  };
  const response = await worker.fetch(new Request('https://example.com/api/courses'), { DB });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const body = await response.json();
  assert.equal(body.initialized, true);
  assert.equal(body.courses.length, 1);
  assert.equal(body.courses[0].title, 'Formação de Líderes');
});

test('falha de forma segura quando a persistência ainda não está configurada', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/courses'), {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'service_not_configured');
  assert.ok(body.requestId);
});

test('normaliza as cinco categorias da jornada e a política de pré-requisitos', () => {
  assert.equal(__test.normalizeCourseCategory('Liderança'), 'Engajar');
  assert.equal(__test.normalizeCourseCategory('Família'), 'Relacionar');
  assert.equal(__test.normalizeCourseCategory('Evangelismo e Missões'), 'Alcançar');
  const normalized = __test.normalizeCourse({
    title: 'Curso avançado',
    status: 'draft',
    category: 'Discipulado',
    accessPolicy: {
      mode: 'restricted',
      prerequisiteCourseIds: ['curso-base'],
      catalogVisibility: 'show_locked',
    },
    modules: [],
  });
  assert.equal(normalized.data.category, 'Discipular');
  assert.deepEqual(normalized.data.accessPolicy, {
    mode: 'restricted',
    prerequisiteCourseIds: ['curso-base'],
    prerequisiteMode: 'all',
    requiredPastoralPhase: null,
    catalogVisibility: 'show_locked',
  });
});

test('rejeita ciclos no grafo de pré-requisitos', () => {
  const catalog = new Map([
    ['curso-a', { accessPolicy: { prerequisiteCourseIds: ['curso-b'] } }],
    ['curso-b', { accessPolicy: { prerequisiteCourseIds: ['curso-a'] } }],
  ]);
  assert.throws(
    () => __test.validatePrerequisiteGraph(catalog),
    /pré-requisitos formam um ciclo/i,
  );
});
