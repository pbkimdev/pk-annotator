---
name: pk-annotator site
description: A quiet paper-and-ink site for browser-based AI development, demonstrated through real app footage.
colors:
  paper: "#fafaf9"
  paper-2: "#f3f3f2"
  paper-3: "#efefee"
  ink: "#282828"
  ink-3: "#504945"
  mute: "#6b6866"
  rule-strong: "#cbcbcb"
  accent: "#ad2111"
  accent-tint: "rgba(173, 33, 17, 0.06)"
typography:
  display:
    fontFamily: "Source Serif 4, Iowan Old Style, Georgia, serif"
    fontSize: "clamp(2.4rem, 6vw, 3.4rem)"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Source Serif 4, Iowan Old Style, Georgia, serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.4
  display-ko:
    fontFamily: "Archivo, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2.4rem, 6vw, 3.4rem)"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  headline-ko:
    fontFamily: "Archivo, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.4
  body:
    fontFamily: "Source Serif 4, Iowan Old Style, Georgia, serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.6
  small:
    fontFamily: "Source Serif 4, Iowan Old Style, Georgia, serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Archivo, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  caption:
    fontFamily: "Archivo, Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
  mono:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  radius: "0"
  radius-pill: "999px"
spacing:
  sp-1: "0.25rem"
  sp-2: "0.5rem"
  sp-3: "0.75rem"
  sp-4: "1rem"
  sp-5: "1.25rem"
  sp-6: "1.5rem"
  sp-8: "2rem"
  sp-10: "2.5rem"
  sp-12: "3rem"
  sp-15: "3.75rem"
  sp-20: "5rem"
components:
  button-primary:
    backgroundColor: "rgb(40 40 40 / 0.88)"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-pill}"
    padding: "0 1.25rem"
    height: "2.5rem"
  button-primary-hover:
    backgroundColor: "rgb(40 40 40 / 0.8)"
  button-play:
    backgroundColor: "rgb(40 40 40 / 0.7)"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-pill}"
    padding: "0 1.25rem 0 1rem"
    height: "2.5rem"
  button-play-hover:
    backgroundColor: "rgb(40 40 40 / 0.88)"
  button-copy:
    backgroundColor: "rgb(255 255 255 / 0.62)"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-pill}"
    size: "2.25rem"
  button-copy-hover:
    backgroundColor: "rgb(255 255 255 / 0.9)"
  button-secondary:
    backgroundColor: "rgb(255 255 255 / 0.62)"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-pill}"
    padding: "0 1.25rem"
    height: "2.5rem"
  button-secondary-hover:
    backgroundColor: "rgb(255 255 255 / 0.9)"
  chapter:
    textColor: "{colors.mute}"
    typography: "{typography.label}"
  chapter-current:
    textColor: "{colors.ink}"
  copy-panel:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "1.25rem"
  film:
    backgroundColor: "{colors.paper-2}"
    rounded: "{rounded.radius}"
    width: "100%"
---

# Design System: pk-annotator site

## Overview

**Creative North Star: "The Film Review Sheet"**

The site uses quiet paper, near-black ink, editorial text, and a single screening surface.
Real app footage supplies the visual detail; the surrounding interface stays sparse and direct.
This replaces the rejected blueprint world, including its sheet furniture, tracked labels, grids, and drawing animations.

This system applies to the public site, not to the overlay shown inside the recordings.
The product name and inline SVG hub mark remain the identity commitments from the root `../PRODUCT.md`.
The current composition and copy belong to `.impeccable/surfaces/site-src-page-ts.md` and `src/content.ts`, not to every future surface.
Implementation evidence is `src/tokens.css`, `src/style.css`, `src/page.ts`, `src/main.ts`, and `src/content.ts`.
Only values consumed by this site are promoted from the larger token inventory.

**Key Characteristics:**

- Paper surfaces, ink actions, and restrained red feedback.
- Serif prose, sans-serif controls, and monospaced commands.
- Flat rectangular containers with rounded glass controls.
- Real footage with explicit playback and plain chapter navigation.
- Shared English and Korean structure with deliberate Hangul typography.

## Colors

The palette is neutral paper and dark ink, with a small red interaction accent.

### Primary

- **Ink** (`ink`): headings, body text, selected chapters, focus outlines, the brand mark, and the tint of dark glass actions.
- **Deep warm gray** (`ink-3`): hover fill of dark actions when glass falls back to solid.
- **Red accent** (`accent`): the copy button's failure icon.
- **Red tap tint** (`accent-tint`): touch feedback on links, buttons, and disclosures.

### Neutral

- **Paper** (`paper`): page ground and reversed text on filled actions.
- **Inset paper** (`paper-2`): film background and copyable prompt or command containers.
- **Hover paper** (`paper-3`): light button hover background when glass falls back to solid.
- **Muted ink** (`mute`): supporting copy, unselected navigation, metadata, and footer text.
- **Strong rule** (`rule-strong`): media frame, solid fallback button borders, resting link underlines, and scrollbar thumb.

