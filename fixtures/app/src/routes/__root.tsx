import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { title: "pk-annotator fixture" }],
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
  return (
    <div className="shell">
      <header>
        <nav>
          <Link to="/" data-testid="nav-home">
            Home
          </Link>{" "}
          <Link to="/lab" data-testid="nav-lab">
            Lab
          </Link>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
