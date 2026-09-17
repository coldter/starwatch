import { createRootRoute, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";
import { AppShell } from "@/app/AppShell";
import { NotFoundGlitch } from "@/components/motion/not-found/glitch";
import { ErrorPanel } from "@/components/common/StatePanel";

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
  errorComponent: RootErrorBoundary,
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
    <NotFoundGlitch
      className="page-shell py-10"
      title="This star isn't on the map"
      description="That route doesn't exist. Head home and look up a GitHub user instead."
      homeHref="/"
      homeLabel="Back home"
      browseHref="https://github.com/coldter/starwatch"
      browseLabel="Browse the source"
    />
  );
}

function RootErrorBoundary({ error, reset }: ErrorComponentProps) {
  return (
    <div className="page-shell py-16">
      <ErrorPanel
        title="Something broke while rendering this page"
        error={
          error instanceof Error ? error : new Error("An unexpected error occurred in the app.")
        }
        onRetry={reset}
      >
        <Link
          to="/"
          className="inline-flex h-8 items-center rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Back home
        </Link>
      </ErrorPanel>
    </div>
  );
}
