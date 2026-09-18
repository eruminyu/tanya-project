import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const packages = fileURLToPath(new URL('../', import.meta.url));
const gateway = process.env.KIRIAN_WEB_DEV_GATEWAY ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [vue()],
  base: '/',
  // The renderer components, shared types and Cubism vendor code live in sibling packages.
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    fs: { allow: [packages] },
    proxy: { '/demo': { target: gateway, ws: true, changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, license: { fileName: 'THIRD_PARTY_LICENSES.md' } },
});
