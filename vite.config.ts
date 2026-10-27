import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS=1 serves over a self-signed certificate so phones on the LAN can open the camera.
// HMR stays off in that mode: its websocket upgrade crashes Vite 8's HTTPS server on Node 22.21.
const https = Boolean(process.env.HTTPS);

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: { host: true, hmr: !https },
  build: {
    rollupOptions: { input: { camera: 'spike/camera.html' } },
  },
});
