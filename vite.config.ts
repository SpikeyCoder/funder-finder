import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
// Static prerender: stitches committed body fragments (prerender/bodies/*.html)
// into full dist/<route>/index.html pages at build time so no-JS crawlers see
// real content. Pure string assembly — no headless browser at build/deploy.
import prerender from './scripts/vite-plugin-prerender.mjs'

export default defineConfig({
  plugins: [react(), prerender()],
  base: '/',
})
