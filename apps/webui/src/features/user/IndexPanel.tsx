import { useEffect, useRef, useState } from "react";
import { Clock, Sparkles } from "lucide-react";
import type { SyncPhase, UserIndexState } from "@starwatch/domain";
import { useSemanticSearch } from "@/app/capabilities";
import { AgentProgress } from "@/components/agents/loading-states/agent-progress";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { TodoList, type TodoItem, type TodoItemStatus } from "@/components/agents/todo-list";
import { Button } from "@/components/motion/button/base";
import { ErrorPanel, NoticeStrip } from "@/components/common/StatePanel";
import { formatDateTime, formatNumber, percent } from "@/lib/format";
import { isActivePhase, isMetadataOnly, phaseLabel, semanticWindow } from "@/lib/state";

export interface IndexPanelProps {
  login: string;
  state: UserIndexState;
  /** How live updates arrive: SSE, 5s polling fallback, or nothing. */
  transport: "off" | "sse" | "polling";
  busy: boolean;
  onStartSync: (options?: { full?: boolean }) => void;
  /** Re-read the stored state, for when a run looks stalled. */
  onRefresh: () => void;
  /**
   * Auto-recovery state for a run that stopped heartbeating: `probing` while
   * the page asks the server to recover it, `failed` when that could not be
   * queued and the reader has to choose.
   */
  stall: "none" | "probing" | "failed";
  /** Why the automatic restart could not be queued (`failed` only). */
  stallMessage?: string | null;
}

/**
 * Seconds this browser has watched the current phase run.
 *
 * The index state carries no run start time — `updatedAt` moves with every
 * progress write — so the panel reports the time it can prove: how long the
 * phase has been on screen here. It resets when the phase changes.
 */
function useObservedSeconds(active: boolean, phase: SyncPhase): number {
  const startedAt = useRef<number | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setSeconds(0);

      return;
    }

    startedAt.current = Date.now();
    setSeconds(0);

    const timer = window.setInterval(() => {
      if (startedAt.current !== null) {
        setSeconds(Math.floor((Date.now() - startedAt.current) / 1000));
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [active, phase]);

  return seconds;
}

/** Position of an active phase in the pipeline: metadata → READMEs → [vectors]. */
function phaseStep(phase: SyncPhase, semanticSearch: boolean): number {
  switch (phase) {
    case "fetching-readmes":
      return 1;
    // A stored `embedding` row can outlive a flag flip; without semantic search
    // the run is finishing the README pass, which is the last step there is.
    case "embedding":
      return semanticSearch ? 2 : 1;
    default:
      return 0;
  }
}

/** A step is done once a later phase is running, live on the current phase. */
function stepStatus(phase: SyncPhase, step: number, semanticSearch: boolean): TodoItemStatus {
  const current = phaseStep(phase, semanticSearch);

  if (step < current) return "completed";

  if (step === current) return "in-progress";

  return "pending";
}

interface PipelineStep {
  id: string;
  title: string;
  done: number;
  total: number;
}

/**
 * Detail line for the live step. A step whose counter is already at its total
 * is *not* finished — the run still has to diff, chain and finalize — so saying
 * "3,447 of 3,447" next to a spinner reads as "stuck at 100%".
 */
function stepDetail(step: PipelineStep): string {
  if (step.total <= 0) return "starting…";

  if (step.done >= step.total) return "wrapping up…";

  return `${formatNumber(step.done)} of ${formatNumber(step.total)}`;
}

/** The sync stages with their real counters, mapped to `TodoList` items. */
function pipelineItems(state: UserIndexState, semanticSearch: boolean): TodoItem[] {
  const steps: PipelineStep[] = [
    {
      id: "metadata",
      title: "Read the star list",
      done: state.reposMetadata,
      total: state.starsTotal,
    },
    {
      id: "readmes",
      title: "Fetch READMEs",
      done: state.readmesFetched,
      total: state.starsTotal,
    },
  ];

  // The third step only exists on deployments that build vectors; a two-step
  // list is the whole pipeline when semantic search is off.
  if (semanticSearch) {
    steps.push({
      id: "semantic",
      title: "Build the semantic index",
      done: state.semanticDocs,
      total: semanticWindow(state),
    });
  }

  const items: TodoItem[] = [];

  for (const [index, step] of steps.entries()) {
    const status = stepStatus(state.phase, index, semanticSearch);

    if (status === "in-progress") {
      items.push({
        id: step.id,
        title: step.title,
        status,
        progress: percent(step.done, step.total),
        detail: stepDetail(step),
      });
    } else {
      items.push({ id: step.id, title: step.title, status });
    }
  }

  return items;
}

/**
 * The reader-facing half of stall recovery, under the indexing steps: a quiet
 * "restarting safely" shimmer while the page probes the server, and a manual
 * retry only when that probe could not queue a run. The scary part of a stall
 * — whether the run is dead or merely quiet — is decided server-side.
 */
function StallNote({
  stall,
  stallMessage,
  busy,
  onRefresh,
  onStartSync,
}: {
  stall: "probing" | "failed";
  stallMessage: string | null;
  busy: boolean;
  onRefresh: () => void;
  onStartSync: (options?: { full?: boolean }) => void;
}) {
  if (stall === "probing") {
    return (
      <ThinkingShimmer>
        Indexing hasn&apos;t reported progress recently — restarting it safely…
      </ThinkingShimmer>
    );
  }

  return (
    <NoticeStrip
      icon={Clock}
      tone="error"
      action={
        <span className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onRefresh}>
            Check again
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onStartSync({ full: true })}
          >
            Restart indexing
          </Button>
        </span>
      }
    >
      <span>
        Indexing stopped reporting progress. Everything already indexed is kept.
        {stallMessage === null || stallMessage.length === 0 ? null : (
          <span className="mt-1 block text-xs text-muted-foreground">{stallMessage}</span>
        )}
      </span>
    </NoticeStrip>
  );
}

