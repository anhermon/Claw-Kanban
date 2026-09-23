#!/usr/bin/env node
// Modified by Angel Hermon (2026) from Claw-Kanban by GreenSheep01201; Apache-2.0 (see LICENSE).

/**
 * Claw-Kanban setup script
 *
 * Prepends kanban orchestration rules to the user's AGENTS.md.
 * This is an UPDATE, not an OVERWRITE - existing content is preserved.
 *
 * Target: --agents-path, else $CLAW_KANBAN_AGENTS_PATH, else ./AGENTS.md
 *
 * Usage:
 *   node scripts/setup.mjs [--agents-path /path/to/AGENTS.md]
 *   pnpm setup [-- --agents-path /path/to/AGENTS.md]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, "..", "templates", "AGENTS-kanban.md");
const START_MARKER = "<!-- BEGIN claw-kanban orchestration rules -->";
const END_MARKER = "<!-- END claw-kanban orchestration rules -->";

function findAgentsPath() {
  // Check CLI args
  const args = process.argv.slice(2);
  const agentsIdx = args.indexOf("--agents-path");
  if (agentsIdx !== -1 && args[agentsIdx + 1]) {
    return path.resolve(args[agentsIdx + 1]);
  }

  // Explicit override via env, else AGENTS.md in the current directory
  const fromEnv = process.env.CLAW_KANBAN_AGENTS_PATH?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(process.cwd(), "AGENTS.md");
}

function main() {
  const agentsPath = findAgentsPath();
  const templateContent = fs.readFileSync(TEMPLATE_PATH, "utf8");

  console.log(`[Claw-Kanban] Setting up kanban orchestration rules`);
  console.log(`[Claw-Kanban] Target: ${agentsPath}`);

  // Read existing content
  let existingContent = "";
  if (fs.existsSync(agentsPath)) {
    existingContent = fs.readFileSync(agentsPath, "utf8");
  }

  // Check if already installed
  if (existingContent.includes(END_MARKER)) {
    console.log(`[Claw-Kanban] Kanban rules already present in ${agentsPath}`);
    console.log(`[Claw-Kanban] To update, remove the section between "${START_MARKER}" and "${END_MARKER}" first.`);
    return;
  }

  // Prepend template to existing content
  const newContent = templateContent + "\n\n" + existingContent;

  // Ensure parent directory exists
  const dir = path.dirname(agentsPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(agentsPath, newContent, "utf8");
  console.log(`[Claw-Kanban] Kanban orchestration rules added to top of ${agentsPath}`);
  console.log(`[Claw-Kanban] Your existing AGENTS.md content is preserved below the kanban rules.`);
  console.log(`[Claw-Kanban] Done!`);
}

main();
