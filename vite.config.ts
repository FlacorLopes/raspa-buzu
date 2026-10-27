import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true },
  build: {
    rollupOptions: { input: { camera: 'spike/camera.html' } },
  },
});
