#!/bin/bash
# Prueft die Schreibprobe des Helfers in BEIDEN Richtungen.
#   Normalfall : Probe muss durchlaufen (Helfer kommt bis Schritt 1)
#   Fehlerfall : ungueltiges Ziel -> Probe greift, es wird NICHTS veraendert
#
# Warum ein eigenes Skript: der Helfer laesst sich nicht "ein bisschen"
# ausfuehren. Ein `| head -2` schneidet ihn MITTEN im Lauf ab und hinterlaesst
# genau den halbfertigen Stand, den die Probe verhindern soll (live passiert
# am 2026-11-26, Compose stand danach auf einem nicht existierenden Tag).
# Hier wird der Ablauf immer bis zum Ende gelesen.
set -uo pipefail

HELFER=/usr/local/bin/armory-docker-update
COMPOSE=/opt/nextcloud/docker-compose.yml
fehler=0

pruefe() { # <Name> <erwartet: 0=durch 9=probe greift> <ausgabe>
  local name="$1" erwartet="$2" aus="$3" rc="$4"
  local ok=1
  [[ "$rc" == "$erwartet" ]] || ok=0
  if [[ "$erwartet" == "9" ]]; then
    grep -q "nicht beschreibbar" <<<"$aus" || ok=0
    grep -q "Es wurde nichts geaendert" <<<"$aus" || ok=0
  fi
  if (( ok )); then echo "  OK   $name (rc=$rc)"
  else echo "  FEHL $name (rc=$rc, erwartet $erwartet)"; echo "$aus" | sed 's/^/       /' | head -6; fehler=1; fi
}

echo "1) Normalfall: Ziel beschreibbar -> Probe laesst durch"
vorher="$(md5sum "$COMPOSE" | cut -d' ' -f1)"
aus="$(sudo -n "$HELFER" nextcloud apply 35.0.3-apache 2>&1)"; rc=$?
pruefe "Probe laesst durch" 5 "$aus" "$rc"   # 5 = Image schon aktuell, also hinter der Probe
[[ "$(md5sum "$COMPOSE" | cut -d' ' -f1)" == "$vorher" ]] \
  && echo "  OK   Compose unveraendert (kein Update noetig)" \
  || { echo "  FEHL Compose wurde veraendert!"; fehler=1; }

echo "2) Fehlerfall: Ziel im read-only Mount -> Probe muss VOR jeder Aenderung abbrechen"
# Der RO-Mount muss NACH dem Ablegen der Datei geschaltet werden - auf einem
# sofort-ro Mount laesst sich keine Datei mehr anlegen, dann bricht der Helfer
# schon bei "Compose-Datei nicht lesbar" (rc 3) ab und die Probe wird nie
# erreicht. Genau daran ist der erste Anlauf dieses Skripts gescheitert.
zieldir=/opt/probe-ro
mkdir -p "$zieldir"
mount -t tmpfs tmpfs "$zieldir" 2>/dev/null
cp "$COMPOSE" "$zieldir/docker-compose.yml"
mount -o remount,ro "$zieldir" 2>/dev/null
kopie=/tmp/helfer-ro-test
sed "s|$COMPOSE|$zieldir/docker-compose.yml|g" "$HELFER" > "$kopie"
aus="$(bash "$kopie" nextcloud apply 35.0.4-apache 2>&1)"; rc=$?
pruefe "Probe greift auf RO-Mount" 9 "$aus" "$rc"
grep -q "Read-only file system" <<<"$aus" \
  && echo "  OK   Grund nennt 'Read-only file system'" \
  || { echo "  FEHL Grund nennt den Mount-Fehler nicht"; fehler=1; }
umount "$zieldir" 2>/dev/null; rmdir "$zieldir" 2>/dev/null; rm -f "$kopie"

echo "3) Fehlerfall: Aufrufer ohne Schreibrecht auf das Zielverzeichnis"
# armory darf den Helfer per sudo starten; danach laeuft er als root und DARF
# schreiben - die Rechtepruefung des Aufrufers greift hier also NICHT.
# Was zaehlen muss: ein ungueltiger Tag darf die Datei nicht anfassen.
aus="$(sudo -u armory sudo -n "$HELFER" nextcloud apply 35.0.4-apache 2>&1)"; rc=$?
[[ "$(md5sum "$COMPOSE" | cut -d' ' -f1)" == "$vorher" ]] \
  && echo "  OK   Compose nach ungueltigem Tag unveraendert" \
  || { echo "  FEHL Compose wurde veraendert!"; fehler=1; }

echo
(( fehler == 0 )) && echo "Alle Proben bestanden." || echo "MINDESTENS EINE PROBE IST KAPUTT."
exit $fehler
