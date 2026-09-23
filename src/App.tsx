// Modified by Angel Hermon (2026) from Claw-Kanban by GreenSheep01201; Apache-2.0 (see LICENSE).
import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import type {
  Card,
  CardStatus,
  ProviderSettings,
  Role,
  TaskType,
  Provider,
  CliStatusMap,
  OAuthStatusMap,
  OAuthConnectProvider,
  OpenClawProfilesResponse,
  ImportResult,
  DeviceCodeStart,
  OAuthModelMap,
  ProviderModelConfig,
  CardSessionResponse,
  ParsedSession,
  SessionTimelineEntry,
} from "./api";
import {
  createCard,
  deleteCard,
  getLogs,
  getTerminal,
  getCardSession,
  listCards,
  patchCard,
  runCard,
  stopCard,
  reviewCard,
  getSettings,
  saveSettings,
  getCliStatus,
  DEFAULT_PROVIDER_SETTINGS,
  getOAuthStatus,
  disconnectOAuth,
  getOAuthStartUrl,
  getOpenClawProfiles,
  importFromOpenClaw,
  startGitHubDeviceFlow,
  pollGitHubDevice,
  getOAuthModels,
  syncHarness,
  getQueueStatus,
  saveQueueConfig,
  moveActiveToBacklog,
  dispatchNextTask,
  type QueueStatusResponse,
} from "./api";

const STATUSES: CardStatus[] = ["Inbox", "Planned", "In Progress", "Review/Test", "Done", "Stopped"];
const ROLES: { value: Role; label: string }[] = [
  { value: "devops", label: "Dev Ops" },
  { value: "backend", label: "BackEnd" },
  { value: "frontend", label: "FrontEnd" },
];
const TASK_TYPES: { value: TaskType; label: string }[] = [
  { value: "new", label: "New" },
  { value: "modify", label: "Modify" },
  { value: "bugfix", label: "Bugfix" },
];
const CLI_PROVIDERS: { value: Provider; label: string; desc: string }[] = [
  { value: "claude", label: "Claude Code", desc: "Claude CLI" },
  { value: "codex", label: "Codex CLI", desc: "OpenAI Codex" },
  { value: "gemini", label: "Gemini CLI", desc: "Google Gemini" },
  { value: "opencode", label: "OpenCode", desc: "OpenCode CLI" },
  { value: "agy", label: "Agy", desc: "Antigravity CLI" },
];
const OAUTH_ASSIGNABLE: { value: Provider; label: string; desc: string; oauthKey: OAuthConnectProvider }[] = [
  { value: "copilot", label: "GitHub Copilot", desc: "via OAuth", oauthKey: "github-copilot" },
  { value: "antigravity", label: "Antigravity", desc: "via OAuth", oauthKey: "antigravity" },
];
const PROVIDERS = [...CLI_PROVIDERS, ...OAUTH_ASSIGNABLE];
const OAUTH_PROVIDERS: { value: OAuthConnectProvider; label: string; desc: string }[] = [
  { value: "antigravity", label: "Antigravity (Google)", desc: "Google OAuth for Antigravity token flow" },
  { value: "github-copilot", label: "GitHub / Copilot", desc: "GitHub OAuth for Copilot-linked workflows" },
];

function fmtTime(ms: number) {
  const d = new Date(ms);
  return d.toLocaleString();
}

function formatMsDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  if (totalSeconds > 0) return `${s}s`;
  return `${ms}ms`;
}

function formatCost(usd: number | null | undefined): string {
  if (usd == null) return "-";
  return `$${usd.toFixed(4)}`;
}

function formatTokenCount(n: number | null | undefined): string {
  if (n == null) return "-";
  return n.toLocaleString();
}

