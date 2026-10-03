---
name: pk-annotator site
description: The public site drawn as a cyanotype drawing set, where marking up the live page is a redline.
colors:
  prussian-ground: "#0d3580"
  prussian-deep: "#0a2a68"
  prussian-ink: "#071c46"
  hairline-white: "#eef3ff"
  hairline-soft: "#b9cdf5"
  hairline-faint: "rgb(238 243 255 / 0.22)"
  grid-minor: "rgb(238 243 255 / 0.055)"
  grid-major: "rgb(238 243 255 / 0.1)"
  redline-pencil: "#ff7a5c"
  pick-highlighter: "#ffe14d"
typography:
  display:
    fontFamily: "Barlow Condensed, Do Hyeon, Arial Narrow, sans-serif"
    fontSize: "clamp(3rem, 5.5vw, 5.4rem)"
    fontWeight: 600
    lineHeight: 0.98
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Barlow Condensed, Do Hyeon, Arial Narrow, sans-serif"
    fontSize: "clamp(2.3rem, 4.6vw, 4rem)"
    fontWeight: 600
    lineHeight: 0.98
  title:
    fontFamily: "Barlow Condensed, Do Hyeon, Arial Narrow, sans-serif"
    fontSize: "clamp(1.5rem, 2.4vw, 2rem)"
    fontWeight: 600
    lineHeight: 0.98
  body:
    fontFamily: "Barlow, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.6
  prose:
    fontFamily: "Barlow, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Barlow Condensed, Do Hyeon, Arial Narrow, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.1em"
  field-value:
    fontFamily: "Barlow Condensed, Do Hyeon, Arial Narrow, sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    letterSpacing: "0.04em"
  hand:
    fontFamily: "Architects Daughter, Nanum Pen Script, cursive"
    fontSize: "18px"
    fontWeight: 400
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, monospace"
    fontSize: "0.8rem"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  none: "0"
  tab: "2px"
  pill: "22px"
  balloon: "50%"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  sheet-gap: "clamp(20px, 3vw, 40px)"
  sheet-pad-x: "clamp(20px, 4vw, 64px)"
  frame: "min(1400px, 100% - 2 * clamp(12px, 2.4vw, 32px))"
components:
  launcher:
    backgroundColor: "{colors.hairline-white}"
    textColor: "{colors.prussian-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.tab}"
    height: "44px"
    padding: "0 16px 0 10px"
  launcher-hover:
    backgroundColor: "{colors.hairline-soft}"
  launcher-pressed:
    backgroundColor: "{colors.pick-highlighter}"
    rounded: "{rounded.pill}"
  copy-field:
    backgroundColor: "{colors.prussian-ink}"
    textColor: "{colors.hairline-white}"
    typography: "{typography.mono}"
    rounded: "{rounded.none}"
    padding: "11px 14px"
  copy-button:
    backgroundColor: "{colors.hairline-white}"
    textColor: "{colors.prussian-ink}"
    rounded: "{rounded.none}"
    padding: "0 16px"
  copy-button-hover:
    backgroundColor: "{colors.hairline-soft}"
  ghost-tab:
    textColor: "{colors.hairline-white}"
    rounded: "{rounded.tab}"
    padding: "4px 10px"
  panel:
    backgroundColor: "{colors.prussian-ink}"
    textColor: "{colors.hairline-white}"
    rounded: "{rounded.none}"
  balloon:
    textColor: "{colors.hairline-white}"
    rounded: "{rounded.balloon}"
    size: "20px"
  balloon-lit:
    backgroundColor: "{colors.hairline-white}"
    textColor: "{colors.prussian-ink}"
  delta-mark:
    backgroundColor: "{colors.redline-pencil}"
    textColor: "{colors.prussian-ink}"
    width: "22px"
    height: "19px"
---

# Design System: pk-annotator site

## Overview

**Creative North Star: "The Redline Drawing Set"**

The site is a cyanotype drawing set.
Each section is one sheet: a solid Prussian-blue ground drawn in white hairlines,
framed by a heavy border with a faint offset outer rule,
lettered A to H across the top and numbered on both side edges.
The graph-paper grid shows only in the gutters between sheets.
Everything a drawing set natively carries is the component vocabulary:
title blocks, revision tables, parts schedules, numbered balloons,
dimension lines, general notes, and status stamps.

Two inks break the white linework, and each has one job.
Red pencil marks a requested change; highlighter yellow marks what is picked right now.
Lettering is condensed and uppercase in English;
hand notes are the only place a handwriting face appears.
Density is that of a working drawing: many small labels, generous sheet margins, hairline dividers in place of boxes.

**Key Characteristics:**

- Solid blue sheets in a gridded gutter, white hairline linework, no fills beyond the darker ink panel.
- Red is markup, yellow is the live pick, everything else is white or soft white.
- Condensed, tracked, uppercase labels for every caption, header, and field name.
- Drawing-set furniture (zones, title block, revisions, balloons, stamps) carries the information.
- Motion draws lines in; it never slides or bounces content.

