# WebUI rebuild contract (beUI + Tailwind v4)

The `apps/webui` interface is being rebuilt from scratch on **beUI** components
(vendored from the `@beui` shadcn registry) and Tailwind v4 tokens. The old
hand-rolled CSS components are gone. This file is the interface contract for
that rebuild: read it before writing any file, and treat it as authoritative.

## 1. Non-negotiables

- **Do not edit** `src/components/motion/**` or `src/components/agents/**`
  (vendored beUI source; the shadcn CLI owns it), `src/lib/{ease,utils,touch,text-shimmer,command-search,presence-gate}.ts(x)`,
  `src/lib/hooks/**`, `src/api.ts`, `src/hooks/useSearch.ts`,
  `src/hooks/useUserIndex.ts`, `src/hooks/useRepo.ts`, `src/lib/**` (app logic),
  `src/app/**` (shell), `src/router.tsx`, `src/routes/**`, `vite.config.ts`,
  `tsconfig.json`, `src/styles.css`.

  **Documented carve-out — the semantic-search capability gate.** When the
  worker was given a `STARWATCH_SEMANTIC_SEARCH` flag (default off), the UI had
  to learn the capability from the server, so these files gained one capability
  read each, through `useSemanticSearch()` from `@/app/capabilities`: `src/api.ts`
  (`HealthPayload` + `fetchHealth`), `src/app/capabilities.tsx` (new:
  `CapabilitiesProvider` / `useSemanticSearch`, mounted in `src/main.tsx`),
  `src/app/CommandMenu.tsx` (hides the search-mode group), `src/lib/state.ts`
  (`freshness`/`phaseLabel` take the flag), `src/routes/user.tsx` (mode
  normalisation, gated auto-start and CTAs), and the presentational gates in
  `src/components/common/Badges.tsx`, `src/features/search/{SearchToolbar,
ResultSummary,SearchStates}.tsx`, `src/features/user/{IndexPanel,ProfileHeader,
BrowsePanel}.tsx`, `src/features/landing/{LandingHero,HowItWorks,
UserPreviewCard}.tsx`. No other rule here changes: this is the only sanctioned
  reason to touch those paths.

### Local patches to vendored beUI

Vendored files stay byte-identical to the registry except for these documented
fixes, which must survive any `shadcn add` re-install (re-apply them after an
update, or the bug returns):

| File                                                                                                                            | Patch                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/motion/bottom-sheet.tsx`, `combobox/use-active-option.ts`, `loader.tsx`, `lib/hooks/{use-row-cursor,use-slider}.ts` | undefined-safe reads for this repo's `noUncheckedIndexedAccess`; the slider also skips reporting values that did not change step                                                                                                                           |
| `components/motion/text-shimmer.tsx`                                                                                            | imports its helpers from `@/lib/text-shimmer` instead of itself                                                                                                                                                                                            |
| `components/motion/button/base.tsx`                                                                                             | disabled fill at `opacity-50` vanished into the light theme's page; raised to `opacity-70`                                                                                                                                                                 |
| `components/motion/select.tsx`                                                                                                  | returns focus to the trigger after a choice; upstream leaves focus on `<body>` because the closed panel is `inert`. Also accepts `ariaLabel` on `SelectTrigger`, which otherwise emits a button with no accessible name (the trigger has no visible label) |
| `components/motion/scroll-reveal.tsx`                                                                                           | unchanged, but consumers must pass `amount="some"` and a `print:` override when the content matters (see `features/search/ResultList.tsx`)                                                                                                                 |

- **Only create the files assigned to your slice.** Other agents are writing
  sibling slices in parallel; a file you were not assigned does not exist yet,
  and touching it will collide.
- **No new dependencies.** Everything you need is installed.
- **Never invent motion.** If a beUI component covers the interaction, use it.
  No custom `motion.div` choreography, no new CSS keyframes.
- Import via the `@/` alias (`@/lib/utils`, `@/components/motion/button/base`).

## 2. Styling rules

- Style with Tailwind utilities only. **Semantic tokens only**, never raw
  palette values: `bg-background`, `bg-card`, `bg-muted`, `bg-accent`,
  `text-foreground`, `text-muted-foreground`, `text-accent-foreground`,
  `border-border`, `border-border-strong`, `bg-primary text-primary-foreground`,
  `text-star` (gold, for stars), `text-live` (green, live), `text-destructive`,
  `text-warn`, `text-info`, `bg-ring`. Light/dark are token swaps — a component
  that hardcodes `text-white` or `bg-gray-900` is broken.
- Compose conditional classes with `cn()` from `@/lib/utils`.
- Shape language: cards and panels `rounded-2xl border border-border bg-card`;
  controls come pre-shaped from beUI (`h-8/h-10` pills, `rounded-xl` fields);
  chips and tags `rounded-full`.
- Layout: wrap page content in `page-shell` (a utility defined in
  `src/styles.css`). Mobile-first; add `sm:`, `lg:` upgrades, never desktop-only.
- Do not remove focus styles. Keyboard visibility is required.
- Keep interactivity obvious on hover **and** focus-visible.

## 3. Code conventions (enforced by `oxlint` as errors)

The repo lints with a custom anti-slop plugin. Write code that passes:

- Blank line required before `return`, `if`, `for`, `while`, `do`, `switch`,
  `try`, and around multi-line `const`s and after the import block.
- No `as` type assertions without a `// SAFETY:` comment stating the checked
  invariant. Prefer narrowing.
