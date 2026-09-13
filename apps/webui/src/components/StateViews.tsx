import type { ReactNode } from "react";
import type { ApiError } from "../api";

export function EmptyState({
  title,
  body,
  children
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <section className="state-card">
      <h2 className="state-card__title">{title}</h2>
      {body ? <p className="state-card__body">{body}</p> : null}
      {children ? <div className="state-card__actions">{children}</div> : null}
    </section>
  );
}

export function NoResultsState({
  query,
  suggestions
}: {
  query: string;
  suggestions?: ReactNode;
}) {
  return (
    <section className="state-card">
      <h2 className="state-card__title">No matches for “{query}”</h2>
      <p className="state-card__body">
        Your filters are still applied. Try fewer words, or widen the filters below the results.
      </p>
      {suggestions ? <div className="state-card__actions">{suggestions}</div> : null}
    </section>
  );
}

export function ErrorState({
  title = "Something went wrong",
  error,
  onRetry,
  children
}: {
  title?: string;
  error: ApiError;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="state-card state-card--error" role="alert">
      <h2 className="state-card__title">{title}</h2>
      <p className="state-card__body">{error.message}</p>
      {error.detail && error.detail !== error.message ? (
        <p className="state-card__detail">{error.detail}</p>
      ) : null}
      <div className="state-card__actions">
        {onRetry ? (
          <button type="button" className="btn btn--small" onClick={onRetry}>
            Retry
          </button>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export function UserNotFoundState({ login }: { login: string }) {
  return (
    <section className="state-card">
      <h2 className="state-card__title">We couldn&apos;t find a GitHub user named “{login}”</h2>
      <p className="state-card__body">
        Check the spelling — usernames use letters, numbers and single hyphens.
      </p>
      <div className="state-card__actions">
        <a className="btn btn--small" href="/">
          Search another user
        </a>
      </div>
    </section>
  );
}
