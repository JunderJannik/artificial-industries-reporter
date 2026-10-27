// Adapter für Cursor (Hooks aus ~/.cursor/hooks.json).
// Registriert werden nur Hooks ohne Rechteentscheidung, damit der Reporter nie etwas erlaubt oder verbietet.
import { createHash } from "node:crypto";
import { clip, lineDiff, makeEvent, stationForCommand, toolLabel } from "../core.mjs";

export const source = "cursor";

/** Cursor erwartet auf manche Hooks eine Antwort; `beforeSubmitPrompt` muss weiterlaufen dürfen. */
export const respond = (h) => (h?.hook_event_name === "beforeSubmitPrompt" ? JSON.stringify({ continue: true }) : "{}");

export const sessionIdOf = (h) => h.conversation_id;
export const isSessionEnd = (h) => h?.hook_event_name === "sessionEnd";

/** Cursor liefert Pfade wie "/E:/Projekt"; daraus wird "E:/Projekt". */
const normPath = (p) => (typeof p === "string" && /^\/[A-Za-z]:[\\/]/.test(p) ? p.slice(1) : p);
export const cwdOf = (h) => normPath(h.workspace_roots?.[0] || (typeof h.cwd === "string" && h.cwd) || ".");

export function stationForTool(name, input = {}) {
  switch (name) {
    case "Read": case "Grep": case "Glob": case "LS": case "SemanticSearch":
      return "archiv";
    case "Write": case "Edit": case "Delete": case "MultiEdit":
      return "werkbank";
    case "Shell":
      return stationForCommand(typeof input.command === "string" ? input.command : "");
    case "Task":
      return "rohrpost";
    case "WebSearch": case "WebFetch":
      return "funkturm";
    case "TodoWrite":
      return "pult";
  }
  if (name.startsWith("MCP:") || name.startsWith("mcp_")) return "lager";
  return "maschinenraum";
}

const label = (name) => (name.startsWith("MCP:") ? clip(`MCP: ${name.slice(4).split(/[_:]/)[0]}`) : toolLabel(name));

const SUB_PARENT_WINDOW_MS = 10 * 60_000;
const FORGET_MS = 24 * 60 * 60_000;

/**
 * Subagenten melden sich mit eigener conversation_id, aber ohne Verweis auf den Vorarbeiter.
 * Eine Unterhaltung ohne sessionStart und ohne Prompt gilt deshalb als Subagent der zuletzt
 * aktiven Hauptunterhaltung im selben Arbeitsbereich.
 */
