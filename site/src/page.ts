import { cloud } from "./shapes.ts";
import { CONTENT, INSTALL_COMMAND, SITE, VERSION, type Content, type Locale } from "./content.ts";

const ZONES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const SHEETS = 5;

function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The product's hub glyph, from src/overlay/launcher.ts. */
function glyph(className: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">
    <g class="glyph-orbit">
      <path d="M16.2 6.7A9.5 9.5 0 0 0 6.7 16.2" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.3"/>
      <circle cx="16.2" cy="6.7" r="2.1" opacity="0.45"/>
      <circle cx="9.48" cy="9.48" r="2.1" opacity="0.75"/>
      <circle cx="6.7" cy="16.2" r="2.1"/>
    </g>
    <circle class="glyph-core" cx="16.2" cy="16.2" r="3.25"/>
  </svg>`;
}

function zones(): string {
  return `<div class="zones" aria-hidden="true">${ZONES.map((zone) => `<span>${zone}</span>`).join("")}</div>`;
}

function sheetHead(t: Content, number: number, title: string): string {
  return `<div class="sheet-head">
    <span class="sheet-no">${t.block.sheet} ${number}/${SHEETS}</span>
    <span class="sheet-name">${esc(title)}</span>
  </div>`;
}

function copyField(t: Content, id: string, value: string, label: string): string {
  return `<div class="copy" data-copy>
    <code id="${id}">${esc(value).replace(/https:\/\/\S+/g, (url) => `<span class="nowrap">${url}</span>`)}</code>
    <button type="button" class="copy-button" aria-describedby="${id}" title="${esc(label)}" data-label="${esc(t.hero.copy)}" data-done="${esc(t.hero.copied)}" data-failed="${esc(t.hero.copyFailed)}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1"/><path d="M3 10.5V3.5a1 1 0 0 1 1-1h7"/></svg>
      <span>${esc(label)}</span>
    </button>
  </div>`;
}

function heroDrawing(t: Content): string {
  const d = t.demo;
  const save = { x: 186, y: 306, width: 176, height: 42 };
  return `<svg class="drawing" viewBox="0 0 600 432" role="img" aria-label="${esc(`${d.label}: ${d.description}`)}">
    <g class="line">
      <rect x="10" y="10" width="580" height="410" rx="6"/>
      <line x1="10" y1="46" x2="590" y2="46"/>
      <circle cx="32" cy="28" r="4.5"/><circle cx="50" cy="28" r="4.5"/><circle cx="68" cy="28" r="4.5"/>
      <rect x="92" y="18" width="300" height="20" rx="10"/>
    </g>
    <text class="t-mono" x="106" y="32">${esc(d.url)}</text>
    <text class="t-heading" x="46" y="100">${esc(d.heading)}</text>
    <g class="line">
      <line x1="46" y1="114" x2="560" y2="114" class="faint"/>
      <rect x="46" y="150" width="330" height="38" rx="4"/>
      <rect x="46" y="226" width="330" height="38" rx="4"/>
    </g>
    <text class="t-label" x="46" y="142">${esc(d.card)}</text>
    <text class="t-field" x="60" y="174">•••• •••• •••• 4242</text>
    <text class="t-label" x="46" y="218">${esc(d.email)}</text>
    <text class="t-field" x="60" y="250">finance@example.com</text>
    <g class="line">
      <rect x="46" y="${save.y}" width="118" height="${save.height}" rx="4"/>
    </g>
    <text class="t-button" x="105" y="${save.y + 26}" text-anchor="middle">${esc(d.cancel)}</text>
    <g class="save">
      <rect class="save-box" x="${save.x}" y="${save.y}" width="${save.width}" height="${save.height}" rx="4"/>
      <text class="save-text" x="${save.x + save.width / 2}" y="${save.y + 26}" text-anchor="middle">${esc(d.save)}</text>
    </g>
    <g class="pick-box">
      <rect x="${save.x - 5}" y="${save.y - 5}" width="${save.width + 10}" height="${save.height + 10}" rx="6"/>
      <rect class="pick-tag" x="${save.x + 12}" y="${save.y - 30}" width="172" height="20" rx="3"/>
      <text class="t-tag" x="${save.x + 20}" y="${save.y - 16}">button · ${esc(d.save)}</text>
    </g>
    <path class="redline cloud" pathLength="1" d="${cloud(save.x - 16, save.y - 14, save.width + 32, save.height + 28, 22)}"/>
    <g class="delta">
      <path class="redline" d="M${save.x - 16} ${save.y - 38}l13 22h-26z"/>
      <text class="t-delta" x="${save.x - 16}" y="${save.y - 20}" text-anchor="middle">1</text>
    </g>
    <path class="redline leader" pathLength="1" d="M${save.x + save.width + 18} ${save.y + 10} L${save.x + save.width + 42} ${save.y - 50} H${save.x + save.width + 48}"/>
    <g class="note">
      ${d.note.map((line, index) => `<text class="t-hand" x="${save.x + save.width + 52}" y="${save.y - 56 + index * 24}">${esc(line)}</text>`).join("")}
    </g>
    <path class="send" pathLength="1" d="M576 386 H600"/>
    <svg class="hub" x="530" y="364" width="44" height="44" viewBox="0 0 44 44">
      <circle class="hub-disc" cx="22" cy="22" r="21"/>
      <svg x="8" y="8" width="28" height="28" viewBox="0 0 24 24">
        <g class="hub-orbit">
          <path d="M16.2 6.7A9.5 9.5 0 0 0 6.7 16.2" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.35"/>
          <circle cx="16.2" cy="6.7" r="2.1" opacity="0.45"/>
          <circle cx="9.48" cy="9.48" r="2.1" opacity="0.75"/>
          <circle cx="6.7" cy="16.2" r="2.1"/>
        </g>
        <circle cx="16.2" cy="16.2" r="3.25"/>
      </svg>
    </svg>
    <g class="reply">
      <rect x="250" y="374" width="268" height="34" rx="4"/>
      <text class="t-reply" x="264" y="396">${esc(d.reply)}</text>
    </g>
  </svg>`;
}

function terminal(t: Content): string {
  const lines: [string, string][] = [
    ["cmd", "wait_for_annotation"],
    ["out", `[element 1] button "${t.demo.save}"`],
    ["out", "src/routes/billing.tsx:42:9"],
    ["cmd", "set_status acknowledged"],
    ["cmd", "Edit src/routes/billing.tsx"],
    ["diff", `variant="ghost" → variant="default"`],
    ["cmd", `reply "${t.demo.reply}"`],
    ["cmd", "set_status resolved"],
  ];
  return `<div class="terminal" aria-hidden="true">
    <div class="terminal-head"><span>claude-code</span><span>pka-mcp</span></div>
    <ol class="terminal-lines">${lines
      .map(([kind, text], index) => `<li class="${kind}" data-line="${index}">${esc(text)}</li>`)
      .join("")}</ol>
  </div>`;
}

function hero(t: Content): string {
  const d = t.demo;
  return `<section class="sheet sheet-hero" id="top" aria-labelledby="hero-title">
    ${zones()}
    <div class="hero-grid">
      <div class="hero-copy">
        <h1 id="hero-title">${esc(t.hero.title)}</h1>
        <p class="lead">${esc(t.hero.lead)}</p>
        <div class="actions">
          <p class="action-label">${esc(t.hero.install)}</p>
          ${copyField(t, "install-command", INSTALL_COMMAND, t.hero.copy)}
          <p class="action-label">${esc(t.hero.askAgent)}</p>
          ${copyField(t, "agent-prompt", t.hero.agentPrompt, t.hero.copy)}
          <p class="requirements">${esc(t.hero.requirements)}</p>
        </div>
      </div>
      <figure class="hero-figure" data-step="0">
        <figcaption class="figure-label">${esc(d.label)}</figcaption>
        ${heroDrawing(t)}
        ${terminal(t)}
        <div class="revisions">
          <div class="revisions-head">
            <span>${esc(d.revisions)}</span>
            <button type="button" class="replay" data-replay>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/></svg>
              ${esc(d.replay)}
            </button>
          </div>
          <table>
            <thead><tr>${d.columns.map((column) => `<th scope="col">${esc(column)}</th>`).join("")}</tr></thead>
            <tbody>
              <tr class="revision-row">
                <td><span class="delta-mark">1</span></td>
                <td>${esc(d.description)}</td>
                <td class="mono">claude-code</td>
                <td><span class="status" data-pending="${esc(d.statuses.pending)}" data-acknowledged="${esc(d.statuses.acknowledged)}" data-resolved="${esc(d.statuses.resolved)}">${esc(d.statuses.resolved)}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </figure>
    </div>
    <dl class="title-block">
      <div class="tb-project"><dt>${esc(t.block.project)}</dt><dd>${glyph("tb-glyph")}pk-annotator</dd></div>
      <div><dt>${esc(t.block.drawing)}</dt><dd>${esc(t.block.drawingValue)}</dd></div>
      <div><dt>${esc(t.block.sheet)}</dt><dd>1/${SHEETS}</dd></div>
      <div><dt>${esc(t.block.rev)}</dt><dd>${VERSION}</dd></div>
      <div><dt>${esc(t.block.date)}</dt><dd>2026-10-03</dd></div>
      <div><dt>${esc(t.block.by)}</dt><dd>Paul B. Kim</dd></div>
    </dl>
  </section>`;
}

function annotationXml(t: Content): string {
  const balloon = (n: number) => `<span class="balloon" data-item="${n}">${n}</span>`;
  const prompt =
    t.lang === "ko"
      ? "[element 1]을 주 버튼으로 바꿔 주세요. 취소 옆에서 링크처럼 보여요. [attachment 1: Screenshot] 참고."
      : "Make [element 1] the primary action; it reads like a link next to Cancel. See [attachment 1: Screenshot].";
  return [
    `&lt;annotation id="k3v9q2m7" route="/settings/billing" viewport="1440x900@2"&gt;`,
    `  ${balloon(1)}&lt;prompt&gt;${esc(prompt)}&lt;/prompt&gt;`,
    `  ${balloon(2)}&lt;element n="1" source="src/ui/button.tsx:12:3"`,
    `           usedAt="src/routes/billing.tsx:42:9"`,
    `           owners="BillingForm &gt; SettingsPage"`,
    `           role="button" name="${esc(t.demo.save)}"`,
    `           ${balloon(3)}crop="capture/frames/sel-1.webp"/&gt;`,
    `  ${balloon(4)}${balloon(5)}${balloon(6)}${balloon(7)}&lt;capture&gt;_interim/annotations/k3v9q2m7/capture/summary.md&lt;/capture&gt;`,
    `&lt;/annotation&gt;`,
  ].join("\n");
}

function detail(t: Content): string {
  const x = t.detail;
  return `<section class="sheet" id="detail" aria-labelledby="detail-title">
    <div class="split">
      <div class="prose">
        <h2 id="detail-title">${esc(x.title)}</h2>
        <p>${esc(x.intro)}</p>
      </div>
      <figure class="xml">
        <figcaption>${esc(x.received)}</figcaption>
        <pre tabindex="0"><code>${annotationXml(t)}</code></pre>
      </figure>
    </div>
    <table class="schedule">
      <thead><tr>${x.columns.map((column) => `<th scope="col">${esc(column)}</th>`).join("")}</tr></thead>
      <tbody>${x.parts
        .map(
          ([part, body, file], index) => `<tr data-item="${index + 1}">
            <td><span class="balloon">${index + 1}</span></td>
            <th scope="row">${esc(part ?? "")}</th>
            <td>${esc(body ?? "")}</td>
            <td class="mono">${esc(file ?? "")}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>
  ${sheetHead(t, 2, x.sheetTitle)}
  </section>`;
}

function hubPlan(t: Content): string {
  const cx = 500;
  const cy = 380;
  const ring = 230;
  const groups = t.hub.groups;
  const nodes = groups
    .map(([name], index) => {
      const angle = Math.PI + (index / (groups.length - 1)) * (Math.PI / 2);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const nx = cx + cos * ring;
      const ny = cy + sin * ring;
      const lx = cx + cos * (ring + 36);
      const ly = cy + sin * (ring + 36) + 6;
      const anchor = cos < -0.3 ? "end" : "middle";
      return `<g class="plan-node" style="--i:${index}">
        <circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="20"/>
        <text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${esc(name ?? "")}</text>
      </g>`;
    })
    .join("");
  return `<svg class="plan" viewBox="80 80 520 400" role="img" aria-label="${esc(t.hub.sheetTitle)}">
    <g class="line faint">
      <line x1="80" y1="${cy + 54}" x2="600" y2="${cy + 54}"/>
      <line x1="${cx + 54}" y1="80" x2="${cx + 54}" y2="480"/>
    </g>
    <path class="plan-arc" pathLength="1" d="M${cx - ring} ${cy} A${ring} ${ring} 0 0 1 ${cx} ${cy - ring}"/>
    <path class="plan-arc outer" pathLength="1" d="M${cx - 120} ${cy} A120 120 0 0 1 ${cx} ${cy - 120}"/>
    ${nodes}
    <circle class="plan-hub" cx="${cx}" cy="${cy}" r="24"/>
    <svg class="plan-glyph" x="${cx - 14}" y="${cy - 14}" width="28" height="28" viewBox="0 0 24 24">
      <path d="M16.2 6.7A9.5 9.5 0 0 0 6.7 16.2" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.4"/>
      <circle cx="16.2" cy="6.7" r="2.1" opacity="0.45"/><circle cx="9.48" cy="9.48" r="2.1" opacity="0.75"/><circle cx="6.7" cy="16.2" r="2.1"/>
      <circle cx="16.2" cy="16.2" r="3.25"/>
    </svg>
    <g class="dimension">
      <line x1="${cx + 24}" y1="${cy + 40}" x2="${cx + 54}" y2="${cy + 40}"/>
      <path d="M${cx + 24} ${cy + 35}v10M${cx + 54} ${cy + 35}v10"/>
      <text x="${cx + 39}" y="${cy + 33}" text-anchor="middle">20</text>
      <line x1="${cx - 40}" y1="${cy + 24}" x2="${cx - 40}" y2="${cy + 54}"/>
      <path d="M${cx - 45} ${cy + 24}h10M${cx - 45} ${cy + 54}h10"/>
      <text x="${cx - 50}" y="${cy + 44}" text-anchor="end">20</text>
    </g>
  </svg>`;
}

function hub(t: Content): string {
  const x = t.hub;
  return `<section class="sheet" id="hub" aria-labelledby="hub-title">
    <div class="split split-reverse">
      <div class="prose">
        <h2 id="hub-title">${esc(x.title)}</h2>
        <p>${esc(x.intro)}</p>
        <dl class="legend">${x.groups
          .map(
            ([group, tools]) =>
              `<div><dt>${esc(group ?? "")}</dt><dd>${esc(tools ?? "")}</dd></div>`,
          )
          .join("")}</dl>
        <p class="aside">${esc(x.agents)}</p>
      </div>
      <figure class="plan-figure">${hubPlan(t)}</figure>
    </div>
  ${sheetHead(t, 3, x.sheetTitle)}
  </section>`;
}

function flow(t: Content): string {
  const x = t.flow;
  return `<section class="sheet" id="flow" aria-labelledby="flow-title">
    <div class="prose wide">
      <h2 id="flow-title">${esc(x.title)}</h2>
      <p>${esc(x.intro)}</p>
    </div>
    <ol class="chain">${x.nodes
      .map(
        ([name, place]) =>
          `<li><span class="node-name">${esc(name ?? "")}</span><span class="node-place">${esc(place ?? "")}</span></li>`,
      )
      .join("")}</ol>
    <div class="chain-legend" aria-hidden="true">
      <span class="flow-request">${esc(x.request)} →</span>
      <span class="flow-reply">← ${esc(x.reply)}</span>
    </div>
    <div class="lifecycle">
      <span class="lifecycle-label">${esc(x.lifecycle)}</span>
      <ol>${x.states.map((state) => `<li>${esc(state)}</li>`).join("")}</ol>
    </div>
    <p class="aside">${esc(x.languages)}</p>
  ${sheetHead(t, 4, x.sheetTitle)}
  </section>`;
}

function notes(t: Content): string {
  const x = t.notes;
  return `<section class="sheet" id="notes" aria-labelledby="notes-title">
    <h2 id="notes-title">${esc(x.title)}</h2>
    <div class="notes-grid">
      <ol class="general-notes">${x.items
        .map(([head, body]) => `<li><strong>${esc(head ?? "")}</strong> ${esc(body ?? "")}</li>`)
        .join("")}</ol>
      <ul class="dimensions">${x.dimensions
        .map(
          ([label, value]) =>
            `<li><span class="dim-value">${esc(value ?? "")}</span><span class="dim-line" aria-hidden="true"></span><span class="dim-label">${esc(label ?? "")}</span></li>`,
        )
        .join("")}</ul>
    </div>
  ${sheetHead(t, 5, x.sheetTitle)}
  </section>`;
}

function install(t: Content): string {
  const x = t.install;
  const code = [
    copyField(t, "step-prompt", t.hero.agentPrompt, t.hero.copy),
    copyField(t, "step-command", INSTALL_COMMAND, t.hero.copy),
    `<pre><code>import { annotator } from "pk-annotator/vite";

export default defineConfig({
  plugins: [...annotator()],
});</code></pre>`,
    `<pre><code>let rootOptions = {};
if (import.meta.env.DEV) {
  try {
    const { mount } = await import("pk-annotator/overlay");
    rootOptions = mount({ hot: import.meta.hot!, theme: "system" }).reactRootOptions;
  } catch (cause) {
    console.error("pk-annotator did not load", cause);
  }
}
createRoot(root, rootOptions).render(&lt;App /&gt;);</code></pre>`,
    `<p class="keys"><kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>A</kbd></p>`,
  ];
  return `<section class="sheet sheet-install" id="install" aria-labelledby="install-title">
    <h2 id="install-title">${esc(x.title)}</h2>
    <ol class="steps">${x.steps
      .map(
        (step, index) => `<li class="step">
          <span class="step-no" aria-hidden="true">${index + 1}</span>
          <div class="step-body">
            <h3>${esc(step.title)}</h3>
            <p>${esc(step.body)}</p>
            ${code[index] ?? ""}
          </div>
        </li>`,
      )
      .join("")}</ol>
    <p class="links">
      <a href="/agents.md">${esc(x.guide)}</a>
      <a href="https://www.npmjs.com/package/pk-annotator">${esc(x.npm)}</a>
      <a href="/install.sh">install.sh</a>
    </p>
    <div class="sheet-head"><span class="sheet-no">IFC</span><span class="sheet-name">${esc(x.sheetTitle)}</span></div>
  </section>`;
}

function header(t: Content): string {
  return `<header class="topbar">
    <a class="brand" href="${t.path}">${glyph("brand-glyph")}<span>pk-annotator</span></a>
    <nav aria-label="Sections">
      <a href="#detail">${esc(t.nav.detail)}</a>
      <a href="#hub">${esc(t.nav.hub)}</a>
      <a href="#flow">${esc(t.nav.flow)}</a>
      <a href="#notes">${esc(t.nav.notes)}</a>
      <a href="#install">${esc(t.nav.install)}</a>
    </nav>
    <a class="lang" href="${t.otherLanguage.href}" hreflang="${t.otherLanguage.lang}" lang="${t.otherLanguage.lang}">${esc(t.otherLanguage.label)}</a>
  </header>`;
}

function footer(t: Content): string {
  return `<footer class="footer">
    <div>${glyph("brand-glyph")}<span>pk-annotator ${VERSION}</span></div>
    <div><a href="https://www.npmjs.com/package/pk-annotator">npm</a> · <span>${esc(t.footer.license)}</span> · <span>${esc(t.footer.madeBy)}</span></div>
    <a class="lang" href="${t.otherLanguage.href}" hreflang="${t.otherLanguage.lang}" lang="${t.otherLanguage.lang}">${esc(t.otherLanguage.label)}</a>
  </footer>`;
}

function picker(t: Content): string {
  const p = t.pick;
  return `<div class="picker" data-picker hidden
    data-hint="${esc(p.hint)}" data-placeholder="${esc(p.placeholder)}" data-save="${esc(p.save)}" data-element="${esc(p.element)}"
    data-copied="${esc(t.hero.copied)}" data-failed="${esc(t.hero.copyFailed)}">
    <div class="picker-panel" role="region" aria-label="${esc(p.marks)}">
      <div class="picker-head"><span>${esc(p.marks)}</span><span class="picker-count">0</span></div>
      <ol class="picker-list"></ol>
      <p class="picker-note">${esc(p.disclaimer)}</p>
      <div class="picker-actions">
        <button type="button" data-pick-copy>${esc(p.copyMarkdown)}</button>
        <button type="button" data-pick-clear>${esc(p.clear)}</button>
      </div>
    </div>
  </div>
  <button type="button" class="launcher" aria-pressed="false" data-launcher aria-label="${esc(p.launcher)}" data-on="${esc(p.exit)}" data-off="${esc(p.launcher)}">
    ${glyph("launcher-glyph")}
    <span class="launcher-label">${esc(p.launcher)}</span>
  </button>`;
}

/** The contract the finish review audits; it must survive the production build. */
const CONTRACT = `<!--
THESIS: Marking up the live page is a redline: the change is drawn where it belongs and issued as a numbered revision. Refuses the dark tool hero with a screenshot and a feature-card grid.
OWN-WORLD: Cyanotype Prussian-blue drawing sheets with white hairline linework, A-H zone borders, title blocks, revision tables, parts schedules, balloons, dimension lines, general notes. Red pencil only for markup, highlighter yellow only for the live pick. Barlow Condensed lettering, Architects Daughter hand notes.
STORY: The visitor sees a request drawn on a page, sent, and resolved by an agent; learns what travels with it; tries marking this page; installs with one command or one prompt.
FIRST VIEWPORT: Headline and lead left with the install command and agent prompt as copy fields; right, the illustrated browser under redline, the agent transcript, and the revision table; title block along the bottom.
FORM: Redline Drawing Set, grounded candidate 3 of 7, seed a393ef13.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->`;

export function renderPage(locale: Locale): string {
  const t = CONTENT[locale];
  return `${CONTRACT}
  <a class="skip" href="#main">${esc(t.skip)}</a>
  ${header(t)}
  <main id="main">
    ${hero(t)}
    ${detail(t)}
    ${hub(t)}
    ${flow(t)}
    ${notes(t)}
    ${install(t)}
  </main>
  ${footer(t)}
  ${picker(t)}`;
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
  return `<main class="not-found" id="main">
    <section class="sheet">
      ${zones()}
      <p class="sheet-no">404</p>
      <h1>${esc(t.notFound.title)}</h1>
      <p>${esc(t.notFound.body)}</p>
      <p><a href="${t.path}">${esc(t.notFound.home)}</a> · <a href="${t.otherLanguage.href}">${esc(t.otherLanguage.label)}</a></p>
    </section>
  </main>`;
}
