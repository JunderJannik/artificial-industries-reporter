#!/usr/bin/env node
// Richtet den Reporter für Claude Code, Codex und Cursor ein (oder entfernt ihn wieder).
//
//   node setup.mjs --server <adresse> --token <token> [--tools claude,codex,cursor] [--dry-run]
//   node setup.mjs --status
//   node setup.mjs --uninstall
//
// Bestehende Konfigurationsdateien werden vor jeder Änderung gesichert (*.bak-<zeit>).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR, readJson, writeJson } from "./core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = join(HOME_DIR, "reporter");
const MARKETPLACE = "artificial-industries";
const PLUGIN_ID = `artificial-industries-reporter@${MARKETPLACE}`;
const MARK = "artificial-industries";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const dry = flag("dry-run");
const log = (msg) => console.log(msg);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const CODEX_EVENTS = { SessionStart: true, UserPromptSubmit: true, PreToolUse: true, PostToolUse: true, PermissionRequest: true, SubagentStart: true, SubagentStop: true, Stop: true, Interrupt: false, SessionEnd: false };
const CURSOR_EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "afterFileEdit", "subagentStop", "afterAgentThought", "stop"];

// ---------- Werkzeuge finden ----------

function which(cmd) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: ["ignore", "pipe", "ignore"] }).toString();
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

/** Claude-Code-CLI: im PATH oder die Version, die in der Claude-Desktop-App steckt (neueste zuerst). */
function findClaude() {
  const onPath = which("claude");
  if (onPath) return onPath;
  const roots = [
    join(process.env.APPDATA ?? "", "Claude", "claude-code"),
    join(homedir(), "Library", "Application Support", "Claude", "claude-code"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const found = [];
    for (const ver of readdirSync(root)) {
      const verDir = join(root, ver);
      if (!statSync(verDir).isDirectory()) continue;
      for (const build of readdirSync(verDir)) {
        for (const exe of ["claude.exe", "claude"]) {
          const p = join(verDir, build, exe);
          if (existsSync(p)) found.push({ p, t: statSync(p).mtimeMs });
        }
      }
    }
    found.sort((a, b) => b.t - a.t);
    if (found[0]) return found[0].p;
  }
  return undefined;
}

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
const cursorHome = () => join(homedir(), ".cursor");

function detect() {
  return {
    claude: findClaude(),
    codex: existsSync(codexHome()) || Boolean(which("codex")),
    cursor: existsSync(cursorHome()),
  };
}

// ---------- Hilfen ----------

function backupAndWrite(path, value) {
  if (dry) return log(`  (Probelauf) würde schreiben: ${path}`);
  if (existsSync(path)) cpSync(path, `${path}.bak-${stamp}`);
  writeJson(path, value);
}

const reportCmd = (adapter) => `node "${join(INSTALL_DIR, "report.mjs")}" ${adapter}`;

/**
 * Cursor startet Hooks unter Windows über PowerShell im Ordner ~/.cursor. Anführungszeichen können
 * dabei verloren gehen, und Benutzerordner enthalten oft Leerzeichen. Deshalb ein relativer Pfad
 * ohne Leerzeichen, wenn möglich.
 */
function cursorCmd() {
  const rel = relative(cursorHome(), join(INSTALL_DIR, "report.mjs")).replace(/\\/g, "/");
  return /\s/.test(rel) ? reportCmd("cursor") : `node ${rel} cursor`;
}
const isOurs = (h) => typeof h?.command === "string" && h.command.includes(MARK);

/** Entfernt eigene Einträge aus einer Hook-Liste; bei Codex stecken Befehle in Gruppen. */
function stripOurs(hooks, grouped) {
  const out = {};
  for (const [event, list] of Object.entries(hooks ?? {})) {
    const kept = grouped
      ? list.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length)
      : list.filter((h) => !isOurs(h));
    if (kept.length) out[event] = kept;
  }
  return out;
}

