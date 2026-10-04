import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Connect, type Plugin } from "vite";
import { z } from "zod";
import { annotator } from "../../src/vite/index.ts";
import { CSP_NONCE } from "./src/csp-nonce.ts";

function sendJson(response: ServerResponse, statusCode: number, json: string) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.setHeader("server-timing", "db;dur=1, total;dur=2");
  response.end(json);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function stream(request: IncomingMessage, response: ServerResponse) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sequence = 0;
  const send = () => {
    sequence += 1;
    response.write(
      `id: ${sequence}\nevent: tick\ndata: ${JSON.stringify({ sequence, at: Date.now() })}\n\n`,
    );
  };
  send();
  const interval = setInterval(send, 1000);
  request.on("close", () => clearInterval(interval));
}

// Served by `vite dev` and by `vite preview`, so `pka lab` can replay /api calls
// against the production build.
const api: Plugin = {
  name: "pk-annotator-fixture:api",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api", handleApi);
  },
  configurePreviewServer(server) {
    server.middlewares.use("/api", handleApi);
  },
};

const Submission = z.strictObject({
  problem: z.string(),
  language: z.string(),
  code: z.string(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

const GameScore = z.strictObject({
  player: z.string().trim().min(1).max(20),
  score: z.number().int().nonnegative(),
  level: z.number().int().positive(),
});
const scores: z.infer<typeof GameScore>[] = [
  { player: "ada", score: 420, level: 3 },
  { player: "linus", score: 260, level: 2 },
  { player: "grace", score: 120, level: 1 },
];

function handleApi(request: IncomingMessage, response: ServerResponse, next: Connect.NextFunction) {
  const route = `${request.method} ${request.url?.split("?")[0]}`;
  if (route === "GET /items") {
    sendJson(
      response,
      200,
      JSON.stringify({
        items: [
          { id: 1, name: "alpha", tags: ["a", "first"] },
          { id: 2, name: "beta", tags: ["b"] },
        ],
      }),
    );
    return;
  }
  // Chunked like Lean's JSON API: no Content-Length.
  if (route === "GET /chunked") {
    response.writeHead(200, {
      "content-type": "application/json",
      "server-timing": "db;dur=1, total;dur=2",
    });
    response.write('{"items":[{"id":1,"name":"alpha"},');
    setTimeout(() => response.end('{"id":2,"name":"beta"}],"session_token":"secret"}'), 50);
    return;
  }
  if (route === "GET /fail") {
    sendJson(response, 500, JSON.stringify({ error: "fixture failure", code: "FIXTURE_FAIL" }));
    return;
  }
  if (route === "POST /echo") {
    readBody(request)
      .then((body) => sendJson(response, 200, JSON.stringify({ echo: JSON.parse(body) })))
      .catch(next);
    return;
  }
  // Slow like a real judge, so a recording sees the request in flight.
  if (route === "POST /submit") {
    readBody(request)
      .then((body) => {
        const { passed, total } = Submission.parse(JSON.parse(body));
        const status = passed === total ? "Accepted" : "Wrong Answer";
        setTimeout(
          () => sendJson(response, 200, JSON.stringify({ status, passed, total, runtimeMs: 52 })),
          400,
        );
      })
      .catch(next);
    return;
  }
  if (route === "GET /scores") {
    sendJson(response, 200, JSON.stringify(scores.slice(0, 5)));
    return;
  }
  // The game's leaderboard; bounded so a long demo session cannot grow it.
  if (route === "POST /score") {
    readBody(request)
      .then((body) => {
        const entry = GameScore.parse(JSON.parse(body));
        scores.push(entry);
        scores.sort((left, right) => right.score - left.score);
        scores.splice(50);
        const rank = scores.indexOf(entry) + 1;
        setTimeout(
          () => sendJson(response, 200, JSON.stringify({ rank, top: scores.slice(0, 5) })),
          300,
        );
      })
      .catch(next);
    return;
  }
  if (route === "GET /stream") {
    stream(request, response);
    return;
  }
  sendJson(response, 404, JSON.stringify({ error: `no fixture route ${route}` }));
}

// The narrowest image policy the overlay works under: screenshots need data: (see
// captureCanvas in src/overlay/send.ts), pasted images need blob:. Trusted Types is enforced
// so an HTML string sink in the overlay fails the smoke; src/trusted-types.ts registers the
// default policy, which accepts only scripts. Styles need the nonce, so an inline style
// attribute or a `<style>` without it from the overlay or snapdom fails the smoke too.
const csp: Plugin = {
  name: "pk-annotator-fixture:csp",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader(
        "content-security-policy",
        `img-src 'self' blob: data:; style-src 'self' 'nonce-${CSP_NONCE}'; require-trusted-types-for 'script'; trusted-types default`,
      );
      next();
    });
  },
};

export default defineConfig({
  plugins: [...annotator({ bodies: ["/api/"] }), api, csp, tanstackStart(), viteReact()],
  // The overlay is consumed as built, like a published package: launcher chunk first,
  // UI chunk on first open. `pnpm fixture` builds dist first.
  resolve: {
    alias: {
      "pk-annotator/overlay": fileURLToPath(new URL("../../dist/overlay.mjs", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 3200), strictPort: true },
});
