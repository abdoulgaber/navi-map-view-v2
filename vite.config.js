import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base is needed for GitHub Pages (repo sub-path); keep dev at '/'
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/navi-map-view-v2/' : '/',
  // MapLibre's worker is an ES module; it is imported with ?worker&url in
  // MapCanvas and handed to setWorkerUrl(), so it must be emitted as ESM.
  worker: { format: 'es' },
}))
