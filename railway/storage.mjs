import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import config from './config.mjs';

function normalizeStorageKey(value) {
  const key = String(value || '').trim().replace(/^\/+/, '');
  if (!key || key.length > 1024 || key.includes('\\') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError('A chave do arquivo é inválida.');
  }
  const parts = key.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('A chave do arquivo contém segmentos inseguros.');
  }
  return parts.join('/');
}

function withPrefix(prefix, key) {
  const normalized = normalizeStorageKey(key);
  return prefix ? `${prefix}/${normalized}` : normalized;
}

function safePath(root, key, suffix = '') {
  const target = resolve(root, ...normalizeStorageKey(key).split('/')) + suffix;
  if (!target.startsWith(`${root}${sep}`)) throw new TypeError('A chave do arquivo saiu do diretório permitido.');
  return target;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => /^[A-Za-z0-9_.-]{1,128}$/.test(key) && child !== undefined && child !== null)
      .map(([key, child]) => [key.toLowerCase(), String(child).slice(0, 2048)]),
  );
}

function normalizeHttpMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const field of ['contentType', 'contentDisposition', 'cacheControl', 'contentLanguage', 'contentEncoding']) {
    if (value[field] !== undefined && value[field] !== null) {
      result[field] = String(value[field]).replace(/[\r\n]/g, '').slice(0, 1024);
    }
  }
  return result;
}

function normalizedRange(value, size) {
  if (!value) return null;
  const offset = Number(value.offset);
  const length = Number(value.length);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError('A faixa solicitada é inválida.');
  }
  if (offset >= size) throw new RangeError('A faixa solicitada começa depois do fim do arquivo.');
  const end = Math.min(offset + length - 1, size - 1);
  return { offset, length: end - offset + 1, end };
}

async function writeBody(target, body) {
  if (typeof body === 'string' || Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    await writeFile(target, body);
    return;
  }
  if (body instanceof ArrayBuffer) {
    await writeFile(target, new Uint8Array(body));
    return;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    await pipeline(Readable.fromWeb(body.stream()), createWriteStream(target, { flags: 'wx' }));
    return;
  }
  if (body && typeof body.getReader === 'function') {
    await pipeline(Readable.fromWeb(body), createWriteStream(target, { flags: 'wx' }));
    return;
  }
  if (body && typeof body.pipe === 'function') {
    await pipeline(body, createWriteStream(target, { flags: 'wx' }));
    return;
  }
  throw new TypeError('O conteúdo do arquivo não é compatível com o armazenamento.');
}

async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
    await rm(destination, { force: true });
    await rename(source, destination);
  }
}

async function readLocalMetadata(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return {};
    throw error;
  }
}

