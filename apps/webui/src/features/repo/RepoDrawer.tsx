import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Star, X } from "lucide-react";
import type { Group, Repo } from "@starwatch/domain";
import { useToast } from "@/app/toast";
import { Avatar } from "@/components/common/Avatar";
import { ArchivedBadge, CollectionChip, TopicChip } from "@/components/common/Badges";
import { LanguageDot } from "@/components/common/LanguageDot";
import { RepoPreview } from "@/components/common/RepoPreview";
import { Skeleton } from "@/components/common/Skeletons";
import { ErrorPanel } from "@/components/common/StatePanel";
import { ActionSwapBlurButton, type ActionSwapItem } from "@/components/motion/action-swap-blur";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { Drawer } from "@/components/motion/drawer";
import { useRepo } from "@/hooks/useRepo";
import { copyText } from "@/lib/clipboard";
import { formatDate, formatNumber, relativeTime } from "@/lib/format";
import { ownerAvatarUrl } from "@/lib/repo-images";

export interface RepoDrawerProps {
  open: boolean;
  owner: string | null;
  name: string | null;
  onClose: () => void;
}

/** Muted micro-label shared by the facts grid and every section title. */
const LABEL = "text-xs font-medium tracking-wide text-muted-foreground uppercase";

const COPY_ITEMS: ActionSwapItem[] = [
  {
    id: "copy",
    label: "Copy",
    icon: <Copy className="size-3.5" aria-hidden="true" />,
  },
  {
    id: "copied",
    label: "Copied",
    icon: <Check className="size-3.5" aria-hidden="true" />,
  },
];

/**
 * The payoff for opening a result: everything the index knows about one repo,
 * dense and scannable. READMEs are never rendered from remote markdown — the
 * drawer links to GitHub's README anchor instead (ui-contract.md §5).
 */
export function RepoDrawer({ open, owner, name, onClose }: RepoDrawerProps) {
  const { data, loading, error, retry } = useRepo(owner, name);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // The drawer primitive owns Escape and the backdrop; this only puts the
  // first tab stop on the close button and hands focus back to the trigger.
  useEffect(() => {
    if (!open) return;

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    return () => {
      restoreRef.current?.focus();
    };
  }, [open]);

  // `aria-modal` promises the page behind is unreachable, and the primitive
  // does not deliver that on its own, so Tab is contained to the panel.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const panel = panelRef.current;

      if (!panel) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

    document.addEventListener("keydown", onKeyDown);

    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const repo = data?.repo ?? null;
  const fallbackTitle = owner && name ? `${owner}/${name}` : "Repository details";

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      side="right"
      ariaLabel="Repository details"
      className="w-full sm:w-96"
    >
      <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {repo ? (
                <Avatar
                  login={repo.owner}
                  src={ownerAvatarUrl(repo.owner, 64)}
                  size={24}
                  className="rounded-md"
                />
              ) : null}
              <h2 className="truncate text-base font-semibold tracking-tight">
                {repo ? (
                  <a
                    href={repo.htmlUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-sm hover:underline"
                  >
                    {repo.fullName}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{fallbackTitle}</span>
                )}
              </h2>
            </div>
            {repo?.archived ? <ArchivedBadge className="mt-1.5" /> : null}
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="icon"
            className="-mr-1 shrink-0"
            aria-label="Close repository details"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? <RepoDrawerSkeleton /> : null}
          {error ? (
            <div className="p-4">
              <ErrorPanel title="Couldn't load this repository" error={error} onRetry={retry} />
            </div>
          ) : null}
          {data ? <RepoDetail repo={data.repo} groups={data.groups} /> : null}
        </div>

        {data ? <RepoFooter repo={data.repo} /> : null}
      </div>
    </Drawer>
  );
}

/** Placeholder with the drawer's anatomy, so nothing jumps once data lands. */
function RepoDrawerSkeleton() {
  return (
    <div className="space-y-3 p-4" role="status" aria-label="Loading repository details">
      <Skeleton className="aspect-2/1 w-full rounded-xl" />
      <Skeleton className="h-3.5 w-4/5" />
      <Skeleton className="h-3.5 w-3/5" />
      <Skeleton className="h-5 w-1/2 rounded-full" />
      <Skeleton className="h-20 w-full rounded-xl" />
    </div>
  );
}

