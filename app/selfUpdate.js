// Game-Armory - Selbst-Update des Panels
// Ruft den privilegierten Helfer /usr/local/bin/armory-self-update auf.
//
// Warum ein Helfer und nicht direkt git/systemctl:
//   Das Panel laeuft als 'armory' und kann sich nicht selbst ersetzen. Der
//   Helfer wechselt auf einen Release-Tag, sichert vorher den alten Stand und
//   rollt zurueck, wenn das Panel danach nicht antwortet.
//
// Sicherheit in dieser Schicht:
//   - Nur Tags der Form vX.Y.Z werden durchgereicht (der Helfer prueft erneut).
//   - Kein Shell-Aufruf, keine Argument-Verkettung: spawn mit Argumentliste.
//   - Zeitlimits: 'status'/'tags' kurz, 'apply' laenger (Neustart + Rollback).

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export const SELF_UPDATE_HELPER = '/usr/local/bin/armory-self-update';

const TAG_RE = /^v\d+\.\d+\.\d+$/;

export class SelfUpdateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'SelfUpdateError';
    this.status = status;
  }
}

// Fuehrt den Helfer aus. Gibt IMMER ein Objekt zurueck (kein Wurf), damit der
// Aufrufer entscheiden kann. exitCode + stdout/stderr bleiben erhalten, weil
// der Helfer sein Ergebnis als key=value-Zeilen ausgibt.
function runHelper(args, { timeoutMs = 20000, env = null } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('sudo', ['-n', SELF_UPDATE_HELPER, ...args], {
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, exitCode: null, stdout, stderr, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        exitCode: code,
        stdout,
        stderr,
        error: timedOut ? `Zeitlimit (${timeoutMs} ms) ueberschritten` : undefined,
      });
    });
  });
}

// Die key=value-Ausgabe des Helfers in ein Objekt wandeln.
// Beispiel: "result=ok\ntag=v0.8.1\nprevious=v0.8.0"
function parseOutput(stdout) {
  const out = {};
  for (const line of String(stdout).split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function assertTag(tag) {
  const t = String(tag ?? '').trim();
  if (!TAG_RE.test(t)) {
    throw new SelfUpdateError(`Ungueltiger Tag: ${JSON.stringify(tag)} (erwartet vX.Y.Z)`);
  }
  return t;
}

// status: welcher Stand laeuft, ist das Arbeitsverzeichnis sauber, antwortet
// das Panel? Antwortet ohne Wurf, weil "unbekannt" ein Zustand ist, kein Fehler.
export async function getSelfUpdateStatus() {
  const res = await runHelper(['status'], { timeoutMs: 15000 });
  const data = parseOutput(res.stdout);
  if (!res.ok) {
    return { ok: false, error: res.stderr.trim() || res.error || 'status fehlgeschlagen', raw: data };
  }
  return {
    ok: true,
    tag: data.tag ?? null,
    commit: data.commit ?? null,
    branch: data.branch ?? null,
    dirty: data.dirty === undefined ? null : Number(data.dirty) > 0,
    // Getrennt (2026-10-19): nur 'tracked' sperrt das Update. Untracked wird
    // gemeldet, aber nicht als Sperre behandelt.
    dirtyTracked: data.dirty_tracked === undefined ? null : Number(data.dirty_tracked),
    dirtyUntracked: data.dirty_untracked === undefined ? null : Number(data.dirty_untracked),
    unit: data.unit ?? null,
    panel: data.panel ?? null,
  };
}

// tags: verfuegbare Release-Tags, neueste zuerst.
export async function listSelfUpdateTags() {
  const res = await runHelper(['tags'], { timeoutMs: 30000 });
  if (!res.ok) {
    throw new SelfUpdateError(res.stderr.trim() || res.error || 'tags fehlgeschlagen', 502);
  }
  const tags = String(res.stdout)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => TAG_RE.test(s));
  return tags;
}

// dry-run: alles pruefen (Tag, Sauberkeit), aber nichts tauschen.
//
// Eigener Helfer-Schritt statt 'apply' mit DRY_RUN=1 (2026-10-25).
// Grund: sudo laeuft auf diesem Host mit 'env_reset' und reicht keine
// Umgebungsvariablen durch. Der Helfer sah dry_run=0 und hat ein ECHTES
// Update gefahren - ein Klick auf "Trockenlauf pruefen" hat den Dienst
// neu gestartet. Argumente ueberleben sudo, Umgebungen nicht.
export async function dryRunSelfUpdate(tag) {
  const t = assertTag(tag);
  const res = await runHelper(['dry-run', t], { timeoutMs: 90000 });
  const data = parseOutput(res.stdout);
  if (!res.ok) {
    throw new SelfUpdateError(res.stderr.trim() || res.error || 'Trockenlauf fehlgeschlagen', 502);
  }
  // Kein backup-Feld: im Trockenlauf entsteht keine Sicherung.
  return { tag: data.tag ?? t, previous: data.previous ?? null };
}

// apply: echte Umstellung. Laeuft lange, weil der Dienst neu startet und der
// Helfer bis zu 45 s auf das Panel wartet (danach Rollback).
export async function applySelfUpdate(tag) {
  const t = assertTag(tag);
  const res = await runHelper(['apply', t], { timeoutMs: 180000 });
  const data = parseOutput(res.stdout);
  if (!res.ok) {
    throw new SelfUpdateError(
      res.stderr.trim() || res.error || `Update fehlgeschlagen (exit ${res.exitCode})`,
      502,
    );
  }
  return {
    result: data.result ?? 'unknown',
    tag: data.tag ?? null,
    previous: data.previous ?? null,
    reason: data.reason ?? null,
    backup: data.backup ?? null,
  };
}

// --- Gegenprobe: ist ein neuerer Tag verfuegbar? (2026-10-19) ----------------
//
// Warum hier und nicht im Panel-JS: Der Vergleich braucht den Helfer (git
// fetch) und das Ergebnis soll im Hintergrund-Takt entstehen, nicht bei jedem
// Aufruf des Headers. Der Zustand wird in der Tabelle settings abgelegt.
//
// Zustands-Werte wie bei den Swords:
//   current  - laufender Tag ist der neueste
//   outdated - ein neuerer Tag liegt vor
//   unknown  - keine belastbare Aussage (kein Helfer, kein Netz, Arbeitsstand)
//
// "unknown" ist ausdruecklich KEIN Fehler: das Panel sagt dann, dass es den
// Stand nicht kennt, statt zu raten.
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseTag(tag) {
  const m = SEMVER.exec(String(tag ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), raw: m[0] };
}

function compareTag(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) return 0;
  if (x.major !== y.major) return x.major < y.major ? -1 : 1;
  if (x.minor !== y.minor) return x.minor < y.minor ? -1 : 1;
  if (x.patch !== y.patch) return x.patch < y.patch ? -1 : 1;
  return 0;
}

