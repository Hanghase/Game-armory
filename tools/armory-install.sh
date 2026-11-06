#!/bin/bash
# Armory - Erstinstallation auf einem frischen System
#
# Ziel: von einem nackten Debian/Ubuntu zu einer laufenden Armory, ohne
# Handarbeit. Idempotent: ein zweiter Lauf aendert nichts, was schon stimmt.
#
# Aufruf:
#   sudo tools/armory-install.sh [Optionen]
#
# Optionen:
#   --dir <pfad>        Installationsverzeichnis (Standard: /opt/game-armory)
#   --user <name>       Service-User (Standard: armory)
#   --game-roots <l>    Zusaetzliche ReadWritePaths, durch Leerzeichen getrennt
#   --check-only        Nur pruefen, nichts aendern
#   --help              Diese Hilfe
#
# Grundsatz: lieber laut abbrechen als halb durchlaufen. Jeder Schritt prueft
# seine Vorbedingung, und am Ende steht eine Selbstpruefung mit OK/FEHLER.

set -euo pipefail

# --- Vorgaben -------------------------------------------------------------
INSTALL_DIR="/opt/game-armory"
SERVICE_USER="armory"
SERVICE_NAME="game-armory"
GAME_ROOTS="/opt/minecraft /opt/7d2d /opt/steamcmd /opt/satisfactory"
CHECK_ONLY=0
MIN_NODE_MAJOR=20

# --- Ausgabe --------------------------------------------------------------
ok()   { printf '  \033[32mOK\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFEHLER\033[0m %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*"; }
die()  { fail "$*"; exit 1; }

# --- Argumente ------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        INSTALL_DIR="${2:?--dir braucht einen Wert}"; shift 2 ;;
    --user)       SERVICE_USER="${2:?--user braucht einen Wert}"; shift 2 ;;
    --game-roots) GAME_ROOTS="${2:?--game-roots braucht einen Wert}"; shift 2 ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --help|-h)    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "Unbekannte Option: $1 (siehe --help)" ;;
  esac
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
SUDOERS_DST="/etc/sudoers.d/armory"
TMPL="${REPO_DIR}/templates/systemd/game-armory.service.tmpl"

run() {
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '  (check-only) wuerde ausfuehren: %s\n' "$*"
    return 0
  fi
  "$@"
}

# --- 1. Vorbedingungen ----------------------------------------------------
step "1. Vorbedingungen pruefen"

[[ "$(id -u)" -eq 0 ]] || die "Bitte als root ausfuehren: sudo $0"
ok "laeuft als root"

if [[ ! -r /etc/os-release ]]; then
  die "/etc/os-release fehlt - unbekanntes System, breche ab"
fi
# shellcheck disable=SC1091
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ok "Distribution: ${PRETTY_NAME:-$ID}" ;;
  *) die "Nicht getestet fuer '${ID:-unbekannt}'. Unterstuetzt: debian, ubuntu. Abbruch (kein Halbzustand)." ;;
esac

[[ "$(ps -p 1 -o comm= 2>/dev/null)" == "systemd" ]] \
  || die "systemd ist nicht PID 1 - die Armory braucht systemd. Abbruch."
ok "systemd ist PID 1"

# Node fehlt oder ist zu alt: das Skript installiert es NICHT selbst (das waere
# ein Fremdsystem-Eingriff, den niemand erwartet), nennt aber den Befehl, der
# auf Debian/Ubuntu funktioniert. Vorher stand hier nur "bitte installieren".
NODE_INSTALL_HINT="curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"

if [[ -z "$NODE_BIN" ]]; then
  fail "node nicht gefunden (mind. Version ${MIN_NODE_MAJOR} noetig)."
  printf '        Installieren mit:\n          %s\n' "$NODE_INSTALL_HINT" >&2
  die "Kein Node - Abbruch, nichts veraendert."
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR:-0}" -lt "$MIN_NODE_MAJOR" ]]; then
  fail "node zu alt: $("$NODE_BIN" -v) (mind. ${MIN_NODE_MAJOR} noetig) - $NODE_BIN"
  printf '        Aktualisieren mit:\n          %s\n' "$NODE_INSTALL_HINT" >&2
  die "Node zu alt - Abbruch, nichts veraendert."
