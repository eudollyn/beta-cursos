import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';

test('a página principal contém os elementos essenciais', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="pt-BR">/);
  assert.match(html, /id="page-landing"/);
  assert.match(html, /id="page-dashboard"/);
  assert.match(html, /id="page-lesson"/);
  assert.match(html, /id="page-check-email"/);
  assert.match(html, /id="page-complete-registration"/);
  assert.match(html, /id="register-birth-date"/);
  assert.match(html, /id="complete-registration-birth-date"/);
  assert.match(html, /id="page-forgot-password"/);
  assert.match(html, /id="page-reset-password"/);
  assert.match(html, /id="beta-admin-root"/);
  assert.match(html, /src="config\.js"/);
  assert.match(html, /src="catalog\.js"/);
  assert.match(html, /src="admin\.js"/);
  assert.match(html, /href="admin\.css"/);
  assert.match(html, /aria-live="polite"/);
});

test('a página evita CTA duplicado e explica que os recursos variam por curso', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, />Como funciona<\/button>/);
  assert.match(html, /id="como-funciona"/);
  assert.match(html, /Cada curso combina os recursos necessários/);
  assert.match(html, /Quando houver vídeo/);
  assert.match(html, /Quando houver avaliação/);
});

test('a linguagem pastoral aprovada aparece na página e na inscrição', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /A formação da Igreja Beta para cada passo da sua caminhada com Cristo\./);
  assert.match(html, /Aqui, formação é discipulado\./);
  assert.match(html, /Deus te chamou para mais\. Comece a caminhar\./);
  assert.match(html, /Para quem é esta formação\?/);
  assert.match(html, /O valor desta formação não paga o conteúdo/);
  assert.match(html, /Sua inscrição/);
  assert.match(html, /Contribuição/);
  assert.match(html, /Código Beta/);
  assert.match(html, /Confirmar inscrição/);

  assert.doesNotMatch(html, /Resumo do pedido/);
  assert.doesNotMatch(html, /Valor cheio/);
  assert.doesNotMatch(html, /Cupom (?:promocional|de desconto)/);
  assert.doesNotMatch(html, /Simular forma de pagamento/);
});

test('a identidade geral não limita a plataforma à formação de líderes', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const eyebrow = html.match(/<span class="hero__eyebrow-text">([^<]+)<\/span>/)?.[1] || '';

  assert.equal(eyebrow, 'Igreja Beta · Formação e Discipulado');
  assert.doesNotMatch(eyebrow, /Formação de Líderes/i);
});

test('o código de membro permanece fora das telas até existir integração oficial', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const adminSource = await readFile(new URL('../admin.js', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /register-member-code|dashboard-member-badge|Código de membro Beta/);
  assert.doesNotMatch(html, /demo-access-button|Ambiente de testes/);
  assert.doesNotMatch(appSource, /register-member-code|dashboard-member-badge|Benefício para membros Beta/);
  assert.doesNotMatch(adminSource, /Desconto para membros|Valor estimado para membro|<th scope="col">Código Beta/);
  assert.match(appSource, /Auth\.requestRegistration\(email\)/);
});

test('confirmação de e-mail e recuperação de senha possuem fluxo completo na interface', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

  assert.match(appSource, /Enviar link de confirmação/);
  assert.match(html, /Conclua seu cadastro/);
  assert.match(html, /Esqueci minha senha/);
  assert.match(html, /Defina uma nova senha/);
  assert.match(html, /id="register-password-confirm"/);
  assert.match(appSource, /password !== confirmation/);
  assert.match(appSource, /passwordConfirmationInput\.disabled = verificationRequired/);
  assert.match(appSource, /\/api\/auth\/complete-registration/);
  assert.match(appSource, /\/api\/auth\/password\/forgot/);
  assert.match(appSource, /\/api\/auth\/password\/reset/);
  assert.match(appSource, /history\.replaceState/);
});

test('o FAQ descreve a experiência final sem linguagem de demonstração', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const faq = html.match(/<section class="faq-section"[\s\S]*?<\/section>/)?.[0] || '';

  assert.match(faq, /Seu progresso é salvo automaticamente na sua conta/);
  assert.match(faq, /inclusive em outro dispositivo/);
  assert.match(faq, /baixar o PDF para estudar quando quiser/);
  assert.match(faq, /A próxima lição é liberada assim que você alcança a nota mínima/);
  assert.doesNotMatch(faq, /demonstração|navegador usado|quando o conteúdo oficial for publicado/i);
});

test('todos os arquivos públicos obrigatórios existem', async () => {
  const required = [
    '../styles.css',
    '../admin.css',
    '../config.js',
    '../data.js',
    '../catalog.js',
    '../app.js',
    '../admin.js',
    '../worker.mjs',
    '../assets/apostila-demo.pdf',
    '../manifest.webmanifest',
    '../favicon.png',
    '../og.png',
  ];
  await Promise.all(required.map(path => access(new URL(path, import.meta.url))));
});

test('build hospedado não publica gabaritos, alunos ou URLs de conteúdo restrito', async () => {
  const publicData = await readFile(new URL('../dist/client/data.js', import.meta.url), 'utf8');
  assert.match(publicData, /const COURSES_DATA =/);
  assert.match(publicData, /"fullPrice": 19\.9/);
  assert.match(publicData, /const COURSES_DATA = \[\];/);
  assert.doesNotMatch(publicData, /jornada-lidere|Jornada Lidere/);
  assert.doesNotMatch(publicData, /correctOptionId|correctAnswer|correctIndex/);
  assert.doesNotMatch(publicData, /pdfUrl|videoUrl|videoEmbedId/);
  assert.doesNotMatch(publicData, /maria@exemplo\.com|Beta0042/);
  await assert.rejects(
    stat(new URL('../dist/client/assets/apostila-demo.pdf', import.meta.url)),
    error => error?.code === 'ENOENT',
  );
});
