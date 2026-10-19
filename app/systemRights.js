// Game-Armory - Systemrechte (ehrlicher Report statt kryptischer Fehler)
//
// Die Armory laeuft als 'armory'. Privilegierte Aktionen laufen ueber drei
// Helfer in /usr/local/bin, jeweils per 'sudo -n':
//   install     -> armory-install-helper
//   service     -> armory-service-ctl
//   selfUpdate  -> armory-self-update
//
// Auf Kundenrechnern ist die sudo-Lage nicht garantiert:
//   (a) sudoers-Regel da          -> 'ok'
//   (b) sudo verlangt Passwort    -> 'password-required'
//   (c) kein sudo / keine Regel   -> 'denied' (bzw. 'missing', wenn die Datei fehlt)
//
// Das Panel soll das VOR dem Klick melden koennen, statt danach mit einem
// unverstaendlichen Fehler zu scheitern.
//
// Zwei Funktionen, bewusst getrennt:
//   getRightsStatus()  - SYNCHRON, liefert nur den Cache (initial detected:false).
//                        Darf niemals blockieren, wird im Request-Pfad benutzt.
//   detectRights()     - die eigentliche Messung (async). Wirft nie.
//
// Messmuster: Jeder Helfer wird OHNE Argumente aufgerufen. Dann geben alle
// drei 'usage' bzw. 'Unerlaubte Aktion' auf stderr aus und beenden mit exit 2
// (siehe usage() in armory-install-helper und armory-self-update, Schritt 1
// in armory-service-ctl). Das ist ein harmloser Seiteneffekt-freier Beweis,
// dass sudo -n durchgeht. Ein einzelner Helfer wird NICHT per 'is-active' oder
// 'logs' geprueft - das braucht einen registrierten Service.
//
// Annahme (konservativ): Ein exit-Code 2 bedeutet 'ok', egal an welcher Stelle
// das Skript aus usage/-Whitelist-Gruenden abbricht - in allen drei Skripten
// steht dieser Abbruch VOR jeder systemveraendernden Aktion.

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { userInfo } from 'node:os';

// Pfad und Anzeigename der drei Helfer. Reihenfolge = Reihenfolge im Report.
const HELPERS = [
  { key: 'install',    path: '/usr/local/bin/armory-install-helper' },
  { key: 'service',    path: '/usr/local/bin/armory-service-ctl' },
  { key: 'selfUpdate', path: '/usr/local/bin/armory-self-update' },
];

const REPO_DIR = '/opt/game-armory';
const PROBE_TIMEOUT_MS = 5000;
const SUDO_BIN = '/usr/bin/sudo';

// Cache. Startwert detected:false -> das UI sieht 'unknown' bis zur ersten
// Messung, NICHT 'blocked' (sonst meldet ein frisch gestarteter Server
// faelschlich "keine Rechte").
let cache = {
  detected: false,
  detectedAt: null,
  user: null,
  uid: null,
  gid: null,
  repoWritable: null,
  helpers: { install: 'unknown', service: 'unknown', selfUpdate: 'unknown' },
  summary: 'unknown',
};

// --- Prozess-/Repo-Kontext (synchron, billig) ------------------------------

function processFacts() {
  let user = null;
  try { user = userInfo().username; } catch { user = null; }

  let repoWritable = false;
  try {
    accessSync(REPO_DIR, constants.W_OK);
    repoWritable = true;
  } catch {
    // EACCES/ENOENT -> nicht schreibbar. Kein Sonderfall, nur eine Antwort.
    repoWritable = false;
  }

  return {
    user,
    // getuid/getgid gibt es nur unter POSIX; auf Windows wuerde getuid werfen.
    // Dann bleibt der Wert null statt zu crashen.
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    repoWritable,
  };
}

// --- Einzelprobe -----------------------------------------------------------