### Named Rules

**The Ink Actions Rule.** Primary actions use paper text on ink-tinted glass; red is reserved for copy failure and tap feedback, not generalized page chrome.

**The Footage Color Rule.** Preserve the product's native colors inside recordings rather than recoloring them to the site's palette.

The imported token file also declares a dark opt-in palette and unused block colors.
The shipped page has no theme switch; those declarations do not establish additional site palettes.

## Typography

**Display and Body Font:** Source Serif 4, with Iowan Old Style, Georgia, and generic serif fallbacks.
**Control Font:** Archivo, with the sans-serif fallback stack recorded in the frontmatter.
**Command Font:** Geist Mono, with UI monospace, SFMono-Regular, Menlo, and generic monospace fallbacks.

English display text uses regular serif lettering with an italic ending.
Controls remain sentence case without tracked uppercase decoration.
The hierarchy is role-based, not a uniform modular scale.

### Hierarchy

- **Display:** the fluid `display` role, balanced and centered; the emphasized ending retains regular weight.
- **Headline:** `headline` for installation headings.
- **Body:** `body` for prose and the centered film caption; lead text and disclosures use the narrow measure.
- **Small:** `small` for secondary prose.
- **Label:** `label` for controls and navigation; brand and current chapter use weight 500.
- **Caption:** `caption` for notes, metadata, and footer.
- **Mono:** `mono` for copyable text; version text uses the mono family with tabular numerals.

### Font delivery and Korean

`src/main.ts` self-hosts Fontsource Latin subsets through the Vite bundle:
`@fontsource/source-serif-4/latin-400.css`, `latin-400-italic.css`,
`@fontsource/archivo/latin-400.css`, `latin-500.css`, and
`@fontsource/geist-mono/latin-400.css`.

`public/fonts/noto-sans-kr.woff2` supplies Hangul for the Archivo logical family.
The normal-weight 400 face uses `font-display: swap` and
`unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7AF` in `src/style.css`.
The supplied font provenance identifies a fonttools subset of the installed
`noto-fonts-cjk` file `NotoSansCJK-Regular.ttc`, face 1, using those same Unicode ranges.
Upstream source: https://github.com/notofonts/noto-cjk.
License: SIL Open Font License 1.1, shipped as `public/fonts/OFL.txt`.
This is a glyph-range alias, not a fourth visual type role.

Korean headings use `display-ko` and `headline-ko` rather than platform display fonts.
The hero ending is upright and muted, not italic.
Korean prose retains the native Hangul serif fallback; it is not covered by the Archivo alias.
All Korean text uses `word-break: keep-all` and `overflow-wrap: break-word`.
Only a regular Hangul face is supplied; there is no separately hosted weight-500 Hangul face.

### Named Rules

**The Korean Roles Rule.** Use the self-hosted Archivo Hangul alias for Korean headings and controls while retaining the serif prose role.

## Layout

The site is a centered single-column flow.
The wide frame is `min(980px, calc(100% - 2rem))`; the prose and installation measure is `min(660px, calc(100% - 2rem))`.
The header is an in-flow flex row with a minimum height of 3.75rem, not sticky chrome.
The hero has 1.5rem block padding; the lead separates title and action with 1.25rem above and 1.5rem below.
Chapter links wrap in a centered row with 1.5rem column gaps and a 1rem gap before the film.
The film preserves an 8:5 aspect ratio and contains its media without cropping.
Installation uses 5rem block padding; the footer returns to the wide frame.

Spacing follows the quarter-rem steps recorded in the frontmatter, with larger section gaps from the same inventory.
Interactive links, buttons, and disclosure summaries provide a hit target at least 44px tall.
Copyable code wraps and breaks long strings rather than forcing horizontal page overflow.

At a maximum viewport width of 640px, navigation and chapter gaps reduce to 1rem,
chapters use the caption size, the hero gains 2rem top padding, installation padding becomes 3rem,
and the footer stacks with no row gap.
Korean display text reduces to the headline size at this breakpoint.
The frame remains fluid; chapter links remain visible and wrap instead of being hidden.

## Elevation & Depth

Containers stay flat: depth comes from the inset paper fill and a single hairline media border.
The poster cover occupies the film bounds without introducing an elevated card.

Buttons are the only raised layer.
Each is a glass control: a translucent fill with `backdrop-filter: blur(16px) saturate(180%)`,
a hairline edge, a 1px inner top highlight, and a soft two-step shadow (`--glass-*` tokens in `src/tokens.css`).
Clear glass is white at 62% over paper; dark glass is ink at 88% on paper and 70% over the poster.
Paper text on the 70% poster glass stays above 4.5:1 even over a white frame.
Under `prefers-reduced-transparency: reduce`, or where `backdrop-filter` is unsupported,
the same tokens resolve to solid paper or ink with a strong-rule edge and no blur.
The older `--shadow-lift` and `--shadow-press` declarations remain unused.

