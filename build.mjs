import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, 'dist');
const client = resolve(dist, 'client');

const publicFiles = [
  'index.html',
  'styles.css',
  'admin.css',
  'config.js',
  'data.js',
  'catalog.js',
  'app.js',
  'admin.js',
  'favicon.png',
  'og.png',
  'manifest.webmanifest',
  'robots.txt',
];

await rm(dist, { recursive: true, force: true });
await mkdir(client, { recursive: true });

for (const file of publicFiles) {
  await cp(resolve(root, file), resolve(client, file));
}

const dataSource = await readFile(resolve(root, 'data.js'), 'utf8');
const dataSandbox = { structuredClone, window: {} };
vm.createContext(dataSandbox);
vm.runInContext(
  `${dataSource}
globalThis.__BETA_PUBLIC_BUILD = JSON.parse(JSON.stringify({
  quizConfig: QUIZ_CONFIG,
  pricingConfig: PRICING_CONFIG,
  courses: COURSES_DATA,
}));`,
  dataSandbox,
  { filename: resolve(root, 'data.js'), timeout: 1_000 },
);

const stripAnswerFields = value => {
  const secrets = new Set([
    'answer',
    'correct',
    'correctAnswer',
    'correctIndex',
    'correctOption',
    'correctOptionId',
    'isCorrect',
  ]);
  if (Array.isArray(value)) return value.map(stripAnswerFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !secrets.has(key))
      .map(([key, nested]) => [key, stripAnswerFields(nested)]),
  );
};

// Hosted builds start without bundled courses. Published content is loaded
// exclusively from the administrative database.
const publicCourses = [];
const publicDataSource = `// Beta Cursos — dados públicos iniciais gerados pelo build.
// Conteúdo restrito e gabaritos são carregados somente pelas APIs autorizadas.
const QUIZ_CONFIG = Object.freeze(${JSON.stringify(dataSandbox.__BETA_PUBLIC_BUILD.quizConfig, null, 2)});
const PRICING_CONFIG = Object.freeze(${JSON.stringify(dataSandbox.__BETA_PUBLIC_BUILD.pricingConfig, null, 2)});
const COURSES_DATA = ${JSON.stringify(publicCourses, null, 2)};
const MOCK_STUDENTS = [];
window.BetaAdminStudents = Object.freeze({ source: 'server', list: () => [] });
`;
await writeFile(resolve(client, 'data.js'), publicDataSource, 'utf8');

const worker = await readFile(resolve(root, 'worker.mjs'), 'utf8');
await mkdir(resolve(dist, 'server'), { recursive: true });
await writeFile(resolve(dist, 'server', 'index.js'), worker, 'utf8');

console.log('Build concluído em dist/.');
