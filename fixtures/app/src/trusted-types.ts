// Imported first by client.tsx, before any module can compile a string. The practice page
// compiles the candidate's code and zod probes `new Function`; HTML sinks stay refused, so
// an HTML string sink in the overlay fails the smoke.
declare global {
  interface Window {
    trustedTypes?: {
      createPolicy(name: string, rules: { createScript(code: string): string }): { name: string };
    };
  }
}

window.trustedTypes?.createPolicy("default", { createScript: (code) => code });

export {};
