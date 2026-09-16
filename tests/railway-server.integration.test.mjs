import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { loadConfig } from '../railway/config.mjs';
import { createBetaServer } from '../railway/server.mjs';

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';', 1)[0];
}

async function payload(response) {
  const body = await response.json();
  assert.ok(response.ok, JSON.stringify(body));
  return body;
}

function courseFixture() {
  return {
    id: 'jornada-teste',
    title: 'Jornada de teste',
    slug: 'jornada-de-teste',
    status: 'published',
    description: 'Curso usado para validar o ambiente completo.',
    pricing: {
      fullPrice: 19.90,
      currency: 'BRL',
      memberDiscount: 0,
      paymentMethods: ['pix', 'credit_card', 'boleto'],
    },
    modules: [{
      id: 'modulo-teste',
      title: 'Fundamentos',
      order: 1,
      lessons: [{
        id: 'licao-teste',
        title: 'Primeira lição',
        order: 1,
        pdfUrl: 'assets/apostila-demo.pdf',
        videoProvider: 'youtube',
        videoUrl: 'https://youtu.be/abcdefghijk',
        quizConfig: { passingScore: 4, maxAttempts: 3 },
        quiz: Array.from({ length: 5 }, (_, index) => ({
          id: `questao-${index + 1}`,
          question: `Pergunta de homologação ${index + 1}?`,
          options: [
            { id: 'a', text: 'Alternativa correta' },
            { id: 'b', text: 'Alternativa dois' },
            { id: 'c', text: 'Alternativa três' },
            { id: 'd', text: 'Alternativa quatro' },
          ],
          correctOptionId: 'a',
        })),
      }],
    }],
  };
}