## Colors

A monochrome cyanotype: three blues for ground and recess, three whites for line weight, and two single-purpose marking inks.

### Primary

- **Hairline White** (`hairline-white`): primary linework, sheet borders, headings, filled buttons, the lit balloon, and the resolved stamp.

### Secondary

- **Redline Pencil** (`redline-pencil`): revision clouds, delta triangles, hand-lettered notes, demo marks drawn on the page, and the dashed note editor. Nothing else.

### Tertiary

- **Pick Highlighter** (`pick-highlighter`): the live pick box and its tag, the picker hover outline and hint, the pressed launcher, the mark count, text selection, and the orbiting moons of the hub glyph. Nothing else.

### Neutral

- **Prussian Ground** (`prussian-ground`): the page and every sheet face.
- **Prussian Deep** (`prussian-deep`): scrollbar track; the recess under the ground.
- **Prussian Ink** (`prussian-ink`): recessed panels (terminal, code, copy fields, flow nodes, picker) and text on white or colored fills.
- **Soft Hairline** (`hairline-soft`): body prose, secondary labels, link underlines, dimension lines, the dashed reply wire.
- **Faint Hairline** (`hairline-faint`): dividers inside a sheet, zone ticks, the outer sheet rule, table rules.
- **Grid Minor / Grid Major** (`grid-minor`, `grid-major`): the 24px and 120px graph grid on the body, visible only in gutters.

### Named Rules

**The Two Inks Rule.** Red appears only on markup and yellow only on the live pick (plus selection and the hub moons). If a red or yellow element is neither a requested change nor the current pick, it is wrong.

**The Line Weight Rule.** Emphasis is carried by switching between white, soft, and faint hairline, never by adding a new hue.

## Typography

**Display Font:** Barlow Condensed 500/600 (Do Hyeon for Hangul, then Arial Narrow)
**Body Font:** Barlow 400/500 (Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR for Hangul)
**Hand Font:** Architects Daughter (Nanum Pen Script for Hangul)
**Mono Font:** JetBrains Mono 400, tabular numerals

**Character:** Engineering lettering over a plain humanist body; the hand face is the drafter's pencil.

### Hierarchy

- **Display** (600, `clamp(3rem, 5.5vw, 5.4rem)`, 0.98): the hero headline only, uppercase in English.
- **Headline** (600, `clamp(2.3rem, 4.6vw, 4rem)`, 0.98, max 16ch): one per sheet.
- **Title** (600, `clamp(1.5rem, 2.4vw, 2rem)`): install step titles.
- **Field value** (600, 1.05rem, 0.02 to 0.04em): title block values, schedule part names, legend terms.
- **Body** (400, 1.0625rem, 1.6) and **Prose** (400, 1.125rem, 58 to 70ch, soft hairline): running text.
- **Label** (500, 0.68 to 0.85rem, 0.08 to 0.12em, uppercase): zones, sheet heads, table heads, panel heads, field names, nav.
- **Mono** (400, 0.8rem, 1.55 to 1.85): commands, transcripts, XML, file names, the pick tag (11px).
- **Hand** (400, 18px; 23px in Korean): red notes in drawings and the note editor input.
- **Outline numeral** (600, `clamp(4rem, 8vw, 6rem)`, 0.8, transparent fill with a 1.5px white stroke): install step numbers.

### Named Rules

**The Korean Label Rule.** On `lang="ko"` pages, small labels switch to the body face, all tracking is zero, headings drop to weight 400 at line height 1.12, uppercase transforms are off, and body text uses `word-break: keep-all` at 1.75.

**The Lettering Rule.** Every caption, header, and field name is set in the label style. Body prose never carries a label's tracking.

## Layout

Sheets are centered on a frame of `min(1400px, 100% - gutters)` and separated by `sheet-gap` so the body grid shows between them.
Each sheet pads `clamp(28px, 5vw, 72px)` on top and `sheet-pad-x` on the sides, and closes with a full-bleed bottom strip
(a title block on sheet 1, a sheet head with sheet number and name on the others) ruled with a 1.5px white line.
Interiors use a 5:7 split (`minmax(0, 5fr) minmax(0, 7fr)`), reversed on alternate sheets.
The hero figure is a 1.9:1 grid of drawing and terminal over a full-width revision table.
The top bar is a 56px sticky strip aligned to the same frame.

At 1080px every split folds to one column, the flow chain stacks vertically with vertical wires, and the title block wraps to three columns.
At 720px the nav, zone letters, and row numbers hide, the hero figure stacks, tables reflow into two-column cards, copy buttons become icon-only, and the title block wraps to two columns.

Small spacing follows an 8, 12, 16px rhythm for panel heads and cells; section-level spacing is clamped between roughly 28 and 72px.

## Elevation & Depth

The system is flat. Depth is drawn: a heavy 1.5px border, a faint 1px outline offset 6px, and the darker ink panel for recesses.
Shadows exist only on elements that float over the page while marking.

### Shadow Vocabulary

