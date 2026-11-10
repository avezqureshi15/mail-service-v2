import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, so session cookies work without CORS exceptions.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/u': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