function resolve(h, shared, nowMs) {
  const convs = (shared.convs ??= {});
  for (const [id, c] of Object.entries(convs)) if (nowMs - c.lastSeen > FORGET_MS) delete convs[id];
  const id = h.conversation_id;
  // Arbeitsbereich als Vergleichsschlüssel; Cursor schreibt Pfade mal mit / und mal mit \.
  const ws = String(normPath(h.workspace_roots?.[0] ?? h.cwd ?? "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const isMainSignal = h.hook_event_name === "sessionStart" || h.hook_event_name === "beforeSubmitPrompt";
  let c = convs[id];
  let fresh = false;
  if (!c) {
    fresh = true;
    if (isMainSignal) {
      c = { main: true, ws };
    } else {
      const parent = Object.entries(convs)
        .filter(([, p]) => p.main && p.ws === ws && nowMs - p.lastSeen < SUB_PARENT_WINDOW_MS)
        .sort((a, b) => b[1].lastSeen - a[1].lastSeen)[0];
      c = parent ? { main: false, parent: parent[0], ws } : { main: true, ws };
    }
    convs[id] = c;
  }
  c.lastSeen = nowMs;
  return { c, fresh, ids: c.main ? { sessionId: id } : { sessionId: c.parent, agentId: id } };
}

export function map(h, ctx) {
  const nowMs = Date.parse(ctx.now);
  const { c, fresh, ids } = resolve(h, ctx.shared, nowMs);
  const ev = (type, data, which = ids) => makeEvent(source, ctx, type, data, which);
  const tool = typeof h.tool_name === "string" ? h.tool_name : "";
  const model = h.model_id ?? h.model;
  const out = [];
  if (fresh && !c.main) out.push(ev("subagent.start", model ? { model: clip(model) } : {}));

  switch (h.hook_event_name) {
    case "sessionStart":
      out.push(ev("session.start", model ? { model: clip(model) } : {}));
      break;
    case "beforeSubmitPrompt":
      out.push(ev("prompt", {}));
      break;
    case "postToolUse":
    case "postToolUseFailure": {
      const ok = h.hook_event_name === "postToolUse";
      out.push(ev("tool.end", {
        tool: label(tool),
        station: stationForTool(tool, h.tool_input),
        ok,
        ...(typeof h.duration === "number" ? { durationMs: Math.max(0, Math.round(h.duration)) } : {}),
      }));
      // Das Task-Ergebnis nennt die Unterhaltung des Subagenten; die ID bleibt lokal.
      if (ok && tool === "Task") {
        let agentId;
        try { agentId = JSON.parse(h.tool_output)?.agentId; } catch {}
        if (agentId && ctx.shared.convs[agentId] && !ctx.shared.convs[agentId].ended) {
          ctx.shared.convs[agentId].ended = true;
          out.push(makeEvent(source, ctx, "subagent.end", { status: "completed" }, { sessionId: h.conversation_id, agentId }));
        }
      }
      break;
    }
    case "afterFileEdit": {
      const d = (Array.isArray(h.edits) ? h.edits : []).reduce((acc, e) => {
        const x = lineDiff(e?.old_string, e?.new_string);
        return { plus: acc.plus + x.plus, minus: acc.minus + x.minus };
      }, { plus: 0, minus: 0 });
      if (d.plus + d.minus > 0) out.push(ev("edit", d));
      break;
    }
    case "subagentStop": {
      // Kommt beim Vorarbeiter an; beendet dessen jüngsten noch offenen Subagenten.
      const open = Object.entries(ctx.shared.convs).filter(([, x]) => x.parent === h.conversation_id && !x.ended).sort((a, b) => b[1].lastSeen - a[1].lastSeen)[0];
      if (open) {
        open[1].ended = true;
        out.push(makeEvent(source, ctx, "subagent.end", { status: clip(h.status ?? "completed") }, { sessionId: h.conversation_id, agentId: open[0] }));
      }
      break;
    }
    case "afterAgentThought": {
      // Cursor meldet jeden Gedanken doppelt, die Kopien unterscheiden sich nur in generation_id und model_params.
      const key = createHash("sha1").update(`${h.duration_ms}|${h.text ?? ""}`).digest("hex").slice(0, 16);
      if (c.lastThought === key) break;
      c.lastThought = key;
      out.push(ev("thinking", typeof h.duration_ms === "number" ? { durationMs: Math.max(0, Math.round(h.duration_ms)) } : {}));
      break;
    }
    case "stop": {
      if (typeof h.input_tokens === "number") {
        const cacheRead = h.cache_read_tokens ?? 0;
        // Gecachte Token sind in input_tokens enthalten (56 718 Eingabe, davon 46 208 aus dem Cache).
        out.push(ev("usage", {
          input: Math.max(0, h.input_tokens - cacheRead),
          output: Math.max(0, h.output_tokens ?? 0),
          cacheRead: Math.max(0, cacheRead),
          cacheWrite: Math.max(0, h.cache_write_tokens ?? 0),
          ...(model ? { model: clip(model) } : {}),
        }));
      }
      if (h.status === "error") out.push(ev("error", { kind: "error" }));
      out.push(ev("idle", { background: 0 }));
      break;
    }
    case "sessionEnd":
      out.push(ev("session.end", h.reason ? { reason: clip(h.reason) } : {}));
      break;
  }
  return out;
}
