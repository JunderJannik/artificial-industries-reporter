import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { map } from "../adapters/codex.mjs";

// Nachgebaut aus dem Codex-Test in Phase 0 (docs/phase0/codex.md), ohne echte Inhalte.
const ctx = (session = {}) => ({ now: "2026-10-27T15:00:00.000Z", project: { id: "abc", name: "fabrik" }, session, shared: {} });
const base = { session_id: "t1", cwd: "E:/x", model: "gpt-6-luna", permission_mode: "default" };

test("Shell-Befehle werden lokal eingeordnet, Inhalte nicht gesendet", () => {
  const s = {};
  const pre = map({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "e1", tool_input: { command: "$c = Get-Content -Raw 'GEHEIM.txt'; Set-Content -Path b.txt -Value $c" } }, ctx(s));
  const post = map({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "e1", tool_input: { command: "x" }, tool_response: "GEHEIM" }, ctx(s));
  assert.equal(pre[0].data.station, "werkbank");
  assert.equal(post[0].type, "tool.end");
  assert.equal(typeof post[0].data.durationMs, "number");
  assert.equal(s.starts.e1, undefined);
  assert.doesNotMatch(JSON.stringify([...pre, ...post]), /GEHEIM/);
});

test("Subagent-Spawn landet in der Rohrpost, Events des Subagenten tragen seine ID", () => {
  const spawn = map({ ...base, hook_event_name: "PreToolUse", tool_name: "collaborationspawn_agent", tool_use_id: "c1", tool_input: { message: "gAAAA" } }, ctx());
  assert.deepEqual(spawn[0].data, { tool: "spawn_agent", station: "rohrpost" });
  const start = map({ ...base, hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "default" }, ctx());
  assert.equal(start[0].agentId, "a1");
  assert.equal(start[0].sessionId, "t1");
});

test("Token kumulativ als Differenz, Cache aus der Eingabe herausgerechnet, Kontingent einmal", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-codex-"));
  const file = join(dir, "rollout.jsonl");
  const tc = (input, cached, output, pct) =>
    JSON.stringify({ type: "event_msg", payload: { type: "token_count",
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output } },
      rate_limits: { primary: { used_percent: pct, window_minutes: 300, resets_at: 1795704152 }, secondary: null, plan_type: "plus" } } }) + "\n";
  writeFileSync(file, JSON.stringify({ type: "session_meta", payload: {} }) + "\n" + tc(1000, 800, 50, 4) + tc(2000, 1500, 90, 4));
  const s = {};
  const first = map({ ...base, hook_event_name: "Stop", transcript_path: file }, ctx(s));
  assert.deepEqual(first.map((e) => e.type), ["usage", "quota", "idle"]);
  assert.deepEqual(first[0].data, { input: 500, output: 90, cacheRead: 1500, cacheWrite: 0, model: "gpt-6-luna" });
  assert.deepEqual(first[1].data, { usedPercent: 4, windowMinutes: 300, resetsAt: new Date(1795704152000).toISOString() });
  appendFileSync(file, tc(2600, 2000, 100, 4));
  const second = map({ ...base, hook_event_name: "SessionEnd", reason: "other", transcript_path: file }, ctx(s));
  assert.deepEqual(second.map((e) => e.type), ["usage", "session.end"]);
  assert.deepEqual(second[0].data, { input: 100, output: 10, cacheRead: 500, cacheWrite: 0, model: "gpt-6-luna" });
});

test("apply_patch: ein Werkstück pro Datei", () => {
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-alt\n+neu\n+mehr\n*** Add File: b.txt\n+eins\n*** End Patch";
  const out = map({ ...base, hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_use_id: "p1", tool_input: { input: patch } }, ctx({}));
  assert.deepEqual(out.filter((e) => e.type === "edit").map((e) => e.data), [{ plus: 2, minus: 1 }, { plus: 1, minus: 0 }]);
  assert.equal(out.at(-1).data.station, "werkbank");
});
