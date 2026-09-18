import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:5178; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none';",
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    license: { fileName: 'THIRD_PARTY_LICENSES.md' },
  },
});
