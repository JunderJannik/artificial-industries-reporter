# Artificial Industries – Reporter

Meldet, **woran** deine KI-Agenten (Claude Code, Codex, Cursor) gerade arbeiten, an die Pixel-Fabrik von Artificial Industries. Prompts, Code, Befehle, Dateipfade und Antworten werden nie gesendet, nur Metadaten wie Werkzeug, Dauer und Token-Zahlen.

**Einrichten:** In der Webapp auf „Werk anschließen“ klicken und den angezeigten Text deiner KI geben. Sie folgt dann [SETUP.md](SETUP.md).

Von Hand:

```bash
node setup.mjs --server <fabrik-adresse> --token <token>
```

Entfernen: `node setup.mjs --uninstall` · Status: `node setup.mjs --status`

Voraussetzung: Node.js 18 oder neuer. Keine weiteren Abhängigkeiten.
