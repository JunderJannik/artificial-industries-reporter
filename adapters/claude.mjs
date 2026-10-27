// Adapter für Claude Code (Hooks aus dem Plugin, siehe hooks/hooks.json).
import { existsSync, openSync, readSync, fstatSync, closeSync } from "node:fs";
import { clip, lineDiff, makeEvent, stationForCommand, toolLabel } from "../core.mjs";

export const source = "claude-code";

export function stationForTool(name, input = {}) {
  switch (name) {
    case "Read": case "Grep": case "Glob": case "LS": case "NotebookRead":
      return "archiv";
    case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      return "werkbank";
    case "Bash": case "PowerShell":
      return stationForCommand(typeof input.command === "string" ? input.command : "");
    case "WebFetch": case "WebSearch":
      return "funkturm";
    case "Agent": case "Task": case "SubagentHandback": case "SendMessage":
      return "rohrpost";
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": case "TaskList": case "TaskGet": case "ExitPlanMode":
      return "pult";
  }
  if (name.startsWith("mcp__")) return "lager";
  return "maschinenraum";
}

/** Zeilen +/− einer Dateibearbeitung; bevorzugt aus dem Patch, den Claude Code mitliefert. */
export function editCounts(tool, input = {}, response) {
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return null;
  const hunks = response && typeof response === "object" ? response.structuredPatch : undefined;
  if (Array.isArray(hunks) && hunks.length) {
    let plus = 0, minus = 0;
    for (const h of hunks) for (const l of h?.lines ?? []) {
      if (typeof l !== "string") continue;
      if (l.startsWith("+")) plus++;
      else if (l.startsWith("-")) minus++;
    }
    return { plus, minus };
  }
  if (tool === "Edit") return lineDiff(input.old_string, input.new_string);
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    return input.edits.reduce((acc, e) => {
      const d = lineDiff(e?.old_string, e?.new_string);
      return { plus: acc.plus + d.plus, minus: acc.minus + d.minus };
    }, { plus: 0, minus: 0 });
  }
  return lineDiff("", input.content);
}

/** Werkzeuge der Claude-Desktop-App, die keine Arbeit an einer Station sind. */
export const isAppInternal = (name) => name.startsWith("mcp__ccd_");

export const sessionIdOf = (h) => h.session_id;
export const cwdOf = (h) => h.cwd;

/** Zählt Aufgaben aus TodoWrite / TaskCreate bzw. der Desktop-Aufgabenliste mit. */
export function updateTodos(plan, toolName, input = {}) {
  const items = plan.items ?? [];
  if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
    plan.items = input.todos.map((t) => t?.status ?? "pending");
  } else if (toolName === "mcp__ccd_turn__update_plan") {
    if (Array.isArray(input.items)) {
      plan.items = input.items.map((t) => t?.status ?? "pending");
    } else if (input.advance) {
      const i = items.indexOf("in_progress");
      if (i >= 0) items[i] = "completed";
      const next = items.indexOf("pending");
      if (next >= 0) items[next] = "in_progress";
    } else {
      for (const d of input.done ?? []) if (items[d - 1]) items[d - 1] = "completed";
      if (input.start && items[input.start - 1]) items[input.start - 1] = "in_progress";
    }
  } else if (toolName === "mcp__ccd_turn__wrap_up") {
    plan.items = items.map(() => "completed");
  } else if (toolName === "TaskCreate") {
    plan.items = [...items, "pending"];
  } else {
    return null;
  }
  const list = plan.items ?? [];
  return { total: list.length, done: list.filter((s) => s === "completed").length };
}

/**
 * Liest neue Zeilen eines Session-Logs ab `cursor.offset` und summiert die Token.
 * Eine Antwort steht oft in mehreren Zeilen mit gleicher message.id, sie zählt nur einmal.
 */
