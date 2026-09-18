import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const source = fileURLToPath(new URL('../../client/', import.meta.url));
await mkdir(join(desktop, 'dist', 'licenses'), { recursive: true });
await cp(join(source, 'public', 'live2d'), join(desktop, 'dist', 'live2d'), { recursive: true });
await cp(join(source, 'model-licenses'), join(desktop, 'dist', 'licenses'), { recursive: true });
console.log('Prepared local Live2D runtime, Kirian model assets and preserved notices.');
