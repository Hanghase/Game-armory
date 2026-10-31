// Game-Armory - Fehlertabelle (M2, Audit 2026-10-22, umgesetzt 2026-10-31)
//
// Warum eine eigene Datei und nicht in auth.js mit untergebracht:
// auth.js ist die Benutzer-/Session-Domaene. Fehler gehoeren zu keiner
// Domaene, sie kommen aus jeder Route. Eine eigene kleine Datei mit eigener
// DB-Verbindung ist hier billiger als auth.js zu importieren (und damit
// dessen ganze Seiteneffekte: Tabellenanlage, bcrypt, Aufraeum-Timer).
//
// Bewusst begrenzt gehalten:
//   - hoechstens MAX_ROWS Zeilen, aelteste fliegen raus (kein unbegrenztes
//     Wachstum, sonst wird die DB nach Monaten dick)
//   - Fehlertext, Stapel, Anfrage-Daten nur bis zu einer festen Laenge
//   - KEINE Passwoerter, KEINE Cookies, KEINE Tokens. Objekt-Felder werden
//     feldnamen-basiert entfernt (scrub), Fehlertext und Stapel ueber
//     Muster (scrubFreeText). Beides ist eine Heuristik, keine Garantie -
//     Geheimnisse gehoeren gar nicht erst in Fehlertexte.
import Database from 'better-sqlite3';

const DB_PATH = '/opt/game-armory/data/armory.db';
const MAX_ROWS = 5000;
const MAX_TEXT = 4000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS error_log (
    id          TEXT PRIMARY KEY,
    at          INTEGER NOT NULL,
    method      TEXT,
    path        TEXT,
    status      INTEGER,
    message     TEXT,
    stack       TEXT,
    user_id     INTEGER,
    username    TEXT,
    ip          TEXT,
    request_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_error_log_at ON error_log(at DESC);
`);

// Schwaerzt Werte, die nie in einer Fehlertabelle landen sollen. Bewusst
// simpel gehalten (Feldname-basiert) - kein Versuch, Freitext zu verstehen.
const SECRET_KEYS = /pass(word)?|token|secret|api[_-]?key|cookie|authorization|session/i;

function scrub(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 3) return '[zu tief]';
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 30)) {
      out[k] = SECRET_KEYS.test(k) ? '[entfernt]' : scrub(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 200);
}

const insertStmt = () => db.prepare(`
  INSERT INTO error_log (id, at, method, path, status, message, stack, user_id, username, ip, request_id)
  VALUES (@id, @at, @method, @path, @status, @message, @stack, @user_id, @username, @ip, @request_id)
`);

let insert = insertStmt();
let count = 0;

// Schwaerzt Geheimnisse in FREITEXT (Fehlertext, Stapel).
// Warum es das braucht (Audit 2026-10-31): scrub() oben arbeitet ueber
// Objekt-FELDER ("password": "..." -> entfernt). Fehlertexte sind aber
// Freitext - dort steht kein JSON-Schluessel, sondern
// "Login fehlgeschlagen fuer password=GEHEIM-123". Genau das ging vorher
// ungefiltert in message und stack und von dort in das Log-Fenster.
//
// Ehrliche Einordnung: Das ist eine Heuristik, keine Garantie. Sie faengt
// die ueblichen Formen (key=wert, Bearer-Token, JWT). Ein Fehler, dessen Text
// ein Geheimnis in unbekannter Form traegt, kommt trotzdem durch. Die richtige
// Regel bleibt: Geheimnisse gehoeren nicht in Fehlertexte.
const FREE_TEXT_SCRUBS = [
  // key=wert / key: "wert" - Wert bis Whitespace/Komma/Anfuehrungszeichen.
  [/(pass(?:word|wort)?|token|secret|api[_-]?key|authorization)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&"']+)/gi,
    (_m, key) => `${key}=[entfernt]`],
  // Bearer-Token (auch mit Praefix im Text)
  [/(bearer)\s+[A-Za-z0-9._\-+/=]{8,}/gi, 'Bearer [entfernt]'],
  // JWT: eyJ...  .eyJ... .
  [/eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}/g, '[JWT entfernt]'],
  // Basic-Auth-Kopf
  [/(basic)\s+[A-Za-z0-9+/=]{8,}/gi, 'Basic [entfernt]'],
];

function scrubFreeText(value, max) {
  let out = String(value ?? '');
  for (const [re, rep] of FREE_TEXT_SCRUBS) out = out.replace(re, rep);
  return out.slice(0, max);
}

// Fasst einen Fehler zusammen. Gibt die persistierte Kennung zurueck.
export function recordError(err, req, { status = 500, id = null } = {}) {
  const requestId = id ?? Math.random().toString(36).slice(2, 10);
  try {
    insert.run({
      id: requestId,
      at: Date.now(),
      method: req?.method ?? null,
      path: String(req?.originalUrl ?? req?.url ?? '').slice(0, 500),
      status,
      message: scrubFreeText(err?.message ?? err ?? '', MAX_TEXT),
      stack: scrubFreeText(err?.stack ?? '', MAX_TEXT),
      user_id: req?.user?.id ?? null,
      username: req?.user?.username ? String(req.user.username).slice(0, 100) : null,
      ip: req?.ip ? String(req.ip).slice(0, 100) : null,
      request_id: requestId,
    });
    // Alle 100 Eintraege aufraeumen: aelteste ueber MAX_ROWS entfernen.
    if (++count % 100 === 0) pruneErrors();
  } catch (e) {
    // Die Fehlertabelle darf NIE den Fehlerpfad zum Absturz bringen.
    console.error(`[errorLog] Konnte Fehler nicht speichern: ${e.message}`);
  }
  return requestId;
}

export function pruneErrors() {
  try {
    db.prepare(`
      DELETE FROM error_log WHERE id NOT IN (
        SELECT id FROM error_log ORDER BY at DESC LIMIT ?
      )
    `).run(MAX_ROWS);
  } catch (e) {
    console.error(`[errorLog] Aufraeumen fehlgeschlagen: ${e.message}`);
  }
}

export function getRecentErrors({ limit = 50 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 50));
  return db.prepare(`
    SELECT id, at, method, path, status, message, user_id, username, ip
      FROM error_log ORDER BY at DESC LIMIT ?
  `).all(n);
}

export function getErrorById(id) {
  return db.prepare('SELECT * FROM error_log WHERE id = ?').get(String(id ?? '')) ?? null;
}

export function countErrors() {
  return db.prepare('SELECT COUNT(*) AS n FROM error_log').get().n;
}

// Nur fuer Tests/Diagnose.
export function __scrub(value) {
  return scrub(value);
}
