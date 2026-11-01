import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = { '/api': { target: 'http://localhost:3000', rewrite: (p: string) => p.replace(/^\/api/, '') } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: api },
  preview: { port: 4174, proxy: api },
});
