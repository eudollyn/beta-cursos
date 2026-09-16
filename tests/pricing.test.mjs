import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const dataSource = await readFile(new URL('../data.js', import.meta.url), 'utf8');
const appSource = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/\r\n/g, '\n');

function createPricingContext() {
  const sandbox = { console, structuredClone };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(dataSource, context, { filename: 'data.js' });

  const enrollmentSource = appSource.match(
    /const Enrollment = \{[\s\S]*?\n\};\n\n\/\/ =+\n\/\/ SECTION 4\.1/,
  )?.[0].replace(/\n\n\/\/ =+\n\/\/ SECTION 4\.1$/, '');

  assert.ok(enrollmentSource, 'o módulo de preço precisa continuar testável');
  vm.runInContext(`${enrollmentSource}\nglobalThis.__Enrollment = Enrollment;`, context, {
    filename: 'app-pricing.js',
  });
  return context;
}

test('a conta de demonstração vê R$ 19,90 sem desconto automático', () => {
  const context = createPricingContext();
  const pricing = JSON.parse(JSON.stringify(
    vm.runInContext("__Enrollment.calculatePrice('jornada-lidere', true)", context),
  ));

  assert.deepEqual(pricing, {
    fullPrice: 19.90,
    discount: 0,
    finalPrice: 19.90,
    hasMemberDiscount: false,
    memberDiscount: 0,
  });
});
