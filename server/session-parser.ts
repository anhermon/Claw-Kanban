import fs from "node:fs";

// Parses the newline-delimited JSON stream produced by `claude --output-format=stream-json
// --include-partial-messages` (piped into logs/{cardId}.log and logs/{cardId}.review.log by
// spawnAgent() / startReviewTest() in server/index.ts) into a structured session summary +
// tool-call timeline, so the UI can render AgentsView-style session detail natively without
// depending on the external agentsview tool/daemon.

export interface ParsedSessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

export interface ParsedSessionModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

export type TimelineEntry =
  | { seq: number; kind: "assistant_text"; timestamp?: string; text: string }
  | {
      seq: number;
      kind: "tool_call";
      timestamp?: string;
      id: string;
      name: string;
      input: unknown;
      summary?: string;
      result?: string;
      isError?: boolean;
    }
  | { seq: number; kind: "notification"; timestamp?: string; text: string }
  | { seq: number; kind: "rate_limit"; timestamp?: string; status?: string };

// Snapshot of the routine quota-utilization telemetry carried on `allowed` rate_limit_event
// lines (see summarizeRateLimitEvent below) - kept for a possible future "quota" stat tile.
// Not surfaced in the timeline; the timeline only gets an entry for a genuine non-"allowed"
// rate-limit signal.
export interface QuotaUtilizationSnapshot {
  fiveHourUtilization: number | null;
  sevenDayUtilization: number | null;
  timestamp?: string;
}

export interface ParsedSession {
  sessionId: string | null;
  model: string | null;
  isComplete: boolean;
  isError: boolean | null;
  stopReason: string | null;
  subtype: string | null;
  durationMs: number | null;
  apiDurationMs: number | null;
  numTurns: number | null;
  ttftMs: number | null;
  startedAt: string | null;
  usage: ParsedSessionUsage | null;
  totalCostUsd: number | null;
  modelUsage: Record<string, ParsedSessionModelUsage> | null;
  toolCallCount: number;
  rateLimitHit: boolean;
  finalResultText: string | null;
  unsupportedFormat?: boolean;
  timeline: TimelineEntry[];
  // Nice-to-have: latest routine ("allowed") quota utilization seen, for a future stat tile.
  // Null when no rate_limit_event lines were seen at all.
  latestQuotaUtilization: QuotaUtilizationSnapshot | null;
}

// Recognized top-level `type` values for the Claude Code stream-json format. If a log file's
// lines never match any of these, it isn't (or is no longer) Claude stream-json output.
const RECOGNIZED_TYPES = new Set([
  "stream_event",
  "assistant",
  "user",
  "system",
  "rate_limit_event",
  "result",
]);

// Loose shape of one Claude stream-json line - only the fields this parser reads. Every field is
// optional/unknown because lines come from an external CLI and are validated at each use site.
interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number };
}

interface StreamContentBlock {
  type?: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

interface StreamMessage {
  id?: unknown;
  model?: unknown;
  usage?: StreamUsage;
  content?: unknown;
}

interface StreamRateLimitInfo {
  status?: unknown;
  unifiedWindows?: {
    five_hour?: { utilization?: unknown };
    seven_day?: { utilization?: unknown };
  };
}

interface StreamModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUSD?: number;
}

interface StreamEvent {
  type?: unknown;
  timestamp?: string;
  session_id?: unknown;
  subtype?: string | null;
  summary?: unknown;
  message?: StreamMessage;
  rate_limit_info?: StreamRateLimitInfo;
  usage?: StreamUsage;
  modelUsage?: Record<string, StreamModelUsage | null | undefined>;
  is_error?: unknown;
  stop_reason?: string | null;
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  num_turns?: number | null;
  ttft_ms?: number | null;
  total_cost_usd?: number | null;
  result?: unknown;
}

function contentBlocks(message: StreamMessage | undefined): StreamContentBlock[] {
  return Array.isArray(message?.content) ? (message.content as StreamContentBlock[]) : [];
}

interface ToolResultContentBlock {
  type?: string;
  text?: string;
}

const SUMMARY_MAX_LEN = 90;

function truncateSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SUMMARY_MAX_LEN) return collapsed;
  return collapsed.slice(0, SUMMARY_MAX_LEN - 1).trimEnd() + "…";
}

