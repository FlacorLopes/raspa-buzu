import { defineConfig } from 'vite';

export default defineConfig({
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(5, 16).replace('T', ' ')) },
  server: { host: true },
  build: {
    rollupOptions: { input: { camera: 'camera/index.html', spike: 'spike/camera.html', swipe: 'spike/swipe.html' } },
  },
});
