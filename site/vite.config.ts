import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { renderHead, renderNotFound, renderPage } from "./src/page.ts";
import type { Locale } from "./src/content.ts";

function pages(): Plugin {
  return {
    name: "pk-annotator-site-pages",
    transformIndexHtml(html, context) {
      const page = context.path.replace(/^\//, "");
      const locale: Locale = page.startsWith("ko/") ? "ko" : "en";
      if (page === "404.html") {
        return html
          .replace(
            "<!--head-->",
            `<title>404 · pk-annotator</title><meta name="robots" content="noindex">`,
          )
          .replace("<!--body-->", renderNotFound(locale));
      }
      return html
        .replace("<!--head-->", renderHead(locale))
        .replace("<!--body-->", renderPage(locale));
    },
  };
}

const input = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [pages()],
  build: {
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { en: input("index.html"), ko: input("ko/index.html"), notFound: input("404.html") },
    },
  },
});
