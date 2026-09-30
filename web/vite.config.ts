import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

const version = pkg.version

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { proxy: {
    '/api': 'http://127.0.0.1:8080',
    '/ws': { target: 'ws://127.0.0.1:8080', ws: true },
  } },
})
