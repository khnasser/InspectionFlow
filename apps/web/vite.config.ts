import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@inspectionflow/engine': fileURLToPath(new URL('../../packages/engine/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/v1': 'http://localhost:3000', '/verify': 'http://localhost:3000', '/health': 'http://localhost:3000' },
  },
});
