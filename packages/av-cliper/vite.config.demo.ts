import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  root:"./demo",
  base: './',
  server:{
    host: "0.0.0.0",
    port: 6066
  },
  publicDir:resolve(__dirname,"../../doc-site/public"),
  build: {
    rollupOptions: {
      input: {
        'concat-media': resolve(__dirname, 'demo/concat-media.html'),
        'decode-media': resolve(__dirname, 'demo/decode-media.html'),
        chromakey: resolve(__dirname, 'demo/chromakey.html'),
        'fast-concat-mp4': resolve(__dirname, 'demo/fast-concat-mp4.html')
      }
    },
    outDir: "../demo-dist",
    emptyOutDir:true
  }
})