/**
 * The whole "what is the index doing" story for a user. Returns nothing when
 * the index is settled, complete, and error-free, so a healthy page stays quiet.
 */
export function IndexPanel({
  login,
  state,
  transport,
  busy,
  onStartSync,
  onRefresh,
  stall,
  stallMessage = null,
}: IndexPanelProps) {
  const active = isActivePhase(state.phase);
  const elapsedSeconds = useObservedSeconds(active, state.phase);
  const semanticSearch = useSemanticSearch();

  if (active) {
    return (
      <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
        <AgentProgress
          label={phaseLabel(state.phase, semanticSearch)}
          elapsedSeconds={elapsedSeconds}
        />
        <TodoList title="Indexing steps" items={pipelineItems(state, semanticSearch)} />
        {stall === "none" ? (
          <ThinkingShimmer>Search works during indexing.</ThinkingShimmer>
        ) : (
          <StallNote
            stall={stall}
            stallMessage={stallMessage}
            busy={busy}
            onRefresh={onRefresh}
            onStartSync={onStartSync}
          />
        )}
        {transport === "polling" ? (
          <p className="text-xs text-muted-foreground">Checking for updates every 5 seconds.</p>
        ) : null}
      </section>
    );
  }

  if (state.phase === "paused") {
    return (
      <NoticeStrip
        icon={Clock}
        action={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onStartSync({ full: true })}
          >
            Try again
          </Button>
        }
      >
        Paused by the GitHub rate limit
        {state.lastError ? `: ${state.lastError}` : ""}. A run that is still waiting resumes on its
        own when the limit resets; if this stays paused, try again.
      </NoticeStrip>
    );
  }

  if (state.phase === "failed") {
    return (
      <ErrorPanel
        title="Indexing failed"
        error={{ message: state.lastError ?? "The last indexing run did not finish." }}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onStartSync({ full: true })}
        >
          Retry
        </Button>
      </ErrorPanel>
    );
  }

  const settled = state.phase === "idle" || state.phase === "ready";

  const needsSemantic =
    semanticSearch && (isMetadataOnly(state) || (state.semanticDocs === 0 && settled));

  const staleError = settled && state.lastError !== null;

  if (!needsSemantic && !staleError) return null;

  return (
    <div className="flex flex-col gap-3">
      {needsSemantic ? (
        <NoticeStrip
          icon={Sparkles}
          action={
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              // `full: true` — a metadata-only re-list never chains the README
              // and embedding pass, so this button could never do what it says.
              onClick={() => onStartSync({ full: true })}
            >
              Enable semantic search
            </Button>
          }
        >
          Build the vector index for @{login} to enable semantic search.
        </NoticeStrip>
      ) : null}

      {staleError ? (
        <p className="text-xs text-muted-foreground">
          Last attempt failed: {state.lastError}
          {state.lastSyncedAt !== null
            ? ` · last success ${formatDateTime(state.lastSyncedAt)}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