- No runtime `typeof` dispatch; no `unknown` params/returns; no `object`
  parameters; no `filter(...).map(...)` chains (use one loop or `flatMap`);
  no accumulating `reduce` spreads.
- Effect-flavored rules do not apply to UI code.
- Run `pnpm exec oxfmt <paths>` from the repo root to format your slice, then
  `pnpm oxlint <paths>` and fix everything it reports.

## 4. What exists (imports and key APIs)

Design tokens and Tailwind live in `src/styles.css`. Read it once.

### Vendored beUI primitives

| Import                                                | Key API                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/components/motion/button/base`                     | `Button`, `ButtonLink` — `variant: "primary" \| "secondary" \| "ghost" \| "outline"`, `size: "sm" \| "md" \| "lg" \| "icon"`                                                                                                                                                                        |
| `@/components/motion/input`                           | `Input` — `label`, `value`, `onChange(value)`, `leftIcon`, `rightIcon`, `error`, `classNames`                                                                                                                                                                                                       |
| `@/components/motion/tabs`                            | `Tabs` (`variant: "pill" \| "segment" \| "underline"`, `value`, `onValueChange`), `TabsList`, `TabsTrigger`, `TabsContent`                                                                                                                                                                          |
| `@/components/motion/select`                          | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` (`value`, `children`)                                                                                                                                                                                                       |
| `@/components/motion/multi-select`                    | `MultiSelect` (`value: string[]`, `onValueChange`, `open`, `onOpenChange`), `MultiSelectTrigger`, `MultiSelectValue` (`placeholder`), `MultiSelectContent`, `MultiSelectList`, `MultiSelectItem` (`value`, `textValue`, `keywords`), `MultiSelectEmpty`, `MultiSelectLabel`, `MultiSelectSeparator` |
| `@/components/motion/range-slider`                    | `RangeSlider` — `value`, `onValueChange`, `min`, `max`, `step`, `showTicks`, `aria-label`, `formatValueText`                                                                                                                                                                                        |
| `@/components/motion/switch`                          | `Switch` — `checked`, `onCheckedChange`, `label`, `ariaLabel`                                                                                                                                                                                                                                       |
| `@/components/motion/drawer`                          | `Drawer` — `open`, `onOpenChange`, `side: "left" \| "right"`, `ariaLabel`, `dismissable`                                                                                                                                                                                                            |
| `@/components/motion/bottom-sheet`                    | `BottomSheet` — `open`, `onOpenChange`, `snapPoints`, `defaultSnap`, `title`, `description`                                                                                                                                                                                                         |
| `@/components/motion/popover`                         | `Popover` (`side`, `align`, `trigger: "click" \| "hover"`), `PopoverTrigger`, `PopoverContent`                                                                                                                                                                                                      |
| `@/components/motion/tooltip`                         | `Tooltip` — `content`, single child trigger                                                                                                                                                                                                                                                         |
| `@/components/motion/animated-badge`                  | `AnimatedBadge` — `status: "neutral" \| "info" \| "success" \| "warning" \| "danger" \| "loading"`, `size: "sm" \| "md"`, `icon` (element), `contentKey`                                                                                                                                            |
| `@/components/motion/loader`                          | `Loader` — `variant` (`"spinner"`, `"dots"`, `"bars"`, `"ascii"`, `"morph"`, `"scramble"`…), `size`, `label`                                                                                                                                                                                        |
| `@/components/motion/scroll-reveal`                   | `ScrollReveal` — wraps children, `delay`, `y`, `once`                                                                                                                                                                                                                                               |
| `@/components/motion/text-reveal`                     | `TextReveal` — `text`, `as`, `split: "word" \| "char"`                                                                                                                                                                                                                                              |
| `@/components/motion/animated-number`                 | `AnimatedNumber` — `value`, `format`                                                                                                                                                                                                                                                                |
| `@/components/motion/number-ticker`                   | `NumberTicker` — `value`, `locale`, `startOnView`                                                                                                                                                                                                                                                   |
| `@/components/motion/action-swap-blur`                | `ActionSwapBlurButton`, `ActionSwapBlurText` — `items: [{ id, label, icon? }]`, `value`, `onValueChange`                                                                                                                                                                                            |
| `@/components/agents/todo-list`                       | `TodoList` — `items: [{ id, title, status: "pending" \| "in-progress" \| "completed" \| "cancelled", progress?, detail? }]`, `title`, `defaultOpen`                                                                                                                                                 |
| `@/components/agents/loading-states/agent-progress`   | `AgentProgress` — `label`, `elapsedSeconds`, `running`                                                                                                                                                                                                                                              |
| `@/components/agents/loading-states/thinking-shimmer` | `ThinkingShimmer` — shimmering status text                                                                                                                                                                                                                                                          |

