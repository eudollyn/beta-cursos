import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFilesystemMediaStore } from '../railway/storage.mjs';

async function temporaryStore(t, maxBytes, existing = []) {
  const root = await mkdtemp(join(tmpdir(), 'beta-storage-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [key, contents] of existing) {
    const path = join(root, 'objects', ...key.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  const store = await createFilesystemMediaStore({
    localPath: root,
    prefix: '',
    maxBytes,
  });
  t.after(() => store.close());
  return { root, store };
}

function assertCapacityError(error, expected) {
  assert.equal(error?.code, 'STORAGE_CAPACITY_EXCEEDED');
  assert.equal(error?.name, 'StorageCapacityError');
  assert.deepEqual(error?.details, expected);
  assert.deepEqual(Object.keys(error?.details || {}).sort(), [
    'availableBytes',
    'incomingBytes',
    'maxBytes',
    'projectedBytes',
    'replacedBytes',
    'usedBytes',
  ]);
  return true;
}

test('filesystem contabiliza objetos existentes e expõe somente metadados seguros ao exceder a cota', async t => {
  const { root, store } = await temporaryStore(t, 10, [
    ['pdf/existente.bin', Buffer.alloc(6, 1)],
  ]);

  let capacityError;
  await assert.rejects(
    store.put('pdf/novo.bin', Buffer.alloc(5, 2)),
    error => {
      capacityError = error;
      return assertCapacityError(error, {
        maxBytes: 10,
        usedBytes: 6,
        availableBytes: 4,
        incomingBytes: 5,
        replacedBytes: 0,
        projectedBytes: 11,
      });
    },
  );
  assert.equal(await store.head('pdf/novo.bin'), null);
  const serializedDetails = JSON.stringify(capacityError.details);
  assert.doesNotMatch(serializedDetails, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serializedDetails, /existente|novo|pdf/i);
});

test('filesystem rejeita antes de substituir e preserva o objeto anterior', async t => {
  const original = Buffer.from('123456');
  const { root, store } = await temporaryStore(t, 10, [
    ['pdf/apostila.bin', original],
  ]);

  await assert.rejects(
    store.put('pdf/apostila.bin', Buffer.alloc(11, 7)),
    error => assertCapacityError(error, {
      maxBytes: 10,
      usedBytes: 6,
      availableBytes: 4,
      incomingBytes: 11,
      replacedBytes: 6,
      projectedBytes: 11,
    }),
  );
  assert.deepEqual(
    await readFile(join(root, 'objects', 'pdf', 'apostila.bin')),
    original,
  );

  await store.put('pdf/apostila.bin', Buffer.alloc(4, 8));
  await store.put('pdf/complemento.bin', Buffer.alloc(6, 9));
  await assert.rejects(
    store.put('pdf/excesso.bin', Buffer.alloc(1)),
    error => assertCapacityError(error, {
      maxBytes: 10,
      usedBytes: 10,
      availableBytes: 0,
      incomingBytes: 1,
      replacedBytes: 0,
      projectedBytes: 11,
    }),
  );
});

test('filesystem serializa puts concorrentes para impedir ultrapassagem da cota', async t => {
  const { store } = await temporaryStore(t, 10);
  const results = await Promise.allSettled([
    store.put('video/primeiro.bin', Buffer.alloc(6, 1)),
    store.put('video/segundo.bin', Buffer.alloc(6, 2)),
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'STORAGE_CAPACITY_EXCEEDED');
  const heads = await Promise.all([
    store.head('video/primeiro.bin'),
    store.head('video/segundo.bin'),
  ]);
  assert.equal(heads.filter(Boolean).length, 1);
  assert.equal(heads.find(Boolean).size, 6);
});

test('filesystem libera capacidade contabilizada depois de delete', async t => {
  const { store } = await temporaryStore(t, 10);
  await store.put('image/capa.bin', Buffer.alloc(10, 1));
  await store.delete('image/capa.bin');
  await store.put('image/nova-capa.bin', Buffer.alloc(10, 2));
  assert.equal((await store.head('image/nova-capa.bin')).size, 10);
});
