import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routesDirectory: './src/app/routes', generatedRouteTree: './src/app/routeTree.gen.ts' }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  // '0.0.0.0' (not the previous '127.0.0.1') so a phone/tablet on the
  // same LAN can reach this dev server too — matching apps/api/src/main.ts,
  // which already binds 0.0.0.0 for exactly this reason.
  server: { port: 5173, host: '0.0.0.0' },
});
