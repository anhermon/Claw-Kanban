import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";

export interface HarnessSyncResult {
  ok: boolean;
  totalSynced: number;
  epicsCount: number;
  internalCount: number;
  lastSyncedAt: number;
  harnessDir: string;
  error?: string;
}

export function getHarnessDataDir(): string {
  return (
    process.env.HARNESS_DATA_DIR ||
    path.join(os.homedir(), ".claude", "agent-harness")
  );
}

function normalizePhaseToKanbanStatus(phaseOrStatus: string): "Inbox" | "Planned" | "In Progress" | "Review/Test" | "Done" | "Stopped" {
  const p = (phaseOrStatus || "").toLowerCase().trim();
  if (["done", "closed", "merged", "resolved", "won't fix", "wont fix", "invalid"].includes(p)) {
    return "Done";
  }
  if (["blocked", "test-failure", "stopped"].includes(p)) {
    return "Stopped";
  }
  // To avoid flooding In-Progress with hundreds of past Jira/harness tickets,
  // all active, in-progress, in-review, and backlog tickets land in Planned (Backlog)
  // so they can be worked on gradually up to the max concurrent WIP limit.
  return "Planned";
}

function priorityToNumber(priStr?: string): number {
  if (!priStr) return 0;
  const p = priStr.toLowerCase();
  if (p.includes("p0") || p.includes("blocker") || p.includes("critical")) return 5;
  if (p.includes("p1") || p.includes("highest") || p.includes("urgent")) return 4;
  if (p.includes("p2") || p.includes("high")) return 3;
  if (p.includes("p3") || p.includes("medium") || p.includes("low")) return 2;
  if (p.includes("p4") || p.includes("lowest")) return 1;
  return 0;
}

function deriveRole(key: string, repoDir?: string): "devops" | "backend" | "frontend" {
  const repo = (repoDir || "").toLowerCase();
  const k = key.toUpperCase();
  if (k.startsWith("AUT-") || repo.includes("automation") || repo.includes("frontend")) {
    return "frontend";
  }
  if (repo.includes("infra") || repo.includes("prod") || repo.includes("helm") || repo.includes("devops")) {
    return "devops";
  }
  return "backend";
}

let lastSyncStats: HarnessSyncResult = {
  ok: true,
  totalSynced: 0,
  epicsCount: 0,
  internalCount: 0,
  lastSyncedAt: 0,
  harnessDir: getHarnessDataDir(),
};

export function getHarnessSyncStatus(): HarnessSyncResult {
  return lastSyncStats;
}

