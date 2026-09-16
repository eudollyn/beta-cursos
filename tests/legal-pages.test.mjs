import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

test('páginas públicas de privacidade, termos e cookies estão disponíveis', () => {
  assert.match(html, /id="page-privacy"/);
  assert.match(html, /id="page-terms"/);
  assert.match(html, /id="page-cookies"/);
  assert.match(html, /21\.726\.252\/0001-72/);
  assert.match(html, /contato@igrejabeta\.com\.br/);
});

test('rodapé e cadastro apontam para os documentos legais', () => {
  assert.match(html, /Informações legais e privacidade/);
  assert.match(html, /Política de Privacidade/);
  assert.match(html, /Termos de Uso/);
  assert.match(html, /Política de Cookies/);
});

test('aviso de cookies é informativo e versionado', () => {
  assert.match(html, /id="cookie-banner"/);
  assert.match(html, />Entendi</);
  assert.match(html, />Saiba mais</);
  assert.doesNotMatch(html, />Aceitar todos|>Rejeitar todos|>Somente necessários/);
  assert.match(app, /const COOKIE_POLICY_VERSION = '2026-07-23'/);
  assert.match(app, /const CookiePreferences =/);
  assert.match(app, /CookiePreferences\.initialize\(\)/);
  assert.match(styles, /\.legal-page/);
  assert.match(styles, /\.cookie-banner/);
});