Read the vendored file before using an unfamiliar prop; it is the source of
truth, and this table is a pointer.

### Shared app components (already written — import, do not duplicate)

| Import                            | API                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@/components/common/Avatar`      | `Avatar({ login, name, src, size?, className? })`                                                                                                                                                                                     |
| `@/components/common/LanguageDot` | `LanguageDot({ language, className? })`                                                                                                                                                                                               |
| `@/components/common/RepoPreview` | `RepoPreview({ repo, className?, loading? })` — GitHub's 2:1 social preview; fades in when it arrives and removes itself when GitHub rate-limits or the repo has no preview                                                           |     |
| `@/components/common/Badges`      | `FreshnessBadge({ state, now?, className? })`, `MatchBadge({ source })`, `ArchivedBadge({ className? })`, `CollectionChip({ name })`, `TopicChip({ children })`                                                                       |
| `@/components/common/StatePanel`  | `StatePanel({ icon?, title, body?, tone?, children? })`, `ErrorPanel({ title, error, onRetry?, children? })`, `NoticeStrip({ icon?, children, tone?, action? })`, type `DisplayError = { message: string; detail?: string \| null }`  |
| `@/components/common/Skeletons`   | `Skeleton`, `ResultSkeleton`, `ResultSkeletonList`, `HeroSkeleton`                                                                                                                                                                    |
| `@/components/common/Brand`       | `GitHubMark({ className? })`                                                                                                                                                                                                          |
| `@/app/toast`                     | `useToast()` → `{ toast, info, success, error, loading, update, dismiss }`; e.g. `toast.success("Link copied", "…")`                                                                                                                  |
| `@/hooks/useDocumentTitle`        | `useDocumentTitle(title)`                                                                                                                                                                                                             |
| `@/lib/format`                    | `formatNumber`, `formatCompact`, `relativeTime`, `formatDate`, `formatDateTime`, `coveragePercent`, `percent`                                                                                                                         |
| `@/lib/state`                     | `hasIndex`, `isActivePhase`, `isTerminalPhase`, `isStale`, `isMetadataOnly`, `exceedsStarCap`, `semanticWindow`, `semanticCoverage`, `phaseProgress`, `phaseLabel(phase, semanticSearch?)`, `freshness(state, now?, semanticSearch?)` |
| `@/lib/languages`                 | `LANGUAGES`, `colorForLanguage`                                                                                                                                                                                                       |
| `@/lib/repo-images`               | `ownerAvatarUrl(owner, size?)`, `ogImageUrl(repo)` — both derived from the login/name, so no schema or index change is needed                                                                                                         |     |
| `@/lib/search-params`             | `SearchState`, `UserSearch`, `toggleGroup`, `hasActiveFilters`, `PAGE_SIZE`, `SEARCH_LIMIT`, `SORTS`, `SORT_LABELS`, `SORT_HINTS`, `DEFAULT_SORT`, `toSort`                                                                           |
| `@/lib/recent`                    | `getRecentUsers()`, `rememberUser(login, name)`                                                                                                                                                                                       |
| Data types                        | `@starwatch/domain`: `SearchHit`, `SearchResponse`, `SearchMode`, `Group`, `Repo`, `UserProfile`, `UserIndexState`, `SyncPhase`, `DegradedReason`                                                                                     |
| API types                         | `@/api`: `ApiError`, `UserPayload`, `RepoPayload`, `HealthPayload` (with `semanticSearch`, the capability flag)                                                                                                                       |

## 4b. Wire contracts the UI must not break

Two request shapes are load-bearing and were wrong before the rebuild:

- **Collections are one comma-joined `group` value**, never a repeated key.
  The worker declares `group` as a single string and splits it itself; a
  repeated key arrives as an array and fails query decoding (400). See
  `searchUrl` in `src/api.ts`.
- **Archived is a tri-state**: `archived=false` excludes archived repos,
  `archived=true` returns only them, and omitting the flag returns both. The
  URL keeps all three (`?archived=hide|include|only`, default `hide`) and the
  page maps them through `toArchivedQuery`; never send `archived=true` for the
  "include" case.
- **Sort is a search key, not a filter**: `?sort=pushed|starred|stars`
  (`relevance` is the default and is omitted from the URL). The worker
  re-orders the match set, so the page passes it through unchanged and never
  sorts locally — a client-side sort of one page would silently lie.
  Changing it resets to page 1 and replaces the history entry (it is a view
  change, like filters).
- **An empty query is the default browse view** (docs/08 §3.4): the page asks
  the API for `q=` with `offset = (page - 1) × PAGE_SIZE` and renders the
  returned page beside the collections rail. The worker reads the default
  `relevance` sort as `starred` for that request, so the listing is "recently
  starred first" without writing a sort into the URL; the toolbar hides the
  retrieval modes and the relevance option while browsing. `response.total` is
  the full candidate count (every filtered star, or the fused match set for a
  query), which is what the pager counts; the worker clamps `offset` to a hard
  ceiling of 10,000.
- **Semantic search is a deployment capability, not a client assumption.**
  `GET /api/health` returns `semanticSearch`, and `useSemanticSearch()`
  (`@/app/capabilities`) is the one place the UI reads it. When it is off the
  mode segment row is **removed** (not disabled, the same shape browse mode
  already ships), `ResultSummary` prints no mode and no coverage, the rail drops
  the Embedded stat and the coverage bar, the "metadata only" badge and the
  "Enable semantic search" card never render, the ⌘K palette has no search-mode
  group, and `?mode=semantic|hybrid` is normalised away on the next navigation.
  A `semantic|hybrid` request is still sent as keyword-safe state and the
  response's own `mode` is authoritative. When the probe says on, today's UI is
  unchanged.
- **Active phases are claims that can go stale.** `runHeartbeat(state)` (in
  `@/lib/state`) measures `updatedAt`, which only progress writes advance; past
  5 minutes an active phase is shown as stalled with _Check again_ /
  _Start again_ instead of an eternal spinner, and an in-progress step whose
  counter already reached its total reads "wrapping up…" rather than
  "3,447 of 3,447". Keep the worker's heartbeat interval well under that window,
  and keep `updatedAt` out of optimistic client-side patches.
- **The freshness chip reads `state.lastSyncedAt`,** so anything that promises a
  re-check must actually start a run: the header's `Re-check GitHub` button posts
  a metadata re-list (`full: false`) and never a client-only refetch. The server
  stamps `phase: "listing"` before it answers `POST /sync`; the client watches the
  events stream until a terminal phase, then takes one authoritative
  `GET /users/:login` (the state stream carries no groups).

## 5. Visual direction

Pierre theme, vibrant variants (github.com/pierrecomputer/theme, MIT): neutral
near-black/white surfaces with Display-P3 hues. Gold still marks stars, green
marks live state, one clear primary action per surface. Cards carry information
density — this is a search tool, not a dashboard.

|       | page      | card      | popover   | muted     | border    |
| ----- | --------- | --------- | --------- | --------- | --------- |
| dark  | `#0a0a0a` | `#101010` | `#1d1d1d` | `#171717` | `#2c2c2c` |
| light | `#f5f5f5` | `#ffffff` | `#ffffff` | `#ededed` | `#d4d4d4` |