fi
ok "node $("$NODE_BIN" -v) ($NODE_BIN)"

[[ -f "$TMPL" ]] || die "Unit-Vorlage fehlt: $TMPL"
ok "Unit-Vorlage gefunden"

PORT_BUSY=0
if command -v ss >/dev/null 2>&1 && ss -tlnH 2>/dev/null | grep -q ':3000 '; then
  PORT_BUSY=1
fi

if [[ "$PORT_BUSY" -eq 1 ]]; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    warn "Port 3000 belegt - vermutlich eine laufende Armory (im check-only kein Abbruch)"
  elif systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    warn "Port 3000 belegt, aber ${SERVICE_NAME} laeuft - das ist der Normalfall bei Reinstall"
  else
    die "Port 3000 ist belegt, aber ${SERVICE_NAME} laeuft nicht. Abbruch (fremder Prozess?)."
  fi
else
  ok "Port 3000 frei"
fi

if [[ "$REPO_DIR" != "$INSTALL_DIR" ]] && [[ "$REPO_DIR" != /tmp/* ]]; then
  warn "Quelle ist ${REPO_DIR}, Ziel ist ${INSTALL_DIR}"
fi

# --- 2. Service-User ------------------------------------------------------
step "2. Service-User '${SERVICE_USER}'"

if id "$SERVICE_USER" >/dev/null 2>&1; then
  ok "User existiert bereits"
else
  run useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  ok "User angelegt"
fi

# --- 3. Installationsverzeichnis -----------------------------------------
step "3. Installationsverzeichnis ${INSTALL_DIR}"

if [[ "$REPO_DIR" != "$INSTALL_DIR" ]]; then
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    ok "bestehendes Git-Repo - Quellcode wird nicht ueberschrieben"
  elif [[ -d "$INSTALL_DIR" ]] && [[ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]]; then
    # cp -a ueberschreibt nur, was in der Quelle liegt. Dateien, die im Ziel
    # existieren und in der Quelle fehlen, bleiben stehen (Altlasten).
    warn "Ziel existiert und ist nicht leer - es wird hineinkopiert, alte Dateien bleiben"
    run cp -a "$REPO_DIR/." "$INSTALL_DIR/"
    ok "Quellcode hineinkopiert"
  else
    run mkdir -p "$INSTALL_DIR"
    run cp -a "$REPO_DIR/." "$INSTALL_DIR/"
    ok "Quellcode kopiert"
  fi
else
  ok "laeuft direkt im Zielverzeichnis"
fi

run mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/data"
run chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
ok "Besitz: ${SERVICE_USER}:${SERVICE_USER}"

# --- 3a. Build-Werkzeuge ------------------------------------------------
# better-sqlite3 ist ein natives Modul und wird beim npm install aus Quellcode
# gebaut. Ein frisches Debian hat keinen Compiler - ohne diesen Schritt bricht
# npm install mit "gyp ERR! not found: make" ab. Auf Systemen, wo die
# Werkzeuge schon liegen (z.B. nach früherer Arbeit), ist das ein No-Op.
step "3a. Build-Werkzeuge fuer native Module"

MISSING_PKGS=()
command -v make       >/dev/null 2>&1 || MISSING_PKGS+=("make")
command -v g++        >/dev/null 2>&1 || MISSING_PKGS+=("g++")
command -v python3    >/dev/null 2>&1 || MISSING_PKGS+=("python3")

if [[ ${#MISSING_PKGS[@]} -eq 0 ]]; then
  ok "make, g++ und python3 vorhanden"
else
  warn "fehlt: ${MISSING_PKGS[*]}"
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '  (check-only) wuerde installieren: build-essential python3\n'
  else
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3
    ok "build-essential + python3 installiert"
  fi
fi

# --- 4. Node-Abhaengigkeiten ---------------------------------------------
step "4. npm-Abhaengigkeiten"

# Nicht nur "node_modules existiert" pruefen: nach einem Update ist der Ordner
# alt und package.json neuer. Entscheidend ist, ob package-lock.json juenger
# ist als node_modules.
NEED_NPM=1
if [[ -d "$INSTALL_DIR/node_modules" ]]; then
  if [[ "$INSTALL_DIR/package-lock.json" -nt "$INSTALL_DIR/node_modules" ]]; then
    warn "package-lock.json ist neuer als node_modules - Abhaengigkeiten werden nachgezogen"
  else
    NEED_NPM=0
    ok "node_modules aktuell"
  fi
fi

if [[ "$NEED_NPM" -eq 1 ]]; then
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '  (check-only) wuerde ausfuehren: npm install --omit=dev\n'
  else
    su -s /bin/bash "$SERVICE_USER" -c "cd '$INSTALL_DIR' && npm install --omit=dev" \
      || die "npm install fehlgeschlagen. Haeufigste Ursache: fehlende Build-Werkzeuge fuer native Module (better-sqlite3). Log oben pruefen."
    ok "npm install ausgefuehrt"
  fi
fi

# --- 5. Helfer ------------------------------------------------------------
step "5. Helfer nach /usr/local/bin"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  printf '  (check-only) wuerde ausfuehren: %s\n' "$INSTALL_DIR/tools/install-helpers.sh"
else
  "$INSTALL_DIR/tools/install-helpers.sh"
fi
ok "Helfer installiert"

# --- 6. sudoers -----------------------------------------------------------
step "6. sudoers-Regel ${SUDOERS_DST}"

SUDOERS_CONTENT="$(cat <<EOF
# Armory - eng gefasste Rechte fuer den ${SERVICE_USER}-User.
# Nur die fest definierten Helfer-Skripte, kein freies sudo.
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/armory-service-ctl
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/armory-install-helper
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/armory-steam-helper
${SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/armory-self-update
EOF
)"

if [[ -f "$SUDOERS_DST" ]] && [[ "$(cat "$SUDOERS_DST")" == "$SUDOERS_CONTENT" ]]; then
  ok "unveraendert"
else
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '  (check-only) wuerde sudoers schreiben\n'
  else
    tmp="$(mktemp)"
    printf '%s\n' "$SUDOERS_CONTENT" > "$tmp"
    chmod 0440 "$tmp"
    visudo -c -f "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers-Inhalt ist ungueltig - nichts geschrieben."; }
    install -m 0440 -o root -g root "$tmp" "$SUDOERS_DST"
    rm -f "$tmp"
    ok "geschrieben + mit visudo -c geprueft"
  fi
fi

# --- 7. systemd-Unit aus Vorlage -----------------------------------------
step "7. systemd-Unit ${UNIT_DST}"

# ReadWritePaths in der Unit benennt Verzeichnisse, die existieren MUESSEN:
# fehlt eines, bricht systemd mit "status=226/NAMESPACE" beim Start ab.
# Auf einem frischen System gibt es die Game-Roots noch nicht - also anlegen.
MISSING_ROOTS=()
for root_dir in $GAME_ROOTS; do
  [[ -d "$root_dir" ]] || MISSING_ROOTS+=("$root_dir")
done
if [[ ${#MISSING_ROOTS[@]} -eq 0 ]]; then
  ok "alle ReadWritePaths vorhanden"
else
  warn "lege fehlende ReadWritePaths an: ${MISSING_ROOTS[*]}"
  run mkdir -p "${MISSING_ROOTS[@]}"
  ok "angelegt"
fi

UNIT_CONTENT="$(sed \
  -e "s|{{INSTALL_DIR}}|${INSTALL_DIR}|g" \
  -e "s|{{SERVICE_USER}}|${SERVICE_USER}|g" \
  -e "s|{{NODE_BIN}}|${NODE_BIN}|g" \
  -e "s|{{GAME_ROOTS}}|${GAME_ROOTS}|g" \
  "$TMPL")"

if grep -q '{{' <<<"$UNIT_CONTENT"; then
  die "Unit enthaelt noch Platzhalter - Vorlage unvollstaendig. Abbruch."
fi

if [[ -f "$UNIT_DST" ]] && [[ "$(cat "$UNIT_DST")" == "$UNIT_CONTENT" ]]; then
  ok "unveraendert"
else
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    printf '  (check-only) wuerde Unit schreiben\n'
  else
    if [[ -f "$UNIT_DST" ]]; then
      backup="${UNIT_DST}.bak-$(date +%Y%m%d-%H%M%S)"
      cp -a "$UNIT_DST" "$backup"
      warn "vorherige Unit gesichert: $backup"
    fi
    printf '%s\n' "$UNIT_CONTENT" > "$UNIT_DST"
    chmod 0644 "$UNIT_DST"
    chown root:root "$UNIT_DST"
    systemctl daemon-reload
    ok "geschrieben + daemon-reload"
  fi
fi

# --- 8. Dienst starten ----------------------------------------------------
step "8. Dienst ${SERVICE_NAME}"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  printf '  (check-only) wuerde enable + start\n'
else
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"

  # 'active' heisst nicht 'lauscht': Node meldet sich ein paar Sekunden nach
  # dem Start als aktiv, bevor listen() durch ist. Daher auf den Port warten.
  READY=0
  for _ in $(seq 1 30); do
    # Nicht "/" messen: die Wurzel leitet ohne Sitzung per 302 auf /login um.
    # Die gesunde Antwort auf einem frischen System ist /login mit 200.
    if [[ "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)" == "active" ]] \
       && [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:3000/login 2>/dev/null)" == "200" ]]; then
      READY=1
      break
    fi
    sleep 1
  done
  [[ "$READY" -eq 1 ]] && ok "Dienst antwortet auf :3000" || warn "Dienst aktiv, aber antwortet noch nicht (Selbstpruefung unten)"
fi

# --- 9. Selbstpruefung ----------------------------------------------------
step "9. Selbstpruefung"

rc=0
chk() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$label"; else fail "$label"; rc=1; fi
}

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  warn "check-only: Selbstpruefung des laufenden Dienstes uebersprungen"
else
  chk "Dienst aktiv"            bash -c "[[ \"\$(systemctl is-active $SERVICE_NAME)\" == active ]]"
  chk "Dienst enabled"          bash -c "[[ \"\$(systemctl is-enabled $SERVICE_NAME 2>/dev/null)\" == enabled ]]"
  chk "Helfer vorhanden"        bash -c "[[ -x /usr/local/bin/armory-service-ctl && -x /usr/local/bin/armory-install-helper ]]"
  chk "sudoers valide"          visudo -c
  chk "sudo ohne Passwort"      su -s /bin/bash "$SERVICE_USER" -c "sudo -n /usr/local/bin/armory-service-ctl 2>&1 | grep -qi 'usage\\|aktion\\|argument\\|fehlt'" || true
  http_ok() {
    for _ in $(seq 1 15); do
      [[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000/login 2>/dev/null)" == "200" ]] && return 0
      sleep 1
    done
    return 1
  }
  chk "HTTP 200 auf :3000/login" http_ok
fi

printf '\n'
if [[ "$rc" -eq 0 ]]; then
  printf '  \033[32mInstallation abgeschlossen.\033[0m\n\n'
  printf '  Das Panel lauscht NUR auf 127.0.0.1:3000 - von aussen ist es damit\n'
  printf '  nicht erreichbar. Fuer den Zugriff gibt es zwei Wege:\n\n'
  printf '    a) SSH-Tunnel von deinem Rechner:\n'
  printf '         ssh -L 3000:127.0.0.1:3000 <user>@<server>\n'
  printf '       dann im Browser: http://127.0.0.1:3000\n\n'
  printf '    b) Reverse-Proxy (nginx/Apache/Caddy) mit HTTPS davor.\n\n'
  printf '  Naechster Schritt: Tunnel oeffnen und den ersten Admin anlegen.\n'
else
  printf '  \033[31mEs sind Pruefungen offen (siehe oben).\033[0m\n'
  printf '  Logs: journalctl -u %s -n 50   |   %s/logs/armory.err\n' "$SERVICE_NAME" "$INSTALL_DIR"
fi
exit "$rc"