// Compact k/M token formatting for the dense card badge (the full-precision count is available
// via the existing Agent Session modal's formatTokenCount usage).
function formatCompactTokenCount(n: number | null | undefined): string {
  if (n == null) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

// Card-level per-stage duration summary, derived from the card's persisted+live run stats
// (inProgressDurationMs/reviewDurationMs/totalDurationMs, populated server-side from ALL of the
// card's card_runs rows - see attachRunStats() in server/index.ts). Returns null for cards with
// no run history at all, so callers can render nothing.
function cardDurationSummary(c: Card): { text: string; title: string } | null {
  // Treat a card with run history but a zero settled/so-far duration the same as "no history" -
  // otherwise a card whose only runs never accumulated real time would render "Total: 0ms" /
  // "In: 0ms (live)", exactly the empty-badge clutter this feature is supposed to avoid for
  // never-run cards.
  if (!c.totalDurationMs) return null;

  if (c.status === "In Progress") {
    return {
      text: `In: ${formatMsDuration(c.inProgressDurationMs)} (live)`,
      title: "Time in In Progress so far (persists if the card leaves this stage)",
    };
  }
  if (c.status === "Review/Test") {
    const parts: string[] = [];
    if (c.inProgressDurationMs) parts.push(`In: ${formatMsDuration(c.inProgressDurationMs)}`);
    parts.push(`Review: ${formatMsDuration(c.reviewDurationMs)} (live)`);
    return { text: parts.join(" · "), title: "Time per stage (In Progress duration is preserved from before)" };
  }

  // Settled status (Done, Stopped, or moved back to Inbox/Planned) with run history: show the
  // full breakdown. Per-ticket-ask: "a done ticket should show both durations + total".
  const parts: string[] = [];
  if (c.inProgressDurationMs) parts.push(`In: ${formatMsDuration(c.inProgressDurationMs)}`);
  if (c.reviewDurationMs) parts.push(`Review: ${formatMsDuration(c.reviewDurationMs)}`);
  parts.push(`Total: ${formatMsDuration(c.totalDurationMs)}`);
  return { text: parts.join(" · "), title: "Time spent per stage across all runs on this card" };
}

function groupByStatus(cards: Card[]) {
  const m: Record<CardStatus, Card[]> = {
    "Inbox": [],
    "Planned": [],
    "In Progress": [],
    "Review/Test": [],
    "Done": [],
    "Stopped": []
  };
  for (const c of cards) m[c.status].push(c);
  for (const s of STATUSES) m[s].sort((a, b) => b.updated_at - a.updated_at);
  return m;
}

export default function App() {
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [logs, setLogs] = useState<Array<{ id: number; created_at: number; kind: string; message: string }>>([]);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const [termOpen, setTermOpen] = useState(false);
  const [termText, setTermText] = useState("");
  const [termPath, setTermPath] = useState<string | null>(null);
  const [termFollow, setTermFollow] = useState(true);
  const termRef = useRef<HTMLPreElement | null>(null);
  const newTitleRef = useRef<HTMLInputElement | null>(null);

  const [sessionOpen, setSessionOpen] = useState(false);
  const [sessionData, setSessionData] = useState<CardSessionResponse | null>(null);
  const [sessionTab, setSessionTab] = useState<"implementation" | "review">("implementation");
  const [sessionErr, setSessionErr] = useState<string | null>(null);
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ProviderSettings>(DEFAULT_PROVIDER_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [cliStatus, setCliStatus] = useState<CliStatusMap | null>(null);
  const [cliLoading, setCliLoading] = useState(false);

  const [oauthStatus, setOauthStatus] = useState<OAuthStatusMap | null>(null);
  const [oauthStorageReady, setOauthStorageReady] = useState(true);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<OAuthConnectProvider | null>(null);

  const [openclawProfiles, setOpenclawProfiles] = useState<OpenClawProfilesResponse | null>(null);
  const [openclawImporting, setOpenclawImporting] = useState(false);
  const [openclawImportResult, setOpenclawImportResult] = useState<ImportResult | null>(null);

  const [deviceCode, setDeviceCode] = useState<DeviceCodeStart | null>(null);
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceStatus, setDeviceStatus] = useState<string | null>(null);

  const [syncingHarness, setSyncingHarness] = useState(false);
  const [harnessMsg, setHarnessMsg] = useState<string | null>(null);
  const [queueStatus, setQueueStatus] = useState<QueueStatusResponse | null>(null);

  const [oauthModels, setOauthModels] = useState<OAuthModelMap>({});

  const [newRole, setNewRole] = useState<Role | "">("");
  const [newTaskType, setNewTaskType] = useState<TaskType | "">("");
  const [newProjectPath, setNewProjectPath] = useState("");

  async function refresh() {
    const cs = await listCards();
    setCards(cs);
    getQueueStatus().then(setQueueStatus).catch(() => {});
    if (selected) {
      const next = cs.find((c) => c.id === selected.id) ?? null;
      setSelected(next);
      if (next) setLogs(await getLogs(next.id));
    }
  }

  async function loadSettings() {
    try {
      const s = await getSettings();
      setSettings(s);
    } catch {
      setSettings(DEFAULT_PROVIDER_SETTINGS);
    }
  }

  async function loadCliStatus(refresh?: boolean) {
    setCliLoading(true);
    try {
      const s = await getCliStatus(refresh);
      setCliStatus(s);
    } catch {
      // keep previous state on error
    } finally {
      setCliLoading(false);
    }
  }

  async function loadOAuthStatus(refresh?: boolean) {
    if (oauthLoading && !refresh) return;
    setOauthLoading(true);
    try {
      const st = await getOAuthStatus();
      setOauthStatus(st.providers);
      setOauthStorageReady(st.storageReady);
    } catch {
      // ignore
    } finally {
      setOauthLoading(false);
    }
  }

  async function loadOAuthModels() {
    try {
      const m = await getOAuthModels();
      setOauthModels(m);
    } catch {
      // ignore
    }
  }

  async function loadOpenClawProfiles() {
    try {
      const p = await getOpenClawProfiles();
      setOpenclawProfiles(p);
    } catch {
      // ignore
    }
  }

  async function handleOpenClawImport(overwrite?: boolean) {
    setOpenclawImporting(true);
    setOpenclawImportResult(null);
    try {
      const result = await importFromOpenClaw(undefined, overwrite);
      setOpenclawImportResult(result);
      await loadOAuthStatus(true);
      await loadOpenClawProfiles();
    } catch (e) {
      const eObj = e as { message?: string };
      setErr(eObj?.message ?? String(e));
    } finally {
      setOpenclawImporting(false);
    }
  }

  async function startDeviceCodeFlow() {
    setDeviceStatus(null);
    try {
      const dc = await startGitHubDeviceFlow();
      setDeviceCode(dc);
      setDevicePolling(true);

      // Start polling
      const intervalMs = Math.max(5000, (dc.interval ?? 5) * 1000);
      const expiresAt = Date.now() + dc.expiresIn * 1000;

      const poll = async () => {
        while (Date.now() < expiresAt) {
          try {
            const result = await pollGitHubDevice(dc.stateId);
            if (result.status === "complete") {
              setDevicePolling(false);
              setDeviceCode(null);
              setDeviceStatus("connected");
              await loadOAuthStatus(true);
              return;
            }
            if (result.status === "expired" || result.status === "denied") {
              setDevicePolling(false);
              setDeviceCode(null);
              setDeviceStatus(result.status === "denied" ? "Login cancelled" : "Code expired");
              return;
            }
            if (result.status === "error") {
              setDevicePolling(false);
              setDeviceCode(null);
              setDeviceStatus(`Error: ${result.error ?? "unknown"}`);
              return;
            }
            // pending or slow_down — wait and retry
            const delay = result.status === "slow_down" ? intervalMs + 2000 : intervalMs;
            await new Promise((r) => setTimeout(r, delay));
          } catch {
            setDevicePolling(false);
            setDeviceCode(null);
            setDeviceStatus("Poll error");
            return;
          }
        }
        setDevicePolling(false);
        setDeviceCode(null);
        setDeviceStatus("Code expired");
      };
      void poll();
    } catch (e) {
      const eObj = e as { message?: string };
      setErr(eObj?.message ?? String(e));
    }
  }

  function startOAuthConnect(provider: OAuthConnectProvider) {
    const redirectTo = `${window.location.origin}${window.location.pathname}?settings=1`;
    window.location.assign(getOAuthStartUrl(provider, redirectTo));
  }

  async function disconnectOAuthProvider(provider: OAuthConnectProvider) {
    setOauthBusy(provider);
    try {
      await disconnectOAuth(provider);
      await loadOAuthStatus(true);
      await loadCliStatus(true);
    } catch (e) {
      const eObj = e as { message?: string };
      setErr(eObj?.message ?? String(e));
    } finally {
      setOauthBusy(null);
    }
  }

  // Provider is available if authenticated (CLI) or connected (OAuth)
  const isProviderAvailable = (p: Provider) => {
    const oauthEntry = OAUTH_ASSIGNABLE.find((o) => o.value === p);
    if (oauthEntry) {
      return oauthStatus?.[oauthEntry.oauthKey]?.connected ?? false;
    }
    return cliStatus?.[p]?.authenticated ?? true;
  };

  async function handleSaveSettings() {
    setSettingsLoading(true);
    try {
      await saveSettings(settings);
      setSettingsOpen(false);
    } catch (e) {
      const err = e as { message?: string };
      setErr(err?.message ?? String(e));
    } finally {
      setSettingsLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch((e) => setErr(String(e)));
    loadSettings().catch(() => {});
    const t = setInterval(() => refresh().catch(() => {}), 1200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const u = new URL(window.location.href);
    const hasSettingsFlag = u.searchParams.get("settings") === "1";
    const oauthFlag = u.searchParams.get("oauth");
    const oauthError = u.searchParams.get("oauth_error");
    if (!hasSettingsFlag && !oauthFlag && !oauthError) return;

    if (oauthError) {
      setErr(`OAuth connect failed (${oauthError})`);
    }

    loadOAuthStatus(true).catch(() => {});
    loadCliStatus(true).catch(() => {});
    setSettingsOpen(true);

    u.searchParams.delete("settings");
    u.searchParams.delete("oauth");
    u.searchParams.delete("oauth_error");
    const next = `${u.pathname}${u.search}${u.hash}`;
    window.history.replaceState({}, document.title, next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!termOpen || !selected) return;
    let alive = true;

    async function tick() {
      try {
        const sel = selected;
        if (!sel) return;
        const t = await getTerminal(sel.id, 800, true);
        if (!alive) return;
        setTermPath(t.path);
        setTermText(t.text);
      } catch {
        // ignore
      }
    }

    tick();
    const iv = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [termOpen, selected]);

  useEffect(() => {
    if (!termOpen) return;
    if (!termFollow) return;
    const el = termRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [termText, termOpen, termFollow]);

  useEffect(() => {
    if (!sessionOpen || !selected) return;
    let alive = true;
    const cardId = selected.id;
    const isLive = selected.status === "In Progress" || selected.status === "Review/Test";

    async function tick() {
      try {
        const s = await getCardSession(cardId);
        if (!alive) return;
        setSessionData(s);
        setSessionErr(null);
      } catch (e) {
        if (!alive) return;
        setSessionErr(String((e as Error).message ?? e));
      }
    }

    tick();
    const iv = isLive ? setInterval(tick, 2000) : null;
    return () => {
      alive = false;
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionOpen, selected?.id, selected?.status]);

  const columns = useMemo(() => groupByStatus(cards), [cards]);
  const totalActive = (columns["In Progress"]?.length ?? 0) + (columns["Review/Test"]?.length ?? 0);
  const wipMax = queueStatus?.maxConcurrentTasks ?? 2;
  const wipAtLimit = totalActive >= wipMax;
  const wipPctDeg = Math.max(0, Math.min(1, totalActive / Math.max(1, wipMax))) * 360;
  const dialRingColor = wipAtLimit ? "var(--warn)" : "var(--accent)";

  async function move(card: Card, status: CardStatus) {
    if (card.status === status) return;
    await patchCard(card.id, { status });
    await refresh();
  }

  async function openCard(card: Card) {
    setSelected(card);
    setLogs(await getLogs(card.id));
  }

  return (
    <div className="layout">
      <nav className="rail">
        <div className="railBrand">
          <img src="/kanban-claw.svg" alt="Claw Kanban" className="railBrandIcon" />
          <div>
            <div className="railBrandName">Claw Kanban</div>
            <div className="railBrandSub">Agent Orchestration</div>
          </div>
        </div>

        <div className="dialWrap">
          <div className="dial" style={{ background: `conic-gradient(${dialRingColor} 0deg ${wipPctDeg}deg, rgba(255,255,255,0.08) ${wipPctDeg}deg 360deg)` }}>
            <div className="dialFace">
              <span className="dialNum">{totalActive}</span>
              <span className="dialCap">of {wipMax}</span>
            </div>
          </div>
          <span className="dialLabel">Active tasks (WIP)</span>
          <select
            className="dialSelect"
            value={queueStatus?.maxConcurrentTasks ?? 2}
            onChange={async (e) => {
              const limit = Number(e.target.value);
              await saveQueueConfig({ maxConcurrentTasks: limit });
              await refresh();
            }}
            title="Maximum concurrent tickets to work on"
          >
            {[1, 2, 3, 4, 5, 8].map((n) => (
              <option key={n} value={n}>Max {n}</option>
            ))}
          </select>
        </div>

        <div className="railGroup">
          <button
            className={`railBtn ${queueStatus?.autoDispatch ? "on" : ""}`}
            onClick={async () => {
              const next = !queueStatus?.autoDispatch;
              await saveQueueConfig({ autoDispatch: next });
              await refresh();
            }}
            title="Gradually auto-process tasks from Planned up to WIP limit"
          >
            {queueStatus?.autoDispatch ? "⚡ Queue: ON" : "⏸ Queue: OFF"}
          </button>

          <button
            className="railBtn"
            onClick={async () => {
              const res = await dispatchNextTask();
              if (res.dispatched) {
                setHarnessMsg(`Dispatched: ${res.card?.title}`);
                setTimeout(() => setHarnessMsg(null), 4000);
              } else {
                alert(res.reason || "No task dispatched");
              }
              await refresh();
            }}
            title="Process next task from Planned gradually"
          >
            ▶ Next
          </button>

          <button
            className="railBtn"
            onClick={async () => {
              if (!confirm("Move all In-Progress and Review/Test tickets back to Planned (Backlog)?")) return;
              const res = await moveActiveToBacklog();
              await refresh();
              setHarnessMsg(`Moved ${res.count} tickets back to Planned`);
              setTimeout(() => setHarnessMsg(null), 5000);
            }}
            title="Move all In-Progress and Review/Test tickets back to Planned"
          >
            ↩ To Backlog
          </button>
        </div>

        <div className="railGroup">
          <button
            className="railBtn"
            onClick={() => {
              loadSettings();
              loadCliStatus();
              loadOAuthStatus(true);
              loadOpenClawProfiles();
              loadOAuthModels();
              setSettingsOpen(true);
            }}
          >Settings</button>
          <button
            className="railBtn"
            disabled={syncingHarness}
            onClick={async () => {
              setSyncingHarness(true);
              setHarnessMsg(null);
              try {
                const res = await syncHarness();
                await refresh();
                setHarnessMsg(`Synced ${res.totalSynced} tasks (${res.epicsCount} Jira Epics, ${res.internalCount} Internal) from Agent Harness`);
                setTimeout(() => setHarnessMsg(null), 6000);
              } catch (e) {
                setErr(String((e as Error).message ?? e));
              } finally {
                setSyncingHarness(false);
              }
            }}
          >
            {syncingHarness ? "Syncing..." : "🔄 Sync Harness"}
          </button>
          <button className="railBtn" onClick={() => refresh()}>Refresh</button>
        </div>

        <div className="railGroupBottom">
          <button
            className="railBtn primary"
            onClick={() => newTitleRef.current?.focus()}
            title="Jump to the new card form"
          >+ New Card</button>
        </div>
      </nav>

      <div className="main">
        <div className="mainHead">
          <h1 className="mainTitle">Claw Kanban</h1>
          <p className="mainSub">AI Agent Orchestration Board - Claude / Codex / Gemini</p>
        </div>

        {harnessMsg && <div className="harnessBanner">{harnessMsg}</div>}
        {err ? <div className="error">{err}</div> : null}

      <section className="newcard">
        <input
          ref={newTitleRef}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New card title (e.g. fix hero card gray border bug)"
        />
        <input
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          placeholder="Description / requirements (optional)"
        />
        <input
          value={newProjectPath}
          onChange={(e) => setNewProjectPath(e.target.value)}
          placeholder="Project path (e.g. /Users/me/my-project)"
          style={{ fontFamily: "monospace" }}
        />
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as Role | "")}
          className="newcard-select"
        >
          <option value="">Select Role</option>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        {newRole === "frontend" && (
          <select
            value={newTaskType}
            onChange={(e) => setNewTaskType(e.target.value as TaskType | "")}
            className="newcard-select"
          >
            <option value="">Task Type</option>
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        )}
        <button
          className="btn primary"
          disabled={!newTitle.trim()}
          onClick={async () => {
            const title = newTitle.trim();
            if (!title) return;
            try {
              await createCard({
                title,
                description: newDesc,
                status: "Inbox",
                role: newRole || undefined,
                task_type: newTaskType || undefined,
                project_path: newProjectPath.trim() || undefined,
              });
              setNewTitle("");
              setNewDesc("");
              setNewRole("");
              setNewTaskType("");
              setNewProjectPath("");
              await refresh();
            } catch (e) {
              setErr(String((e as Error).message ?? e));
            }
          }}
        >+ Add</button>
      </section>

      <main className={`board ${selected ? "drawerOpen" : ""}`}>
        {STATUSES.map((s) => (
          <div key={s} className="col">
            <div className="colHeader">
              <span>{s}</span>
              <span className={`badge ${(s === "In Progress" || s === "Review/Test") && totalActive >= (queueStatus?.maxConcurrentTasks ?? 2) ? "badge-limit" : ""}`}>
                {(s === "In Progress" || s === "Review/Test") ? `${totalActive}/${queueStatus?.maxConcurrentTasks ?? 2} max` : columns[s].length}
              </span>
            </div>
            <div className="colBody">
              {columns[s].map((c) => (
                <div key={c.id} className={"card"
                       + (selected?.id === c.id ? " selected" : "")
                       + (c.status === "In Progress" ? " agent-active" : "")
                       + (c.status === "Review/Test" ? " agent-reviewing" : "")}
                     onClick={() => openCard(c)}>
                  <div className="cardTitle">
                    {c.source === "agent-harness:jira" && <span className="cardEpicBadge">EPIC</span>}
                    {c.source === "agent-harness:internal" && <span className="cardInternalBadge">INTERNAL</span>}
                    {c.title.replace(/^\[(EPIC|INTERNAL)\]\s*/, "")}
                  </div>
                  <div className="cardMeta">
                    {c.status === "In Progress" && <span className="agentActiveDot" aria-hidden="true"></span>}
                    {c.status === "Review/Test" && <span className="agentReviewDot" aria-hidden="true"></span>}
                    <span className="cardModel">{c.assignee ?? "unassigned"}</span>
                    {c.role && <span className="cardRole">{ROLES.find(r => r.value === c.role)?.label}</span>}
                    {(() => {
                      const duration = cardDurationSummary(c);
                      return duration ? (
                        <span className="cardDuration" title={duration.title}>⏱ {duration.text}</span>
                      ) : null;
                    })()}
                    <span>·</span>
                    <span>{fmtTime(c.updated_at)}</span>
                  </div>
                  {c.modelsUsed && c.modelsUsed.length > 0 && (
                    <div className="cardRunMeta">
                      {c.modelsUsed.map((m) => (
                        <span key={m} className="cardModelPill" title={`Model used: ${m}`}>{m}</span>
                      ))}
                      {(c.totalInputTokens != null || c.totalOutputTokens != null) && (
                        <span className="cardTokenStat" title="Total tokens across completed runs on this card">
                          {formatCompactTokenCount(c.totalInputTokens)} in / {formatCompactTokenCount(c.totalOutputTokens)} out
                        </span>
                      )}
                    </div>
                  )}
                  <div className="cardActions" onClick={(e) => e.stopPropagation()}>
                    <select value={c.status} onChange={(e) => move(c, e.target.value as CardStatus)}>
                      {STATUSES.map((st) => (
                        <option key={st} value={st}>{st}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
      </div>

      {selected && (
        <section className="drawer">
          <div className="drawerHead">
            <div className="drawerTitleBlock">
              <div className="drawerBadges">
                {selected.source === "agent-harness:jira" && <span className="cardEpicBadge">EPIC</span>}
                {selected.source === "agent-harness:internal" && <span className="cardInternalBadge">INTERNAL</span>}
              </div>
              <h2 className="drawerTitle">{selected.title.replace(/^\[(EPIC|INTERNAL)\]\s*/, "")}</h2>
            </div>
            <button
              className="drawerClose"
              onClick={() => {
                setSelected(null);
                setLogs([]);
              }}
              aria-label="Close"
            >×</button>
          </div>

          <div className="drawerBody">
            <div className="drawerCol drawerMeta">
              <div><b>ID</b> {selected.id}</div>
              <div><b>Source</b> {selected.source} {selected.source_message_id ? `(msg ${selected.source_message_id})` : ""}</div>
              <div><b>Author</b> {selected.source_author ?? "-"}</div>
              <div><b>Chat</b> {selected.source_chat ?? "-"}</div>
              {selected.project_path && <div><b>Working Dir</b> <code>{selected.project_path}</code></div>}
            </div>

            <div className="drawerCol">
              <div className="drawerFieldGroup">
                <label>Role</label>
                <select
                  value={selected.role || ""}
                  onChange={async (e) => {
                    const role = e.target.value as Role | "";
                    setSelected({ ...selected, role: role || undefined });
                    await patchCard(selected.id, { role: role || undefined });
                    await refresh();
                  }}
                >
                  <option value="">None</option>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              {selected.role === "frontend" && (
                <div className="drawerFieldGroup">
                  <label>Task Type</label>
                  <select
                    value={selected.task_type || ""}
                    onChange={async (e) => {
                      const taskType = e.target.value as TaskType | "";
                      setSelected({ ...selected, task_type: taskType || undefined });
                      await patchCard(selected.id, { task_type: taskType || undefined });
                      await refresh();
                    }}
                  >
                    <option value="">None</option>
                    {TASK_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="drawerFieldGroup">
                <label>Provider (Assignee)</label>
                <select
                  value={selected.assignee || ""}
                  onChange={async (e) => {
                    const assignee = e.target.value as Provider | "";
                    setSelected({ ...selected, assignee: assignee || null });
                    await patchCard(selected.id, { assignee: assignee || undefined });
                    await refresh();
                  }}
                >
                  <option value="">Auto-assign</option>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                      {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="drawerCol">
              <div className="drawerFieldGroup">
                <label>Project Path</label>
                <input
                  value={selected.project_path ?? ""}
                  onChange={(e) => setSelected({ ...selected, project_path: e.target.value || null })}
                  placeholder="e.g. /Users/me/my-project"
                />
              </div>
              <textarea
                className="drawerTextarea"
                value={selected.description}
                onChange={(e) => setSelected({ ...selected, description: e.target.value })}
                rows={6}
              />
              <div className="drawerBtnsInline">
                <button
                  className="btn"
                  onClick={async () => {
                    await patchCard(selected.id, {
                      description: selected.description,
                      project_path: selected.project_path || null,
                    });
                    await refresh();
                  }}
                >Save Details</button>
              </div>
            </div>

            <div className="drawerCol">
              <div className="drawerBtns">
                <button
                  className="btn"
                  onClick={async () => {
                    setLogs(await getLogs(selected.id));
                  }}
                >Refresh Logs</button>
                <button
                  className="btn"
                  onClick={() => setTermOpen(true)}
                >Terminal</button>
                <button
                  className="btn"
                  onClick={() => {
                    setSessionTab(selected.status === "Review/Test" ? "review" : "implementation");
                    setSessionData(null);
                    setSessionErr(null);
                    setExpandedToolCalls(new Set());
                    setSessionOpen(true);
                  }}
                >🔎 Agent Session</button>

                {(selected.status === "Inbox" || selected.status === "Planned" || selected.status === "Stopped") && (
                  <button
                    className="btn primary"
                    onClick={async () => {
                      if (!confirm("Start this task (run agent)?")) return;
                      await runCard(selected.id);
                      await refresh();
                      setTermOpen(true);
                    }}
                  >{selected.status === "Stopped" ? "Restart" : "Start"}</button>
                )}

                {selected.status === "Review/Test" && (
                  <button
                    className="btn primary"
                    onClick={async () => {
                      if (!confirm("Re-run review/test?")) return;
                      await reviewCard(selected.id);
                      await refresh();
                      setTermOpen(true);
                    }}
                  >Re-review</button>
                )}

                {selected.status === "In Progress" && (
                  <button
                    className="btn"
                    onClick={async () => {
                      if (!confirm("Stop this task (kill process)?")) return;
                      await stopCard(selected.id);
                      await refresh();
                    }}
                  >Stop</button>
                )}

                <button
                  className="btn danger"
                  onClick={async () => {
                    if (!confirm("Delete this card?")) return;
                    await deleteCard(selected.id);
                    setSelected(null);
                    setLogs([]);
                    await refresh();
                  }}
                >Delete</button>
              </div>
            </div>

            <div className="drawerCol drawerLogsCol">
              <div className="logsHeader">Logs (latest 500)</div>
              <div className="logs">
                {logs.length === 0 ? <div className="logRow dim">(no logs)</div> : null}
                {logs.map((l) => (
                  <div key={l.id} className="logRow">
                    <span className="logTime">{fmtTime(l.created_at)}</span>
                    <span className="logKind">[{l.kind}]</span>
                    <span className="logMsg">{l.message}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
      {termOpen ? (
        <div className="modalOverlay" onClick={() => setTermOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Terminal · {selected?.title ?? ""}</div>
                <div className="modalSub">{termPath ?? ""}</div>
              </div>
              <div className="modalActions">
                <label className="toggle">
                  <input type="checkbox" checked={termFollow} onChange={(e) => setTermFollow(e.target.checked)} />
                  <span>follow</span>
                </label>
                <button
                  className="btn"
                  onClick={() => {
                    const el = termRef.current;
                    if (el) el.scrollTop = el.scrollHeight;
                  }}
                >Scroll to bottom</button>
                <button className="btn" onClick={() => setTermOpen(false)}>Close</button>
              </div>
            </div>
            <pre ref={termRef} className="terminal">{termText || "(no terminal log yet)"}</pre>
          </div>
        </div>
      ) : null}

      {sessionOpen ? (
        <div className="modalOverlay" onClick={() => setSessionOpen(false)}>
          <div className="modal sessionModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">🔎 Agent Session · {selected?.title ?? ""}</div>
                <div className="modalSub">
                  {sessionData?.implementation?.sessionId ?? sessionData?.review?.sessionId ?? ""}
                </div>
              </div>
              <div className="modalActions">
                <button className="btn" onClick={() => setSessionOpen(false)}>Close</button>
              </div>
            </div>

            {(() => {
              const hasImpl = !!sessionData?.implementation;
              const hasReview = !!sessionData?.review;
              const activeSession: ParsedSession | null =
                sessionTab === "review" ? sessionData?.review ?? null : sessionData?.implementation ?? null;

              return (
                <>
                  {(hasImpl || hasReview) && (
                    <div className="sessionTabs">
                      {hasImpl && (
                        <button
                          className={`sessionTab ${sessionTab === "implementation" ? "active" : ""}`}
                          onClick={() => setSessionTab("implementation")}
                        >Implementation</button>
                      )}
                      {hasReview && (
                        <button
                          className={`sessionTab ${sessionTab === "review" ? "active" : ""}`}
                          onClick={() => setSessionTab("review")}
                        >Review</button>
                      )}
                    </div>
                  )}

                  <div className="sessionBody">
                    {sessionErr && <div className="error">{sessionErr}</div>}

                    {!sessionData && !sessionErr && (
                      <div className="sessionEmpty">Loading session...</div>
                    )}

                    {sessionData && !hasImpl && !hasReview && (
                      <div className="sessionEmpty">No run logs found for this card yet.</div>
                    )}

                    {activeSession?.unsupportedFormat && (
                      <div className="sessionUnsupported">
                        <div>
                          Structured session view isn't available for the <code>{selected?.assignee ?? "this"}</code> CLI yet.
                        </div>
                        <button
                          className="btn"
                          onClick={() => {
                            setSessionOpen(false);
                            setTermOpen(true);
                          }}
                        >Open raw Terminal viewer</button>
                      </div>
                    )}

                    {activeSession && !activeSession.unsupportedFormat && (
                      <>
                        <div className="sessionStats">
                          <div className="statTile">
                            <div className="statLabel">Status</div>
                            <div className={
                              "statBadge " +
                              (!activeSession.isComplete ? "running" : activeSession.isError ? "error" : "success")
                            }>
                              {!activeSession.isComplete ? "Running" : activeSession.isError ? "Error" : "Success"}
                            </div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Duration{!activeSession.isComplete && activeSession.durationMs != null ? " (live)" : ""}</div>
                            <div className="statValue">{formatMsDuration(activeSession.durationMs)}</div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">API Time</div>
                            <div className="statValue">
                              {activeSession.apiDurationMs == null && !activeSession.isComplete
                                ? "…"
                                : formatMsDuration(activeSession.apiDurationMs)}
                            </div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Turns{!activeSession.isComplete && activeSession.numTurns != null ? " (so far)" : ""}</div>
                            <div className="statValue">{activeSession.numTurns ?? "-"}</div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Model</div>
                            <div className="statValue statValueSmall">{activeSession.model ?? "-"}</div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Cost</div>
                            <div className="statValue">
                              {activeSession.totalCostUsd == null && !activeSession.isComplete
                                ? "…"
                                : formatCost(activeSession.totalCostUsd)}
                            </div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Tokens In / Out{!activeSession.isComplete && activeSession.usage ? " (live)" : ""}</div>
                            <div className="statValue statValueSmall">
                              {formatTokenCount(activeSession.usage?.inputTokens)} / {formatTokenCount(activeSession.usage?.outputTokens)}
                            </div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Cache Read / Write{!activeSession.isComplete && activeSession.usage ? " (live)" : ""}</div>
                            <div className="statValue statValueSmall">
                              {formatTokenCount(activeSession.usage?.cacheReadTokens)} / {formatTokenCount(activeSession.usage?.cacheCreationTokens)}
                            </div>
                          </div>
                          <div className="statTile">
                            <div className="statLabel">Tool Calls</div>
                            <div className="statValue">{activeSession.toolCallCount}</div>
                          </div>
                        </div>

                        {activeSession.rateLimitHit && (
                          <div className="sessionRateLimitBanner">⚠ Rate limit event occurred during this session</div>
                        )}

                        <div className="sessionTimeline">
                          {activeSession.timeline.length === 0 && (
                            <div className="sessionEmpty">(no timeline entries yet)</div>
                          )}
                          {activeSession.timeline.map((entry: SessionTimelineEntry) => {
                            if (entry.kind === "assistant_text") {
                              return (
                                <div key={entry.seq} className="timelineText">
                                  {entry.text}
                                </div>
                              );
                            }
                            if (entry.kind === "notification") {
                              return (
                                <div key={entry.seq} className="timelineNotification">
                                  ℹ {entry.text}
                                </div>
                              );
                            }
                            if (entry.kind === "rate_limit") {
                              return (
                                <div key={entry.seq} className="timelineRateLimit">
                                  ⚠ Rate limit event
                                </div>
                              );
                            }
                            // tool_call
                            const expanded = expandedToolCalls.has(entry.id);
                            return (
                              <div
                                key={entry.seq}
                                className={`timelineToolCall ${entry.isError ? "isError" : ""} ${expanded ? "expanded" : ""}`}
                                onClick={() => {
                                  setExpandedToolCalls((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(entry.id)) next.delete(entry.id);
                                    else next.add(entry.id);
                                    return next;
                                  });
                                }}
                              >
                                <div className="timelineToolCallHeader">
                                  <span className="toolCallBadge">{entry.name}</span>
                                  {entry.summary && <span className="toolCallSummary">{entry.summary}</span>}
                                  {entry.isError && <span className="toolCallErrorBadge">error</span>}
                                  <span className="toolCallToggle">{expanded ? "▾" : "▸"}</span>
                                </div>
                                {expanded && (
                                  <div className="timelineToolCallBody">
                                    <div className="toolCallSectionLabel">Input</div>
                                    <pre className="toolCallPre">{JSON.stringify(entry.input, null, 2)}</pre>
                                    <div className="toolCallSectionLabel">Result</div>
                                    <pre className="toolCallPre">{entry.result ?? "(no result yet)"}</pre>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      ) : null}

      {settingsOpen && (
        <div className="modalOverlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal settingsModal" onClick={(e) => e.stopPropagation()}>
            <div className="modalHeader">
              <div>
                <div className="modalTitle">Provider Settings</div>
                <div className="modalSub">Configure role-based and stage-based provider mapping</div>
              </div>
              <div className="modalActions">
                <button className="btn" onClick={() => setSettingsOpen(false)}>Close</button>
              </div>
            </div>
            <div className="settingsContent">
              <div className="settingsSection">
                <div className="settingsSectionTitle">AI Providers</div>
                <div className="cliProviders">
                  {CLI_PROVIDERS.map((p) => {
                    const st = cliStatus?.[p.value];
                    const cls = !st || cliLoading
                      ? "cliCard loading"
                      : st.installed && st.authenticated
                        ? "cliCard ready"
                        : st.installed
                          ? "cliCard warning"
                          : "cliCard missing";
                    return (
                      <div key={p.value} className={cls}>
                        <div className="cliCardName">{p.label}</div>
                        <div className="cliCardVersion">
                          {cliLoading ? "..." : st?.version ?? (st?.installed ? "installed" : "not installed")}
                        </div>
                        <div className={`cliBadge ${!st || cliLoading ? "loading" : st.installed && st.authenticated ? "ready" : st.installed ? "warning" : "missing"}`}>
                          {cliLoading
                            ? "Checking..."
                            : st?.installed && st?.authenticated
                              ? "\u2713 Ready"
                              : st?.installed
                                ? "\u26A0 Login needed"
                                : "Not installed"}
                        </div>
                        {st && !st.authenticated && st.installed && !cliLoading && (
                          <div className="cliHint">{st.authHint}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <button
                  className="btn secondary cliRecheck"
                  onClick={() => loadCliStatus(true)}
                  disabled={cliLoading}
                >{cliLoading ? "Checking..." : "Re-check"}</button>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">OAuth Connect (optional)</div>
                <div className="settingsHint" style={{ marginBottom: 12 }}>
                  Credentials are stored only on the server (encrypted in SQLite). No token is stored in browser storage.
                </div>
                {!oauthStorageReady && (
                  <div className="oauthWarning">
                    `OAUTH_ENCRYPTION_SECRET` is missing on the server. OAuth connect is disabled until it is configured.
                  </div>
                )}
                <div className="oauthGrid">
                  {OAUTH_PROVIDERS.map((oauthProvider) => {
                    const st = oauthStatus?.[oauthProvider.value];
                    const isConnected = st?.connected ?? false;
                    const isBusy = oauthBusy === oauthProvider.value;
                    return (
                      <div
                        key={oauthProvider.value}
                        className={`oauthCard ${oauthLoading ? "loading" : isConnected ? "connected" : "disconnected"}`}
                      >
                        <div className="oauthCardHead">
                          <div className="oauthCardName">{oauthProvider.label}</div>
                          <div className={`oauthBadge ${oauthLoading ? "loading" : isConnected ? "connected" : "disconnected"}`}>
                            {oauthLoading ? "Checking..." : isConnected ? "Connected" : "Not connected"}
                          </div>
                        </div>
                        <div className="oauthCardDesc">{oauthProvider.desc}</div>
                        <div className="oauthCardMeta">
                          {isConnected ? (
                            <>
                              <span>{st?.email ?? "email unavailable"}</span>
                              {st?.updatedAt ? <span>Updated: {fmtTime(st.updatedAt)}</span> : null}
                              {st?.expiresAt ? <span>Expires: {fmtTime(st.expiresAt)}</span> : null}
                              {st?.source ? <span>Source: {st.source}</span> : null}
                            </>
                          ) : (
                            <span>OAuth not connected</span>
                          )}
                        </div>
                        <div className="oauthCardActions">
                          {oauthProvider.value === "github-copilot" ? (
                            <button
                              className="btn"
                              onClick={() => startDeviceCodeFlow()}
                              disabled={!oauthStorageReady || oauthLoading || oauthBusy !== null || devicePolling}
                            >{devicePolling ? "Waiting..." : "Connect (Device Code)"}</button>
                          ) : (
                            <button
                              className="btn"
                              onClick={() => startOAuthConnect(oauthProvider.value)}
                              disabled={!oauthStorageReady || oauthLoading || oauthBusy !== null}
                            >Connect</button>
                          )}
                          <button
                            className="btn secondary"
                            onClick={() => disconnectOAuthProvider(oauthProvider.value)}
                            disabled={oauthLoading || oauthBusy !== null || !isConnected}
                          >{isBusy ? "Disconnecting..." : "Disconnect"}</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {deviceCode && (
                  <div style={{
                    margin: "12px 0",
                    padding: 16,
                    background: "#1a1a2e",
                    borderRadius: 8,
                    border: "1px solid #444",
                    textAlign: "center",
                  }}>
                    <div style={{ fontSize: "0.9em", marginBottom: 8 }}>
                      Go to <a
                        href={deviceCode.verificationUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "#58a6ff" }}
                      >{deviceCode.verificationUri}</a> and enter:
                    </div>
                    <div style={{
                      fontSize: "1.8em",
                      fontWeight: "bold",
                      fontFamily: "monospace",
                      letterSpacing: "0.15em",
                      padding: "8px 0",
                      userSelect: "all",
                    }}>{deviceCode.userCode}</div>
                    <div style={{ fontSize: "0.8em", color: "#999" }}>
                      {devicePolling ? "Waiting for authorization..." : ""}
                    </div>
                  </div>
                )}
                {deviceStatus && !deviceCode && (
                  <div style={{
                    margin: "8px 0",
                    fontSize: "0.85em",
                    color: deviceStatus === "connected" ? "#4caf50" : "#f44336",
                  }}>
                    {deviceStatus === "connected" ? "GitHub connected successfully!" : deviceStatus}
                  </div>
                )}

                <button
                  className="btn secondary cliRecheck"
                  onClick={() => loadOAuthStatus(true)}
                  disabled={oauthLoading || oauthBusy !== null}
                >{oauthLoading ? "Checking..." : "Re-check OAuth"}</button>

                {openclawProfiles && openclawProfiles.profiles.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <div className="settingsSectionTitle" style={{ fontSize: "0.9em", marginBottom: 8 }}>
                      Import from OpenClaw
                    </div>
                    <div className="settingsHint" style={{ marginBottom: 8 }}>
                      Found {openclawProfiles.profiles.length} profile(s) in OpenClaw auth-profiles. Import tokens to connect without separate OAuth app credentials.
                    </div>
                    <div className="oauthGrid">
                      {openclawProfiles.profiles.map((p) => {
                        const alreadyConnected = oauthStatus?.[
                          p.kanbanProvider === "google_antigravity" ? "antigravity" : "github-copilot"
                        ]?.connected ?? false;
                        return (
                          <div
                            key={p.profileKey}
                            className={`oauthCard ${alreadyConnected ? "connected" : p.expired ? "disconnected" : "disconnected"}`}
                          >
                            <div className="oauthCardHead">
                              <div className="oauthCardName">{p.label}</div>
                              <div className={`oauthBadge ${alreadyConnected ? "connected" : p.expired ? "warning" : "disconnected"}`}>
                                {alreadyConnected ? "Already imported" : p.expired ? "Token expired" : "Available"}
                              </div>
                            </div>
                            <div className="oauthCardMeta">
                              {p.email && <span>{p.email}</span>}
                              {p.expiresAt && <span>Expires: {fmtTime(p.expiresAt)}</span>}
                              {p.hasRefreshToken && <span>Has refresh token</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button
                        className="btn primary"
                        onClick={() => handleOpenClawImport(false)}
                        disabled={openclawImporting || !oauthStorageReady}
                      >{openclawImporting ? "Importing..." : "Import All"}</button>
                      <button
                        className="btn secondary"
                        onClick={() => handleOpenClawImport(true)}
                        disabled={openclawImporting || !oauthStorageReady}
                      >{openclawImporting ? "Importing..." : "Import (overwrite)"}</button>
                    </div>
                    {openclawImportResult && (
                      <div style={{ marginTop: 8, fontSize: "0.85em", lineHeight: 1.5 }}>
                        {openclawImportResult.imported.length > 0 && (
                          <div style={{ color: "#4caf50" }}>Imported: {openclawImportResult.imported.join(", ")}</div>
                        )}
                        {openclawImportResult.skipped.length > 0 && (
                          <div style={{ color: "#ff9800" }}>Skipped (already connected): {openclawImportResult.skipped.join(", ")}</div>
                        )}
                        {openclawImportResult.errors.length > 0 && (
                          <div style={{ color: "#f44336" }}>
                            Errors: {openclawImportResult.errors.map((e) => `${e.provider}: ${e.error}`).join(", ")}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {(() => {
                // Show model config for providers that support model selection
                const modelProviders = PROVIDERS.filter((p) => {
                  if (p.value === "opencode") return cliStatus?.opencode?.installed ?? false;
                  const oEntry = OAUTH_ASSIGNABLE.find((o) => o.value === p.value);
                  if (oEntry) return oauthStatus?.[oEntry.oauthKey]?.connected ?? false;
                  return false;
                });
                if (modelProviders.length === 0) return null;
                return (
                  <div className="settingsSection">
                    <div className="settingsSectionTitle">Model Selection</div>
                    <div className="settingsHint" style={{ marginBottom: 12 }}>
                      Choose which model each provider uses when running tasks.
                    </div>
                    <div className="settingsGrid">
                      {modelProviders.map((p) => {
                        const cfg: ProviderModelConfig = settings.providerModelConfig?.[p.value] ?? { model: "" };
                        const models = oauthModels[p.value] ?? [];
                        return (
                          <div key={p.value} className="settingsField">
                            <label>{p.label}</label>
                            <select
                              value={cfg.model}
                              onChange={(e) => {
                                const next = { ...settings.providerModelConfig, [p.value]: { model: e.target.value } };
                                setSettings({ ...settings, providerModelConfig: next });
                              }}
                            >
                              <option value="">{p.value === "opencode" ? "Default model" : "Select model..."}</option>
                              {models.map((m) => (
                                <option key={m} value={m}>{m}</option>
                              ))}
                            </select>
                            <span className="settingsHint">
                              {cfg.model || (p.value === "opencode" ? "Uses opencode default" : "No model selected")}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              <div className="settingsSection">
                <div className="settingsSectionTitle">Auto-assign</div>
                <label className="settingsToggle">
                  <input
                    type="checkbox"
                    checked={settings.autoAssign}
                    onChange={(e) => setSettings({ ...settings, autoAssign: e.target.checked })}
                  />
                  <span>Enable role-based provider auto-assignment</span>
                </label>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">Role-based Providers</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>Dev Ops</label>
                    <select
                      value={settings.roleProviders.devops}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: { ...settings.roleProviders, devops: e.target.value as Provider }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Overall orchestration and logic</span>
                  </div>

                  <div className="settingsField">
                    <label>BackEnd</label>
                    <select
                      value={settings.roleProviders.backend}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: { ...settings.roleProviders, backend: e.target.value as Provider }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Backend-focused tasks</span>
                  </div>
                </div>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">FrontEnd Providers (by task type)</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>New Feature</label>
                    <select
                      value={settings.roleProviders.frontend.new}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, new: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">New UI/feature development</span>
                  </div>

                  <div className="settingsField">
                    <label>Modify / Improve</label>
                    <select
                      value={settings.roleProviders.frontend.modify}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, modify: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Modify/improve existing code</span>
                  </div>

                  <div className="settingsField">
                    <label>Bugfix</label>
                    <select
                      value={settings.roleProviders.frontend.bugfix}
                      onChange={(e) => setSettings({
                        ...settings,
                        roleProviders: {
                          ...settings.roleProviders,
                          frontend: { ...settings.roleProviders.frontend, bugfix: e.target.value as Provider }
                        }
                      })}
                    >
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Bug fixes and issue resolution</span>
                  </div>
                </div>
              </div>

              <div className="settingsSection">
                <div className="settingsSectionTitle">Stage-based Providers (optional)</div>
                <div className="settingsGrid">
                  <div className="settingsField">
                    <label>In Progress</label>
                    <select
                      value={settings.stageProviders.inProgress ?? ""}
                      onChange={(e) => setSettings({
                        ...settings,
                        stageProviders: {
                          ...settings.stageProviders,
                          inProgress: e.target.value ? e.target.value as Provider : null
                        }
                      })}
                    >
                      <option value="">Follow role settings</option>
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Default provider for In Progress stage</span>
                  </div>

                  <div className="settingsField">
                    <label>Review/Test</label>
                    <select
                      value={settings.stageProviders.reviewTest ?? ""}
                      onChange={(e) => setSettings({
                        ...settings,
                        stageProviders: {
                          ...settings.stageProviders,
                          reviewTest: e.target.value ? e.target.value as Provider : null
                        }
                      })}
                    >
                      <option value="">Follow role settings</option>
                      {PROVIDERS.map((p) => (
                        <option key={p.value} value={p.value} disabled={!isProviderAvailable(p.value)}>
                          {p.label} {!isProviderAvailable(p.value) ? "(not authenticated)" : `(${p.desc})`}
                        </option>
                      ))}
                    </select>
                    <span className="settingsHint">Default provider for Review/Test stage</span>
                  </div>
                </div>
              </div>

              <div className="settingsActions">
                <button
                  className="btn"
                  onClick={() => setSettings(DEFAULT_PROVIDER_SETTINGS)}
                >Reset Defaults</button>
                <button
                  className="btn"
                  onClick={handleSaveSettings}
                  disabled={settingsLoading}
                >{settingsLoading ? "Saving..." : "Save"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