async function removeIfPresent(path) {
  try {
    await rm(path, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function toWebStream(body) {
  if (!body) return null;
  if (typeof body.transformToWebStream === 'function') return body.transformToWebStream();
  if (typeof body.getReader === 'function') return body;
  if (body instanceof Readable || typeof body.pipe === 'function') return Readable.toWeb(body);
  return body;
}

function notFoundError(error) {
  if (error?.name === 'NoSuchBucket') return false;
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  return status === 404 || ['NoSuchKey', 'NotFound'].includes(error?.name);
}

function normalizedCapacity(value) {
  if (value === undefined || value === null || value === '') return null;
  const capacity = Number(value);
  if (capacity === 0) return null;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new TypeError('O limite do armazenamento local deve ser um número inteiro positivo de bytes.');
  }
  return capacity;
}

function knownBodySize(body) {
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  return null;
}

async function directorySize(root) {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

async function fileSize(path) {
  try {
    const details = await stat(path);
    return details.isFile() ? details.size : 0;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function capacityExceededError({ maxBytes, usedBytes, incomingBytes, replacedBytes }) {
  const projectedBytes = usedBytes - replacedBytes + incomingBytes;
  const error = new Error('O armazenamento local atingiu o limite de capacidade.');
  error.name = 'StorageCapacityError';
  error.code = 'STORAGE_CAPACITY_EXCEEDED';
  error.details = Object.freeze({
    maxBytes,
    usedBytes,
    availableBytes: Math.max(0, maxBytes - usedBytes),
    incomingBytes,
    replacedBytes,
    projectedBytes,
  });
  return error;
}

export async function createFilesystemMediaStore(storageConfig) {
  const root = resolve(storageConfig.localPath);
  const objectsRoot = resolve(root, 'objects');
  const metadataRoot = resolve(root, 'metadata');
  const maxBytes = normalizedCapacity(storageConfig.maxBytes);
  await Promise.all([
    mkdir(objectsRoot, { recursive: true }),
    mkdir(metadataRoot, { recursive: true }),
  ]);
  let usedBytes = await directorySize(objectsRoot);
  let mutationQueue = Promise.resolve();

  function locations(key) {
    const storageKey = withPrefix(storageConfig.prefix, key);
    return {
      storageKey,
      objectPath: safePath(objectsRoot, storageKey),
      metadataPath: safePath(metadataRoot, storageKey, '.json'),
    };
  }

  function serializeMutation(operation) {
    const execution = mutationQueue.then(operation, operation);
    mutationQueue = execution.catch(() => {});
    return execution;
  }

  function assertCapacity(incomingBytes, replacedBytes) {
    if (maxBytes === null) return;
    if (usedBytes - replacedBytes + incomingBytes > maxBytes) {
      throw capacityExceededError({
        maxBytes,
        usedBytes,
        incomingBytes,
        replacedBytes,
      });
    }
  }

  return Object.freeze({
    driver: 'filesystem',

    async put(key, body, options = {}) {
      return serializeMutation(async () => {
        const { storageKey, objectPath, metadataPath } = locations(key);
        await Promise.all([
          mkdir(dirname(objectPath), { recursive: true }),
          mkdir(dirname(metadataPath), { recursive: true }),
        ]);
        const replacedBytes = await fileSize(objectPath);
        const declaredBytes = knownBodySize(body);
        if (declaredBytes !== null) assertCapacity(declaredBytes, replacedBytes);
        const marker = randomUUID();
        const temporaryObject = `${objectPath}.${marker}.tmp`;
        const temporaryMetadata = `${metadataPath}.${marker}.tmp`;
        let committedBytes = null;
        try {
          await writeBody(temporaryObject, body);
          const objectStat = await stat(temporaryObject);
          assertCapacity(objectStat.size, replacedBytes);
          const metadata = {
            storageKey,
            size: objectStat.size,
            uploadedAt: new Date().toISOString(),
            httpMetadata: normalizeHttpMetadata(options.httpMetadata),
            customMetadata: normalizeMetadata(options.customMetadata),
          };
          await writeFile(temporaryMetadata, JSON.stringify(metadata), { flag: 'wx' });
          await replaceFile(temporaryObject, objectPath);
          committedBytes = objectStat.size;
          usedBytes = usedBytes - replacedBytes + committedBytes;
          try {
            await replaceFile(temporaryMetadata, metadataPath);
          } catch (error) {
            await removeIfPresent(objectPath);
            usedBytes = Math.max(0, usedBytes - committedBytes);
            throw error;
          }
          return {
            key,
            size: objectStat.size,
            etag: metadata.customMetadata.sha256
              ? `"sha256-${metadata.customMetadata.sha256}"`
              : `"local-${objectStat.size}-${Math.trunc(objectStat.mtimeMs)}"`,
            ...metadata,
          };
        } finally {
          await Promise.allSettled([
            removeIfPresent(temporaryObject),
            removeIfPresent(temporaryMetadata),
          ]);
        }
      });
    },

    async get(key, options = {}) {
      const { objectPath, metadataPath } = locations(key);
      let objectStat;
      try {
        objectStat = await stat(objectPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const metadata = await readLocalMetadata(metadataPath);
      const range = normalizedRange(options.range, objectStat.size);
      const stream = createReadStream(objectPath, range ? { start: range.offset, end: range.end } : undefined);
      return {
        key,
        body: Readable.toWeb(stream),
        size: objectStat.size,
        range,
        etag: metadata.customMetadata?.sha256
          ? `"sha256-${metadata.customMetadata.sha256}"`
          : `"local-${objectStat.size}-${Math.trunc(objectStat.mtimeMs)}"`,
        httpMetadata: metadata.httpMetadata || {},
        customMetadata: metadata.customMetadata || {},
        uploadedAt: metadata.uploadedAt || null,
      };
    },

    async head(key) {
      const { objectPath, metadataPath } = locations(key);
      let objectStat;
      try {
        objectStat = await stat(objectPath);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const metadata = await readLocalMetadata(metadataPath);
      return {
        key,
        size: objectStat.size,
        etag: metadata.customMetadata?.sha256
          ? `"sha256-${metadata.customMetadata.sha256}"`
          : `"local-${objectStat.size}-${Math.trunc(objectStat.mtimeMs)}"`,
        httpMetadata: metadata.httpMetadata || {},
        customMetadata: metadata.customMetadata || {},
        uploadedAt: metadata.uploadedAt || null,
      };
    },

    async delete(key) {
      return serializeMutation(async () => {
        const { objectPath, metadataPath } = locations(key);
        const removedBytes = await fileSize(objectPath);
        await Promise.all([
          removeIfPresent(objectPath),
          removeIfPresent(metadataPath),
        ]);
        usedBytes = Math.max(0, usedBytes - removedBytes);
      });
    },

    async healthcheck() {
      const probe = resolve(root, `.health-${randomUUID()}`);
      try {
        await writeFile(probe, 'ok', { flag: 'wx' });
        const probeStat = await stat(probe);
        if (probeStat.size !== 2) throw new Error('A verificação do armazenamento local falhou.');
        return { ok: true, driver: 'filesystem' };
      } finally {
        await removeIfPresent(probe);
      }
    },

    async close() {},
  });
}

export async function createS3MediaStore(storageConfig) {
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-s3');
  } catch (error) {
    const wrapped = new Error(
      'O driver S3 exige a dependência @aws-sdk/client-s3. Instale-a antes de iniciar o serviço hospedado.',
      { cause: error },
    );
    wrapped.code = 'S3_SDK_MISSING';
    throw wrapped;
  }

  const {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
  } = sdk;
  const credentials = {
    accessKeyId: storageConfig.accessKeyId,
    secretAccessKey: storageConfig.secretAccessKey,
    ...(storageConfig.sessionToken ? { sessionToken: storageConfig.sessionToken } : {}),
  };
  const client = new S3Client({
    region: storageConfig.region,
    ...(storageConfig.endpoint ? { endpoint: storageConfig.endpoint } : {}),
    credentials,
    forcePathStyle: storageConfig.forcePathStyle,
  });

  function objectKey(key) {
    return withPrefix(storageConfig.prefix, key);
  }

  return Object.freeze({
    driver: 's3',

    async put(key, body, options = {}) {
      const httpMetadata = normalizeHttpMetadata(options.httpMetadata);
      const customMetadata = normalizeMetadata(options.customMetadata);
      const response = await client.send(new PutObjectCommand({
        Bucket: storageConfig.bucket,
        Key: objectKey(key),
        Body: body instanceof ArrayBuffer ? new Uint8Array(body) : body,
        ...(httpMetadata.contentType ? { ContentType: httpMetadata.contentType } : {}),
        ...(httpMetadata.contentDisposition ? { ContentDisposition: httpMetadata.contentDisposition } : {}),
        ...(httpMetadata.cacheControl ? { CacheControl: httpMetadata.cacheControl } : {}),
        ...(httpMetadata.contentLanguage ? { ContentLanguage: httpMetadata.contentLanguage } : {}),
        ...(httpMetadata.contentEncoding ? { ContentEncoding: httpMetadata.contentEncoding } : {}),
        ...(Object.keys(customMetadata).length ? { Metadata: customMetadata } : {}),
      }));
      return {
        key,
        etag: response.ETag || null,
        version: response.VersionId || null,
        httpMetadata,
        customMetadata,
      };
    },

    async get(key, options = {}) {
      const range = options.range
        ? (() => {
          const offset = Number(options.range.offset);
          const length = Number(options.range.length);
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0) {
            throw new RangeError('A faixa solicitada é inválida.');
          }
          return { offset, length, end: offset + length - 1 };
        })()
        : null;
      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: storageConfig.bucket,
          Key: objectKey(key),
          ...(range ? { Range: `bytes=${range.offset}-${range.end}` } : {}),
        }));
        const totalFromRange = response.ContentRange?.match(/\/(\d+)$/)?.[1];
        return {
          key,
          body: toWebStream(response.Body),
          size: Number(totalFromRange || response.ContentLength || 0),
          range,
          etag: response.ETag || null,
          httpMetadata: {
            contentType: response.ContentType,
            contentDisposition: response.ContentDisposition,
            cacheControl: response.CacheControl,
            contentLanguage: response.ContentLanguage,
            contentEncoding: response.ContentEncoding,
          },
          customMetadata: response.Metadata || {},
          uploadedAt: response.LastModified?.toISOString?.() || null,
        };
      } catch (error) {
        if (notFoundError(error)) return null;
        throw error;
      }
    },

    async head(key) {
      try {
        const response = await client.send(new HeadObjectCommand({
          Bucket: storageConfig.bucket,
          Key: objectKey(key),
        }));
        return {
          key,
          size: Number(response.ContentLength || 0),
          etag: response.ETag || null,
          httpMetadata: {
            contentType: response.ContentType,
            contentDisposition: response.ContentDisposition,
            cacheControl: response.CacheControl,
            contentLanguage: response.ContentLanguage,
            contentEncoding: response.ContentEncoding,
          },
          customMetadata: response.Metadata || {},
          uploadedAt: response.LastModified?.toISOString?.() || null,
        };
      } catch (error) {
        if (notFoundError(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({
        Bucket: storageConfig.bucket,
        Key: objectKey(key),
      }));
    },

    async healthcheck() {
      const abortSignal = AbortSignal.timeout(storageConfig.healthcheckTimeoutMs || 3000);
      await client.send(new ListObjectsV2Command({
        Bucket: storageConfig.bucket,
        Prefix: storageConfig.prefix || undefined,
        MaxKeys: 1,
      }), { abortSignal });
      return { ok: true, driver: 's3' };
    },

    async close() {
      client.destroy();
    },
  });
}

export async function createMediaStore(input = config.storage) {
  const storageConfig = input?.storage || input;
  if (!storageConfig || typeof storageConfig !== 'object') {
    throw new TypeError('A configuração do armazenamento não foi informada.');
  }
  if (storageConfig.driver === 'filesystem') return createFilesystemMediaStore(storageConfig);
  if (storageConfig.driver === 's3') return createS3MediaStore(storageConfig);
  throw new TypeError(`Driver de armazenamento não suportado: ${storageConfig.driver || 'vazio'}.`);
}

export const createStorage = createMediaStore;

export default createMediaStore;