function RepoDetail({ repo, groups }: { repo: Repo; groups: ReadonlyArray<Group> }) {
  const cloneHttps = `https://github.com/${repo.fullName}.git`;
  const cloneSsh = `git@github.com:${repo.fullName}.git`;

  return (
    <div className="space-y-5 px-4 py-4">
      <RepoPreview repo={repo} loading="eager" className="w-full" />

      <p className="text-sm leading-relaxed text-muted-foreground">
        {repo.description ?? "No description on GitHub."}
      </p>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-xl border border-border bg-muted/40 p-3.5 sm:grid-cols-2">
        <Fact label="Stars">
          <span className="inline-flex items-center gap-1">
            <Star className="size-3.5 fill-star text-star" aria-hidden="true" />
            {formatNumber(repo.stars)}
          </span>
        </Fact>
        <Fact label="Forks">{formatNumber(repo.forks)}</Fact>
        <Fact label="Language">
          <span className="inline-flex items-center gap-1.5">
            <LanguageDot language={repo.language} />
            {repo.language ?? "—"}
          </span>
        </Fact>
        <Fact label="License">{repo.license ?? "—"}</Fact>
        <Fact label="Last pushed">
          {repo.pushedAt ? `${formatDate(repo.pushedAt)} · ${relativeTime(repo.pushedAt)}` : "—"}
        </Fact>
        <Fact label="Starred at">{formatDate(repo.starredAt)}</Fact>
        {repo.homepage ? (
          <Fact label="Homepage">
            <a
              href={repo.homepage}
              target="_blank"
              rel="noreferrer noopener"
              className="block max-w-full truncate text-primary hover:underline"
            >
              {repo.homepage}
            </a>
          </Fact>
        ) : null}
      </dl>

      {repo.topics.length > 0 ? (
        <section className="space-y-2">
          <h3 className={LABEL}>Topics</h3>
          <div className="flex flex-wrap gap-1.5">
            {repo.topics.map((topic) => (
              <TopicChip key={topic}>{topic}</TopicChip>
            ))}
          </div>
        </section>
      ) : null}

      {groups.length > 0 ? (
        <section className="space-y-2">
          <h3 className={LABEL}>Collections</h3>
          <div className="flex flex-wrap gap-1.5">
            {groups.map((group) => (
              <CollectionChip key={group.id} name={group.name} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border bg-muted/40 p-3.5">
        <h3 className={LABEL}>Clone</h3>
        <div className="mt-2.5 space-y-3">
          <CloneRow label="HTTPS" url={cloneHttps} />
          <CloneRow label="SSH" url={cloneSsh} />
        </div>
      </section>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={LABEL}>{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function CloneRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        <CopyButton value={url} name={`${label} clone URL`} />
      </div>
      <code className="block overflow-x-auto rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground select-all">
        {url}
      </code>
    </div>
  );
}

/**
 * Copy control driven by the write result: the label only says "Copied" after
 * the clipboard really took the text, so the button and the toast can never
 * contradict each other.
 */
function CopyButton({ value, name }: { value: string; name: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const ok = await copyText(value);

    if (!ok) {
      toast.error("Couldn't copy", "Select the URL and copy it manually.");

      return;
    }

    toast.success(`${name} copied`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <ActionSwapBlurButton
      items={COPY_ITEMS}
      value={copied ? "copied" : "copy"}
      variant="secondary"
      size="sm"
      aria-label={`Copy ${name}`}
      onValueChange={() => {
        void handleCopy();
      }}
    />
  );
}

function RepoFooter({ repo }: { repo: Repo }) {
  return (
    <footer className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3.5">
      <ButtonLink
        href={repo.htmlUrl}
        target="_blank"
        rel="noreferrer noopener"
        variant="primary"
        className="w-full"
      >
        Open on GitHub
      </ButtonLink>
      <ButtonLink
        href={`${repo.htmlUrl}#readme`}
        target="_blank"
        rel="noreferrer noopener"
        variant="secondary"
        className="w-full"
      >
        README on GitHub
      </ButtonLink>
      {repo.homepage ? (
        <ButtonLink
          href={repo.homepage}
          target="_blank"
          rel="noreferrer noopener"
          variant="ghost"
          className="w-full"
        >
          Homepage
        </ButtonLink>
      ) : null}
    </footer>
  );
}
