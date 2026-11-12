#!/bin/bash
# Starter von NewtonBot.app: Bot im Hintergrund starten (oder den laufenden finden) und das Panel öffnen.
# Beendet wird der Bot im Panel über "Beenden".

APP_CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
BOT="$APP_CONTENTS/Resources/bot"
PORT=8090
URL="http://127.0.0.1:$PORT"
DATA="$HOME/Library/Application Support/NewtonBot"
LOGDIR="$HOME/Library/Logs/NewtonBot"
LOG="$LOGDIR/newtonbot.log"
mkdir -p "$DATA" "$LOGDIR"

alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with icon caution with title \"NewtonBot\"" >/dev/null 2>&1
}

panel_up() { curl -s -m 1 -o /dev/null -X POST "$URL/api/ping"; }

# Läuft schon? Dann nur das Panel zeigen.
if panel_up; then open "$URL"; exit 0; fi

# Node.js finden (Apps erben den PATH der Shell nicht)
find_node() {
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  local n
  n="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
  [ -n "$n" ] && { echo "$n"; return; }
  n="$(/bin/zsh -lc 'command -v node' 2>/dev/null)"
  [ -n "$n" ] && echo "$n"
}
NODE="$(find_node)"
if [ -z "$NODE" ]; then
  r="$(osascript -e 'button returned of (display dialog "NewtonBot braucht Node.js (Version 18 oder neuer). Bitte installieren und NewtonBot erneut öffnen." buttons {"Abbrechen", "Node.js herunterladen"} default button 2 with icon caution with title "NewtonBot")' 2>/dev/null)"
  [ "$r" = "Node.js herunterladen" ] && open "https://nodejs.org/"
  exit 1
fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$MAJOR" -lt 18 ]; then
  alert "Node.js $MAJOR ist zu alt. NewtonBot braucht Version 18 oder neuer."
  exit 1
fi

# Log klein halten
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 5000000 ]; then mv -f "$LOG" "$LOG.1"; fi
echo "===== Start $(date) =====" >> "$LOG"

nohup "$NODE" "$BOT/src/supervisor.js" --connect --http=$PORT --config="$DATA/config.json" >> "$LOG" 2>&1 &

for _ in $(seq 1 60); do panel_up && break; sleep 0.25; done
if panel_up; then
  open "$URL"
else
  alert "NewtonBot konnte nicht starten. Details im Log: ~/Library/Logs/NewtonBot/newtonbot.log"
  open -a Console "$LOG" 2>/dev/null
fi
