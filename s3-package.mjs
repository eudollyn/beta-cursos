import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = resolve(root, 'dist', 'client');
const destination = resolve(root, process.argv[2] || 's3-dist');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const index = await readFile(resolve(source, 'index.html'));
await writeFile(resolve(destination, 'error.html'), index);

console.log(`Pacote estático do S3 concluído em ${destination}`);
