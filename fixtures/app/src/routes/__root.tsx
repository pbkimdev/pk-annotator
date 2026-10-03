import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { title: "pk-annotator fixture" }],
    // An empty icon, so the browser does not request /favicon.ico.
    links: [{ rel: "icon", href: "data:," }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootDocument(properties: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {properties.children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  useEffect(() => {
    document.documentElement.dataset.fixtureReady = "true";
    return () => {
      delete document.documentElement.dataset.fixtureReady;
    };
  }, []);
  return (
    <div className="shell">
      <header>
        <nav>
          <Link to="/" data-testid="nav-home">
            Home
          </Link>{" "}
          <Link to="/lab" data-testid="nav-lab">
            Lab
          </Link>{" "}
          <Link to="/practice" data-testid="nav-practice">
            Practice
          </Link>{" "}
          <Link to="/game" data-testid="nav-game">
            Game
          </Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
