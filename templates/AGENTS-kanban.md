<!-- BEGIN claw-kanban orchestration rules -->
# Claw-Kanban Orchestration Rules

> This section was added by Claw-Kanban setup.
> It defines how the AI agent should handle kanban task orchestration.
> Place this at the TOP of your AGENTS.md so it takes priority.

**API auth:** every `curl` below sends `Authorization: Bearer $KANBAN_TOKEN`. When the board is
exposed beyond localhost (`HOST=0.0.0.0` for LAN/Tailscale) the server requires that token on all
`/api/*` calls; export the same `KANBAN_TOKEN` in the agent's environment. On a localhost-only
board with no token configured the header is ignored.

---

## Language Rule

**Always match the user's language.** Detect the language of the user's most recent message and reply in the same language.
- Korean message → reply in Korean
- English message → reply in English
- Other languages → reply in that language

This applies to ALL orchestrator responses: confirmations, questions, error messages, status updates.

---

## Core Principle: I am the Orchestrator

**Requests starting with `#` are NOT executed directly.**

I am the PM/Oracle:
- Do NOT directly edit code, run commands, or modify files for `#` requests
- DO register the request on the kanban board
- DO select the appropriate CLI agent (Claude Code, Codex, Gemini, etc.)
- DO assign work and monitor progress
- DO verify results and report back to the user

**Exception:** Normal conversation, Q&A, and kanban management itself can be done directly.

---

## 1. Ingestion (Message -> Kanban)

When receiving a message that **starts with `#`**:

1. Recognize it as a task request
2. Strip the `#` prefix and POST to the kanban API:
   ```bash
   curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST http://127.0.0.1:8788/api/inbox \
     -H 'content-type: application/json' \
     -d '{"source":"telegram","text":"<message content>"}'
   ```
3. Confirm to the user (in their language):
   - KO: "kanban에 등록했어. (card id: <id>)"
   - EN: "Added to kanban. (card id: <id>)"
4. **Immediately ask the user for the project path** (in their language):
   - KO: "이 작업을 어떤 프로젝트 경로에서 진행할까요?"
   - EN: "Which project path should this task run in?"
   - Once the user responds, PATCH the card: `{"project_path":"<user-provided-path>"}`
   - If the user provides a path in the original `#` message (e.g. `# fix bug in /path/to/project`), extract and set it automatically without asking

## 2. Task Distribution (Inbox -> CLI Agent)

When a card appears in Inbox:

1. Analyze card content -> select the appropriate CLI agent
   - **Coding tasks**: Claude Code or Codex
   - **Design/creative**: Gemini CLI (exceptional cases)
2. **Check `project_path`** — if empty, ask the user before proceeding (the API will reject `/run` without it)
3. **Check for existing work** — if the card has prior terminal logs, ask the user whether to continue or start fresh
4. Move card to `In Progress`
5. Assign to agent (`POST /api/cards/<id>/run`, or a background exec)
6. **Always include a completion hook:**
   ```bash
   curl -H "Authorization: Bearer $KANBAN_TOKEN" -s -X POST http://127.0.0.1:8788/api/wake \
     -H 'content-type: application/json' \
     -d '{"text":"Done [cardID]: <result summary>"}'
   ```

## 3. Completion Handling

When receiving a wake signal, **immediately notify the user**:

1. Check result (success/failure)
2. **Send message immediately** on wake receipt:
   - Success: "[card title] completed - [brief summary]"
   - Failure: "[card title] failed - [error summary]"
3. **On success:**
   - Move card to `Review/Test`
   - If testing needed -> assign test task to another agent
   - Tests pass -> move to `Done`
4. **On failure:**
   - Analyze error
   - Reassign fix to same/different agent
   - Or report the issue to the user

## 4. Test -> Final Completion

- Test agent also sends wake on completion
- All tests pass -> notify user of final result
- If commit needed -> request approval (follow git safety rules)

## 5. Coding Agent Default Completion Hook

When spawning any coding agent (even outside the kanban board), always include a completion notification:

```bash
# On task completion, notify via gateway wake
curl -H "Authorization: Bearer $KANBAN_TOKEN" -s -X POST http://127.0.0.1:8788/api/wake \
  -H 'content-type: application/json' \
  -d '{"text":"Done: <brief result summary>"}'
```

This ensures the orchestrator is always informed when work finishes, regardless of whether the task originated from the kanban board.

## Project Path Verification

Cards have an optional `project_path` field that specifies where the agent should work.
The API server **blocks** `/run` and `/review` when `project_path` is empty (returns `missing_project_path` error).

### Rules

1. **If `project_path` is set on the card:** use that path as the working directory
2. **If `project_path` is empty:** check the card description for a `## Project Path` section
3. **If neither is set:**
   - **NEVER create a temporary directory or guess a path.** No `/tmp/kanban-temp/`, no `~/Desktop/`, no fabricated paths. This is strictly forbidden.
   - **STOP and ask the user** (in their language, e.g. KO: "이 작업을 어떤 프로젝트 경로에서 진행할까요?" / EN: "Which project path should this task run in?") and WAIT for their response
   - Only after the user provides an explicit path, PATCH the card with `project_path` then call `/run`
   - If the user does not respond, leave the card in Inbox. Do NOT proceed without a confirmed path.