export function syncAgentHarness(db: DatabaseSync): HarnessSyncResult {
  const harnessDir = getHarnessDataDir();
  const stateDir = path.join(harnessDir, "state");
  const jiraStatusesPath = path.join(harnessDir, "jira-statuses.json");

  if (!fs.existsSync(harnessDir)) {
    return {
      ok: false,
      totalSynced: 0,
      epicsCount: 0,
      internalCount: 0,
      lastSyncedAt: Date.now(),
      harnessDir,
      error: `Harness directory not found at ${harnessDir}`,
    };
  }

  let jiraStatuses: Record<string, any> = {};
  try {
    if (fs.existsSync(jiraStatusesPath)) {
      jiraStatuses = JSON.parse(fs.readFileSync(jiraStatusesPath, "utf8"));
    }
  } catch (e) {
    console.error("[Harness Sync] Error reading jira-statuses.json:", e);
  }

  const stateMap = new Map<string, any>();
  if (fs.existsSync(stateDir)) {
    const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const fullPath = path.join(stateDir, f);
        const data = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const key = (data.jira_key || f.replace(/\.json$/, "")).toUpperCase();
        stateMap.set(key, { ...data, _file: fullPath, jira_key: key });
      } catch (e) {
        console.error(`[Harness Sync] Error reading state file ${f}:`, e);
      }
    }
  }

  // Collect all unique keys from state files and jira-statuses
  const allKeys = new Set<string>([...stateMap.keys(), ...Object.keys(jiraStatuses)]);

  let epicsCount = 0;
  let internalCount = 0;
  let totalSynced = 0;
  const now = Date.now();

  const insertCardStmt = db.prepare(`
    INSERT INTO cards (id, created_at, updated_at, source, source_message_id, source_author, source_chat, title, description, status, assignee, priority, role, task_type, project_path)
    VALUES (@id, @created_at, @updated_at, @source, @source_message_id, @source_author, @source_chat, @title, @description, @status, @assignee, @priority, @role, @task_type, @project_path)
  `);

  const updateCardStmt = db.prepare(`
    UPDATE cards
    SET updated_at = @updated_at,
        title = @title,
        description = @description,
        status = @status,
        priority = @priority,
        role = @role,
        project_path = @project_path
    WHERE id = @id
  `);

  for (const key of allKeys) {
    const state = stateMap.get(key) || {};
    const jira = jiraStatuses[key] || {};

    const isInternal = key.startsWith("INT-") || key.includes("INTERNAL");
    const source = isInternal ? "agent-harness:internal" : "agent-harness:jira";
    if (isInternal) {
      internalCount++;
    } else {
      epicsCount++;
    }

    const summary = jira.summary || state.notes?.slice(0, 80) || key;
    const prefix = isInternal ? "[INTERNAL]" : "[EPIC]";
    const title = `${prefix} ${key}: ${summary}`;

    const rawPhase = state.phase || jira.status || "Planned";
    const status = normalizePhaseToKanbanStatus(rawPhase);
    const priority = priorityToNumber(jira.priority || state.priority);
    const repoDir = state.repo_dir || null;
    const role = deriveRole(key, repoDir);
    const assignee = state.assignee || (isInternal ? "claude" : null);

    // Build rich Markdown description
    const descParts: string[] = [];
    descParts.push(`## ${isInternal ? "Internal Task" : "Jira Epic"}: ${key}`);
    if (jira.summary) {
      descParts.push(`**Summary:** ${jira.summary}\n`);
    }
    if (repoDir) {
      descParts.push(`## Project Path\n${repoDir}\n`);
    }
    if (state.branch) {
      descParts.push(`- **Branch:** \`${state.branch}\``);
    }
    if (state.phase) {
      descParts.push(`- **Harness Phase:** \`${state.phase}\``);
    }
    if (jira.status) {
      descParts.push(`- **Jira Status:** \`${jira.status}\``);
    }
    if (state.test_counts?.latest) {
      descParts.push(`- **Test Counts:** ${state.test_counts.latest}`);
    }
    if (state.notes) {
      descParts.push(`\n### Notes\n${state.notes}`);
    }
    if (jira.description) {
      descParts.push(`\n### Jira Description\n${jira.description.slice(0, 1500)}`);
    }
    if (Array.isArray(jira.comments) && jira.comments.length > 0) {
      descParts.push(`\n### Recent Comments`);
      for (const comment of jira.comments.slice(-3)) {
        descParts.push(`> **${comment.author || "Comment"}** (${comment.created || ""}):\n> ${comment.body_text || ""}\n`);
      }
    }

    const description = descParts.join("\n");

    // Check if card exists by source_message_id
    const existing = db.prepare("SELECT * FROM cards WHERE source_message_id = ? LIMIT 1").get(key) as any;

    if (existing) {
      // Don't overwrite In Progress if card is currently actively running locally
      const currentStatus = existing.status;
      const targetStatus = (currentStatus === "In Progress" || currentStatus === "Review/Test" || currentStatus === "Done")
        ? currentStatus
        : status;

      updateCardStmt.run({
        id: existing.id,
        updated_at: now,
        title,
        description,
        status: targetStatus,
        priority,
        role,
        project_path: repoDir || existing.project_path,
      });
      totalSynced++;
    } else {
      const cardId = `c_harness_${key.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
      insertCardStmt.run({
        id: cardId,
        created_at: now,
        updated_at: now,
        source,
        source_message_id: key,
        source_author: "agent-harness",
        source_chat: null,
        title,
        description,
        status,
        assignee,
        priority,
        role,
        task_type: isInternal ? "modify" : "new",
        project_path: repoDir,
      });

      db.prepare("INSERT INTO card_logs (card_id, created_at, kind, message) VALUES (?, ?, ?, ?)").run(
        cardId,
        now,
        "system",
        `Synced from agent-harness (${source})`,
      );
      totalSynced++;
    }
  }

  lastSyncStats = {
    ok: true,
    totalSynced,
    epicsCount,
    internalCount,
    lastSyncedAt: now,
    harnessDir,
  };

  console.log(`[Harness Sync] Synced ${totalSynced} tasks (${epicsCount} Epics, ${internalCount} Internal) from ${harnessDir}`);
  return lastSyncStats;
}

export function updateHarnessStateFile(key: string, kanbanStatus: string): void {
  const harnessDir = getHarnessDataDir();
  const stateFile = path.join(harnessDir, "state", `${key.toUpperCase()}.json`);
  if (!fs.existsSync(stateFile)) return;

  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    let phase = data.phase;
    if (kanbanStatus === "In Progress") phase = "in-progress";
    else if (kanbanStatus === "Review/Test") phase = "in-review";
    else if (kanbanStatus === "Done") phase = "submitted";
    else if (kanbanStatus === "Planned") phase = "branch-created";

    data.phase = phase;
    data.last_updated = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(data, null, 2), "utf8");
    console.log(`[Harness Sync] Updated agent-harness state for ${key} -> ${phase}`);
  } catch (e) {
    console.error(`[Harness Sync] Failed to update state file for ${key}:`, e);
  }
}
