import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

test('Dockerfile instala dependências a partir do lockfile imutável', () => {
  assert.match(
    dockerfile,
    /COPY\s+package\.json\s+pnpm-lock\.yaml\s+\.\//,
    'a camada de dependências deve copiar o manifesto e o lockfile antes da instalação',
  );
  assert.match(
    dockerfile,
    /RUN\s+pnpm\s+install\s+--frozen-lockfile/,
    'a instalação da imagem deve falhar se o lockfile divergir do manifesto',
  );
  assert.doesNotMatch(
    dockerfile,
    /pnpm\s+install\s+--no-frozen-lockfile/,
    'o Dockerfile não pode permitir que o build altere ou ignore o lockfile',
  );
});