// Neuester Tag aus einer Liste (unabhaengig von der Sortierung des Helfers).
export function newestTag(tags) {
  let best = null;
  for (const t of tags) {
    if (!parseTag(t)) continue;
    if (best === null || compareTag(t, best) > 0) best = t;
  }
  return best;
}

// Eine Pruefung durchfuehren. Wirft nie - "unbekannt" ist ein Ergebnis.
// Rueckgabe: { state, installed, available, reason, checkedAt }
export async function checkSelfUpdate() {
  const checkedAt = Date.now();

  const status = await getSelfUpdateStatus();
  if (!status.ok) {
    return {
      state: 'unknown',
      installed: null,
      available: null,
      reason: `Stand nicht lesbar: ${status.error}`,
      checkedAt,
    };
  }

  const installed = status.tag && parseTag(status.tag) ? status.tag : null;
  if (!installed) {
    // Kein Tag = Arbeitsstand (z.B. direkt auf einem Commit). Ein Vergleich
    // waere hier Spekulation.
    return {
      state: 'unknown',
      installed: null,
      available: null,
      reason: `Kein Release-Tag aktiv (${status.commit ?? '?'})`,
      checkedAt,
    };
  }

  // Nur geaenderte VERFOLGTE Dateien sperren die Aussage: bei denen kann ein
  // checkout etwas verwerfen. Neue Dateien (untracked) machen den Stand nicht
  // unbekannt - sie werden im Status gemeldet, mehr nicht.
  const trackedChanged = status.dirtyTracked === null
    ? (status.dirty ? 1 : 0)
    : status.dirtyTracked;
  if (trackedChanged > 0) {
    return {
      state: 'unknown',
      installed,
      available: null,
      reason: `Arbeitsstand: ${trackedChanged} geaenderte verfolgte Datei(en)`,
      checkedAt,
    };
  }

  let tags;
  try {
    tags = await listSelfUpdateTags();
  } catch (err) {
    return {
      state: 'unknown',
      installed,
      available: null,
      reason: `Abgleich nicht moeglich: ${err.message}`,
      checkedAt,
    };
  }

  const newest = newestTag(tags);
  if (!newest) {
    return {
      state: 'unknown',
      installed,
      available: null,
      reason: 'Keine Release-Tags gefunden',
      checkedAt,
    };
  }

  const cmp = compareTag(newest, installed);
  if (cmp > 0) {
    return { state: 'outdated', installed, available: newest, reason: null, checkedAt };
  }
  return { state: 'current', installed, available: newest, reason: null, checkedAt };
}

// --- Ergebnis des letzten Selbst-Updates -------------------------------------
//
// Beim apply startet der Helfer den Panel-Dienst neu. Die HTTP-Verbindung
// stirbt dabei, der Browser sieht 502 - obwohl das Update gelaufen ist. Der
// Nutzer kann aus dieser Antwort nicht unterscheiden: "Update erfolgreich,
// Panel gerade neu gestartet" oder "Update fehlgeschlagen".
//
// Deshalb legt der Helfer sein Ergebnis zusaetzlich als JSON ab (zweite Senke,
// keine zweite Wahrheit: dieselben Felder, die er auf stdout schreibt). Diese
// Funktion liest sie. Ist keine Datei da, gibt es schlicht nichts zu melden -
// das ist kein Fehler.
//
// Der Inhalt bleibt sichtbar, bis jemand ein neues Update startet (dann
// ueberschreibt der Helfer die Datei). Bewusst NICHT "einmal zeigen und
// loeschen": "das war das letzte Update, am 25.10." ist die ehrlichere Aussage
// als ein Hinweis, der beim naechsten Neuladen spurlos verschwindet.
const RESULT_FILE = '/opt/game-armory/.self-update-backup/last-result.json';

export async function getLastSelfUpdateResult() {
  let raw;
  try {
    raw = await readFile(RESULT_FILE, 'utf8');
  } catch {
    return null;   // keine Datei: noch nie gelaufen oder Verzeichnis geleert
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;   // halb geschriebene Datei: lieber nichts als Unsinn
  }
  if (!data || typeof data !== 'object') return null;
  const at = Number(data.at);
  return {
    result: typeof data.result === 'string' ? data.result : 'unknown',
    tag: typeof data.tag === 'string' ? data.tag : null,
    previous: typeof data.previous === 'string' ? data.previous : null,
    reason: typeof data.reason === 'string' ? data.reason : null,
    backup: typeof data.backup === 'string' ? data.backup : null,
    at: Number.isFinite(at) && at > 0 ? at * 1000 : null,
  };
}
