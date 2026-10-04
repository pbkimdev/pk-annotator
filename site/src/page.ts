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

function copyField(t: Content, id: string, value: string, label: string): string {
  return `<div class="copy" data-value="${esc(value)}">
    <code id="${id}" tabindex="0">${esc(value)}</code>
    <button class="copy-button" type="button" hidden aria-describedby="${id}" data-done="${esc(t.install.copied)}" data-failed="${esc(t.install.failed)}">${esc(label)}</button>
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
      <a class="button primary" href="#install">${esc(t.hero.action)}<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5"/></svg></a>
      <p class="hero-note">${esc(t.hero.note)}</p>
    </section>
    <section class="demo frame" aria-label="${esc(t.demo.label)}">
      <nav class="chapters" aria-label="${esc(t.demo.label)}">${CLIPS.map((clip, index) => `<a class="chapter" href="/demo/${clip}.mp4" data-clip="${clip}" aria-controls="demo-player"${index === 0 ? ' aria-current="true"' : ""}>${esc(t.demo.chapters[index]!)}</a>`).join("")}</nav>
      <figure>
        <div class="film">
          <video id="demo-player" controls playsinline muted preload="metadata" poster="/demo/annotate.webp" src="/demo/annotate.mp4" aria-describedby="demo-caption">
            <track kind="captions" src="/demo/annotate.${locale}.vtt" srclang="${locale}" label="${locale === "ko" ? "한국어" : "English"}" default>
            ${esc(t.demo.fallback)}
          </video>
          <button class="play-cover" type="button" aria-controls="demo-player" hidden><img src="/demo/annotate.webp" alt="" width="1600" height="1000"><span>${esc(t.demo.play)}</span></button>
        </div>
        <figcaption id="demo-caption" aria-live="polite">${esc(t.demo.captions[0]!)}</figcaption>
      </figure>
      <p class="media-status" role="status" aria-live="polite" data-loading hidden>${esc(t.demo.loading)}</p>
      <div class="media-error" role="alert" data-media-error hidden>
        <p>${esc(t.demo.error)}</p>
        <button type="button" data-retry>${esc(t.demo.retry)}</button>
        <a data-video-link href="/demo/annotate.mp4">${esc(t.demo.download)}</a>
      </div>
      <div class="demo-meta">
        <p>${esc(t.demo.footage)}</p>
        <details><summary>${esc(t.demo.transcript)}</summary>
          ${CLIPS.map((clip, index) => `<p data-summary="${clip}" data-caption="${esc(t.demo.captions[index]!)}"${index === 0 ? "" : " hidden"}>${esc(t.demo.summaries[index]!)}</p>`).join("")}
        </details>
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
      <p class="requirements">${esc(t.install.requirements)}<br>${esc(t.install.yarn)}</p>
      <p class="aside">${esc(t.local)}</p>
    </section>
  </main>
  <footer class="footer frame">
    <span>pk-annotator <span class="version">${VERSION}</span></span>
    <div><a href="https://www.npmjs.com/package/pk-annotator">npm</a><a href="https://github.com/pbkimdev/pk-annotator/blob/main/LICENSE">${esc(t.footer.license)}</a><span>${esc(t.footer.author)}</span></div>
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
