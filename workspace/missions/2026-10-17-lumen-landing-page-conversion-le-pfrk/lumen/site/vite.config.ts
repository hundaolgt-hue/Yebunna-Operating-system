import { defineConfig } from 'vite';

// Vercel sets VERCEL_ENV to "production" | "preview" | "development" during its builds.
// The dev-only "checkout link pending" notice is compiled in for anything that is NOT production.
const isPreviewBuild = process.env.VERCEL_ENV !== 'production';

export default defineConfig({
  define: { __PREVIEW_BUILD__: JSON.stringify(isPreviewBuild) },
  build: { target: 'es2020', assetsInlineLimit: 0 },
});
