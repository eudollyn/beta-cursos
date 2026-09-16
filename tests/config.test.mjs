import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const configSource = await readFile(new URL('../config.js', import.meta.url), 'utf8');

function loadConfig(source = {}, location = {}) {
  const hostname = Object.prototype.hasOwnProperty.call(location, 'hostname')
    ? location.hostname
    : 'cursos.beta.org';
  const protocol = Object.prototype.hasOwnProperty.call(location, 'protocol')
    ? location.protocol
    : 'https:';
  const port = location.port ? `:${location.port}` : '';
  const origin = location.origin || `${protocol}//${hostname}${port}`;
  const sandbox = {
    URL,
    window: {
      BETA_CONFIG: source,
      location: { hostname, origin, protocol },
    },
  };
  vm.runInContext(configSource, vm.createContext(sandbox), { filename: 'config.js' });
  return sandbox.window.BetaConfig;
}

test('normaliza base HTTPS com espaços, barras finais e estágio /prod', () => {
  const config = loadConfig({ apiBaseUrl: '  https://api.beta.org/prod///  ' });

  assert.equal(config.apiBaseUrl, 'https://api.beta.org/prod');
});

test('mantém base vazia para API na mesma origem', () => {
  assert.equal(loadConfig().apiBaseUrl, '');
  assert.equal(loadConfig({ apiBaseUrl: '   ' }).apiBaseUrl, '');
});

test('prefixa rotas /api com exatamente uma barra', () => {
  const config = loadConfig({ apiBaseUrl: 'https://api.beta.org/prod////' });

  assert.equal(config.apiUrl('/api/courses'), 'https://api.beta.org/prod/api/courses');
  assert.equal(config.apiUrl('/api?status=published'), 'https://api.beta.org/prod/api?status=published');
});

test('preserva URL HTTPS absoluta', () => {
  const config = loadConfig({ apiBaseUrl: 'https://api.beta.org/prod' });
  const external = 'https://cdn.beta.org/media/aula.mp4?token=publico';

  assert.equal(config.apiUrl(external), external);
});

test('apiUrl bloqueia esquemas perigosos, origem remota HTTP e caminhos fora de /api', async t => {
  const config = loadConfig();
  const blocked = [
    ['javascript', 'javascript:alert(1)'],
    ['javascript com espaços e caixa mista', '  JaVaScRiPt:alert(1)  '],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript', 'vbscript:msgbox(1)'],
    ['protocol-relative', '//evil.example/api/courses'],
    ['HTTP remoto', 'http://api.beta.org/api/courses'],
    ['caminho absoluto não-/api', '/courses'],
    ['caminho relativo', 'api/courses'],
  ];

  for (const [name, value] of blocked) {
    await t.test(name, () => {
      assert.throws(() => config.apiUrl(value), /\/api/);
    });
  }
});

test('base HTTP é aceita somente para localhost e 127.0.0.1', () => {
  const localhost = loadConfig({ apiBaseUrl: 'http://localhost:8787/prod/' });
  const loopback = loadConfig({ apiBaseUrl: 'http://127.0.0.1:8787/' });
  const remote = loadConfig({ apiBaseUrl: 'http://api.beta.org/prod/' });

  assert.equal(localhost.apiBaseUrl, 'http://localhost:8787/prod');
  assert.equal(localhost.apiUrl('/api/courses'), 'http://localhost:8787/prod/api/courses');
  assert.equal(loopback.apiBaseUrl, 'http://127.0.0.1:8787');
  assert.equal(loopback.apiUrl('/api/courses'), 'http://127.0.0.1:8787/api/courses');
  assert.equal(remote.apiBaseUrl, '');
});

test('mediaUrl prefixa somente recursos internos em /api', () => {
  const config = loadConfig({ apiBaseUrl: 'https://api.beta.org/prod/' });

  assert.equal(
    config.mediaUrl('/api/media/apostila-1'),
    'https://api.beta.org/prod/api/media/apostila-1',
  );
  assert.equal(config.mediaUrl('assets/apostila.pdf'), 'assets/apostila.pdf');
  assert.equal(config.mediaUrl('/assets/apostila.pdf'), '/assets/apostila.pdf');
  assert.equal(config.mediaUrl('https://cdn.beta.org/aula.mp4'), 'https://cdn.beta.org/aula.mp4');
});

test('credentialsFor usa same-origin para rotas locais e origem HTTPS igual', () => {
  const relative = loadConfig({}, { hostname: 'cursos.beta.org', origin: 'https://cursos.beta.org' });
  const absoluteSameOrigin = loadConfig(
    { apiBaseUrl: 'https://cursos.beta.org' },
    { hostname: 'cursos.beta.org', origin: 'https://cursos.beta.org' },
  );

  assert.equal(relative.credentialsFor('/api/courses'), 'same-origin');
  assert.equal(absoluteSameOrigin.credentialsFor('/api/courses'), 'same-origin');
});

test('credentialsFor omite credenciais entre origens por padrão e inclui apenas com flag', () => {
  const defaultConfig = loadConfig(
    { apiBaseUrl: 'https://api.beta.org' },
    { hostname: 'cursos.beta.org', origin: 'https://cursos.beta.org' },
  );
  const optedIn = loadConfig(
    { apiBaseUrl: 'https://api.beta.org', crossOriginCredentials: 'include' },
    { hostname: 'cursos.beta.org', origin: 'https://cursos.beta.org' },
  );

  assert.equal(defaultConfig.credentialsFor('/api/admin/me'), 'omit');
  assert.equal(optedIn.credentialsFor('/api/admin/me'), 'include');
});

test('allowLocalFallback permanece desativado em produção e aceita previews locais ou flag explícita', () => {
  const production = loadConfig({}, { hostname: 'cursos.beta.org' });
  const localhost = loadConfig({}, { hostname: 'localhost', protocol: 'http:', port: '4173' });
  const loopback = loadConfig({}, { hostname: '127.0.0.1', protocol: 'http:', port: '4173' });
  const explicit = loadConfig({ allowLocalFallback: true }, { hostname: 'cursos.beta.org' });
  const truthyButNotBoolean = loadConfig({ allowLocalFallback: 'true' }, { hostname: 'cursos.beta.org' });

  assert.equal(production.allowLocalFallback, false);
  assert.equal(localhost.allowLocalFallback, true);
  assert.equal(loopback.allowLocalFallback, true);
  assert.equal(explicit.allowLocalFallback, true);
  assert.equal(truthyButNotBoolean.allowLocalFallback, false);
});

test('ativa o modo local quando o pacote de demonstração é aberto por file://', () => {
  const localFile = loadConfig({}, {
    hostname: '',
    origin: 'null',
    protocol: 'file:',
  });

  assert.equal(localFile.allowLocalFallback, true);
});