// Builds a short, scannable one-line preview of a tool call's input, tailored per common tool
// name, so the collapsed timeline row shows *what* the call did instead of just its name. The
// full untruncated input JSON is still available in the expandable body.
function summarizeToolInput(name: string, input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const lowerName = name.toLowerCase();

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

  if (lowerName === "bash") {
    const command = str(record.command);
    if (command) return truncateSummary(command);
  } else if (["read", "edit", "write", "notebookedit"].includes(lowerName)) {
    const target = str(record.file_path) ?? str(record.path) ?? str(record.notebook_path);
    if (target) return truncateSummary(target);
  } else if (["glob", "grep"].includes(lowerName)) {
    const pattern = str(record.pattern);
    if (pattern) {
      const p = str(record.path);
      return truncateSummary(p ? `${pattern} in ${p}` : pattern);
    }
  } else if (["webfetch", "websearch"].includes(lowerName)) {
    const target = str(record.url) ?? str(record.query);
    if (target) return truncateSummary(target);
  }

  try {
    return truncateSummary(JSON.stringify(input));
  } catch {
    return undefined;
  }
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: ToolResultContentBlock) => (typeof block?.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function parseClaudeSessionLog(logPath: string): ParsedSession | null {
  if (!fs.existsSync(logPath)) return null;

  const raw = fs.readFileSync(logPath, "utf8");
  const rawLines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) return null;

  const events: StreamEvent[] = [];
  for (const line of rawLines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Truncated/mid-write last line (or otherwise malformed) - skip it.
      continue;
    }
  }

  if (events.length === 0) return null;

  let anyRecognized = false;
  for (const e of events) {
    if (e && typeof e === "object" && typeof e.type === "string" && RECOGNIZED_TYPES.has(e.type)) {
      anyRecognized = true;
      break;
    }
  }
  if (!anyRecognized) {
    return {
      sessionId: null,
      model: null,
      isComplete: false,
      isError: null,
      stopReason: null,
      subtype: null,
      durationMs: null,
      apiDurationMs: null,
      numTurns: null,
      ttftMs: null,
      startedAt: null,
      usage: null,
      totalCostUsd: null,
      modelUsage: null,
      toolCallCount: 0,
      rateLimitHit: false,
      finalResultText: null,
      unsupportedFormat: true,
      timeline: [],
      latestQuotaUtilization: null,
    };
  }

  let sessionId: string | null = null;
  let model: string | null = null;
  let startedAt: string | null = null;
  let rateLimitHit = false;
  let resultEvent: StreamEvent | null = null;
  let latestQuotaUtilization: QuotaUtilizationSnapshot | null = null;

  const timeline: TimelineEntry[] = [];
  // toolu_id -> index into `timeline` of the matching tool_call entry, so tool_result events
  // (which arrive later as separate `user` lines) can be attached back to their call.
  const toolCallIndexById = new Map<string, number>();
  let seq = 0;

  // Running ("so far") turn/usage totals derived directly from `assistant` message events, used
  // as a best-effort fallback for the header stats while the session is still in progress (no
  // `result` event yet). Each assistant *message* (not content block) can appear on multiple
  // stream-json lines - one per content block - all carrying the same message-level `usage`
  // snapshot, so we dedupe by message id before accumulating.
  const seenTurnMessageIds = new Set<string>();
  let turnsSoFar = 0;
  let runningInputTokens = 0;
  let runningOutputTokens = 0;
  let runningCacheReadTokens = 0;
  let runningCacheCreationTokens = 0;

  for (const e of events) {
    if (!e || typeof e !== "object") continue;

    if (!startedAt && typeof e.timestamp === "string") {
      startedAt = e.timestamp;
    }
    if (!sessionId && typeof e.session_id === "string") {
      sessionId = e.session_id;
    }

    switch (e.type) {
      case "assistant": {
        const message: StreamMessage = e.message ?? {};
        if (!model && typeof message.model === "string") model = message.model;

        // A given assistant *message* (message.id) can be split across several stream-json
        // lines - one per content block - each repeating the same message-level `usage`
        // snapshot. Count/accumulate it once per distinct message id.
        if (typeof message.id === "string" && !seenTurnMessageIds.has(message.id)) {
          seenTurnMessageIds.add(message.id);
          turnsSoFar++;
          const u: StreamUsage = message.usage ?? {};
          runningInputTokens += Number(u.input_tokens ?? 0);
          runningOutputTokens += Number(u.output_tokens ?? 0);
          runningCacheReadTokens += Number(u.cache_read_input_tokens ?? 0);
          runningCacheCreationTokens += Number(u.cache_creation_input_tokens ?? 0);
        }

        for (const block of contentBlocks(message)) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            timeline.push({ seq: seq++, kind: "assistant_text", timestamp: e.timestamp, text: block.text });
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            const entry: TimelineEntry = {
              seq: seq++,
              kind: "tool_call",
              timestamp: e.timestamp,
              id: block.id,
              name,
              input: block.input,
              summary: summarizeToolInput(name, block.input),
            };
            toolCallIndexById.set(block.id, timeline.length);
            timeline.push(entry);
          }
          // "thinking" blocks are intentionally skipped from the timeline (internal reasoning,
          // too noisy for the session-detail view).
        }
        break;
      }
      case "user": {
        for (const block of contentBlocks(e.message)) {
          if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
          const toolUseId = block.tool_use_id;
          if (typeof toolUseId !== "string") continue;
          const idx = toolCallIndexById.get(toolUseId);
          if (idx == null) continue;
          const target = timeline[idx];
          if (target.kind !== "tool_call") continue;
          target.result = normalizeToolResultContent(block.content);
          target.isError = Boolean(block.is_error);
        }
        break;
      }
      case "system": {
        if (e.subtype === "task_notification" && typeof e.summary === "string") {
          timeline.push({ seq: seq++, kind: "notification", timestamp: e.timestamp, text: e.summary });
        }
        // status / hook_started / hook_response / thinking_tokens / task_started: internal
        // noise, intentionally skipped from the timeline.
        break;
      }
      case "rate_limit_event": {
        const info: StreamRateLimitInfo = e.rate_limit_info ?? {};
        const status = typeof info.status === "string" ? info.status : null;

        // `status: "allowed"` is routine quota-utilization telemetry - the request WAS allowed,
        // it's not an incident. Stash the latest utilization for a possible future "quota" stat
        // tile, but don't treat it as a rate-limit signal: no rateLimitHit, no timeline entry.
        const windows = info.unifiedWindows ?? {};
        const fiveHourUtil = windows.five_hour?.utilization;
        const sevenDayUtil = windows.seven_day?.utilization;
        latestQuotaUtilization = {
          fiveHourUtilization: typeof fiveHourUtil === "number" ? fiveHourUtil : null,
          sevenDayUtilization: typeof sevenDayUtil === "number" ? sevenDayUtil : null,
          timestamp: e.timestamp,
        };

        if (status !== "allowed") {
          rateLimitHit = true;
          timeline.push({ seq: seq++, kind: "rate_limit", timestamp: e.timestamp, status: status ?? undefined });
        }
        break;
      }
      case "result": {
        resultEvent = e;
        break;
      }
      default:
        break;
    }
  }

  const toolCallCount = timeline.filter((t) => t.kind === "tool_call").length;

  let usage: ParsedSessionUsage | null = null;
  let modelUsage: Record<string, ParsedSessionModelUsage> | null = null;
  if (resultEvent) {
    const u: StreamUsage = resultEvent.usage ?? {};
    usage = {
      inputTokens: Number(u.input_tokens ?? 0),
      outputTokens: Number(u.output_tokens ?? 0),
      cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
      cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
      thinkingTokens: Number(u.output_tokens_details?.thinking_tokens ?? 0),
    };

    if (resultEvent.modelUsage && typeof resultEvent.modelUsage === "object") {
      modelUsage = {};
      for (const [modelName, mu] of Object.entries(resultEvent.modelUsage)) {
        modelUsage[modelName] = {
          inputTokens: Number(mu?.inputTokens ?? 0),
          outputTokens: Number(mu?.outputTokens ?? 0),
          costUSD: Number(mu?.costUSD ?? 0),
        };
      }
    }
  } else if (turnsSoFar > 0) {
    // No `result` event yet (session still running / interrupted mid-stream): fall back to
    // best-effort "so far" totals derived directly from the assistant events seen above, so the
    // live polling view (2s interval while the card is In Progress/Review) shows real running
    // numbers instead of leaving every stat tile blank. API time and cost intentionally stay
    // null here - neither is derivable from per-message data, only from the final `result` event.
    usage = {
      inputTokens: runningInputTokens,
      outputTokens: runningOutputTokens,
      cacheReadTokens: runningCacheReadTokens,
      cacheCreationTokens: runningCacheCreationTokens,
      thinkingTokens: 0,
    };
  }

  const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
  const fallbackDurationMs = !resultEvent && !Number.isNaN(startedAtMs) ? Date.now() - startedAtMs : null;
  const fallbackNumTurns = !resultEvent && turnsSoFar > 0 ? turnsSoFar : null;

  return {
    sessionId,
    model,
    isComplete: resultEvent != null,
    isError: resultEvent ? Boolean(resultEvent.is_error) : null,
    stopReason: resultEvent?.stop_reason ?? null,
    subtype: resultEvent?.subtype ?? null,
    durationMs: resultEvent?.duration_ms ?? fallbackDurationMs,
    apiDurationMs: resultEvent?.duration_api_ms ?? null,
    numTurns: resultEvent?.num_turns ?? fallbackNumTurns,
    ttftMs: resultEvent?.ttft_ms ?? null,
    startedAt,
    usage,
    totalCostUsd: resultEvent?.total_cost_usd ?? null,
    modelUsage,
    toolCallCount,
    rateLimitHit,
    finalResultText: typeof resultEvent?.result === "string" ? resultEvent.result : null,
    timeline,
    latestQuotaUtilization,
  };
}
