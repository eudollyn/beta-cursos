import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const dataFile = fileURLToPath(new URL('../data.js', import.meta.url));
const SYSTEM_FIELDS = new Set([
  'id',
  'version',
  'revision',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
]);
let cachedCourses;

export async function loadSeedCourses() {
  if (cachedCourses) return structuredClone(cachedCourses);
  const source = await readFile(dataFile, 'utf8');
  const sandbox = {
    structuredClone,
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${source}\nglobalThis.__BETA_COURSES = JSON.parse(JSON.stringify(COURSES_DATA));`,
    sandbox,
    {
      filename: resolve(dataFile),
      timeout: 1_000,
    },
  );
  if (!Array.isArray(sandbox.__BETA_COURSES) || !sandbox.__BETA_COURSES.length) {
    throw new Error('O catálogo inicial do Beta Cursos está vazio ou inválido.');
  }
  cachedCourses = structuredClone(sandbox.__BETA_COURSES);
  return structuredClone(cachedCourses);
}

export async function seedInitialCatalog(database) {
  const row = await database.prepare('SELECT COUNT(*) AS count FROM courses').first();
  if (Number(row?.count || 0) > 0) return { inserted: 0, skipped: true };
  const courses = await loadSeedCourses();
  const timestamp = new Date().toISOString();
  let inserted = 0;
  for (const course of courses) {
    const data = Object.fromEntries(
      Object.entries(course).filter(([key]) => !SYSTEM_FIELDS.has(key)),
    );
    const result = await database.prepare(`INSERT INTO courses
      (id, slug, title, status, data_json, version, created_at, updated_at, published_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`)
      .bind(
        course.id,
        course.slug,
        course.title,
        course.status === 'published' ? 'published' : 'draft',
        JSON.stringify(data),
        Math.max(1, Number(course.version || course.revision || 1)),
        course.createdAt || timestamp,
        timestamp,
        course.status === 'published' ? (course.publishedAt || timestamp) : null,
        'system@beta.local',
        'system@beta.local',
      )
      .run();
    inserted += Number(result?.meta?.changes || 0);
  }
  return { inserted, skipped: false };
}
