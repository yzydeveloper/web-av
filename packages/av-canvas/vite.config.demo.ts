import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  root:"./demo",
  base: './',
  build: {
    rollupOptions: {
      input: {
        'record-avcanvas': resolve(__dirname, 'demo/record-avcanvas.html')
      }
    },
    outDir: '../demo-dist',
    emptyOutDir:true
  }
})
