import { createRootRoute, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { AppShell } from "../components/AppShell";
import { EmptyState } from "../components/StateViews";

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorBoundary
});

function RootLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function NotFoundPage() {
  return (
    <div className="container container--narrow">
      <EmptyState
        title="Page not found"
        body="That route doesn't exist. Head back home and search a GitHub user instead."
      >
        <Link className="btn" to="/">
          Back home
        </Link>
      </EmptyState>
    </div>
  );
}

function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
  return (
    <div className="container container--narrow">
      <EmptyState
        title="Something broke"
        body={error instanceof Error ? error.message : "An unexpected error occurred in the app."}
      >
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
        <Link className="btn btn--ghost" to="/">
          Back home
        </Link>
      </EmptyState>
    </div>
  );
}