- **Floating launcher** (`box-shadow: 0 8px 24px rgb(4 16 44 / 0.45)`): the launcher while it is fixed in the corner during marking.
- **Picker panel** (`box-shadow: 0 12px 32px rgb(4 16 44 / 0.5)`): the demo picker panel.

### Named Rules

**The Drawn Depth Rule.** Sheets and in-flow panels never cast shadows; a soft shadow means the element floats above the drawing during marking.

## Shapes

Corners are square.
Small ghost controls (language switch, replay) take a 2px radius, and the launcher becomes a 22px pill only while it floats.
Circles are reserved for balloons, general-note numbers, callouts, and the hub disc.
Triangles (clip-path) are reserved for red delta marks.
Revision clouds are generated scalloped paths with round joins at 2.2px.
Wires are 1.5px lines with an 8px solid arrowhead; the reply wire is dashed (5px on, 4px off) in soft white.
Dashed borders mean "not yet": the acknowledged stamp, the last lifecycle state, the unsaved button in the hero drawing, and the note editor.

## Components

### Buttons

- **Launcher:** filled white, ink text, 44px tall, hub glyph left, uppercase label (none in Korean). Hover goes soft white and rotates the glyph's moons 16 degrees; pressed goes yellow and rotates them 90 degrees. It sits in sheet 1's title block and floats bottom right only while marking; under 720px the floating launcher is a 44px icon.
- **Copy button:** a filled white cell attached to the right of a copy field, divided by a 1.5px white rule, 16px stroke icon. Hover, done, and failed states go soft white.
- **Ghost tab:** 1px faint border, 2px radius, inherits label type; hover brings the border or text to full white. Used for the language switch and Replay.
- **Text actions:** picker and note editor buttons are bare label text divided by a faint left rule; hover turns them yellow.

### Status stamp

A 1.5px bordered label rotated -2 degrees. Pending is soft white, acknowledged is white and dashed, resolved is a filled white stamp with ink text.

### Cards / Containers

- **Sheet:** see Layout and Elevation; solid ground, no radius.
- **Ink panel:** terminal, XML figure, code blocks, copy fields, flow nodes, and picker share a 1.5px white border on Prussian Ink with a label-style head row over a faint rule.
- **Title block:** a full-bleed grid of field cells divided by faint rules, each a label-style name over a field value.

### Inputs / Fields

- **Copy field:** mono text on ink inside a 1.5px white border, scrolling horizontally.
- **Note editor:** 1.5px dashed red border on ink; the input is red hand lettering with a red caret and no focus outline (the editor itself is the focus).
- **Focus (global):** 2px white outline offset 3px.

### Navigation

The top bar is a translucent ground strip (92% opacity, 6px blur) with a faint bottom rule. Brand is the hub glyph with mixed-case wordmark; nav links are soft white uppercase labels that turn white on hover.

### Drawing furniture (signature)

- **Zones and rows:** A to H letters above each sheet on faint ticks, and the sheet number centered on both side edges, in soft label type.
- **Balloon:** 20px white-ringed circle with a numeral; lit (filled white) when its matching schedule row is active. General notes use a 28px version.
- **Delta mark:** a red triangle with an ink numeral, keyed to a revision.
- **Schedule and legend:** tables with label-style heads, field-value row names, soft prose, mono file names, faint rules, and a 6% white row hover.
- **Pick box:** 2px yellow outline over 10% yellow fill with a yellow mono tag naming the element and its zone.

### Motion

Two easings: `cubic-bezier(0.22, 1, 0.36, 1)` for state changes and `cubic-bezier(0.65, 0, 0.35, 1)` for drawing strokes.
Lines draw in by `stroke-dashoffset` on normalized path length (700 to 1100ms); notes reveal by clip-path wipe; transcript lines type by stepped clip.
The hero sequence plays once and holds; plan drawings draw when their sheet first enters view.
Under reduced motion or without script, the final drawn state shows immediately.

## Do's and Don'ts

### Do:

- **Do** draw every sheet as solid ground with zones on top, its number on both side edges, and a ruled bottom strip.
- **Do** use red only for markup and yellow only for the live pick, selection, and hub moons.
- **Do** express hierarchy with white, soft, and faint hairline weights.
- **Do** set captions, headers, and field names in the tracked uppercase label style, and switch them to the body face with zero tracking on Korean pages.
- **Do** reuse drawing-set furniture (title block, revisions, schedule, balloons, stamps, dimension lines) before inventing a new container.
- **Do** show the final drawn state when motion is reduced or script is unavailable.

### Don't:

- **Don't** show the graph grid inside a sheet; it belongs to the gutters.
- **Don't** add a third accent hue or use red or yellow for emphasis, links, or decoration.
- **Don't** put shadows on sheets or in-flow panels; only marking-time floating elements cast one.
- **Don't** round sheet or panel corners; radius is limited to 2px ghost controls, the floating launcher pill, and circular balloons.
- **Don't** use the hand face for anything but red markup notes.
- **Don't** put a label above a heading or figure as a decorative tag line; a label must name a field, a column, or a panel.
