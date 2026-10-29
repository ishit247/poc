import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = { '/api': { target: 'http://localhost:3000', rewrite: (p: string) => p.replace(/^\/api/, '') } };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify('0.0.0-phase3') },
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api },
});
