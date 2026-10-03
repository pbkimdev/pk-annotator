#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Every session compiles the same bundled server; V8 reuses the cached code (os.tmpdir()
// or NODE_COMPILE_CACHE; NODE_DISABLE_COMPILE_CACHE turns it off). It must be enabled
// before the server module is compiled, hence the dynamic import.
enableCompileCache();
await import("./main.ts");
