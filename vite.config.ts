import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the Express server under /dashboard (the URL registered
// as the Wix dashboard page extension). In `npm run dev` Vite proxies the API.
export default defineConfig({
  root: 'src/dashboard',
  base: '/dashboard/',
  plugins: [react()],
  build: { outDir: '../../dist/dashboard', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/oauth': 'http://localhost:3000' },
  },
});
