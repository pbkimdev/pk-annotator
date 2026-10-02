import type { IncomingMessage, ServerResponse } from "node:http";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { annotator } from "../../src/vite/index.ts";

function sendJson(response: ServerResponse, statusCode: number, json: string) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
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

const api: Plugin = {
  name: "pk-annotator-fixture:api",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api", (request, response, next) => {
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
      if (route === "GET /stream") {
        stream(request, response);
        return;
      }
      sendJson(response, 404, JSON.stringify({ error: `no fixture route ${route}` }));
    });
  },
};

export default defineConfig({
  plugins: [...annotator({ bodies: ["/api/"] }), api, tanstackStart(), viteReact()],
  server: { host: "127.0.0.1", port: Number(process.env.PORT ?? 3200), strictPort: true },
});
