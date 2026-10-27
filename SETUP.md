# Artificial Industries – Reporter einrichten

Diese Anleitung ist für die KI geschrieben, die den Reporter für ihren Menschen einrichtet (Claude Code, Codex oder Cursor). Menschen können ihr genauso folgen.

## Was der Reporter tut

Er meldet einer gemeinsamen Webapp („die Fabrik“), **woran** die KI-Agenten gerade arbeiten, damit Freunde es als Pixel-Fabrik sehen. Gesendet werden nur:

- Art des Ereignisses (Session beginnt, Werkzeug benutzt, Subagent gestartet, …)
- Werkzeugname und eine grobe Station (z. B. „Archiv“ für Lesen, „Werkbank“ für Schreiben), Dauer, Erfolg
- Token-Zahlen und Modellname, bei Codex das Abo-Kontingent in Prozent
- ein Hash des Projektpfads und der Ordnername des Projekts

**Nie** gesendet werden: Prompts, Antworten, Gedanken, Code, Dateiinhalte, Dateipfade, Shell-Befehle, E-Mail-Adressen. Die Einordnung von Shell-Befehlen passiert lokal.

## Voraussetzungen

- Node.js 18 oder neuer (`node --version`)
- Eine Fabrik-Adresse und ein persönlicher Token. Beides steht in dem Text, den der Mensch aus der Webapp kopiert hat („Werk anschließen“).

## Einrichten

Im Ordner dieses Repos ausführen. Adresse und Token aus dem Text des Menschen einsetzen:

```bash
node setup.mjs --server <fabrik-adresse> --token <token>
```

Das Skript:

1. prüft zuerst, ob Fabrik und Token funktionieren. Wenn nicht, bricht es ab und verändert nichts.
2. kopiert den Reporter nach `~/.artificial-industries/reporter` und legt dort `config.json` mit Adresse und Token ab.
3. richtet ihn für jedes gefundene Tool ein:
   - **Claude Code:** installiert das Plugin `artificial-industries-reporter` über die Claude-CLI (auch die in der Claude-Desktop-App enthaltene).
   - **Codex:** trägt Hooks in `~/.codex/hooks.json` ein (bzw. `$CODEX_HOME/hooks.json`).
   - **Cursor:** trägt Hooks in `~/.cursor/hooks.json` ein.
4. sichert jede vorhandene Datei vor der Änderung als `*.bak-<zeitstempel>` und lässt fremde Hooks unverändert.

Nur bestimmte Tools einrichten: `--tools claude,cursor`. Nur anzeigen, was passieren würde: `--dry-run`.

## Danach dem Menschen sagen

- Der Reporter wirkt erst in **neuen** Sessions bzw. Chats.
- **Codex:** Einmal `/hooks` in Codex aufrufen und die Hooks von Artificial Industries freigeben. Ohne Freigabe führt Codex sie nicht aus, und nach jedem Update des Reporters ist das erneut nötig.
- **Cursor:** Wenn der Arbeitsbereich nicht vertrauenswürdig ist, laufen Hooks nicht. Unter Customize → Hooks sieht man, ob sie geladen wurden.
- Die Fabrik-Adresse im Browser öffnen: Dort erscheint das eigene Werk mit einer Halle pro KI.

## Prüfen und entfernen

```bash
node setup.mjs --status
```

```bash
node setup.mjs --uninstall
```

`--uninstall` entfernt Plugin und Hooks und löscht `~/.artificial-industries` vollständig. Fremde Hooks bleiben erhalten.

## Projekte verstecken

In `~/.artificial-industries/config.json` eine Liste von Ordnernamen eintragen, die nie gemeldet werden:

```json
{ "server_url": "…", "token": "…", "hidden_projects": ["geheimes-projekt"] }
```

## Fehlersuche

- Fehler des Reporters stehen in `reporter.log` im Datenordner, also `~/.artificial-industries/data/<tool>/` bzw. bei Claude Code `~/.claude/plugins/data/artificial-industries-reporter-artificial-industries/`.
- Ist die Fabrik nicht erreichbar, werden Ereignisse in `queue.jsonl` gepuffert und später nachgesendet (höchstens 5 000).
- Der Reporter beendet sich immer mit Exit-Code 0 und blockiert die Tools nie.
