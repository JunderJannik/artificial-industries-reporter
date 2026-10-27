import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { map, updateTodos } from "../adapters/claude.mjs";
import { stationForCommand, toolLabel } from "../core.mjs";

const ctx = () => ({ now: "2026-10-27T15:00:00.000Z", project: { id: "abc", name: "fabrik" }, session: {}, shared: {} });

test("Prompt und Befehle verlassen den Rechner nicht", () => {
  const out = [
    ...map({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "GEHEIM" }, ctx()),
    ...map({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "echo GEHEIM" } }, ctx()),
    ...map({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Write", tool_input: { file_path: "C:/GEHEIM.txt", content: "GEHEIM" }, tool_response: "GEHEIM", duration_ms: 25 }, ctx()),
  ];
  assert.deepEqual(out.map((e) => e.type), ["prompt", "tool.start", "edit", "tool.end"]);
  assert.doesNotMatch(JSON.stringify(out), /GEHEIM/);
  assert.deepEqual(out[3].data, { tool: "Write", station: "werkbank", ok: true, durationMs: 25 });
});

test("Subagent-Rückmeldung ist kein neuer Auftrag", () => {
  assert.deepEqual(map({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: '<agent-message from="a1">x' }, ctx()), []);
});

test("Shell-Befehle werden lokal einer Station zugeordnet", () => {
  assert.equal(stationForCommand("npm test"), "pruefstand");
  assert.equal(stationForCommand("Get-Content a.txt"), "archiv");
  assert.equal(stationForCommand("rm -rf build"), "maschinenraum");
  assert.equal(stationForCommand("$c = Get-Content -Raw a.txt; Set-Content -Path b.txt -Value $c"), "werkbank");
  assert.equal(stationForCommand('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-ChildItem -Force"'), "archiv");
  assert.equal(toolLabel("mcp__github__create_issue"), "MCP: github");
});

test("Interne App-Tools erzeugen keine Stationsarbeit, aber Aufgaben", () => {
  const c = ctx();
  const a = map({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "mcp__ccd_turn__update_plan", tool_input: { items: [{ status: "in_progress" }, { status: "pending" }] } }, c);
  assert.deepEqual(a.map((e) => e.type), ["todo"]);
  const b = map({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "mcp__ccd_turn__update_plan", tool_input: { advance: true } }, c);
  assert.deepEqual(b[0].data, { total: 2, done: 1 });
  assert.equal(updateTodos({}, "Read", {}), null);
});

test("Token zählen pro message.id nur einmal und nur neue Zeilen", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-rep-"));
  const file = join(dir, "t.jsonl");
  const row = (id, out) => JSON.stringify({ type: "assistant", message: { id, model: "opus", usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } }) + "\n";
  writeFileSync(file, row("m1", 5) + row("m1", 5) + row("m2", 7));
  const c = ctx();
  const first = map({ hook_event_name: "Stop", session_id: "s", transcript_path: file, background_tasks: [] }, c);
  assert.deepEqual(first[0].data, { input: 2, output: 12, cacheRead: 20, cacheWrite: 0, model: "opus" });
  assert.deepEqual(first[1].data, { background: 0 });
  appendFileSync(file, row("m2", 7) + row("m3", 1));
  const second = map({ hook_event_name: "Stop", session_id: "s", transcript_path: file, background_tasks: [{ status: "running" }] }, c);
  assert.equal(second[0].data.output, 1);
  assert.deepEqual(second[1].data, { background: 1 });
});

test("Test-Path ist kein Testlauf", () => {
  assert.equal(stationForCommand("Get-ChildItem -Force; if (Test-Path b.txt) { Get-Content b.txt }"), "archiv");
});

test("Werkstücke: Zeilen zählen ohne Inhalte zu senden", () => {
  const edit = map({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Edit", tool_input: { file_path: "GEHEIM", old_string: "a\nb\nc", new_string: "a\nB\nX\nc" } }, ctx());
  assert.deepEqual(edit[0], { ...edit[0], type: "edit", data: { plus: 2, minus: 1 } });
  const patched = map({ hook_event_name: "PostToolUse", session_id: "s", tool_name: "Write", tool_input: { content: "GEHEIM" }, tool_response: { structuredPatch: [{ lines: [" x", "-y", "+z", "+w"] }] } }, ctx());
  assert.deepEqual(patched[0].data, { plus: 2, minus: 1 });
  assert.doesNotMatch(JSON.stringify([...edit, ...patched]), /GEHEIM/);
});
