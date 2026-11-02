import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any static host path (GitHub Pages, a subfolder, file servers).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
