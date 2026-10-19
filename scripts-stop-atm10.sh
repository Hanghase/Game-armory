#!/bin/bash
# Sauberer ATM10-Stop via RCON.
#
# Ablauf:
#   1. Konsolen-Befehl "stop" via RCON senden -> Minecraft speichert die Welt.
#   2. WARTEN, bis der Java-Prozess wirklich beendet ist.
#   3. Erst dann exit 0 -> systemd schickt kein SIGTERM mitten ins Speichern.
#
# WICHTIG: Zum Warten NUR 'pgrep' verwenden. Ein (echo > /dev/tcp/host/port)
# ist eine echte Verbindung und erzeugt bei Wiederholung RCON-Spam, der den
# laufenden Shutdown blockiert.
#
# WICHTIG 2: Das Skript laeuft als Service-User (atm10), nicht als root.
# Die RCON-Passwort-Datei muss fuer diesen User lesbar sein.
set -u
PW_FILE="/opt/game-armory/data/atm10-rcon.password"
NODE_BIN="/usr/bin/node"

if [ ! -r "$PW_FILE" ]; then
  echo "[rcon-stop] RCON-Passwort nicht lesbar: $PW_FILE" >&2
  exit 0   # SIGTERM-Fallback greift danach
fi
PW=$(cat "$PW_FILE")

# Stop-Kommando senden (Abbrueche ignorieren - sie sind beim Stop erwartet).
"$NODE_BIN" /opt/game-armory/tools/rcon-stop.mjs "$PW" || true

# Auf das saubere Ende des Servers warten. NICHT auf den Port pruefen
# (das erzeugt Verbindungen!), sondern auf den Java-Prozess.
# TimeoutStopSec=180 begrenzt das ohnehin.
# Der Server haengt beim Runterfahren gelegentlich im Shutdown (Mods halten
# Threads offen, z.B. Netty-Epollo). Dann kommt er nie von selbst zum Ende.
# Nach GRACE Sekunden sauberem Warten greifen wir hart ein - sonst blockiert
# der Stop den ganzen Update-Ablauf, und systemd wartet nur bis
# TimeoutStopSec, weil dieses Skript selbst noch laeuft.
#
# Ablauf: GRACE s warten -> SIGTERM -> nochmals KILL_GRACE s warten -> SIGKILL.
GRACE="${ARMORY_STOP_GRACE:-90}"
KILL_GRACE="${ARMORY_STOP_KILL_GRACE:-15}"
PATTERN="neoforge.*unix_args.txt"
WORKDIR="/opt/minecraft/atm10"

# Liefert PIDs des Server-Prozesses. Die eigene Shell ($$) und den Aufrufer
# ($PPID) schliessen wir aus: steht das Muster in einer Kommandozeile, wuerde
# 'pkill -f' sonst die eigene Shell treffen.
# Nur Prozesse DIESER Instanz, nicht fremde Minecraft-Server: der Java-Command
# enthaelt keinen Pfad, deshalb pruefen wir das Arbeitsverzeichnis ueber
# /proc/<pid>/cwd. Sonst wartet/killt der Stop bei gleicher Neoforge-Version
# die falsche Instanz (live erlebt: atm10 wartete auf atm11s Java).
server_pids() {
  local pid cwd
  for pid in $(pgrep -f "$PATTERN" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    [ "$pid" = "$PPID" ] && continue
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)" || continue
    [ "$cwd" = "$WORKDIR" ] && echo "$pid"
  done
}

wait_gone() {
  local limit="$1" i
  for ((i = 1; i <= limit; i++)); do
    [ -z "$(server_pids)" ] && return 0
    sleep 1
  done
  return 1
}

if wait_gone "$GRACE"; then
  echo "[rcon-stop] Server beendet nach sauberem Shutdown."
  exit 0
fi

echo "[rcon-stop] Server haengt nach ${GRACE}s - sende SIGTERM." >&2
for p in $(server_pids); do kill -TERM "$p" 2>/dev/null || true; done
if wait_gone "$KILL_GRACE"; then
  echo "[rcon-stop] Server nach SIGTERM beendet."
  exit 0
fi

echo "[rcon-stop] Server reagiert nicht auf SIGTERM - sende SIGKILL." >&2
for p in $(server_pids); do kill -KILL "$p" 2>/dev/null || true; done
if wait_gone 10; then
  echo "[rcon-stop] Server nach SIGKILL beendet (erzwungen)."
  exit 0
fi

echo "[rcon-stop] WARNUNG: Server-Prozess laeuft trotz SIGKILL noch." >&2
exit 0
