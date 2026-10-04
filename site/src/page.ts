import {
  CLIPS,
  CONTENT,
  INSTALL_COMMAND,
  SITE,
  VERSION,
  type Content,
  type Locale,
} from "./content.ts";

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function glyph(): string {
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16.2 6.7A9.5 9.5 0 0 0 6.7 16.2" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.3"/>
    <circle cx="16.2" cy="6.7" r="2.1" opacity="0.45"/>
    <circle cx="9.48" cy="9.48" r="2.1" opacity="0.75"/>
    <circle cx="6.7" cy="16.2" r="2.1"/>
    <circle cx="16.2" cy="16.2" r="3.25"/>
  </svg>`;
}

// Icon paths from Lucide 1.49.0 (copy, check, circle-alert, play), ISC License.
const ICON = `viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;

function copyField(t: Content, id: string, value: string, label: string): string {
  return `<div class="copy" data-value="${esc(value)}">
    <code id="${id}" tabindex="0">${esc(value)}</code>
    <button class="glass copy-button" type="button" hidden aria-label="${esc(label)}" title="${esc(label)}" aria-describedby="${id}" data-done="${esc(t.install.copied)}" data-failed="${esc(t.install.failed)}">
      <svg data-icon="copy" ${ICON}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      <svg data-icon="done" ${ICON}><path d="M20 6 9 17l-5-5"/></svg>
      <svg data-icon="failed" ${ICON}><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
    </button>
  </div>`;
}

export function renderPage(locale: Locale): string {
  const t = CONTENT[locale];
  return `<a class="skip" href="#main">${esc(t.skip)}</a>
  <header class="topbar frame">
    <a class="brand" href="${t.path}">${glyph()}<span>pk-annotator</span></a>
    <nav aria-label="${locale === "ko" ? "사이트" : "Site"}">
      <a href="${t.docsUrl}">${esc(t.docs)}</a>
      <a href="${t.otherLanguage.href}" hreflang="${t.otherLanguage.lang}" lang="${t.otherLanguage.lang}">${t.otherLanguage.label}</a>
    </nav>
  </header>
  <main id="main">
    <section class="hero frame" aria-labelledby="hero-title">
      <h1 id="hero-title">${esc(t.hero.title)}<br><em>${esc(t.hero.ending)}</em></h1>
      <p class="lead">${esc(t.hero.lead)}</p>
      <a class="glass ink" href="#install">${esc(t.hero.action)}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></a>
      <p class="hero-note">${esc(t.hero.note)}</p>
    </section>
    <section class="demo frame" aria-label="${esc(t.demo.label)}">
      <nav class="chapters" aria-label="${esc(t.demo.label)}">${CLIPS.map((clip, index) => `<a class="chapter" href="/demo/${clip}.mp4" data-clip="${clip}" data-caption="${esc(t.demo.summaries[index]!)}" aria-controls="demo-player"${index === 0 ? ' aria-current="true"' : ""}>${esc(t.demo.chapters[index]!)}</a>`).join("")}</nav>
      <figure>
        <div class="film">
          <video id="demo-player" controls playsinline muted preload="metadata" poster="/demo/agent.webp" src="/demo/agent.mp4" aria-describedby="demo-caption">
            ${esc(t.demo.fallback)}
          </video>
          <button class="play-cover" type="button" aria-controls="demo-player" hidden><img src="/demo/agent.webp" alt="" width="1600" height="1000"><span class="glass ink"><svg ${ICON}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>${esc(t.demo.play)}</span></button>
        </div>
        <figcaption id="demo-caption" aria-live="polite">${esc(t.demo.summaries[0]!)}</figcaption>
      </figure>
      <p class="media-status" role="status" aria-live="polite" data-loading hidden>${esc(t.demo.loading)}</p>
      <div class="media-error" role="alert" data-media-error hidden>
        <p>${esc(t.demo.error)}</p>
        <button class="glass" type="button" data-retry>${esc(t.demo.retry)}</button>
        <a data-video-link href="/demo/agent.mp4">${esc(t.demo.download)}</a>
      </div>
      <div class="demo-meta">
        <p>${esc(t.demo.footage)}</p>
      </div>
    </section>
    <section class="install measure" id="install" aria-labelledby="install-title">
      <h2 id="install-title">${esc(t.install.title)}</h2>
      <p>${esc(t.install.body)}</p>
      ${copyField(t, "setup-prompt", t.install.prompt, t.install.copyPrompt)}
      <p class="copy-status" role="status" aria-live="polite"></p>
      <details class="terminal">
        <summary>${esc(t.install.commandLabel)}</summary>
        <p>${esc(t.install.commandBody)}</p>
        ${copyField(t, "install-command", INSTALL_COMMAND, t.install.copyCommand)}
        <p><a href="/agents.md">${esc(t.install.guide)}</a> · <a href="/install.sh">install.sh</a></p>
      </details>
    </section>
  </main>
  <footer class="footer frame">
    <span>pk-annotator <span class="version">${VERSION}</span></span>
    <div><a href="https://github.com/pbkimdev/pk-annotator"><svg class="github" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>GitHub</a><a href="https://github.com/pbkimdev/pk-annotator/blob/main/LICENSE">${esc(t.footer.license)}</a><span>${esc(t.footer.author)}</span></div>
  </footer>`;
}

export function renderHead(locale: Locale): string {
  const t = CONTENT[locale];
  const url = `${SITE}${t.path}`;
  return `<title>${esc(t.title)}</title>
    <meta name="description" content="${esc(t.description)}">
    <link rel="canonical" href="${url}">
    <link rel="alternate" hreflang="en" href="${SITE}/">
    <link rel="alternate" hreflang="ko" href="${SITE}/ko/">
    <link rel="alternate" hreflang="x-default" href="${SITE}/">
    <meta property="og:type" content="website">
    <meta property="og:title" content="${esc(t.title)}">
    <meta property="og:description" content="${esc(t.description)}">
    <meta property="og:url" content="${url}">
    <meta property="og:image" content="${SITE}/og.png">
    <meta property="og:locale" content="${locale === "ko" ? "ko_KR" : "en_US"}">
    <meta name="twitter:card" content="summary_large_image">`;
}

export function renderNotFound(locale: Locale): string {
  const t = CONTENT[locale];
  return `<main class="not-found measure" id="main">
    <a class="brand" href="${t.path}">${glyph()}pk-annotator</a>
    <p class="version">404</p>
    <h1>${esc(t.notFound.title)}</h1>
    <p>${esc(t.notFound.body)}</p>
    <a href="${t.path}">${esc(t.notFound.home)}</a> · <a href="${t.otherLanguage.href}" lang="${t.otherLanguage.lang}">${t.otherLanguage.label}</a>
  </main>`;
}
