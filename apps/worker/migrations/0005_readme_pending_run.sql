-- 0005 — which run left a repo's README in `pending`.
--
-- `repos` is a shared corpus: many users star the same repo, but each user's
-- vector blob is their own. "README text stored, vector not in the blob yet" is
-- therefore a *per-run* fact, and storing it on the shared row needs to say
-- whose run it was. Without this, one user's finalize could flip another
-- user's pending row to `present`, and if that run then died before its own
-- finalize the planner would consider the repo done and its vector would never
-- be built — the same permanent-loss mode migration 0004-era code had.
--
-- The flip is `WHERE readme_state = 'pending' AND readme_pending_run = ?`, so a
-- concurrent run that overwrote the marker keeps its own pending state. A row
-- whose run never finalizes stays pending and is re-selected: that is the
-- self-healing path.

ALTER TABLE repos ADD COLUMN readme_pending_run TEXT;
