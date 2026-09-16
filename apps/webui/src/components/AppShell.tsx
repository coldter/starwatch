import type { ReactNode } from "react";
import { Header } from "./Header";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" className="app__main" tabIndex={-1}>
        {children}
      </main>
      <footer className="app__footer">
        <div className="container">
          <p>
            starwatch indexes public stars only — no account, no sign-in. Search
            results come from the shared community index; be kind to
            GitHub&apos;s rate limits.
          </p>
        </div>
      </footer>
    </div>
  );
}
