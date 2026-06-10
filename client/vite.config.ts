import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  // VITE_API_PROXY (env lub .env.local) pozwala wskazać backend na innym porcie
  // (np. drugi dev serwer z git worktree obok głównego na 3001).
  const env = loadEnv(mode, __dirname, '');
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api': env.VITE_API_PROXY || 'http://localhost:3001',
      },
    },
  };
});
