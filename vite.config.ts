import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 serves over a self-signed certificate so phones on the LAN can open the camera.
export default defineConfig({
  plugins: process.env.HTTPS ? [basicSsl()] : [],
  server: { host: true },
  build: {
    rollupOptions: { input: { camera: 'spike/camera.html' } },
  },
});
