import { defineConfig } from 'vite';

export default defineConfig({
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')) },
  server: { host: true },
  build: {
    rollupOptions: { input: { camera: 'spike/camera.html' } },
  },
});
