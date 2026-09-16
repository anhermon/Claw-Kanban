# Backlog Triage, Session Claims & Board Filtering — Design

Date: 2026-09-16
Status: Draft, approved by Angel in chat, pending spec review sign-off

## Problem

Two related gaps observed live on the running board:

1. **Backlog has no coherent admission strategy.** `harness-sync.ts` lands
   every synced Jira epic that isn't Done/Blocked into `Planned`
   (`normalizePhaseToKanbanStatus`, comment: "to avoid flooding
   In-Progress... land in Planned (Backlog)"). This produced 168 cards in
   `Planned` with no filtering for staleness, relevance, or ordering
   beyond `priority DESC, updated_at ASC`. `queue-dispatcher.ts`'s
   `dispatchNextTask` then blindly pulls the top of that pile. Enabling
   `autoDispatch` (done once during verification, then reverted) started
   two real `claude` subprocesses against real DealHub tickets
   (`DEV-47774`, `AUT-273`) within seconds — proof the current admission
   gate is not safe to leave on.
2. **No task-control surface for external sessions.** The board can only
   ever be driven by its own `spawnAgent` loop or a human clicking the
   UI. There's no way for an already-running Claude Code session
   (elsewhere on the machine, working a real repo) to (a) show up on the
   board so Angel can see its progress instead of reading terminal
   output, or (b) reserve a specific ticket so the board's own dispatcher
   doesn't also grab it.

Primary goal, per Angel: the board should be a **visual surface for
what sessions are doing**, replacing the terminal-output flood — task
orchestration (auto-dispatch) is secondary and already defaults off.

## Goals

- Shrink `Planned` back down to cards that are actually meant to be
  worked next, without losing the synced Jira/harness data.
- Let dispatch (when enabled) skip stale/already-resolved cards without
  a live Jira call.
- Prevent two agent runs (board-spawned or external) from working the
  same `project_path` concurrently.
- Show live progress from any Claude Code session on the machine against
  its matching card, with zero instrumentation required in the common
  case.
- Give an external session an explicit way to reserve/update/release a
  card when it wants that guarantee.
- Let Angel filter the board down to "what's relevant to the session
  I'm currently in," instead of scanning the whole backlog.

## Non-Goals

- No dependency graph / blocking-ticket ordering between cards.
- No live Jira API calls from the dispatch or filter path (all
  freshness signals are persisted at sync time).
- No multi-user auth on the claim API — single-user local tool.
- No change to `autoDispatch`'s default (`false`) — this design does not
  make auto-dispatch safer to leave on by default, it makes the pool it
  would draw from smaller and more correct.

## Design

### 1. Sync/triage fix (`server/harness-sync.ts`)

- Change the upsert target for a **newly created** card from `Planned`
  to `Inbox` (existing, currently-unused-by-sync column in the
  `status` enum). `normalizePhaseToKanbanStatus`'s catch-all branch
  (currently always `"Planned"`) becomes the `Inbox` target instead.
  Done/Blocked mapping is unchanged.
- **Existing** cards already promoted to `Planned` (or beyond) by a
  human/agent are left alone on resync — the existing "don't overwrite
  In Progress/Review/Done" guard in `harness-sync.ts` extends to also
  preserve a `Planned` a card was manually promoted into (sync only
  ever downgrades into `Inbox` on first creation, never demotes an
  already-promoted card).
- Promotion `Inbox → Planned` becomes an explicit action: a button in
  the UI (bulk or per-card), or the same action an external claim
  performs implicitly (see §3).
- Add three columns to `cards`, populated at sync time from data
  `harness-sync.ts` already reads but currently only embeds into the
  Markdown description:
  - `jira_status TEXT` — raw `jira.status` string
  - `harness_phase TEXT` — raw `state.phase` string
  - `last_seen_at INTEGER` — epoch ms of this sync pass
- These three columns are what dispatch/filter queries check for
  staleness — no live Jira call anywhere in the hot path.

### 2. Dispatch fix (`server/queue-dispatcher.ts`)

`dispatchNextTask`'s candidate query gains two exclusions, applied
before the existing `ORDER BY priority DESC, updated_at ASC`:

- Exclude any `Planned` card whose `project_path` equals the
  `project_path` of a card currently in `ACTIVE_STATUSES`
  (`'In Progress', 'Review/Test'`). This is a correctness fix
  independent of everything else in this design — today two cards
  sharing a repo can dispatch concurrently and run two `claude`
  processes in the same working tree.
- Exclude any card with a non-expired `claimed_session_id` (see §3) —
  an externally-claimed card is off-limits to the board's own
  dispatcher even if its status is technically `Planned`.

### 3. Claim/lease model (unifies board-spawned and external work)

New columns on `cards`:

- `claimed_session_id TEXT` — the owning session's id (agentsview
  session id for external; a synthetic board-run id for `spawnAgent`)
- `claimed_by TEXT` — `'board'` | `'external'`
- `claim_expires_at INTEGER` — epoch ms lease expiry

`spawnAgent`'s existing dispatch path is changed to set these same
three fields (`claimed_by='board'`) at the point it starts a run,
instead of the current implicit "status says In Progress so it must be
running" assumption. This gives both flows one shared state instead of
two.

New external-facing HTTP endpoints:

| Method & path | Effect |
|---|---|
| `POST /api/cards/:id/claim` `{session_id}` | Card must be `Inbox`/`Planned` and unclaimed. Sets `claimed_by='external'`, `claimed_session_id`, `claim_expires_at = now + 15m`, status → `In Progress`. |
| `POST /api/cards/:id/heartbeat` `{session_id}` | Requires matching `claimed_session_id`. Extends `claim_expires_at` by 15m. |
| `POST /api/cards/:id/release` `{session_id, outcome}` | Requires matching `claimed_session_id`. `outcome` ∈ `done` (→ `Review/Test`), `blocked` (→ `Stopped`), `abandon` (→ back to `Planned`, claim cleared). |
| `GET /api/cards?project_path=<path>` | Existing list endpoint, gains a `project_path` filter (exact match on the repo path) — also the mechanism §6's session filter uses. |

A session finds its own id the same way it already does today
(printed at session start in its own context — see
`SessionStart:startup hook success: 📊 Session started: <id>` — no new
mechanism needed to discover it).

### 4. Passive correlation (default visualization, zero instrumentation)

Server-side, on an interval (reuse the existing dispatcher's 4s
background loop cadence — no second interval), for every *unclaimed*
card in `Inbox`/`Planned`/`In Progress`/`Review/Test`:

- Fetch recent sessions from agentsview (`GET
  http://127.0.0.1:50030/api/v1/sessions`, proxied server-side — see
  §6 for why this is proxied rather than called from the browser).
- Match the card's ticket key (parsed from its `id`/`title`, e.g.
  `AUT-273`) against each session's `git_branch` and `first_message`.
- On a match, attach a read-only overlay to the card response (not
  persisted): live token/message counts, `health_score`, elapsed
  duration, from that agentsview session record.
- A card with a non-null `claimed_session_id` shows that session's live
  data directly instead of running the fuzzy match — explicit claim
  always wins over inferred correlation.
- No match found: card renders as it does today, no overlay.

If agentsview is unreachable, this step no-ops silently (log at DEBUG,
not WARN/ERROR — it's a best-effort enhancement, not a dependency the
board requires to function).

### 5. Reconciliation sweep (single path)

One interval job (same 4s loop) replaces the ad-hoc stale-detection
currently at `index.ts:2844`:

- Any card with `claimed_by='external'` and `claim_expires_at < now`:
  check agentsview for a still-live session matching
  `claimed_session_id`. If none, auto-release to `Planned`, clear claim
  fields, append a `card_logs` system entry ("claim expired, released
  automatically").
- Board-spawned (`claimed_by='board'`) cards keep using the existing
  process-exit-driven completion path (`handleRunComplete` /
  `handleReviewComplete`) — this sweep only needs to catch the case a
  lease-holder disappears without calling `release`.

### 6. Session filter (board UI)

- Claw-Kanban's server proxies `GET /api/v1/sessions` from agentsview
  (already fetched server-side for §4) into a new endpoint, `GET
  /api/sessions/recent`, returning a trimmed list (id, project, cwd,
  git_branch, started_at, ended_at) for the last 24h. Proxying (instead
  of the browser calling `:50030` directly) avoids hardcoding
  agentsview's port in client code and keeps agentsview an optional
  dependency the frontend never needs to know about directly.
- UI adds a session picker (sidebar, near the existing WIP-limit
  control). Selecting a session filters the visible board to:
  - any card whose `project_path` matches that session's `cwd`/repo
    root (across all columns, including `Inbox`/`Planned` — this is
    the "what should I work on next in this session" view), **and**
  - any card that session currently holds via `claimed_session_id`,
    regardless of `project_path` (covers a session that claimed
    something outside its own cwd).
- Clearing the picker returns to the unfiltered board.

## Data Model Summary

```
ALTER TABLE cards ADD COLUMN jira_status TEXT;
ALTER TABLE cards ADD COLUMN harness_phase TEXT;
ALTER TABLE cards ADD COLUMN last_seen_at INTEGER;
ALTER TABLE cards ADD COLUMN claimed_session_id TEXT;
ALTER TABLE cards ADD COLUMN claimed_by TEXT;
ALTER TABLE cards ADD COLUMN claim_expires_at INTEGER;
```

(Follows the existing pattern at `index.ts:616` — `ALTER TABLE ...
ADD COLUMN` wrapped in try/catch for idempotent startup on an existing
db.)

## Testing

- Unit: `normalizePhaseToKanbanStatus` catch-all now returns `Inbox`
  (update existing test expectations).
- Unit: `dispatchNextTask` — fixture with two `Planned` cards sharing a
  `project_path`, one already `In Progress` on that path → dispatcher
  must not pick the second.
- Unit: claim/heartbeat/release — expired lease with no live agentsview
  session → reconciliation sweep releases it; expired lease with a live
  session → left alone.
- Manual: verify the session-filter picker against this session's own
  `git_branch`/cwd once implemented.

## Rollout

- `autoDispatch` stays `false` by default — unaffected by this change.
- Existing `Planned` cards (the 168 currently synced) are **not**
  migrated to `Inbox` retroactively; the new sync behavior only applies
  going forward to newly-created cards. A one-time manual triage of the
  existing pile is a separate, human task, not part of this design.
