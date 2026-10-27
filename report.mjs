#!/usr/bin/env node
// Wird von jedem Hook kurz gestartet: `node report.mjs <claude|codex|cursor>`.
// Übersetzen, puffern, senden, beenden. Darf das Tool nie stören: Fehler landen nur in
// reporter.log, der Exit-Code ist immer 0, und Antworten auf stdout kommen zuerst.
import { join } from "node:path";
import { HOME_DIR, enqueue, flush, loadConfig, logError, projectOf, readJson, withLock, writeJson } from "./core.mjs";
import { unlinkSync, mkdirSync } from "node:fs";
import * as claude from "./adapters/claude.mjs";
import * as codex from "./adapters/codex.mjs";
import * as cursor from "./adapters/cursor.mjs";

const ADAPTERS = { claude, codex, cursor };
const name = process.argv[2] ?? "claude";
const adapter = ADAPTERS[name];
const DATA = process.env.CLAUDE_PLUGIN_DATA || process.env.PLUGIN_DATA || join(HOME_DIR, "data", name);

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

async function main() {
  const hook = await readStdin();
  // Manche Tools (Cursor) erwarten eine Antwort; sie kommt vor allem anderen, auch bei Fehlern.
  if (adapter?.respond) process.stdout.write(adapter.respond(hook));
  if (!adapter || !hook) return;

  mkdirSync(DATA, { recursive: true });
  const cfg = loadConfig(DATA);
  if (!cfg.url || !cfg.token) return;

  const project = projectOf(adapter.cwdOf(hook));
  if (cfg.hidden.includes(project.name.toLowerCase())) return;

  const sessionId = String(adapter.sessionIdOf(hook) ?? "unbekannt").replace(/[^\w-]/g, "_");
  const sessionFile = join(DATA, `session-${sessionId}.json`);
  const sharedFile = join(DATA, "shared.json");
  const ctx = () => ({
    now: new Date().toISOString(),
    project,
    session: readJson(sessionFile, {}),
    shared: readJson(sharedFile, {}),
  });

  const done = await withLock(DATA, async () => {
    const c = ctx();
    const events = adapter.map(hook, c);
    if (adapter.isSessionEnd?.(hook)) {
      try { unlinkSync(sessionFile); } catch {}
    } else {
      writeJson(sessionFile, c.session);
    }
    writeJson(sharedFile, c.shared);
    enqueue(DATA, events);
    await flush(DATA, cfg);
    return true;
  }, adapter.isSessionEnd?.(hook) ? 800 : 4_000);

  if (!done) {
    // Sperre belegt (z. B. Server langsam): Ereignis trotzdem puffern. Token ohne gespeicherten
    // Lese-Cursor würden doppelt gezählt, sie folgen beim nächsten Hook.
    enqueue(DATA, adapter.map(hook, ctx()).filter((e) => e.type !== "usage" && e.type !== "quota"));
  }
}

main()
  .catch((err) => logError(DATA, err))
  .finally(() => process.exit(0));

