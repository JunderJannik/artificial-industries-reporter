// Gemeinsamer Kern aller Adapter: Projekt erkennen, Ereignisse bauen, puffern und senden.
// Grundregel: Es verlässt nie Inhalt den Rechner (keine Prompts, Befehle, Dateipfade, Antworten).
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Gemeinsamer Ordner für Konfiguration (Adresse, Token), falls das Tool keinen eigenen Datenordner liefert. */
export const HOME_DIR = process.env.AI_REPORTER_HOME || join(homedir(), ".artificial-industries");

const QUEUE_LIMIT = 5_000;
const SEND_TIMEOUT_MS = 2_500;

const TEST_CMD = /\b(test|tests|jest|vitest|pytest|mocha|playwright|tsc|eslint|typecheck|mvn|gradle|cargo (test|build|check|clippy)|go (test|build|vet)|(npm|pnpm|yarn|bun) (run )?(build|lint|check))\b(?!-)/i;
const READ_CMD = /^\s*(cat|head|tail|less|ls|dir|tree|grep|rg|find|fd|wc|sed -n|git (status|log|diff|show)|get-content|get-childitem|select-string|type)\b/i;
const WRITE_CMD = /\b(set-content|add-content|out-file|apply_patch)\b|^\s*(new-item|tee|touch|mkdir|cp|mv|copy-item|move-item)\b/i;

/** Ordnet einen Shell-Befehl lokal einer Station zu. Nur die Station wird gesendet. */
export function stationForCommand(command = "") {
  // PowerShell-Aufrufe wie `powershell.exe -Command "..."` auf den eigentlichen Befehl reduzieren
  const inner = command.replace(/^\s*"?[^"\s]*powershell(\.exe)?"?\s+(-\w+\s+)*-Command\s+/i, "").replace(/^['"]/, "");
  if (TEST_CMD.test(inner)) return "pruefstand";
  if (WRITE_CMD.test(inner)) return "werkbank";
  if (READ_CMD.test(inner)) return "archiv";
  return "maschinenraum";
}

/** MCP-Tools nur mit Servernamen anzeigen. */
export function toolLabel(name) {
  const m = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  return (m ? `MCP: ${m[1]}` : name).slice(0, 80);
}

export function findProjectRoot(cwd) {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return cwd;
}

/** Projekt-ID ist ein Hash des Pfads; gesendet wird nur dieser Hash und der Ordnername. */
export function projectOf(cwd) {
  const root = findProjectRoot(cwd || ".");
  const norm = process.platform === "win32" ? root.toLowerCase().replace(/\//g, "\\") : root;
  return {
    id: createHash("sha256").update(norm).digest("hex").slice(0, 16),
    name: (basename(root) || "Projekt").slice(0, 80),
  };
}

export const clip = (v, n = 80) => String(v).slice(0, n);

const lines = (s) => (typeof s === "string" && s.length ? s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : []);

/** Zeilen hinzugefügt/entfernt zwischen zwei Textständen (gemeinsamer Anfang und Ende zählen nicht). */
export function lineDiff(before, after) {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { plus: b.length - start - end, minus: a.length - start - end };
}

/** Teilt einen Codex-apply_patch in Dateiabschnitte und zählt pro Datei. */
export function patchFiles(text) {
  const parts = String(text ?? "").split(/^\*\*\* (?:Add|Update|Delete) File: .*$/m).slice(1);
  return parts.length ? parts.map(patchCounts) : [patchCounts(text)];
}

/** Zählt +/− Zeilen in einem Patch (unified diff oder Codex-apply_patch). */
export function patchCounts(text) {
  let plus = 0;
  let minus = 0;
  for (const l of lines(text)) {
    if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("***")) continue;
    if (l.startsWith("+")) plus++;
    else if (l.startsWith("-")) minus++;
  }
  return { plus, minus };
}

/** Baut ein Fabrik-Ereignis. `ids` enthält sessionId und optional agentId. */
export function makeEvent(source, ctx, type, data, ids) {
  return {
    v: 1,
    id: randomUUID(),
    ts: ctx.now,
    source,
    sessionId: clip(ids.sessionId, 128),
    ...(ids.agentId ? { agentId: clip(ids.agentId, 128) } : {}),
    project: ctx.project,
    type,
    data,
  };
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    return fallback;
  }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** Adresse und Token: zuerst aus den Plugin-Optionen von Claude Code, sonst aus der gemeinsamen config.json. */
export function loadConfig(dataDir) {
  const file = { ...readJson(join(HOME_DIR, "config.json"), {}), ...readJson(join(dataDir, "config.json"), {}) };
  const hidden = process.env.CLAUDE_PLUGIN_OPTION_HIDDEN_PROJECTS ?? file.hidden_projects ?? "";
  return {
    url: (process.env.CLAUDE_PLUGIN_OPTION_SERVER_URL || process.env.AI_SERVER_URL || file.server_url || "").replace(/\/+$/, ""),
    token: process.env.CLAUDE_PLUGIN_OPTION_TOKEN || process.env.AI_TOKEN || file.token || "",
    hidden: (Array.isArray(hidden) ? hidden : String(hidden).split(",")).map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

export function logError(dataDir, err) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, "reporter.log");
    if (existsSync(file) && statSync(file).size > 200_000) writeFileSync(file, "");
    appendFileSync(file, `${new Date().toISOString()} ${err?.stack ?? err}\n`);
  } catch {
    // Nicht einmal loggen geht: still aufgeben.
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Einfache Dateisperre, damit parallel laufende Hooks sich nicht in die Quere kommen. */
export async function withLock(dataDir, fn, waitMs = 2_000) {
  const lock = join(dataDir, "lock");
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {}
      if (Date.now() > until) return undefined;
      await sleep(25);
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lock); } catch {}
  }
}

export function enqueue(dataDir, events) {
  if (events.length) appendFileSync(join(dataDir, "queue.jsonl"), events.map((e) => JSON.stringify(e) + "\n").join(""));
}

/** Sendet gepufferte Ereignisse. Nur unter Sperre aufrufen. */
export async function flush(dataDir, cfg) {
  const queue = join(dataDir, "queue.jsonl");
  if (!existsSync(queue)) return;
  const sending = `${queue}.sending`;
  renameSync(queue, sending);
  const lines = readFileSync(sending, "utf8").split("\n").filter(Boolean).slice(-QUEUE_LIMIT);
  let sent = 0;
  try {
    for (let i = 0; i < lines.length; i += 100) {
      const events = lines.slice(i, i + 100).map((l) => JSON.parse(l));
      const res = await fetch(`${cfg.url}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ events }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // 4xx bedeutet: diese Ereignisse werden nie angenommen (z. B. falscher Token). Nicht endlos puffern.
      if (!res.ok && res.status < 500) logError(dataDir, `Server lehnt ab: ${res.status} ${await res.text().catch(() => "")}`);
      else if (!res.ok) throw new Error(`Server-Fehler ${res.status}`);
      sent = i + events.length;
    }
  } finally {
    const rest = lines.slice(sent);
    if (rest.length) appendFileSync(queue, rest.map((l) => l + "\n").join(""));
    unlinkSync(sending);
  }
}
