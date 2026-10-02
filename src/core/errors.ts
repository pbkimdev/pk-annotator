interface Frame {
  fn: string | undefined;
  path: string;
  line: number;
}

const LOCATION = /((?:[a-z][a-z\d+.-]*:\/\/|\/)[^\s()]*?):(\d+):\d+\)?\s*$/i;
const CHROME_FN = /^\s*at (?:async )?(.+?) \(/;
const GECKO_FN = /^([^@\s]*)@/;
const NOT_APP = /\/node_modules\/|\/\.vite\/deps\/|\/@vite\/|\/@react-refresh/;
const FRAMES_IN_FINGERPRINT = 3;

// Parses Chrome ("at fn (url:1:2)") and Firefox/Safari ("fn@url:1:2") lines.
// `path` drops the origin, query, and hash so cache-busting `?t=` and `?v=`
// parameters from Vite do not split a group.
function parseFrames(stack: string): Frame[] {
  const frames: Frame[] = [];
  for (const text of stack.split("\n")) {
    const location = LOCATION.exec(text);
    if (location === null) continue;
    const fn = (CHROME_FN.exec(text) ?? GECKO_FN.exec(text))?.[1];
    frames.push({
      fn: fn === undefined || fn === "" ? undefined : fn,
      path: stripUrl(location[1] ?? ""),
      line: Number(location[2]),
    });
  }
  return frames;
}

export function stripUrl(url: string): string {
  return url.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
}

export function normalizeMessage(message: string): string {
  return message
    .slice(0, 500)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(?:0x[0-9a-f]+|(?=[0-9a-f]*\d)[0-9a-f]{8,})\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>");
}

export interface Fingerprinted {
  fingerprint: string;
  topFrame: string | undefined;
}

// Groups by error type, normalized message, and the top in-app frames. Frames use
// the function name rather than the line when one exists, so an edit above the
// throw site keeps the group; the message separates throws from sibling inline
// handlers, which share a name such as `onClick`.
export function fingerprintError(type: string, message: string, stack: string): Fingerprinted {
  const frames = parseFrames(stack).filter(
    (frame) => frame.path !== "" && !NOT_APP.test(frame.path),
  );
  const top = frames[0];
  const key = [
    type,
    normalizeMessage(message),
    ...frames
      .slice(0, FRAMES_IN_FINGERPRINT)
      .map((frame) => `${frame.path}:${frame.fn ?? frame.line}`),
  ].join("|");
  return { fingerprint: hash(key), topFrame: top && `${top.path}:${top.line}` };
}

export function fingerprintResource(tag: string, url: string): string {
  return hash(`resource|${tag}|${stripUrl(url)}`);
}

// cyrb53: a 53-bit string hash, enough to keep fingerprints distinct within one page.
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
