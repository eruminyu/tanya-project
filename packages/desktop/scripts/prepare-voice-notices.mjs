import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(root + 'dist/licenses', { recursive: true });
await copyFile(root + 'src/vendor/airi-audio/LICENSE', root + 'dist/licenses/airi-audio-MIT.txt');
await copyFile(root + 'src/vendor/airi-audio/provenance.json', root + 'dist/licenses/airi-audio-provenance.json');
