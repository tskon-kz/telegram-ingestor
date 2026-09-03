import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by Fastify under /app in production. Dev proxies API calls to the backend.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    proxy: {
      '/portal': 'http://localhost:8080',
      '/login': 'http://localhost:8080',
    },
  },
});