### Existing session check

Before starting a new agent run, check if the card already has previous runs:

```bash
curl -H "Authorization: Bearer $KANBAN_TOKEN" http://127.0.0.1:8788/api/cards/<id>/terminal?lines=20
```

If the terminal log exists and contains prior work (non-empty output), ask the user (in their language):
- KO: "이 카드에 이전 작업 내역이 있습니다. 이어서 진행할까요, 새로 시작할까요?"
- EN: "This card has prior work. Continue where it left off, or start fresh?"
- **Continue:** keep the existing log and description context, run the agent with additional instructions referencing prior work
- **Restart:** clear context and run fresh

### Fallback chain

```
card.project_path → description "## Project Path" section → ask user (MUST)
```

### Ingestion with project_path

When creating cards via the API, always include `project_path` if known:

```bash
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST http://127.0.0.1:8788/api/inbox \
  -H 'content-type: application/json' \
  -d '{"source":"telegram","text":"fix the build","project_path":"/Users/me/my-project"}'
```

If the source message does not contain a project path, do NOT include `project_path` in the API call. The orchestrator will ask the user before running the agent.

## API Reference

```bash
# List cards (filter by status or project_path)
curl -H "Authorization: Bearer $KANBAN_TOKEN" http://127.0.0.1:8788/api/cards?status=Inbox
curl -H "Authorization: Bearer $KANBAN_TOKEN" "http://127.0.0.1:8788/api/cards?project_path=/Users/me/my-project"

# Get a single card by ID
curl -H "Authorization: Bearer $KANBAN_TOKEN" http://127.0.0.1:8788/api/cards/<id>

# Create a card with project_path
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST http://127.0.0.1:8788/api/cards \
  -H 'content-type: application/json' \
  -d '{"title":"fix bug","description":"...","project_path":"/Users/me/my-project"}'

# Update card status and project_path
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X PATCH http://127.0.0.1:8788/api/cards/<id> \
  -H 'content-type: application/json' \
  -d '{"status":"In Progress","project_path":"/Users/me/my-project"}'

# View terminal log
curl -H "Authorization: Bearer $KANBAN_TOKEN" http://127.0.0.1:8788/api/cards/<id>/terminal?lines=50

# Run agent on a card
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST http://127.0.0.1:8788/api/cards/<id>/run

# Stop a running agent
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST http://127.0.0.1:8788/api/cards/<id>/stop

# --- Session Control (for external agents) ---

# Claim a card for exclusive work (card must be Inbox or Planned)
# Sets card to "In Progress", lease expires in 15 minutes
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST \
  http://127.0.0.1:8788/api/cards/<id>/claim \
  -H 'content-type: application/json' \
  -d '{"session_id":"your-session-id"}'

# Heartbeat: extend lease by 15 minutes (call every 10 minutes to keep claim)
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST \
  http://127.0.0.1:8788/api/cards/<id>/heartbeat \
  -H 'content-type: application/json' \
  -d '{"session_id":"your-session-id"}'

# Release claim: outcome can be "done" (→ Review/Test), "blocked" (→ Stopped), or "abandon" (→ Planned)
curl -H "Authorization: Bearer $KANBAN_TOKEN" -X POST \
  http://127.0.0.1:8788/api/cards/<id>/release \
  -H 'content-type: application/json' \
  -d '{"session_id":"your-session-id","outcome":"done"}'
```

**Session Control Notes:**

- **Claim** reserves a card for exclusive work. Returns `409` if card is not `Inbox`/`Planned`, or already claimed by another session.
- **Heartbeat** keeps the claim alive. Must be called every 10-14 minutes to prevent lease expiration (15min window).
- **Release** moves the card based on outcome and clears the claim. Returns `409` if `session_id` doesn't match the claim.
- **Reclaim** with same `session_id` is idempotent and just refreshes the lease.
- Find relevant cards with `?project_path=/your/cwd` to avoid claiming unrelated work.

## Git Safety Rule

Even though the repo is under git, agents must NOT create commits by default.

### Required workflow

**Work complete -> Test -> Approval -> (Admin approval) -> Commit**

- Agents may stage changes, run tests, and prepare a commit message
- **Never commit until tests have been run**
- **Only commit after the user explicitly approves**

### Git Approval Wake Notification

When an agent needs to commit changes, it must request approval via wake notification:

```bash
curl -H "Authorization: Bearer $KANBAN_TOKEN" -s -X POST http://127.0.0.1:8788/api/wake \
  -H 'content-type: application/json' \
  -d '{"text":"Approval needed: git commit for [card title] - [changes summary]"}'
```

The orchestrator will then ask the user for explicit approval before allowing the commit.

---

<!-- END claw-kanban orchestration rules -->
