// Adapter für die Codex CLI (Hooks aus ~/.codex/hooks.json bzw. dem Codex-Plugin).
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { clip, makeEvent, patchFiles, stationForCommand, toolLabel } from "../core.mjs";

export const source = "codex";

export const sessionIdOf = (h) => h.session_id;
export const cwdOf = (h) => h.cwd;
export const isSessionEnd = (h) => h?.hook_event_name === "SessionEnd";

export function stationForTool(name, input = {}) {
  if (name === "Bash" || name === "shell" || name === "exec_command") {
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
    return stationForCommand(cmd);
  }
  if (name === "apply_patch" || name === "Edit" || name === "Write") return "werkbank";
  if (/spawn_agent|send_input|wait_agent|close_agent/.test(name)) return "rohrpost";
  if (name === "update_plan") return "pult";
  if (name === "view_image") return "archiv";
  if (name === "web_search") return "funkturm";
  if (name.startsWith("mcp__")) return "lager";
  return "maschinenraum";
}

/** Codex nennt das Subagent-Tool z. B. `collaborationspawn_agent`; angezeigt wird ein lesbarer Name. */
const label = (name) => (/spawn_agent/.test(name) ? "spawn_agent" : toolLabel(name));

/**
 * Liest das Rollout-Log ab `cursor.offset` und merkt sich die jüngste token_count-Meldung.
 * Codex zählt kumulativ; die Differenz zum letzten gemeldeten Stand ergibt die neuen Token.
 */
export function readRollout(path, cursor) {
  if (!path || !existsSync(path)) return { usage: null, quota: null };
  const fd = openSync(path, "r");
  let last = cursor.last ?? null;
  let quota = null;
  try {
    const size = fstatSync(fd).size;
    if (size < (cursor.offset ?? 0)) cursor.offset = 0;
    const start = cursor.offset ?? 0;
    if (size > start) {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      const lastNl = buf.lastIndexOf(10);
      if (lastNl >= 0) {
        cursor.offset = start + lastNl + 1;
        for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
          if (!line.includes('"token_count"')) continue;
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          const p = row?.payload;
          if (p?.type !== "token_count") continue;
          if (p.info?.total_token_usage) last = p.info.total_token_usage;
          if (p.rate_limits?.primary) quota = p.rate_limits.primary;
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  if (!last) return { usage: null, quota };
  const prev = cursor.reported ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, cache_write_input_tokens: 0 };
  cursor.last = last;
  cursor.reported = last;
  const d = (k) => Math.max(0, (last[k] ?? 0) - (prev[k] ?? 0));
  const cached = d("cached_input_tokens");
  // Bei Codex sind gecachte Token in input_tokens enthalten.
  const usage = { input: Math.max(0, d("input_tokens") - cached), output: d("output_tokens"), cacheRead: cached, cacheWrite: d("cache_write_input_tokens") };
  return { usage: usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : null, quota };
}

/** Den Patch-Text aus der Tool-Eingabe holen, egal wie Codex ihn verpackt. */
function patchText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  for (const v of Object.values(input)) {
    if (typeof v === "string" && /\*\*\* Begin Patch|^@@/m.test(v)) return v;
    if (Array.isArray(v)) {
      const s = v.find((x) => typeof x === "string" && x.includes("*** Begin Patch"));
      if (s) return s;
    }
  }
  return "";
}

export function map(h, ctx) {
  const ids = { sessionId: h.session_id, agentId: h.agent_id };
  const main = { sessionId: h.session_id };
  const ev = (type, data, which = ids) => makeEvent(source, ctx, type, data, which);
  const tool = typeof h.tool_name === "string" ? h.tool_name : "";
  const s = ctx.session;

  const usage = (path, key, which) => {
    const { usage: u, quota } = readRollout(path, ((s.cursors ??= {})[key] ??= {}));
    const out = [];
    if (u) out.push(ev("usage", { ...u, ...(h.model ? { model: clip(h.model) } : {}) }, which));
    if (quota && typeof quota.used_percent === "number") {
      const q = {
        usedPercent: Math.min(100, Math.max(0, quota.used_percent)),
        windowMinutes: Math.max(0, Math.round(quota.window_minutes ?? 0)),
        ...(quota.resets_at ? { resetsAt: new Date(quota.resets_at * 1000).toISOString() } : {}),
      };
      if (JSON.stringify(q) !== JSON.stringify(s.quota)) {
        s.quota = q;
        out.push(ev("quota", q, main));
      }
    }
    return out;
  };

  switch (h.hook_event_name) {
    case "SessionStart":
      return [ev("session.start", h.model ? { model: clip(h.model) } : {}, main)];
    case "UserPromptSubmit":
      return [ev("prompt", {}, ids)];
    case "PreToolUse":
      (s.starts ??= {})[h.tool_use_id] = Date.now();
      return [ev("tool.start", { tool: label(tool), station: stationForTool(tool, h.tool_input) })];
    case "PostToolUse": {
      const started = s.starts?.[h.tool_use_id];
      if (started) delete s.starts[h.tool_use_id];
      const failed = h.tool_response && typeof h.tool_response === "object" && (h.tool_response.success === false || h.tool_response.exit_code > 0);
      const edits = /^(apply_patch|Edit|Write)$/.test(tool) ? patchFiles(patchText(h.tool_input)).filter((d) => d.plus + d.minus > 0) : [];
      return [...edits.map((d) => ev("edit", d)), ev("tool.end", {
        tool: label(tool),
        station: stationForTool(tool, h.tool_input),
        ok: !failed,
        ...(started ? { durationMs: Math.max(0, Date.now() - started) } : {}),
      })];
    }
    case "PermissionRequest":
      return [ev("waiting", { reason: "freigabe" })];
    case "SubagentStart":
      return [ev("subagent.start", { ...(h.agent_type ? { agentType: clip(h.agent_type) } : {}), ...(h.model ? { model: clip(h.model) } : {}) })];
    case "SubagentStop":
      return [...usage(h.agent_transcript_path, `agent:${h.agent_id}`, ids), ev("subagent.end", {})];
    case "Stop":
    case "Interrupt":
      return [...usage(h.transcript_path, "main", main), ev("idle", { background: 0 }, main)];
    case "SessionEnd":
      return [...usage(h.transcript_path, "main", main), ev("session.end", h.reason ? { reason: clip(h.reason) } : {}, main)];
  }
  return [];
}
