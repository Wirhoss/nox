import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import vueDevTools from 'vite-plugin-vue-devtools'

const projectRoot = fileURLToPath(new URL('./', import.meta.url))
const apiTarget = process.env.NOX_API_TARGET ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [vue(), vueDevTools()],
  resolve: {
    alias: {
      '@': projectRoot,
    },
  },
  server: {
    proxy: {
      '/auth': { target: apiTarget },
      '^/chat/(stream|conversations)': { target: apiTarget },
    },
  },
})
