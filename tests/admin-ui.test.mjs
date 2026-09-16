import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const adminSource = await readFile(new URL('../admin.js', import.meta.url), 'utf8');

test('uma falha de inicialização não é escondida ao trocar de seção', () => {
  const renderSource = adminSource.match(/function render\(\) \{[\s\S]*?\n  function overviewTemplate/)?.[0] || '';

  assert.match(renderSource, /if \(state\.initError\)/);
  assert.match(renderSource, /Não foi possível abrir o painel/);
  assert.ok(
    renderSource.indexOf('if (state.initError)') < renderSource.indexOf('switch (state.view)'),
    'o erro precisa ser preservado antes da renderização das seções',
  );
});

test('cada montagem limpa dados antigos e registra a falha definitiva', () => {
  assert.match(adminSource, /state\.adapter = null;/);
  assert.match(adminSource, /state\.courses = \[\];/);
  assert.match(adminSource, /state\.media = \[\];/);
  assert.match(adminSource, /state\.initError = null;/);
  assert.match(adminSource, /state\.initError = error;\s*render\(\);/);
  assert.match(adminSource, /state\.mode = 'error'/);
});

test('o armazenamento local antigo remove o desconto automático da Jornada Lidere', () => {
  assert.match(adminSource, /const LOCAL_STORE_VERSION = 2;/);
  assert.match(adminSource, /value\.id === 'jornada-lidere'/);
  assert.match(adminSource, /value\.pricing\.memberDiscount = 0;/);
  assert.match(adminSource, /value\.pricing\.discountPercent = 0;/);
});
test('o editor oferece capa opcional por módulo com fallback para a capa do curso', () => {
  assert.match(adminSource, /value\.coverImage = value\.coverImage \|\| '';/);
  assert.match(adminSource, /data-upload-target="module-cover"/);
  assert.match(adminSource, /Usar imagem da biblioteca', 'module-cover'/);
  assert.match(adminSource, /module\.coverImage \|\| state\.editorCourse\.coverImage/);
  assert.match(adminSource, /data-action="remove-module-cover"/);
});

test('o acompanhamento de alunos oferece filtros e detalhamento por curso', () => {
  assert.match(adminSource, /studentStatus: 'all'/);
  assert.match(adminSource, /data-filter="student-status"/);
  assert.match(adminSource, /data-action="open-student-progress"/);
  assert.match(adminSource, /getStudentProgress\(id\)/);
  assert.match(adminSource, /Histórico de tentativas/);
  assert.match(adminSource, /Acompanhamento individual/);
});

test('o editor limita categorias à jornada e permite configurar pré-requisitos', async () => {
  const [adminSource, adminStyles] = await Promise.all([
    readFile(new URL('../admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../admin.css', import.meta.url), 'utf8'),
  ]);
  for (const category of ['Alcançar', 'Adorar', 'Relacionar', 'Discipular', 'Engajar']) {
    assert.match(adminSource, new RegExp(category));
  }
  assert.match(adminSource, /Exigir conclusão de outros cursos/);
  assert.match(adminSource, /data-course-prerequisite/);
  assert.match(adminSource, /prerequisiteGraphHasCycle/);
  assert.match(adminStyles, /\.ba-prerequisite-grid/);
});


test('painel permite desativar, reativar e excluir alunos com confirmação por e-mail', async () => {
  const adminStyles = await readFile(new URL('../admin.css', import.meta.url), 'utf8');
  assert.match(adminSource, /studentAccountStatus:\s*'active'/);
  assert.match(adminSource, /data-student-account-action="deactivate"/);
  assert.match(adminSource, /data-student-account-action="reactivate"/);
  assert.match(adminSource, /data-student-account-action="delete"/);
  assert.match(adminSource, /typedConfirmationDialog/);
  assert.match(adminSource, /Alunos arquivados/);
  assert.match(adminSource, /Matrículas, progresso e tentativas permanecem preservados/);
  assert.match(adminStyles, /\.ba-student-account-actions/);
  assert.match(adminStyles, /\.ba-account-badge--disabled/);
});

test('curso novo recalcula o endereço interno a partir do título ao digitar e ao salvar', () => {
  assert.match(
    adminSource,
    /if \(path === 'title' && state\.editorIsNew\) \{\s*state\.editorCourse\.slug = slugify\(value\);\s*\}/,
  );
  assert.match(
    adminSource,
    /if \(state\.editorIsNew\) \{\s*state\.editorCourse\.slug = slugify\(state\.editorCourse\.title\);\s*\}\s*const course = normalizeCourse\(state\.editorCourse\);/,
  );
  assert.doesNotMatch(adminSource, /state\.editorCourse\.slug === 'novo-curso'/);
});

test('painel separa proprietário, administrador e facilitador e oferece backup integral', () => {
  assert.match(adminSource, /facilitator: 'Facilitador'/);
  assert.match(adminSource, /navButton\('team', '05', 'Equipe', 'owner'\)/);
  assert.match(adminSource, /data-team-role/);
  assert.match(adminSource, /roleManagedByConfig/);
  assert.match(adminSource, /\/api\/admin\/system-backup/);
  assert.match(adminSource, /Backup integral da plataforma/);
  assert.match(adminSource, /somente o proprietário altera funções, exclui contas e baixa o backup completo/);
});
