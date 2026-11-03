import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

/** Where the site is published. Set SITE_URL (or change the default) when it moves to its own domain. */
const SITE_URL = (process.env.SITE_URL || 'https://adam2kg.github.io/3d-city/').replace(/\/?$/, '/');
const PAGES = ['', 'about/'];

/** Fills %SITE_URL% in the pages (canonical and preview links must be absolute) and writes sitemap.xml and robots.txt. */
function site(): Plugin {
  return {
    name: 'your-place-site',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('%SITE_URL%', SITE_URL) },
    generateBundle() {
      const day = new Date().toISOString().slice(0, 10);
      const urls = PAGES.map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${day}</lastmod></url>`).join('\n');
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      });
      // only read by crawlers at a domain's root, i.e. once the site has its own domain
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n` });
    },
  };
}

export default defineConfig({
  // Relative base so the build works from any static host path (GitHub Pages, a subfolder, file servers).
  base: './',
  plugins: [site()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        about: fileURLToPath(new URL('./about/index.html', import.meta.url)),
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as Parameters<typeof defineConfig>[0]);
