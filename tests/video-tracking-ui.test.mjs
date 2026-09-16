import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const [appSource, styles, serverSource, sqliteMigration, postgresMigration, adminSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../railway/server.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../railway/migrations/sqlite/009_video_progress.sql', import.meta.url), 'utf8'),
  readFile(new URL('../railway/migrations/postgres/009_video_progress.sql', import.meta.url), 'utf8'),
  readFile(new URL('../admin.js', import.meta.url), 'utf8'),
]);

test('player rastreia YouTube, Vimeo e vídeo HTML5 e aguarda o fim real', () => {
  assert.match(appSource, /const VIDEO_COMPLETION_THRESHOLD = 0\.95/);
  assert.match(appSource, /https:\/\/www\.youtube\.com\/iframe_api/);
  assert.match(appSource, /https:\/\/player\.vimeo\.com\/api\/player\.js/);
  assert.match(appSource, /attachHtml5\(session, video\)/);
  assert.match(appSource, /enablejsapi=1/);
  assert.match(appSource, /timeupdate/);
  assert.match(appSource, /VIDEO_TRACKING_MAX_SEGMENT_SECONDS/);
  assert.match(appSource, /ended: session\.pendingEnded === true/);
  assert.match(appSource, /Continue até o vídeo terminar/);
  assert.match(appSource, /force: true, ended: true/);
  assert.match(appSource, /renderStepContent\(session\.courseId, lesson, lessonProgress, 'video'\)/);
  assert.match(appSource, /Saltos na linha do tempo não entram no percentual/);
});

test('confirmação manual permanece somente como contingência', () => {
  assert.match(appSource, /Problemas com a detecção automática\?/);
  assert.match(appSource, /Marcar vídeo como assistido/);
  assert.match(appSource, /data-video-manual-fallback/);
  assert.match(styles, /\.video-manual-fallback/);
});

test('servidor permite os SDKs oficiais e persiste progresso nos dois bancos', () => {
  assert.match(serverSource, /script-src[^\n]+https:\/\/www\.youtube\.com[^\n]+https:\/\/player\.vimeo\.com/);
  for (const migration of [sqliteMigration, postgresMigration]) {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS app_video_progress/);
    assert.match(migration, /tracking_cycle/);
    assert.match(migration, /intervals_json/);
    assert.match(migration, /completed_at/);
  }
});

test('acompanhamento administrativo exibe o percentual assistido', () => {
  assert.match(adminSource, /videoTracking\?\.percentage/);
  assert.match(adminSource, /Vídeo · \$\{Math\.floor/);
});
