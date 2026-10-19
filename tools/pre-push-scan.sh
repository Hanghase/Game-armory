#!/bin/sh
# =============================================================================
# pre-push-scan.sh - laesst keinen Push durch, der Betreiberdaten enthaelt.
#
# Aufruf:  tools/pre-push-scan.sh          (prueft alle Commits, die rausgehen)
#          tools/pre-push-scan.sh --staged (prueft nur den Index, fuer Handbetrieb)
#
# Warum: Am 2026-10-19 standen IP-Adressen des Betreibers fest im Code und die
# Betreiber-Mailadresse in 18 Commit-Metadaten. Das Repo war privat, deshalb ist
# nichts passiert. Einmal oeffentlich gepusht ist es nicht mehr zu korrigieren -
# der Fix-Commit entfernt die Zeile, nicht die Historie.
#
# Dieser Scanner laeuft VOR dem Upload. Er findet nichts? Push geht durch.
# Er findet etwas? Push bricht ab, mit Datei, Zeile und Treffer.
# =============================================================================
set -eu

REPO_DIR=$(git rev-parse --show-toplevel)
cd "$REPO_DIR"

MODE=history
[ "${1:-}" = "--staged" ] && MODE=staged

RED=$(printf '\033[31m'); YEL=$(printf '\033[33m'); OFF=$(printf '\033[0m')

# --- Suchmuster -------------------------------------------------------------
# Jedes Muster ist eine erweiterte Regex. Treffer werden gemeldet, nicht
# automatisch als Fehler gewertet - ausser bei MUSTER_HART.
#
# Weiche Muster (Warnung): koennen harmlos sein (z.B. "Felix" in einem Zitat).
# Harte Muster (Abbruch): haben in einem oeffentlichen Repo nichts zu suchen.

check_pattern() {
    label="$1"; regex="$2"; hard="$3"
    hits=$(git grep -n -I -E -e "$regex" -- . 2>/dev/null \
           | grep -v '^tools/pre-push-scan.sh:' \
           | grep -v '^tools/git-hooks/' || true)
    if [ -n "$hits" ]; then
        if [ "$hard" = "hard" ]; then
            echo "${RED}ABBRUCH${OFF} [$label]"
            echo "$hits" | head -20 | sed 's/^/    /'
            FAIL=1
        else
            echo "${YEL}HINWEIS${OFF} [$label]"
            echo "$hits" | head -10 | sed 's/^/    /'
        fi
    fi
}

FAIL=0

# Betreiber-spezifische Muster stehen NICHT in diesem Skript. Eine IP oder
# Mailadresse im Scanner verraet genau das, wonach sie sucht - und der
# Scanner selbst liegt im oeffentlichen Repository. Die Muster kommen aus
# .private/scan-patterns.sh (nicht versioniert, siehe .gitignore).
PATTERN_FILE="${ARMORY_SCAN_PATTERNS:-$REPO_DIR/.private/scan-patterns.sh}"
if [ -f "$PATTERN_FILE" ]; then
    # shellcheck disable=SC1090
    . "$PATTERN_FILE"
else
    echo "${YEL}HINWEIS${OFF} Keine lokalen Muster ($PATTERN_FILE)."
    echo "    Betreiber-spezifische Scans (eigene IPs/Maildomain) laufen nicht."
    echo "    Vorlage: .private/scan-patterns.sh anlegen."
    HARD_IPS=''; HARD_MAILS=''; HARD_MAIL_DOMAIN=''; WARN_NAMES=''; WARN_HOSTING=''
fi

echo "=== Scan: Betreiber-Infrastruktur ==="
if [ -n "${HARD_IPS:-}" ]; then
    check_pattern "eigene IP-Adresse" "$HARD_IPS" hard
fi
# Tailscale-Bereich ist generisch (100.64.0.0/10) - kein Betreiber-Geheimnis,
# deshalb fest im Skript.
check_pattern "Tailscale-Host"    '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}' warn

echo "=== Scan: Namen und Mail ==="
if [ -n "${HARD_MAILS:-}" ]; then
    check_pattern "eigene Mailadresse" "$HARD_MAILS" hard
fi
if [ -n "${WARN_NAMES:-}" ]; then
    check_pattern "Betreiber-Name" "$WARN_NAMES" warn
fi
if [ -n "${WARN_HOSTING:-}" ]; then
    check_pattern "Hosting-Panel"  "$WARN_HOSTING" warn
fi

echo "=== Scan: Schluessel und Tokens ==="
check_pattern "Private Key"       'BEGIN ([A-Z]+ )?PRIVATE KEY'          hard
check_pattern "GitHub-Token"      'gh[pousr]_[A-Za-z0-9]{20,}'           hard
check_pattern "GitHub PAT"        'github_pat_[A-Za-z0-9_]{20,}'         hard
check_pattern "AWS Key"           'AKIA[0-9A-Z]{16}'                     hard
check_pattern "Passwort-Zuweisung" '(password|passwd|secret|api[_-]?key)\s*[:=]\s*["\x27][^"\x27]{8,}["\x27]' warn

echo "=== Scan: Laufzeitdaten ==="
check_pattern "SQLite-Datei"      'SQLite format 3'                      warn
for f in $(git ls-files | grep -E '\.(db|sqlite3?|db-wal|db-shm|log)$' || true); do
    echo "${RED}ABBRUCH${OFF} [getrackte Laufzeitdatei]"
    echo "    $f"
    FAIL=1
done

# --- Commit-Metadaten -------------------------------------------------------
echo "=== Scan: Commit-Metadaten ==="
# Autoren-Mailadresse: darf nur die noreply-Adresse sein.
badauthor=$(git log --format='%an <%ae>' | sort -u \
            | grep -vE '@users\.noreply\.github\.com>|@noreply\.github\.com>' || true)
if [ -n "$badauthor" ]; then
    echo "${YEL}HINWEIS${OFF} [Autoren mit echter Mailadresse]"
    echo "$badauthor" | sed 's/^/    /'
fi
if [ -n "${HARD_MAIL_DOMAIN:-}" ]; then
    badmail=$(git log --format='%ae' | sort -u | grep -E "$HARD_MAIL_DOMAIN" || true)
else
    badmail=''
fi
if [ -n "$badmail" ]; then
    echo "${RED}ABBRUCH${OFF} [Betreiber-Mailadresse in Commit-Metadaten]"
    echo "$badmail" | sed 's/^/    /'
    FAIL=1
fi

# --- Ergebnis ---------------------------------------------------------------
echo ""
if [ "$FAIL" -ne 0 ]; then
    echo "${RED}Push abgebrochen.${OFF} Die Treffer oben muessen weg, bevor dieser"
    echo "Stand das Haus verlaesst. Historie bereinigen:"
    echo "    git checkout --orphan fresh && git add -A && git commit"
    exit 1
fi
echo "Scan sauber - Push darf raus."
exit 0
