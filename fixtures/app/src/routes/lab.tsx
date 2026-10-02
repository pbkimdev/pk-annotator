import { Link, createFileRoute } from "@tanstack/react-router";
import { Component, useRef, useState, type ReactNode } from "react";

export const Route = createFileRoute("/lab")({ component: Lab });

const nested = {
  user: { id: 7, name: "Ada", roles: ["admin", "editor"] },
  settings: { theme: "dark", panels: [{ id: "net", open: true }] },
};

async function report(response: Response): Promise<string> {
  return `${response.status} ${await response.text()}`;
}

function Thrower(): ReactNode {
  throw new Error("lab: render threw");
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) return <p data-testid="lab-boundary-fallback">Boundary caught</p>;
    return this.props.children;
  }
}

function Lab() {
  const [output, setOutput] = useState("");
  const [events, setEvents] = useState(0);
  const [renderThrow, setRenderThrow] = useState(false);
  const [text, setText] = useState("");
  const stream = useRef<AbortController | null>(null);

  const startStream = async () => {
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    const response = await fetch("/api/stream", { signal: controller.signal });
    if (!response.body) throw new Error("lab: stream response has no body");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!controller.signal.aborted) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        setEvents((count) => count + blocks.length);
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  };

  return (
    <main id="lab">
      <h1>Lab</h1>
      <section>
        <button
          type="button"
          data-testid="lab-throw"
          onClick={() => {
            throw new Error("lab: click handler threw");
          }}
        >
          Throw in click handler
        </button>
        <button
          type="button"
          data-testid="lab-reject"
          onClick={() => {
            void Promise.reject(new Error("lab: unhandled rejection"));
          }}
        >
          Unhandled rejection
        </button>
        <button
          type="button"
          data-testid="lab-console"
          onClick={() => {
            console.log("lab: log", nested);
            console.warn("lab: warn", { level: "warn", detail: nested.settings });
            console.error("lab: error", { level: "error", cause: { nested } });
          }}
        >
          Console log, warn, error
        </button>
      </section>
      <section>
        <button
          type="button"
          data-testid="lab-fetch-items"
          onClick={async () => setOutput(await report(await fetch("/api/items")))}
        >
          Fetch /api/items (200)
        </button>
        <button
          type="button"
          data-testid="lab-fetch-fail"
          onClick={async () => setOutput(await report(await fetch("/api/fail")))}
        >
          Fetch /api/fail (500)
        </button>
        <button
          type="button"
          data-testid="lab-fetch-echo"
          onClick={async () => {
            const response = await fetch("/api/echo", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: "ada", password: "hunter2", remember: true }),
            });
            setOutput(await report(response));
          }}
        >
          POST /api/echo with password
        </button>
        <button type="button" data-testid="lab-stream-start" onClick={startStream}>
          Start event stream
        </button>
        <button type="button" data-testid="lab-stream-stop" onClick={() => stream.current?.abort()}>
          Stop event stream
        </button>
        <output data-testid="lab-stream-count">{events}</output>
      </section>
      <section>
        <button
          type="button"
          data-testid="lab-slow"
          onClick={() => {
            const started = performance.now();
            while (performance.now() - started < 300);
            setOutput("slow click done");
          }}
        >
          Slow click (300 ms)
        </button>
        <button type="button" data-testid="lab-render-throw" onClick={() => setRenderThrow(true)}>
          Throw during render
        </button>
        <Boundary>{renderThrow ? <Thrower /> : null}</Boundary>
      </section>
      <form
        data-testid="lab-form"
        onSubmit={(event) => {
          event.preventDefault();
          setOutput(`submitted ${text}`);
        }}
      >
        <label>
          Text{" "}
          <input
            data-testid="lab-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" data-testid="lab-submit">
          Submit
        </button>
      </form>
      <pre data-testid="lab-output">{output}</pre>
      <Link to="/" data-testid="lab-link-home">
        Back to home
      </Link>
    </main>
  );
}
