import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(nodeScrypt);

const DEFAULT_SCRYPT = Object.freeze({
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
  keyLength: 64,
});

function positiveInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function powerOfTwo(value, fallback) {
  const parsed = positiveInteger(value, fallback, 1_024, 1_048_576);
  return (parsed & (parsed - 1)) === 0 ? parsed : fallback;
}

function resolveScryptOptions(options = {}) {
  return {
    cost: powerOfTwo(options.cost, DEFAULT_SCRYPT.cost),
    blockSize: positiveInteger(options.blockSize, DEFAULT_SCRYPT.blockSize, 1, 32),
    parallelization: positiveInteger(options.parallelization, DEFAULT_SCRYPT.parallelization, 1, 16),
    keyLength: positiveInteger(options.keyLength, DEFAULT_SCRYPT.keyLength, 32, 128),
  };
}

export async function hashPassword(password, options = {}) {
  const value = String(password || '');
  const config = resolveScryptOptions(options);
  const salt = randomBytes(16);
  const maxmem = Math.max(
    64 * 1024 * 1024,
    128 * config.cost * config.blockSize + 1024 * 1024,
  );
  const derived = await scrypt(value, salt, config.keyLength, {
    N: config.cost,
    r: config.blockSize,
    p: config.parallelization,
    maxmem,
  });
  return [
    'scrypt',
    config.cost,
    config.blockSize,
    config.parallelization,
    config.keyLength,
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, encoded) {
  try {
    const [algorithm, cost, blockSize, parallelization, keyLength, saltValue, hashValue, extra] =
      String(encoded || '').split('$');
    if (algorithm !== 'scrypt' || extra !== undefined) return false;
    const config = resolveScryptOptions({
      cost: Number(cost),
      blockSize: Number(blockSize),
      parallelization: Number(parallelization),
      keyLength: Number(keyLength),
    });
    if (
      config.cost !== Number(cost)
      || config.blockSize !== Number(blockSize)
      || config.parallelization !== Number(parallelization)
      || config.keyLength !== Number(keyLength)
    ) {
      return false;
    }
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (salt.length < 16 || expected.length !== config.keyLength) return false;
    const maxmem = Math.max(
      64 * 1024 * 1024,
      128 * config.cost * config.blockSize + 1024 * 1024,
    );
    const candidate = Buffer.from(await scrypt(String(password || ''), salt, config.keyLength, {
      N: config.cost,
      r: config.blockSize,
      p: config.parallelization,
      maxmem,
    }));
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

export function createOpaqueToken() {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token, secret = '') {
  const value = String(token || '');
  const key = String(secret || '');
  return key
    ? createHmac('sha256', key).update(value, 'utf8').digest('hex')
    : createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashMetadata(value) {
  const normalized = String(value || '').slice(0, 1_024);
  return normalized ? createHash('sha256').update(normalized, 'utf8').digest('hex') : null;
}

export function createId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
