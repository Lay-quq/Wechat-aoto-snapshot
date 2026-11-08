import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
export default defineConfig({ base: './', publicDir: false, plugins: [react()], build: { outDir: 'dist-standard', emptyOutDir: true, sourcemap: false, rollupOptions: { input: resolve(__dirname, 'standard.html') } } })
