// Game-Armory - Audit-Spur (2026-11-26)
//
// Warum es das braucht: Ich stand vor der Frage "hast du die beiden User
// angelegt?" und konnte sie nicht beantworten. Nicht aus Nachlaessigkeit -
// das Panel hat es schlicht nie aufgeschrieben. Es gab eine Fehlertabelle
// (errorLog.js, entstanden aus einem Audit am 2026-10-22), aber die kennt nur
// Fehler. Ein Konto loeschen, eine Rolle aendern, ein Update fahren: davon
// blieb nichts, ausser einer Zeile im Log, die beim naechsten Rotieren weg war.
//
// Das ist die Luecke, die ein Audit schliesst: WER hat WAS WANN getan.
// Nicht "welche Anfrage ist gescheitert", sondern "welche Aenderung ist
// passiert". Beides zusammen ergibt erst eine Spur.
//
// Bauart bewusst wie errorLog.js - eine Domaene, eine kleine Datei:
//   - hoechstens MAX_ROWS Zeilen, aelteste fliegen raus (kein Wachstum ins Uferlose)
//   - KEINE Passwoerter, KEINE Tokens, KEINE Cookies. Dieselbe Feldnamen-
//     Heuristik, dieselbe ehrliche Einordnung: eine Heuristik ist keine
//     Garantie. Geheimnisse gehoeren nicht in Audit-Details.
//   - Schreiben darf NIE eine Aktion zum Scheitern bringen. Ein Audit, das
//     den Vorgang blockiert, weil die Platte voll ist, waere schlimmer als
//     kein Audit. Deshalb: try/catch um jeden Schreibvorgang, Fehler nur
//     auf stderr.
import Database from 'better-sqlite3';

const DB_PATH = process.env.ARMORY_DB_PATH || '/opt/game-armory/data/armory.db';
const MAX_ROWS = 20000;
const MAX_TEXT = 2000;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    action      TEXT NOT NULL,
    user_id     INTEGER,
    username    TEXT,
    target      TEXT,
    result      TEXT,
    detail      TEXT,
    ip          TEXT,
    request_id  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(username, at DESC);
`);

// Schwaerzt Werte, deren Feldname nach Geheimnis klingt. Gleiche Absicht wie
// in errorLog.js: lieber ein Feld zu viel entfernt als eines zu wenig.
const SECRET_KEYS = /pass(word|wort)?|token|secret|api[_-]?key|cookie|authorization|session|hash/i;

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

let insertStmt = null;
let anzahl = 0;

function insert() {
  if (insertStmt) return insertStmt;
  insertStmt = db.prepare(`
    INSERT INTO audit_log (at, action, user_id, username, target, result, detail, ip, request_id)
    VALUES (@at, @action, @user_id, @username, @target, @result, @detail, @ip, @request_id)
  `);
  return insertStmt;
}

// Aktionen mit festem Namen. Kein Freitext: ein Tippfehler im Aktionsnamen
// macht die Spur sonst unauffindbar. Neue Aktion hier eintragen.
export const AUDIT_ACTIONS = Object.freeze({
  LOGIN_OK: 'login.ok',
  LOGIN_FAIL: 'login.fail',
  LOGOUT: 'logout',
  USER_CREATE: 'user.create',
  USER_DELETE: 'user.delete',
  USER_ROLE: 'user.role',
  USER_PASSWORD: 'user.password',
  SWORD_UPDATE: 'sword.update',
  SWORD_CONFIG: 'sword.config',
  DOCKER_UPDATE: 'docker.update',
  RACK_CHANGE: 'rack.change',
  SETTINGS_CHANGE: 'settings.change',
  SELF_UPDATE: 'self.update',
});

/**
 * Eine Zeile in die Spur schreiben. Wirft nie - ein Audit-Fehler darf
 * niemals die eigentliche Aktion zum Scheitern bringen.
 *
 * @param {object} eintrag
 * @param {string} eintrag.action   aus AUDIT_ACTIONS
 * @param {string} [eintrag.result] 'ok' | 'fail' | 'denied' (Standard 'ok')
 * @param {object} [eintrag.user]   req.user ({id, username})
 * @param {string} [eintrag.target] woran es geschah ("user:57", "sword:nextcloud")
 * @param {object|string} [eintrag.detail] Zusatzangaben, wird geschwaerzt
 * @param {string} [eintrag.ip]
 * @param {string} [eintrag.requestId]
 */
export function audit(eintrag = {}) {
  try {
    const action = String(eintrag.action ?? '').slice(0, 80);
    if (!action) return false;

    let detail = null;
    if (eintrag.detail !== undefined && eintrag.detail !== null) {
      detail = typeof eintrag.detail === 'string'
        ? eintrag.detail.slice(0, MAX_TEXT)
        : JSON.stringify(scrub(eintrag.detail)).slice(0, MAX_TEXT);
    }

    const user = eintrag.user ?? null;
    insert().run({
      at: Date.now(),
      action,
      user_id: Number.isInteger(user?.id) ? user.id : null,
      username: typeof user?.username === 'string' ? user.username.slice(0, 80) : null,
      target: eintrag.target == null ? null : String(eintrag.target).slice(0, 120),
      result: eintrag.result == null ? 'ok' : String(eintrag.result).slice(0, 20),
      detail,
      ip: eintrag.ip == null ? null : String(eintrag.ip).slice(0, 60),
      request_id: eintrag.requestId == null ? null : String(eintrag.requestId).slice(0, 80),
    });

    // Aufraeumen nicht bei jedem Schreibvorgang (das waere eine zweite
    // Abfrage pro Aktion), sondern alle 500 Zeilen.
    anzahl += 1;
    if (anzahl % 500 === 0) {
      db.prepare(`
        DELETE FROM audit_log WHERE id NOT IN (
          SELECT id FROM audit_log ORDER BY id DESC LIMIT ?
        )
      `).run(MAX_ROWS);
    }
    return true;
  } catch (err) {
    // Sichtbar auf stderr, aber ohne den Vorgang zu stoeren.
    console.error(`[audit] Eintrag verworfen: ${err.message}`);
    return false;
  }
}

/**
 * Middleware: haengt audit() an die Antwort, damit die Route nur die
 * fachliche Aktion benennen muss. Kein automatisches Mitschnitt-Allerlei -
 * nur Routen, die auditRouten() ausdruecklich aufnehmen.
 */
export function auditRoute(action, beschreibe) {
  return (req, res, next) => {
    res.on('finish', () => {
      try {
        const info = typeof beschreibe === 'function' ? beschreibe(req, res) : {};
        if (info === false) return;
        audit({
          action,
          result: res.statusCode < 400 ? 'ok' : (res.statusCode === 403 ? 'denied' : 'fail'),
          user: req.user ?? null,
          target: info?.target ?? null,
          detail: info?.detail ?? null,
          ip: req.ip,
          requestId: req.requestId ?? res.getHeader?.('x-request-id') ?? null,
        });
      } catch (err) {
        console.error(`[audit] Middleware: ${err.message}`);
      }
    });
    next();
  };
}

export function listAudit({ limit = 100, action = null, username = null } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const wo = [];
  const args = [];
  if (action) { wo.push('action = ?'); args.push(String(action)); }
  if (username) { wo.push('username = ?'); args.push(String(username)); }
  const sql = 'SELECT * FROM audit_log'
    + (wo.length ? ' WHERE ' + wo.join(' AND ') : '')
    + ' ORDER BY id DESC LIMIT ?';
  args.push(n);
  return db.prepare(sql).all(...args);
}

export function countAudit() {
  return db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
}
