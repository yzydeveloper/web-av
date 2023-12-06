import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  root:"./demo",
  base: './',
  build: {
    rollupOptions: {
      input: {
        'record-usermedia': resolve(__dirname, 'demo/record-usermedia.html')
      }
    },
    outDir: '../demo-dist',
    emptyOutDir:true
  }
})