// Klassifiziert stderr/exit eines Helfer-Aufrufs. Immer ein gueltiger Wert.
function classify(code, stderr) {
  const err = String(stderr || '').toLowerCase();

  // sudo -n ohne passende sudoers-Regel / ohne Passwort.
  if (err.includes('a password is required') || err.includes('a terminal is required')) {
    return 'password-required';
  }
  // sudo verweigert (keine Regel, oder kein tty erlaubt).
  if (err.includes('not allowed') || err.includes('no tty present') || err.includes('is not in the sudoers')) {
    return 'denied';
  }
  // Helfer selbst meldet usage -> sudo laeuft, Skript wurde ausgefuehrt.
  if (code === 0 || code === 2) return 'ok';
  // Alles andere (exit 1 ohne Passwort-Text, exit 3, Signal ...) = unspezifisch.
  return 'error';
}

function probeHelper(helper) {
  return new Promise((resolve) => {
    // 1) Datei vorhanden + ausfuehrbar? Ohne das braucht man sudo gar nicht.
    try {
      accessSync(helper.path, constants.X_OK);
    } catch {
      resolve(existsSync(helper.path) ? 'denied' : 'missing');
      return;
    }

    // 2) sudo -n <helfer> ohne Argumente -> exit 2 + usage auf stderr.
    execFile(
      SUDO_BIN,
      ['-n', helper.path],
      { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          // Kein Fehlerobjekt = exit 0.
          resolve('ok');
          return;
        }
        if (error.killed || error.signal === 'SIGKILL' || error.code === 'ETIMEDOUT') {
          resolve('timeout');
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        if (code === null) {
          // ENOENT (kein sudo installiert), EACCES o.ae.
          const msg = String(error.message || '').toLowerCase();
          resolve(msg.includes('enoent') ? 'denied' : 'error');
          return;
        }
        resolve(classify(code, stderr));
      },
    );
  }).catch(() => 'error');   // niemals werfen
}

// --- Zusammenfassung -------------------------------------------------------

function summarize(helpers) {
  const values = HELPERS.map((h) => helpers[h.key]);
  if (values.every((v) => v === 'ok')) return 'ok';

  // 'blocked' = nichts geht: jeder Helfer ist missing oder denied.
  // Alles andere (Mischung, timeout, error, password-required) heisst 'partial',
  // damit ein Teilausfall im UI als "teilweise" sichtbar bleibt.
  if (values.every((v) => v === 'missing' || v === 'denied')) return 'blocked';
  return 'partial';
}

// --- Oeffentliche API ------------------------------------------------------

// Wie oben, aber ohne Zeitautomatik: gemessen wird beim Start (server.js ruft
// detectRights()) und auf ausdruecklichen Wunsch (POST /api/system/rights/recheck).
// Grund (2026-10-19): Rechte aendern sich nur, wenn jemand die sudoers-Datei
// anfasst - und dann folgt ohnehin ein Neustart. Ein Timer wuerde nur alle
// 60 s einen sudo-Login ins Journal schreiben, ohne neue Erkenntnis.
export function getRightsStatus() {
  return cache;
}

// Erzwungene Neumessung fuer den Knopf im Panel. Wirft nie.
export async function recheckRights() {
  try {
    return await detectRights();
  } catch {
    return cache;
  }
}

// Die eigentliche Messung. Wirft nie, setzt immer den Cache und gibt ihn zurueck.
export async function detectRights() {
  const facts = processFacts();
  const helpers = {};

  // nacheinander waere 3 x bis zu 5 s = 15 s; parallel haelt die Gesamtzeit
  // bei max. 5 s. Die Proben sind unabhaengig voneinander.
  const results = await Promise.all(HELPERS.map((h) => probeHelper(h)));
  HELPERS.forEach((h, i) => { helpers[h.key] = results[i]; });

  const next = {
    detected: true,
    detectedAt: Date.now(),
    user: facts.user,
    uid: facts.uid,
    gid: facts.gid,
    repoWritable: facts.repoWritable,
    helpers,
    summary: summarize(helpers),
  };

  cache = next;
  return { ...next, helpers: { ...helpers } };
}
