import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/** Build web autonome de l'interface : application mobile (Capacitor) et version navigateur. */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: { outDir: resolve('out/web'), emptyOutDir: true, target: 'es2022' },
  resolve: { alias: { '@': resolve('src/renderer/src') } }
})
