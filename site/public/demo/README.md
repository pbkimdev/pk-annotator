# Demo media

These five silent clips are screen recordings of the real pk-annotator overlay.
Each clip has a WebP poster cut from the same recording.

| File           | Route       | Length | Workflow                                                                     |
| -------------- | ----------- | ------ | ---------------------------------------------------------------------------- |
| `annotate.mp4` | `/practice` | 15.9 s | Draw a circle, which saves a mark; open Send, type a comment, send           |
| `capture.mp4`  | `/practice` | 14.7 s | Drag a screenshot area, confirm the crop, type a request, send               |
| `record.mp4`   | `/game`     | 17.1 s | Record a region with Video and GIF on, play, stop, type a request, save      |
| `multi.mp4`    | `/practice` | 22.2 s | Save an element mark and a screenshot mark, then send both as one annotation |
| `rapid.mp4`    | `/practice` | 18.6 s | Pick and send two requests back to back; History lists both                  |

## Source

The overlay was built from git revision `9867717` on 2026-10-04.
It ran in headed Chromium at device scale 2 on the repository fixture (`fixtures/app`).
The fixture served on a loopback port and wrote to a scratch annotation store under `/tmp`.
ffmpeg x11grab filmed the browser's content area on an Xvfb display.
The renderer cropped the fixture's navigation row and scaled each frame from 1760 x 1100 to 1600 x 1000.
A script drove the input as real Chrome DevTools Protocol mouse and keyboard events.
The visible pointer is drawn from the log of those events, because the virtual display has no cursor of its own.
The capture context overrides `navigator.webdriver` the same way `fixtures/smoke.ts` does.
The product's automation guard was not changed.

Each MP4 carries `title`, `comment`, and `date` tags that state this provenance and the steps.
Each WebP poster carries the same text in an XMP chunk.

## What the clips do not show

No agent was connected, and no AI changed the fixture's code.
The requests are demo input.
After Send, History lists each request as Pending, and it stays pending.
The product's "Don't show again" choice was stored before filming, so the no-agent "Copied to clipboard" pop-up does not appear.

The built `pka` CLI read each scratch store after filming:

- annotate: one pending annotation, the comment followed by `## Mark 1` and the ellipse drawing as attachment 1.
- capture: one pending annotation, `Show this example as a table: [attachment 1: Cropped screenshot]`.
- record: the clip ends at Save.
  A Send after the clip's end point stored the mark; its manifest lists a WebM and a 480 x 310 GIF with 23 frames.
- multi: one pending annotation with `## Mark 1 (elements 1)` and `## Mark 2`.
- rapid: two separate pending annotations.

In `record.mp4`, typed spaces were entered as text input, because the fixture game pauses on a Space keydown even while focus is in the overlay's composer.
