import { useEffect, useRef } from "react";
import { useRepo } from "../hooks/useRepo";
import { useToast } from "../hooks/useToasts";
import { formatDate, formatNumber, relativeTime } from "../lib/format";
import { GroupChips } from "./GroupChips";
import { LanguageDot } from "./LanguageDot";
import { SkeletonCard } from "./SkeletonCard";
import { ErrorState } from "./StateViews";

export interface RepoDrawerProps {
  owner: string;
  name: string;
  onClose: () => void;
}

/**
 * Side drawer with full repo metadata. READMEs are never rendered from remote
 * markdown — we link to GitHub instead (docs/08 §5.2).
 */
export function RepoDrawer({ owner, name, onClose }: RepoDrawerProps) {
  const { data, loading, error, retry } = useRepo(owner, name);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const toast = useToast();

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    return () => {
      restoreRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();

        return;
      }

      if (event.key !== "Tab") return;
      const panel = panelRef.current;

      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const copy = (value: string, label: string) => {
    navigator.clipboard.writeText(value).then(
      () => toast({ title: `${label} copied` }),
      () =>
        toast({
          title: "Couldn't copy",
          body: "Select the URL and copy it manually.",
          tone: "error",
        }),
    );
  };

  const repo = data?.repo;
  const cloneHttps = repo ? `https://github.com/${repo.fullName}.git` : "";
  const cloneSsh = repo ? `git@github.com:${repo.fullName}.git` : "";

  return (
    <div className="drawer-layer">
      <button
        type="button"
        className="drawer-backdrop"
        aria-label="Close details"
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-drawer-title"
      >
        <header className="drawer__header">
          <h2 className="drawer__title" id="repo-drawer-title">
            {repo ? (
              <a href={repo.htmlUrl} target="_blank" rel="noreferrer noopener">
                {repo.fullName}
              </a>
            ) : (
              `${owner}/${name}`
            )}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="btn btn--ghost btn--small"
            onClick={onClose}
            aria-label="Close details"
          >
            ✕
          </button>
        </header>

        <div className="drawer__body">
          {loading ? <SkeletonCard /> : null}
          {error ? (
            <ErrorState title="Couldn't load this repository" error={error} onRetry={retry} />
          ) : null}

          {repo ? (
            <>
              <p className="drawer__desc">{repo.description ?? "No description provided."}</p>

              {repo.archived ? <p className="badge badge--archived">archived on GitHub</p> : null}

              <dl className="meta-grid">
                <div className="meta-grid__item">
                  <dt>Stars</dt>
                  <dd>{formatNumber(repo.stars)}</dd>
                </div>
                <div className="meta-grid__item">
                  <dt>Forks</dt>
                  <dd>{formatNumber(repo.forks)}</dd>
                </div>
                <div className="meta-grid__item">
                  <dt>Language</dt>
                  <dd>
                    <LanguageDot language={repo.language} /> {repo.language ?? "—"}
                  </dd>
                </div>
                <div className="meta-grid__item">
                  <dt>License</dt>
                  <dd>{repo.license ?? "—"}</dd>
                </div>
                <div className="meta-grid__item">
                  <dt>Pushed</dt>
                  <dd>
                    {repo.pushedAt
                      ? `${formatDate(repo.pushedAt)} (${relativeTime(repo.pushedAt)})`
                      : "—"}
                  </dd>
                </div>
                <div className="meta-grid__item">
                  <dt>Starred</dt>
                  <dd>{repo.starredAt ? formatDate(repo.starredAt) : "—"}</dd>
                </div>
              </dl>

              {repo.topics.length > 0 ? (
                <div className="drawer__section">
                  <h3 className="drawer__section-title">Topics</h3>
                  <GroupChips names={repo.topics} max={12} />
                </div>
              ) : null}

              {data && data.groups.length > 0 ? (
                <div className="drawer__section">
                  <h3 className="drawer__section-title">Collections</h3>
                  <GroupChips names={data.groups.map((group) => group.name)} max={6} />
                </div>
              ) : null}

              <div className="drawer__section">
                <h3 className="drawer__section-title">Clone</h3>
                <div className="copy-row">
                  <code className="copy-row__value">{cloneHttps}</code>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => copy(cloneHttps, "Clone URL")}
                  >
                    Copy
                  </button>
                </div>
                <div className="copy-row">
                  <code className="copy-row__value">{cloneSsh}</code>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() => copy(cloneSsh, "SSH clone URL")}
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div className="drawer__actions">
                <a className="btn" href={repo.htmlUrl} target="_blank" rel="noreferrer noopener">
                  Open on GitHub ↗
                </a>
                <a
                  className="btn btn--ghost"
                  href={`${repo.htmlUrl}#readme`}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  README on GitHub ↗
                </a>
                {repo.homepage ? (
                  <a
                    className="btn btn--ghost"
                    href={repo.homepage}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Homepage ↗
                  </a>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