function runClaude(exe, cliArgs, allowFail = false) {
  if (dry) return log(`  (Probelauf) claude ${cliArgs.join(" ")}`), "";
  try {
    return execFileSync(exe, cliArgs, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (err) {
    if (allowFail) return "";
    throw new Error(`claude ${cliArgs.slice(0, 3).join(" ")} fehlgeschlagen: ${err.stderr?.toString() || err.message}`);
  }
}

// ---------- Einrichten ----------

function installFiles(server, token) {
  if (dry) return log(`  (Probelauf) würde den Reporter nach ${INSTALL_DIR} kopieren`);
  if (HERE !== INSTALL_DIR) {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    for (const part of [".claude-plugin", "adapters", "hooks", "core.mjs", "report.mjs", "setup.mjs", "package.json", "SETUP.md"]) {
      if (existsSync(join(HERE, part))) cpSync(join(HERE, part), join(INSTALL_DIR, part), { recursive: true });
    }
  }
  writeJson(join(HOME_DIR, "config.json"), { server_url: server.replace(/\/+$/, ""), token });
}

function setupClaude(exe, server, token) {
  runClaude(exe, ["plugin", "uninstall", PLUGIN_ID], true);
  runClaude(exe, ["plugin", "marketplace", "remove", MARKETPLACE], true);
  runClaude(exe, ["plugin", "marketplace", "add", INSTALL_DIR]);
  runClaude(exe, ["plugin", "install", PLUGIN_ID, "--config", `server_url=${server}`, "--config", `token=${token}`]);
  log("✓ Claude Code: Plugin installiert. Wirkt ab der nächsten neuen Session.");
}

function setupCodex() {
  const path = join(codexHome(), "hooks.json");
  const cfg = readJson(path, {});
  const hooks = stripOurs(cfg.hooks, true);
  for (const [event, async] of Object.entries(CODEX_EVENTS)) {
    const entry = { type: "command", command: reportCmd("codex"), ...(async ? { async: true, timeout: 15 } : { timeout: 3 }) };
    (hooks[event] ??= []).push({ hooks: [entry] });
  }
  backupAndWrite(path, { ...cfg, hooks });
  log(`✓ Codex: Hooks in ${path} eingetragen.`);
  log("  ⚠ Wichtig: In Codex einmal /hooks aufrufen und die Hooks von Artificial Industries freigeben.");
}

function setupCursor() {
  const path = join(cursorHome(), "hooks.json");
  const cfg = readJson(path, { version: 1 });
  const hooks = stripOurs(cfg.hooks, false);
  for (const event of CURSOR_EVENTS) (hooks[event] ??= []).push({ command: cursorCmd(), timeout: 10 });
  backupAndWrite(path, { version: cfg.version ?? 1, ...cfg, hooks });
  log(`✓ Cursor: Hooks in ${path} eingetragen. Cursor lädt sie beim Speichern neu.`);
}

async function checkToken(server, token) {
  try {
    const res = await fetch(`${server.replace(/\/+$/, "")}/api/reporter/check`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (res.ok) return { ok: true, user: (await res.json()).user };
    return { ok: false, reason: res.status === 401 ? "Token unbekannt" : `Server antwortet mit ${res.status}` };
  } catch (err) {
    return { ok: false, reason: `Server nicht erreichbar (${err.message})` };
  }
}

async function install() {
  const server = opt("server");
  const token = opt("token");
  if (!server || !token) {
    log("Aufruf: node setup.mjs --server <adresse> --token <token> [--tools claude,codex,cursor] [--dry-run]");
    process.exitCode = 1;
    return;
  }
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) throw new Error(`Node ${process.versions.node} ist zu alt, nötig ist mindestens 18.`);

  const check = await checkToken(server, token);
  if (!check.ok) throw new Error(`Verbindung zur Fabrik fehlgeschlagen: ${check.reason}. Nichts wurde verändert.`);
  log(`✓ Fabrik erreichbar, Token gehört zu Werk „${check.user}“.`);

  const found = detect();
  const wanted = (opt("tools") ?? "claude,codex,cursor").split(",").map((s) => s.trim());
  installFiles(server, token);
  log(`✓ Reporter liegt in ${INSTALL_DIR}`);

  for (const tool of wanted) {
    if (tool === "claude") {
      if (found.claude) setupClaude(found.claude, server, token);
      else log("– Claude Code nicht gefunden, übersprungen.");
    } else if (tool === "codex") {
      if (found.codex) setupCodex();
      else log("– Codex nicht gefunden, übersprungen.");
    } else if (tool === "cursor") {
      if (found.cursor) setupCursor();
      else log("– Cursor nicht gefunden, übersprungen.");
    }
  }
  log("\nFertig. Neue Sessions erscheinen jetzt in der Fabrik.");
}

function uninstall() {
  const found = detect();
  if (found.claude) {
    runClaude(found.claude, ["plugin", "uninstall", PLUGIN_ID], true);
    runClaude(found.claude, ["plugin", "marketplace", "remove", MARKETPLACE], true);
    log("✓ Claude Code: Plugin entfernt.");
  }
  for (const [path, grouped] of [[join(codexHome(), "hooks.json"), true], [join(cursorHome(), "hooks.json"), false]]) {
    if (!existsSync(path)) continue;
    const cfg = readJson(path, {});
    const hooks = stripOurs(cfg.hooks, grouped);
    if (JSON.stringify(hooks) === JSON.stringify(cfg.hooks ?? {})) continue;
    backupAndWrite(path, { ...cfg, hooks });
    log(`✓ Hooks aus ${path} entfernt.`);
  }
  if (!dry) rmSync(HOME_DIR, { recursive: true, force: true });
  log(`✓ ${HOME_DIR} gelöscht. Artificial Industries ist vollständig entfernt.`);
}

function status() {
  const found = detect();
  const cfg = readJson(join(HOME_DIR, "config.json"), null);
  log(`Reporter: ${existsSync(join(INSTALL_DIR, "report.mjs")) ? INSTALL_DIR : "nicht installiert"}`);
  log(`Fabrik-Adresse: ${cfg?.server_url ?? "–"}`);
  log(`Claude Code: ${found.claude ? `gefunden (${found.claude})` : "nicht gefunden"}`);
  for (const [name, path, grouped] of [["Codex", join(codexHome(), "hooks.json"), true], ["Cursor", join(cursorHome(), "hooks.json"), false]]) {
    const hooks = readJson(path, {}).hooks ?? {};
    const ours = Object.values(hooks).flat().flatMap((g) => (grouped ? g.hooks ?? [] : [g])).filter(isOurs).length;
    log(`${name}: ${ours ? `${ours} Hooks eingetragen` : "keine Hooks"}`);
  }
}

try {
  if (flag("uninstall")) uninstall();
  else if (flag("status")) status();
  else await install();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
}