test('servidor Railway integra sessão, administração, curso, checkout e progresso', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'beta-cursos-server-'));
  let mockOrder = null;
  const mercadoPagoFetch = async (url, init = {}) => {
    const endpoint = new URL(url);
    if (endpoint.pathname === '/v1/orders' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      mockOrder = {
        id: 'ORDTST00000900001',
        status: 'processed',
        external_reference: body.external_reference,
        total_amount: body.total_amount,
        currency: 'BRL',
        transactions: { payments: [{ id: '900001' }] },
      };
      return Response.json({
        id: mockOrder.id,
        checkout_url: `https://sandbox.mercadopago.com/checkout?order_id=${mockOrder.id}`,
      });
    }
    if (endpoint.pathname === '/v1/orders/ORDTST00000900001' && mockOrder) {
      return Response.json(mockOrder);
    }
    return Response.json({ error: 'unexpected_request' }, { status: 500 });
  };
  const baseConfig = loadConfig({
    APP_ENV: 'test',
    NODE_ENV: 'test',
    PORT: '3199',
    APP_ORIGIN: 'http://127.0.0.1:3199',
    DATABASE_URL: 'sqlite::memory:',
    STORAGE_DRIVER: 'filesystem',
    LOCAL_STORAGE_PATH: dataRoot,
    SESSION_SECRET: 'integration-test-secret-with-more-than-32-characters',
    COOKIE_SECURE: 'false',
    BOOTSTRAP_OWNER_EMAIL: 'owner@beta.local',
    ENABLE_DEMO_LOGIN: 'true',
    CHECKOUT_MODE: 'test',
    MERCADO_PAGO_ACCESS_TOKEN_TEST: 'TEST-integration-token',
    MERCADO_PAGO_WEBHOOK_SECRET_TEST: 'test-webhook-secret',
  });
  const config = {
    ...baseConfig,
    port: 0,
    storage: {
      ...baseConfig.storage,
      localPath: dataRoot,
    },
    payments: {
      ...baseConfig.payments,
      fetch: mercadoPagoFetch,
    },
  };
  const application = await createBetaServer({
    config,
    clientRoot: fileURLToPath(new URL('..', import.meta.url)),
  });
  await application.listen();
  const address = application.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const origin = baseUrl;

  try {
    let response = await fetch(`${baseUrl}/health/ready`);
    assert.equal(response.status, 200);
    const ready = await response.json();
    assert.equal(ready.ok, true);
    assert.equal(ready.email.driver, 'preview');
    assert.equal(ready.email.status, 'ready');
    assert.equal(ready.email.providerProbe, 'not_performed');

    response = await fetch(`${baseUrl}/api/courses`);
    const initialCatalog = await payload(response);
    assert.equal(initialCatalog.courses[0].id, 'jornada-lidere');
    assert.equal(initialCatalog.courses[0].pricing.fullPrice, 19.90);
    assert.equal(
      JSON.stringify(initialCatalog.courses).includes('correctOptionId'),
      false,
      'o catálogo público não pode expor o gabarito',
    );
    const initialPublicLesson = initialCatalog.courses[0].modules[0].lessons[0];
    assert.equal(initialPublicLesson.quiz.length, 0);
    assert.equal(Object.hasOwn(initialPublicLesson, 'pdfUrl'), false);
    assert.equal(Object.hasOwn(initialPublicLesson, 'videoEmbedId'), false);

    response = await fetch(`http://localhost:${address.port}/api/auth/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://localhost:${address.port}`,
      },
      body: JSON.stringify({
        name: 'Acesso por Localhost',
        email: 'localhost@beta.local',
        birthDate: '1990-01-01',
        password: 'senha-localhost-123',
      }),
    });
    assert.equal(response.status, 201, 'localhost e 127.0.0.1 devem funcionar no ambiente local');

    response = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: {
        Origin: origin,
        'oai-authenticated-user-email': 'attacker@beta.local',
      },
    });
    assert.equal(response.status, 401, 'cabeçalho de identidade enviado pelo cliente deve ser ignorado');

    response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        name: 'Responsável Beta',
        email: 'owner@beta.local',
        birthDate: '1990-01-01',
        password: 'senha-segura-123',
      }),
    });
    const owner = await payload(response);
    assert.equal(owner.user.role, 'owner');
    const ownerCookie = cookieFrom(response);
    assert.match(ownerCookie, /^beta_session=/);

    response = await fetch(`${baseUrl}/api/admin/bootstrap`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, Origin: origin },
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).admin.role, 'owner');

    const mediaForm = new FormData();
    mediaForm.append('kind', 'pdf');
    mediaForm.append('file', new File(
      [new TextEncoder().encode('%PDF-1.7\nmaterial protegido')],
      'material-protegido.pdf',
      { type: 'application/pdf' },
    ));
    response = await fetch(`${baseUrl}/api/admin/media`, {
      method: 'POST',
      headers: { Cookie: ownerCookie, Origin: origin },
      body: mediaForm,
    });
    const uploadedMaterial = (await payload(response)).media;

    const publishedCourse = courseFixture();
    publishedCourse.modules[0].lessons[0].pdfUrl = uploadedMaterial.url;
    response = await fetch(`${baseUrl}/api/admin/courses`, {
      method: 'POST',
      headers: {
        Cookie: ownerCookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(publishedCourse),
    });
    const created = await payload(response);
    assert.equal(created.course.pricing.fullPrice, 19.90);

    response = await fetch(`${baseUrl}/api/admin/system-backup`);
    assert.equal(response.status, 401);
    response = await fetch(`${baseUrl}/api/admin/system-backup`, {
      headers: { Cookie: ownerCookie },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.match(response.headers.get('content-disposition') || '', /beta-cursos-backup-completo-/);
    const backupLines = gunzipSync(Buffer.from(await response.arrayBuffer()))
      .toString('utf8').trim().split('\n').map(JSON.parse);
    assert.equal(backupLines[0].format, 'beta-cursos-full-backup');
    assert.ok(backupLines.some(item => item.type === 'media-start' && item.mediaId === uploadedMaterial.id));
    assert.equal(backupLines.at(-1).type, 'complete');

    response = await fetch(`${baseUrl}${uploadedMaterial.url}`);
    assert.equal(response.status, 401, 'apostila não pode ser baixada sem autenticação');

    response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({
        name: 'Aluno de Teste',
        email: 'aluno@beta.local',
        birthDate: '1990-01-01',
        password: 'outra-senha-segura',
      }),
    });
    const studentCookie = cookieFrom(response);
    assert.equal((await payload(response)).user.role, 'student');

    response = await fetch(`${baseUrl}/api/checkouts`, {
      method: 'POST',
      headers: {
        Cookie: studentCookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'matricula-jornada-teste',
      },
      body: JSON.stringify({
        courseId: 'jornada-teste',
        paymentMethod: 'pix',
      }),
    });
    let checkout = await payload(response);
    assert.equal(checkout.testMode, true);
    assert.equal(checkout.status, 'pending');
    assert.equal(checkout.checkout.amountCents, 1990);
    assert.match(checkout.checkout.checkoutUrl, /^https:\/\/sandbox\.mercadopago\.com\//);
    assert.equal(checkout.enrollment, null);

    response = await fetch(
      `${baseUrl}/api/checkouts/${encodeURIComponent(checkout.checkout.id)}?order_id=ORDTST00000900001`,
      { headers: { Cookie: studentCookie } },
    );
    checkout = await payload(response);
    assert.equal(checkout.status, 'approved');
    assert.equal(checkout.enrollment.status, 'active');

    response = await fetch(`${baseUrl}/api/courses`, {
      headers: { Cookie: studentCookie },
    });
    const enrolledCatalog = await payload(response);
    const enrolledCourse = enrolledCatalog.courses.find(item => item.id === 'jornada-teste');
    const enrolledLesson = enrolledCourse.modules[0].lessons[0];
    assert.equal(enrolledLesson.pdfUrl, uploadedMaterial.url);
    assert.equal(enrolledLesson.quiz.length, 5);
    assert.equal(Object.hasOwn(enrolledLesson.quiz[0], 'correctOptionId'), false);

    response = await fetch(`${baseUrl}${uploadedMaterial.url}`, {
      headers: { Cookie: studentCookie },
    });
    assert.equal(response.status, 200, 'aluno matriculado deve acessar a apostila');
    assert.match(await response.text(), /^%PDF-1\.7/);

    response = await fetch(`${baseUrl}/api/me/state`, {
      headers: { Cookie: studentCookie },
    });
    const state = await payload(response);
    assert.deepEqual(state.enrollments, ['jornada-teste']);
    const syncProgress = async progress => {
      const syncResponse = await fetch(`${baseUrl}/api/me/progress/jornada-teste`, {
        method: 'PUT',
        headers: {
          Cookie: studentCookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ progress }),
      });
      return (await payload(syncResponse)).progress;
    };
    let progress = structuredClone(state.progress['jornada-teste']);
    progress.lessons['licao-teste'].pdfRead = true;
    progress = await syncProgress(progress);
    response = await fetch(`${baseUrl}/api/me/video-progress/jornada-teste/licao-teste`, {
      method: 'PUT',
      headers: {
        Cookie: studentCookie,
        Origin: origin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        trackingCycle: 1,
        durationSeconds: 100,
        lastPositionSeconds: 100,
        intervals: [
          [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
          [50, 60], [60, 70], [70, 80], [80, 90], [90, 95],
        ],
        ended: true,
      }),
    });
    const trackedVideo = await payload(response);
    assert.equal(trackedVideo.tracking.completed, true);
    assert.equal(trackedVideo.videoCompleted, true);
    response = await fetch(`${baseUrl}/api/me/state`, { headers: { Cookie: studentCookie } });
    progress = (await payload(response)).progress['jornada-teste'];
    response = await fetch(`${baseUrl}/api/me/quiz/jornada-teste/licao-teste/attempt`, {
      method: 'POST',
      headers: {
        Cookie: studentCookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'quiz-integracao-licao-teste-1',
      },
      body: JSON.stringify({
        answers: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`questao-${index + 1}`, 'a']),
        ),
      }),
    });
    const quizAttempt = await payload(response);
    assert.equal(quizAttempt.score, 5);
    assert.equal(quizAttempt.passed, true);
    progress = quizAttempt.progress;
    assert.equal(progress.lessons['licao-teste'].lessonCompleted, true);

    response = await fetch(`${baseUrl}/api/admin/students`, {
      headers: { Cookie: ownerCookie },
    });
    const students = await payload(response);
    const enrolledStudent = students.students.find(item => item.email === 'aluno@beta.local');
    assert.ok(enrolledStudent);
    assert.equal(enrolledStudent.progress['jornada-teste'].percentage, 100);
  } finally {
    await application.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});
