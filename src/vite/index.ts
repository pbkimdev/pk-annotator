import type { Plugin } from "vite";

export type AnnotatorOptions = { bodies?: string[]; maxStoreBytes?: number };

export function annotator(_options?: AnnotatorOptions): Plugin[] {
  return [];
}
