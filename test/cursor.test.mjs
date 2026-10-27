import { test } from "node:test";
import assert from "node:assert/strict";
import { map, respond } from "../adapters/cursor.mjs";

// Nachgebaut aus dem Cursor-Test in Phase 0 (docs/phase0/cursor.md), ohne echte Inhalte.
const WS = ["/E:/Projekte/fabrik"];
const common = { cursor_version: "3.17.8", workspace_roots: WS, user_email: "geheim@example.com", model: "cursor-grok-4.6-medium", model_id: "grok-4.6", transcript_path: null };
let t = 0;
const run = (shared, h) => map({ ...common, ...h }, { now: new Date(Date.parse("2026-10-27T15:00:00Z") + (t += 1000)).toISOString(), project: { id: "abc", name: "fabrik" }, session: {}, shared });

test("Antworten blockieren nie: Prompt läuft weiter, sonst leere Antwort", () => {
  assert.deepEqual(JSON.parse(respond({ hook_event_name: "beforeSubmitPrompt" })), { continue: true });
  assert.equal(respond({ hook_event_name: "postToolUse" }), "{}");
  assert.equal(respond(null), "{}");
});

test("Ablauf mit Subagent: Zuordnung, Dauer, Token, keine E-Mail", () => {
  const shared = {};
  const all = [
    ...run(shared, { hook_event_name: "sessionStart", conversation_id: "K0", session_id: "K0", composer_mode: "agent" }),
    ...run(shared, { hook_event_name: "beforeSubmitPrompt", conversation_id: "K0", prompt: "GEHEIM" }),
    ...run(shared, { hook_event_name: "postToolUse", conversation_id: "K0", tool_name: "Read", tool_input: { file_path: "GEHEIM" }, tool_output: "GEHEIM", duration: 416.3, cwd: "E:\\Projekte\\fabrik" }),
    // Erstes Ereignis des Subagenten: eigene Unterhaltung ohne sessionStart
    ...run(shared, { hook_event_name: "afterAgentThought", conversation_id: "K1", text: "GEHEIM", duration_ms: 1365, generation_id: "" }),
    ...run(shared, { hook_event_name: "afterAgentThought", conversation_id: "K1", text: "GEHEIM", duration_ms: 1365, generation_id: "g1" }),
    ...run(shared, { hook_event_name: "postToolUse", conversation_id: "K1", tool_name: "Shell", tool_input: { command: "Get-ChildItem" }, tool_output: "{}", duration: 13.4, cwd: "" }),
    ...run(shared, { hook_event_name: "postToolUse", conversation_id: "K0", tool_name: "Task", tool_input: {}, tool_output: JSON.stringify({ status: "success", agentId: "K1" }), duration: 23214 }),
    ...run(shared, { hook_event_name: "subagentStop", conversation_id: "K0", subagent_type: "explore", status: "completed" }),
    ...run(shared, { hook_event_name: "stop", conversation_id: "K0", status: "completed", input_tokens: 56718, output_tokens: 1109, cache_read_tokens: 46208, cache_write_tokens: 0 }),
  ];
  assert.doesNotMatch(JSON.stringify(all), /GEHEIM|geheim@example/);
  assert.deepEqual(all.map((e) => `${e.type}:${e.agentId ?? "-"}`), [
    "session.start:-", "prompt:-", "tool.end:-",
    "subagent.start:K1", "thinking:K1", "tool.end:K1",
    "tool.end:-", "subagent.end:K1",
    "usage:-", "idle:-",
  ]);
  assert.ok(all.every((e) => e.sessionId === "K0"));
  assert.deepEqual(all[2].data, { tool: "Read", station: "archiv", ok: true, durationMs: 416 });
  assert.equal(all[5].data.station, "archiv");
  assert.deepEqual(all[8].data, { input: 10510, output: 1109, cacheRead: 46208, cacheWrite: 0, model: "grok-4.6" });
});

test("afterFileEdit zählt Zeilen", () => {
  const out = run({}, { hook_event_name: "afterFileEdit", conversation_id: "K9", file_path: "GEHEIM", edits: [{ old_string: "", new_string: "a\nb" }, { old_string: "x", new_string: "y" }] });
  const edit = out.find((e) => e.type === "edit");
  assert.deepEqual(edit.data, { plus: 3, minus: 1 });
  assert.doesNotMatch(JSON.stringify(out), /GEHEIM/);
});
