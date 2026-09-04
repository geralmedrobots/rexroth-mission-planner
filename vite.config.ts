import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  test: {
    environment: 'jsdom',
    setupFiles: './src/tests/setup.ts',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts'],
  },
});
