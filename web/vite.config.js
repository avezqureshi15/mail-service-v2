import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Where the dev server proxies the API. Overridable because port 4000 is a
// popular default - if another project already has it, run the backend
// elsewhere and point this at it rather than editing this file:
//   DEV_API_TARGET=http://localhost:4010 npm run dev
const apiTarget = process.env.DEV_API_TARGET ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev, so session cookies work without CORS exceptions.
    // Mirrors what netlify.toml does in production.
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/u': { target: apiTarget, changeOrigin: true },
      '/t': { target: apiTarget, changeOrigin: true },
    },
  },
});
