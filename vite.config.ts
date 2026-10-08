import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./client'),
  publicDir: r('./client/public'),
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@data': r('./data'),
    },
  },
  server: {
    host: true,
    port: 5173,
    fs: { allow: [r('.')] },
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
  },
  worker: { format: 'es' },
});