Dark takes the theme's P3 values as-is and pairs the bright fills with near-black
text (`--primary-foreground`), the way the theme itself does. On white those same
hues cannot carry text _and_ sit under white text, so light uses the deeper sRGB
steps of the same ramps; `--ring` stays the electric P3 blue in both themes
because a focus indicator only has to clear 3:1. The measured ratios live in the
header comment of `src/styles.css` — keep them in sync when a token moves.

Third-party images (owner avatar, social preview) are decoration, never
information: each has a fallback — initials, or no tile at all — they lazy-load,
and the result list only renders a preview from `lg` up so phones never fetch
one. GitHub rate-limits the preview endpoint, so a missing tile is a normal
state, not an error state.

- Style with semantic tokens only (`bg-card`, `text-muted-foreground`, `text-star`),
  never a raw palette value; a new hue is a new token, not a class in a component.
- Type scale: page title `text-2xl sm:text-3xl font-semibold tracking-tight`;
  section title `text-base font-semibold`; body `text-sm`; meta
  `text-xs text-muted-foreground`; numbers `tabular-nums`.
- Copy: sentence case, plain words, no exclamation marks, no marketing voice.
  Say what happened and what the user can do. Short labels on buttons
  ("Search", "Index now", "Copy"), never "Click here". With semantic search
  off, no semantic-adjacent copy ships except the toolbar notice that says so
  — `Semantic search is disabled on this deployment, so results come from
names, descriptions, topics and READMEs.` — and the landing page's
  keyword-only description: no "vector", "embedding", "meaning" or
  "coverage" wording anywhere (the design-token phrase "semantic tokens" is
  style vocabulary and stays).
- Accessibility: every input has a label or `aria-label`; toggles expose
  `aria-pressed`; async status uses `aria-live`/`role="status"`; never encode
  meaning in color alone (pair the dot with the language name); text contrast
  must survive both themes.

## 5b. Icons

`public/favicon.svg` is the source of truth for the mark — the dark tile with one
gold star, with a `prefers-color-scheme` rule so the tile stays visible on dark
browser chrome. `public/favicon.ico` (16/32/48) and `public/apple-touch-icon.png`
(180, full-bleed because iOS applies its own mask) are rasters of it:

```bash
pnpm -F @starwatch/webui icons   # needs librsvg + ImageMagick
```

Re-run that only when the mark changes; the committed rasters are what ships.

## 6. Verification

From the repo root (fast, no worker needed):

```bash
pnpm --filter @starwatch/webui typecheck
pnpm exec oxfmt apps/webui/src/features/<your-slice>
pnpm oxlint apps/webui/src/features/<your-slice>
```

Both must be clean. Route files are owned by the parent agent and are composed
after all slices land; if you need a page-level check, build a small local
preview harness file inside your own slice and delete it before finishing.
