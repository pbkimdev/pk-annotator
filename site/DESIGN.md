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
  radius-soft: "2px"
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
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-soft}"
    padding: "0.75rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.ink-3}"
  button-copy:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-soft}"
    padding: "0.75rem 1rem"
  button-copy-hover:
    backgroundColor: "{colors.ink-3}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-soft}"
    padding: "0.75rem 1rem"
  button-secondary-hover:
    backgroundColor: "{colors.paper-3}"
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
- Flat rectangular containers with slightly softened controls.
- Real footage with explicit playback and plain chapter navigation.
- Shared English and Korean structure with deliberate Hangul typography.

## Colors

The palette is neutral paper and dark ink, with a small red interaction accent.

### Primary

- **Ink** (`ink`): headings, body text, selected chapters, focus outlines, the brand mark, and filled actions.
- **Deep warm gray** (`ink-3`): hover fill for setup and copy actions.
- **Red accent** (`accent`): the Play label's hover fill.
- **Red tap tint** (`accent-tint`): touch feedback on links, buttons, and disclosures.

### Neutral

- **Paper** (`paper`): page ground and reversed text on filled actions.
- **Inset paper** (`paper-2`): film background and copyable prompt or command containers.
- **Hover paper** (`paper-3`): secondary button hover background.
- **Muted ink** (`mute`): supporting copy, unselected navigation, metadata, and footer text.
- **Strong rule** (`rule-strong`): media frame, button borders, resting link underlines, and scrollbar thumb.

### Named Rules

**The Ink Actions Rule.** Primary actions use ink on paper in reverse; red is reserved for the existing Play hover and tap feedback, not generalized page chrome.

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
- **Small:** `small` for secondary prose; the local-files aside is italic.
- **Label:** `label` for controls and navigation; brand and current chapter use weight 500.
- **Caption:** `caption` for notes, metadata, requirements, and footer.
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
Interactive links, buttons, and disclosure summaries provide a minimum 44px height.
Copyable code wraps and breaks long strings rather than forcing horizontal page overflow.

At a maximum viewport width of 640px, navigation and chapter gaps reduce to 1rem,
chapters use the caption size, the hero gains 2rem top padding, installation padding becomes 3rem,
and the footer stacks with no row gap.
Korean display text reduces to the headline size at this breakpoint.
The frame remains fluid; chapter links remain visible and wrap instead of being hidden.

## Elevation & Depth

The site has no applied shadows, translucent layers, or backdrop blur.
Depth comes from the inset paper fill and a single hairline media border.
The poster cover occupies the film bounds without introducing an elevated card.
Unused shadow declarations in `src/tokens.css` are not part of this site's vocabulary.

### Named Rules

**The Flat Surface Rule.** Separate in-flow surfaces with tone, whitespace, and the existing hairline border rather than shadows.

## Shapes

Film and copy containers have square corners.
Buttons and the Play label use the small control radius from the frontmatter.
The film border is 1px; the active chapter underline and focus outline are 2px.
Focus outlines are offset by 0.25rem and apply to links, buttons, summaries, video, and focusable code.
The hub identity is an inline SVG core with three moons on a quarter orbit.
The setup arrow is also an inline SVG; neither requires an icon font.

## Components

### Buttons

Filled actions use paper text on ink with the small control radius.
The setup anchor uses the primary padding and a 20px stroked SVG arrow; its hover changes the fill to deep warm gray.
Copy buttons use the slightly narrower button padding and an ink border.
The retry button is paper with an ink label and strong-rule border; hover changes to hover paper with an ink border.
All retain the shared visible focus outline.
No custom pressed-state animation is implemented.

### Navigation

The brand and two text links share the in-flow header.
Header links change from muted ink to ink on hover; their hit areas remain at least 44px tall.
The chapter rail is plain text navigation, not a pill group or ARIA tab widget.
The current link uses ink, weight 500, a 2px bottom border, and `aria-current`.
Other chapters gain ink text and a strong-rule underline on hover.
The language link uses the destination language and route; English and Korean share the same structure.

### Film and poster

One bordered film frame shows five actual clips: `annotate`, `capture`, `record`, `multi`, and `rapid`.
Each uses `/demo/<clip>.mp4`, a matching WebP poster, and locale-specific `.en.vtt` or `.ko.vtt` captions.
The current first clip is Annotate.
An explicit poster button appears when script runs; successful playback hides it and exposes the native player controls.
The cover image contains the full poster, and its text label sits 1.25rem from the lower-left corner.
Its fill changes from ink to red on hover.
The cover uses a localized text-only Play label.

Chapter selection changes the video, poster, caption, transcript, download link, and caption track together, then requests playback.
There is no initial autoplay, automatic chapter advance, entrance animation, or decorative animation loop.
The player is muted, inline, and metadata-preloaded; native pause, timeline, and captions remain available.
Playback pauses when the document becomes hidden or the film leaves the viewport.
The cover retains a usable state if playback is blocked and transfers focus to the video when it successfully starts from the focused button.

Loading feedback uses a polite status region.
Failure reveals a retry button and direct video link; written steps remain available in a native disclosure.
Without script, the native first video remains usable, chapters are direct MP4 links, and the initial written steps remain readable.
The footage disclosure states that the requests are demonstrations with no connected agent.

### Copy panels and disclosures

Copyable prompts and commands are selectable code, not text inputs.
The flat inset-paper panel stacks text and a button with a 1rem gap and 1.25rem padding.
Buttons appear only with script.
Success updates a polite status region; clipboard failure selects and focuses the code for manual copying.
A reserved 1.5rem status height limits layout movement.
Native details and summary elements expose the terminal option and written demo steps without adding a custom accordion system.

### Motion

Setup hover and chapter state changes use `200ms ease-in-out` transitions.
Under `prefers-reduced-motion: reduce`, the token duration becomes `0ms`.
The imported slow duration is unused by this surface.
User-requested video playback remains available under reduced motion; the page does not start it on entry.

## Do's and Don'ts

### Do:

- **Do** keep surrounding chrome quiet so actual product footage supplies the detail.
- **Do** preserve the serif prose, sans-serif controls, and mono command roles in both locales.
- **Do** retain explicit playback, native video controls, localized captions, and readable steps.
- **Do** keep current chapter state visible with text weight and an underline, not color alone.
- **Do** preserve keyboard focus, 44px control height, and selectable setup text without script.

### Don't:

- **Don't** restore blueprint grids, sheet furniture, architectural diagrams, or decorative feature-card grids.
- **Don't** add shadows to the site's flat containers or promote unused shadow tokens into new components.
- **Don't** autoplay on entry, advance chapters automatically, or add entrance animation.
- **Don't** turn unused palette or eyebrow declarations into new site styles.
- **Don't** replace real footage with invented product or agent-success evidence.
