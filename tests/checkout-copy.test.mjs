import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

test('a inscrição usa a linguagem aprovada para o fluxo visível', () => {
  assert.match(appSource, /checkout: 'Confirmar inscrição \| Beta Cursos'/);
  assert.match(appSource, /textContent = 'Confirmar inscrição'/);
  assert.match(appSource, /textContent = 'Código Beta'/);
  assert.match(appSource, /querySelector\('h1\.checkout-section-title'\)\.textContent = 'Confirmar inscrição'/);
  assert.match(appSource, /textContent = 'Sua inscrição'/);
  assert.match(appSource, /textContent = 'Contribuição total'/);
  assert.match(appSource, /mode === 'disabled'/);
  assert.match(appSource, /Inscrições em breve/);

  assert.doesNotMatch(appSource, /Benefício para membros Beta/);
  assert.doesNotMatch(appSource, /Simular inscrição/i);
  assert.doesNotMatch(appSource, /Cupom (?:aplicado|inválido)/i);
  assert.doesNotMatch(appSource, /concluir a simulação/i);
});

test('produção bloqueia inscrição enquanto o provedor oficial não está conectado', () => {
  assert.match(
    appSource,
    /A forma de pagamento oficial ainda está sendo conectada\./,
  );
  assert.match(appSource, /As inscrições ainda não estão abertas\./);
});