export function readUsage(path, cursor) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: undefined };
  if (!path || !existsSync(path)) return out;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < (cursor.offset ?? 0)) cursor.offset = 0;
    const start = cursor.offset ?? 0;
    if (size === start) return out;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < 0) return out;
    cursor.offset = start + lastNl + 1;
    const seen = new Set(cursor.seen ?? []);
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const msg = row?.message;
      if (row?.type !== "assistant" || !msg?.usage) continue;
      if (msg.id) {
        if (seen.has(msg.id)) continue;
        seen.add(msg.id);
      }
      const u = msg.usage;
      out.input += u.input_tokens ?? 0;
      out.output += u.output_tokens ?? 0;
      out.cacheRead += u.cache_read_input_tokens ?? 0;
      out.cacheWrite += u.cache_creation_input_tokens ?? 0;
      if (msg.model) out.model = clip(msg.model);
    }
    cursor.seen = [...seen].slice(-500);
  } finally {
    closeSync(fd);
  }
  return out;
}

/** Übersetzt ein Hook-Ereignis in null, ein oder mehrere Fabrik-Ereignisse. */
export function map(h, ctx) {
  const ids = { sessionId: h.session_id, agentId: h.agent_id };
  const main = { sessionId: h.session_id };
  const ev = (type, data, which = ids) => makeEvent(source, ctx, type, data, which);
  const usage = (path, key, which) => {
    const u = readUsage(path, (ctx.session.cursors ??= {})[key] ??= {});
    if (u.input + u.output + u.cacheRead + u.cacheWrite === 0) return [];
    const { model, ...counts } = u;
    return [ev("usage", { ...counts, ...(model ? { model } : {}) }, which)];
  };
  const tool = typeof h.tool_name === "string" ? h.tool_name : "";

  switch (h.hook_event_name) {
    case "SessionStart":
      return [ev("session.start", h.model ? { model: clip(h.model) } : {})];
    case "UserPromptSubmit":
      // Rückmeldungen von Subagenten kommen als Prompt, sind aber kein neuer Auftrag.
      if (typeof h.prompt === "string" && h.prompt.trimStart().startsWith("<agent-message")) return [];
      return [ev("prompt", {})];
    case "PreToolUse":
      if (isAppInternal(tool)) return [];
      return [ev("tool.start", { tool: toolLabel(tool), station: stationForTool(tool, h.tool_input) })];
    case "PostToolUse":
    case "PostToolUseFailure": {
      const events = [];
      const todo = updateTodos((ctx.session.plan ??= {}), tool, h.tool_input);
      if (todo) events.push(ev("todo", todo));
      const edit = h.hook_event_name === "PostToolUse" ? editCounts(tool, h.tool_input, h.tool_response) : null;
      if (edit) events.push(ev("edit", edit));
      if (!isAppInternal(tool)) {
        events.push(ev("tool.end", {
          tool: toolLabel(tool),
          station: stationForTool(tool, h.tool_input),
          ok: h.hook_event_name === "PostToolUse",
          ...(typeof h.duration_ms === "number" ? { durationMs: Math.max(0, Math.round(h.duration_ms)) } : {}),
        }));
      }
      return events;
    }
    case "PermissionRequest":
      return [ev("waiting", { reason: "freigabe" })];
    case "Notification":
      if (h.notification_type === "permission_prompt") return [ev("waiting", { reason: "freigabe" })];
      if (["idle_prompt", "agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"].includes(h.notification_type))
        return [ev("waiting", { reason: "eingabe" })];
      return [];
    case "SubagentStart":
      return [ev("subagent.start", h.agent_type ? { agentType: clip(h.agent_type) } : {})];
    case "SubagentStop":
      return [...usage(h.agent_transcript_path, `agent:${h.agent_id}`, ids), ev("subagent.end", {})];
    case "Stop": {
      const running = Array.isArray(h.background_tasks) ? h.background_tasks.filter((t) => t?.status === "running").length : 0;
      return [...usage(h.transcript_path, "main", main), ev("idle", { background: running }, main)];
    }
    case "StopFailure":
      return [ev("error", { kind: clip(h.error ?? "unknown") }, main)];
    case "SessionEnd":
      return [...usage(h.transcript_path, "main", main), ev("session.end", h.reason ? { reason: clip(h.reason) } : {}, main)];
  }
  return [];
}

export const isSessionEnd = (h) => h?.hook_event_name === "SessionEnd";
