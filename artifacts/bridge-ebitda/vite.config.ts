import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const envDir = path.resolve(import.meta.dirname, '../..');

export default defineConfig(async ({ mode, command, isPreview }) => {
  // Read the root .env for server configuration only. Vite still exposes
  // only VITE_* variables to browser code; never inject this object via define.
  const env = loadEnv(mode, envDir, '');
  const rawPort = env.PORT || env.FRONTEND_PORT || '5173';
  const port = Number(rawPort);
  const apiPort = Number(env.API_PORT || '3000');

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid frontend port: "${rawPort}"`);
  }
  if (!Number.isInteger(apiPort) || apiPort <= 0 || apiPort > 65535) {
    throw new Error('API_PORT must be an integer between 1 and 65535.');
  }

  return {
    envDir,
    base: env.BASE_PATH || '/',
    plugins: [
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      ...(process.env.NODE_ENV !== 'production' &&
      process.env.REPL_ID !== undefined
        ? [
            await import('@replit/vite-plugin-cartographer').then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, '..'),
              }),
            ),
            await import('@replit/vite-plugin-dev-banner').then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      proxy:
        command === 'serve' && !isPreview
          ? {
              '/api': {
                target: `http://localhost:${apiPort}`,
                changeOrigin: true,
              },
            }
          : undefined,
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