### Named Rules

**The Flat Surface Rule.** Separate in-flow surfaces with tone, whitespace, and the existing hairline border; only buttons carry glass and shadow.

## Shapes

Film and copy containers have square corners.
Buttons are fully rounded: text buttons are 2.5rem pills and copy buttons are 2.25rem circles.
A transparent `::after` extends each visual control to a 44px hit target.
The film border is 1px; the active chapter underline and focus outline are 2px.
Focus outlines are offset by 0.25rem and apply to links, buttons, summaries, video, and focusable code.
The hub identity is an inline SVG core with three moons on a quarter orbit.
The setup arrow, the footer GitHub mark from simple-icons, and the Lucide 1.49.0 `copy`, `check`, `circle-alert`, and `play` paths (ISC License) are inline SVGs; none requires an icon font.

## Components

### Buttons

All buttons share the `.glass` control described under Elevation & Depth.
The setup anchor is a dark glass pill with paper text and a 16px stroked SVG arrow; hover thins the tint slightly.
The retry button is a clear glass pill with an ink label; hover raises the fill toward opaque white.
Copy buttons are icon-only clear glass circles described under Copy panels.
Pressing scales a control to 97% and flattens its shadow; reduced motion keeps the scale at 100%.
All retain the shared visible focus outline.

### Navigation

The brand and two text links share the in-flow header.
Header links change from muted ink to ink on hover; their hit areas remain at least 44px tall.
The chapter rail is plain text navigation, not a pill group or ARIA tab widget.
The current link uses ink, weight 500, a 2px bottom border, and `aria-current`.
Other chapters gain ink text and a strong-rule underline on hover.
The language link uses the destination language and route; English and Korean share the same structure.

### Film and poster

One bordered film frame shows six actual clips: `agent`, `annotate`, `capture`, `record`, `multi`, and `rapid`.
Each uses `/demo/<clip>.mp4` and a matching WebP poster; the silent clips carry no subtitle tracks.
The current first clip is Claude Code: the browser on the left and a live Claude Code session on the right.
An explicit poster button appears when script runs; successful playback hides it and exposes the native player controls.
The cover image contains the full poster, and its Play pill sits 1.25rem from the lower-left corner (0.75rem at 640px and below).
The pill is dark glass at 70% that blurs the footage beneath it and deepens to 88% on hover.
It carries a filled play icon and the localized Play label.

Chapter selection changes the video, poster, figure caption, and download link together, then requests playback.
There is no initial autoplay, automatic chapter advance, entrance animation, or decorative animation loop.
The player is muted, inline, and metadata-preloaded; native pause and timeline remain available.
Playback pauses when the document becomes hidden or the film leaves the viewport.
The cover retains a usable state if playback is blocked and transfers focus to the video when it successfully starts from the focused button.

Loading feedback uses a polite status region.
Failure reveals a retry button and direct video link.
Without script, the native first video remains usable and chapters are direct MP4 links.
The footage disclosure states that only the first clip has a connected agent and the others show the overlay alone.

### Copy panels and disclosures

Copyable prompts and commands are selectable code, not text inputs.
The flat inset-paper panel places the code beside a copy button at its top-right, with a 0.75rem gap.
The panel has 0.75rem padding and 1.25rem on the left; the code's block padding centres its first line on the button.
Buttons appear only with script.
Each copy button shows only a copy icon, with the localized copy label as `aria-label` and `title`.
Success swaps the icon to a check and failure to a red alert icon for two seconds.
Success also updates a polite status region; clipboard failure selects and focuses the code for manual copying.
A reserved 1.5rem status height limits layout movement.
Native details and summary elements expose the terminal option without adding a custom accordion system.

### Motion

Button fill, shadow, and press scale, and chapter state changes use `200ms ease-in-out` transitions.
Under `prefers-reduced-motion: reduce`, the token duration becomes `0ms`.
The imported slow duration is unused by this surface.
User-requested video playback remains available under reduced motion; the page does not start it on entry.

## Do's and Don'ts

### Do:

- **Do** keep surrounding chrome quiet so actual product footage supplies the detail.
- **Do** preserve the serif prose, sans-serif controls, and mono command roles in both locales.
- **Do** retain explicit playback, native video controls, and the localized figure caption.
- **Do** keep current chapter state visible with text weight and an underline, not color alone.
- **Do** preserve keyboard focus, 44px hit targets, and selectable setup text without script.

### Don't:

- **Don't** restore blueprint grids, sheet furniture, architectural diagrams, or decorative feature-card grids.
- **Don't** add shadows or glass to the site's flat containers; keep glass on buttons.
- **Don't** autoplay on entry, advance chapters automatically, or add entrance animation.
- **Don't** turn unused palette or eyebrow declarations into new site styles.
- **Don't** replace real footage with invented product or agent-success evidence.
