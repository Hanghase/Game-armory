#!/bin/bash
# Game-Armory - Helfer nach /usr/local/bin installieren
#
# Die Helfer in tools/ sind die Quelle, /usr/local/bin ist der Laufzeitort.
# Bewusst KOPIE statt Symlink: waehrend eines Selbst-Updates wechselt das
# Arbeitsverzeichnis per 'git checkout' auf einen anderen Tag. Waere der
# laufende Helfer ein Symlink ins Repo, wuerde er sich mitten im Vorgang
# selbst unter den Fuessen wegziehen.
#
# Aufruf:  sudo tools/install-helpers.sh
# Erneut ausfuehrbar (idempotent): gleicher Inhalt -> nichts zu tun.

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/usr/local/bin"

HELPERS=(
  armory-install-helper
  armory-service-ctl
  armory-self-update
)

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Bitte als root ausfuehren: sudo $0" >&2
  exit 1
fi

rc=0
for name in "${HELPERS[@]}"; do
  src="$SRC_DIR/$name"
  dest="$DEST_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "FEHLT: $src" >&2
    rc=1
    continue
  fi

  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    echo "unveraendert: $name"
    continue
  fi

  if [[ -f "$dest" ]]; then
    echo "aktualisiert: $name"
  else
    echo "angelegt:     $name"
  fi
  install -m 0755 -o root -g root "$src" "$dest"
done

exit $rc
