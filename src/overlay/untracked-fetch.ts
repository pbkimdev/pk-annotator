import { getCapture } from "./capture.ts";

// The overlay build injects this for every free `fetch` reference (tsdown.config.ts), so
// requests from overlay code and bundled libraries such as snapdom, which has no fetch
// option, bypass capture and never appear as page requests.
export function untrackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return getCapture().fetch(input, init);
}
