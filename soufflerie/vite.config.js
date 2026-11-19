import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html') },
    },
  },
  resolve: { dedupe: ['three'] },
  optimizeDeps: { include: ['three', 'three/addons/controls/OrbitControls.js', 'three/addons/environments/RoomEnvironment.js', 'three/addons/loaders/GLTFLoader.js', 'three/addons/loaders/STLLoader.js', 'three/addons/loaders/OBJLoader.js'] },
  server: { host: '127.0.0.1', port: 5173 },
});
