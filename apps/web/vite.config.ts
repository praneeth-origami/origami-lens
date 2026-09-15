import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // Phase 16/A — GitHub OAuth login routes live on the API, but must be
      // reached through the frontend's own origin so the session cookie the
      // callback sets is scoped to this origin, not localhost:3100 — see
      // GITHUB_OAUTH_CALLBACK_URL in .env.example. No path rewrite: the API
      // mounts these at /auth/*, unlike /api which is stripped.
      '/auth': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
      // Phase 16/C-D — GitHub App / GitLab OAuth connect+callback routes,
      // same same-origin-cookie reasoning as /auth above (GITHUB_APP and
      // GITLAB_OAUTH_REDIRECT_URI both point at this frontend origin).
      '/providers': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
});
