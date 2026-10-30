// Game-Armory - Auth & User-Verwaltung
// SQLite-basiert: User, Sessions, Rollen (admin / moderator / friend).
// Passwörter mit bcrypt. Sessions als httpOnly-Cookies.

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
// Rechte-Matrix 2.0 (Stufe 1). permissions.js importiert NICHTS aus auth.js,
// daher kein Circular-Import. loadPermissions() wird unten beim Start gerufen.
import { roleHasPerm, loadPermissions } from './permissions.js';
import { getSetting } from './settings.js';

// --- Passwort-Richtlinie (2026-10-22) --------------------------------------
// Vorher wurde NUR die Laenge geprueft (min. 8) - '12345678' kam damit durch.
// Diese Funktion ist die EINZIGE Stelle mit der Regel; alle Aufrufer
// (createUser, changeOwnPassword, setUserPassword, reset, invite) nutzen sie.
//
// Regeln:
//   1. mindestens 10 Zeichen
//   2. mindestens 3 der 4 Gruppen: Kleinbuchstaben, Grossbuchstaben, Ziffern,
//      Sonderzeichen
//   3. keine Wiederholung eines einzelnen Zeichens (aaaaaaaaaa)
//   4. nicht auf der Blockliste gaengiger Passwoerter
//   5. nicht (fast) gleich dem Benutzernamen
const PASSWORD_MIN_LENGTH = 10;

// Kleine Blockliste - die haeufigsten Passwoerter, bewusst kurz gehalten.
// Kein externes Paket: eine Abhaengigkeit weniger, die gepflegt werden muss.
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', '12345678910',
  'password', 'password1', 'password12', 'password123', 'passwort',
  'passwort1', 'passwort12', 'passwort123', 'qwertzuiop', 'qwertyuiop',
  'qwertz1234', 'qwerty1234', 'abcdefghij', 'abcd123456',
  'iloveyou1', 'welcome123', 'admin12345', 'administrator',
  'letmein123', 'football12', 'baseball12', 'sonnenschein',
  'schalke04', 'dortmund09', 'hallo12345', 'test123456',
]);

// --- Leak-Pruefung ueber Have I Been Pwned (k-anonymity, 2026-10-23) ------
// Die Formpruefung oben erkennt starke Passwoerter, aber keine bekannt
// geleakten: 'Test12345' besteht alle Regeln und steht trotzdem in jeder
// Woerterbuchliste. Deshalb zusaetzlich ein Abgleich gegen HIBP.
//
// Datenschutz: gesendet werden nur die ERSTEN 5 ZEICHEN des SHA-1-Hashes.
// Das Passwort selbst verlaesst den Server nie, HIBP sieht nur einen
// 5-stelligen Praefix, der auf ~800 Hashes passt.
//
// Fail-open: bei Netzfehler, Timeout oder Rate-Limit wird das Passwort
// DURCHGELASSEN und der Vorfall geloggt. Sonst blockiert ein HIBP-Ausfall
// jede Benutzeranlage und jede Passwortaenderung.
//
// Abschaltbar per Setting 'hibp_enabled' = 'false' (Default: an).
const HIBP_TIMEOUT_MS = 4000;
const HIBP_API = 'https://api.pwnedpasswords.com/range/';

function hibpEnabled() {
  return String(getSetting('hibp_enabled') ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * Fragt HIBP, ob das Passwort in bekannten Leaks auftaucht.
 * @returns {Promise<{checked: boolean, count: number, skipped?: string}>}
 *   checked=false bedeutet: nicht geprueft (Fehler/Timeout/abgeschaltet).
 */
async function hibpCheck(password) {
  if (!hibpEnabled()) return { checked: false, count: 0, skipped: 'disabled' };

  const sha1 = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const res = await fetch(HIBP_API + prefix, {
      headers: { 'User-Agent': 'game-armory-leak-check', 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(HIBP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();

    // Antwort: Zeilen "SUFFIX:COUNT". Add-Padding fuellt mit 0-Zaehlern auf,
    // damit die Antwortgroesse nichts verraet.
    for (const line of body.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      if (line.slice(0, idx).trim().toUpperCase() !== suffix) continue;
      const n = Number.parseInt(line.slice(idx + 1).trim(), 10);
      return { checked: true, count: Number.isFinite(n) ? n : 0 };
    }
    return { checked: true, count: 0 };
  } catch (err) {
    // Fail-open: durchlassen, aber sichtbar machen.
    console.error('[armory] HIBP-Pruefung fehlgeschlagen (Passwort durchgelassen):', err.message);
    return { checked: false, count: 0, skipped: err.message };
  }
}

/**
 * Prueft ein Passwort gegen die Richtlinie. Wirft Error mit klarer Meldung.
 * @param {string} password
 * @param {string} [username] - optional: Passwort darf nicht der Name sein
 */
export async function validatePassword(password, username = '') {
  const pw = String(password ?? '');

  if (pw.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Passwort zu kurz (min. ${PASSWORD_MIN_LENGTH} Zeichen)`);
  }

  // Blockliste ZUERST: sonst meldet ein verbreitetes Passwort wie 'password12'
  // nur "3 der 4 Gruppen" und der Nutzer erfaehrt nicht, dass es bekannt ist.
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    throw new Error('Dieses Passwort ist zu verbreitet - bitte ein anderes waehlen');
  }

  if (/^(.)\1*$/.test(pw)) {
    throw new Error('Passwort darf nicht aus einem einzigen wiederholten Zeichen bestehen');
  }

  const groups = [
    /[a-z]/.test(pw),            // Kleinbuchstaben
    /[A-Z]/.test(pw),            // Grossbuchstaben
    /[0-9]/.test(pw),            // Ziffern
    /[^a-zA-Z0-9]/.test(pw),     // Sonderzeichen
  ].filter(Boolean).length;
  if (groups < 3) {
    throw new Error('Passwort braucht mindestens 3 der 4 Gruppen: Kleinbuchstaben, Grossbuchstaben, Ziffern, Sonderzeichen');
  }

  const name = String(username ?? '').trim().toLowerCase();
  if (name.length >= 3 && pw.toLowerCase().includes(name)) {
    throw new Error('Passwort darf den Benutzernamen nicht enthalten');
  }

  // Zuletzt: bekannte Leaks. Bewusst NACH allen Formregeln - ein zu kurzes
  // Passwort soll 'zu kurz' melden, nicht 'geleakt'.
  const leak = await hibpCheck(pw);
  if (leak.checked && leak.count > 0) {
    throw new Error(
      `Dieses Passwort taucht in bekannten Datenleaks auf (${leak.count.toLocaleString('de-DE')}x) - bitte ein anderes waehlen`
    );
  }

  return true;
}

const DB_PATH = '/opt/game-armory/data/armory.db';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 Tage

// Rang-Hierarchie (Level 0-4): superuser > admin > moderator > friend > strangerdanger
//   strangerdanger = 0  nur Server-Status lesen (keine Live-Konsole, keine Aktionen)
//   friend         = 1  darf NUR 'start' ausfuehren
//   moderator      = 2  stop/restart/config/update
//   admin          = 3  Swords anlegen/loeschen, Racks, Nutzer, EULA, reload
//   superuser      = 4  Armory-Grundkonfig (Settings/API-Keys)
export const ROLES = ['strangerdanger', 'friend', 'moderator', 'admin', 'superuser'];
export const ROLE_LEVEL = { strangerdanger: 0, friend: 1, moderator: 2, admin: 3, superuser: 4 };

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'friend',
    created_at INTEGER NOT NULL,
    -- E-Mail fuer Passwort-Reset und Einladungen. Kam nach dem ersten
    -- Schema dazu: bestehende Datenbanken bekommen sie per Migration
    -- weiter unten, frische Installationen direkt hier.
    email TEXT,
    -- Darstellung je Nutzer (JSON): z.B. {"theme":"light"}.
    -- NULL = noch nichts gewaehlt, dann gilt der Standard (dunkel).
    prefs TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  -- Brute-Force-Schutz: Fehlversuche je Client-IP, inkl. Sperrzeitpunkt.
  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    fails INTEGER NOT NULL DEFAULT 0,
    first_fail_at INTEGER NOT NULL,
    banned_until INTEGER
  );
  -- Einmal-Token fuer Passwort-Reset und Einladungen. Gehalten wird nur der
  -- HASH des Tokens, nie der Token selbst: wer die Datenbank liest, kann
  -- damit keinen Reset ausloesen. used_at ist NULL solange unverbraucht.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    purpose    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Migration: spaeter hinzugekommene Spalten. CREATE TABLE IF NOT EXISTS
// aendert eine bestehende Tabelle NICHT - deshalb hier nachziehen.
// WICHTIG: Jede Spalte, die im CREATE TABLE oben steht und irgendwo benutzt
// wird (createUser, listUsers, setUserEmail), MUSS hier auftauchen. Sonst
// laeuft eine bestehende Installation weiter, aber eine frische bricht beim
// ersten Schreibvorgang mit "no such column" ab. (2026-10-25: email fehlte)
(() => {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const add = (name, ddl) => {
    if (cols.includes(name)) return;
    db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
    console.log(`[auth] Migration: users.${name} angelegt`);
  };
  add('email', 'email TEXT');
  add('prefs', 'prefs TEXT');
})();

// --- Darstellung je Nutzer ---------------------------------------------------
// prefs ist ein JSON-Objekt. Unbekannte Schluessel werden beim Lesen verworfen,
// damit ein alter/verbogener Wert das Frontend nicht durcheinanderbringt.
const THEMES = ['dark', 'light'];

export function getUserPrefs(userId) {
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId);
  const out = { theme: 'dark' };
  if (!row || !row.prefs) return out;
  try {
    const parsed = JSON.parse(row.prefs);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (THEMES.includes(parsed.theme)) out.theme = parsed.theme;
    }
  } catch {
    /* ungueltig -> Standard */
  }
  return out;
}

export function setUserPrefs(userId, patch) {
  const next = getUserPrefs(userId);
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    if (THEMES.includes(patch.theme)) next.theme = patch.theme;
  }
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(next), userId);
  return next;
}

// --- Setup-Hilfe: ersten Admin anlegen, falls keine User existieren ---------
export function hasUsers() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  return row.n > 0;
}

export async function createUser(username, password, role = 'friend', email = null) {
  if (!ROLES.includes(role)) throw new Error(`Ungültige Rolle: ${role}`);
  if (!username || username.length < 3) throw new Error('Username zu kurz (min. 3 Zeichen)');
  await validatePassword(password, username);

  const hash = bcrypt.hashSync(password, 12);
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role, created_at, email) VALUES (?, ?, ?, ?, ?)')
      .run(username, hash, role, Date.now(), email ? String(email).trim() : null);
    return { id: info.lastInsertRowid, username, role };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error('Username bereits vergeben');
    throw err;
  }
}

// --- Passwort-Aenderung / -Reset -------------------------------------------
// Fehler-Strategie: es wird IMMER ein Error geworfen (kein null-Rueckgabewert),
// konsistent zu createUser/setRole. Die Route-Handler fangen das ab und antworten
// mit 400 + {error}. Dadurch bleibt genau ein Fehlerkanal, und der Aufrufer kann
// nicht versehentlich einen stillen null-Fall als Erfolg behandeln.
// Kein Rueckgabewert enthaelt je Passwort oder Hash.

// 2026-10-25: loescht die Sessions des Nutzers genauso wie der Admin-Reset.
// Begruendung: Wer sein Passwort aendert, tut das (auch) dann, wenn er glaubt,
// dass jemand anderes seines kennt. Blieben die alten Sessions gueltig, waere
// die Aenderung wirkungslos - der Angreifer saesse weiter drin. Die eigene
// Sitzung wird danach ueber keepSessionId am Leben gehalten, damit den Nutzer
// nicht seine eigene Anmeldung rauswirft.
export async function changeOwnPassword(userId, currentPassword, newPassword, keepSessionId = null) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Benutzer nicht gefunden');
  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new Error('Aktuelles Passwort ist falsch');
  }
  await validatePassword(newPassword, user.username);

  const hash = bcrypt.hashSync(newPassword, 12);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    if (keepSessionId) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, keepSessionId);
    } else {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  });
  tx();
  return true;
}

// Admin-Reset: setzt ein neues Passwort OHNE Pruefung des aktuellen Passworts.
// 2026-10-22: loescht dabei ALLE Sessions des Nutzers. Vorher blieb eine bereits
// bestehende (ggf. gestohlene) Session nach einem Passwort-Reset weiter gueltig -
// der Reset haette einen Angreifer also nicht hinausgeworfen.
export async function setUserPassword(userId, newPassword) {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Benutzer nicht gefunden');
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  await validatePassword(newPassword, row?.username ?? '');

  const hash = bcrypt.hashSync(newPassword, 12);
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  });
  tx();
  return true;
}

export function verifyLogin(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, role: user.role, email: user.email ?? null };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(`SELECT u.id, u.username, u.role, u.email, s.expires_at
              FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.token = ?`)
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  // email MUSS mit: das Panel zeigt sie im Konto-Tab an. Fehlt sie hier,
  // sieht der Nutzer seine hinterlegte Adresse nie und tippt sie im Zweifel
  // immer wieder neu ein.
  return { id: row.id, username: row.username, role: row.role, email: row.email ?? null };
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function listUsers() {
  return db.prepare('SELECT id, username, role, created_at, email FROM users ORDER BY id').all();
}

export function deleteUser(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// Zaehlt aktive Superuser - Basis fuer den Lockout-Schutz in authRoutes.
// Wird ueber einen Helper in authRoutes aufgerufen (requireRole schuetzt die Route).
export function countSuperusers() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'superuser'").get();
  return row ? row.n : 0;
}

export function getRole(id) {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  return row ? row.role : null;
}

// --- Token fuer Passwort-Reset und Einladung -------------------------------
// Sicherheit: In der DB liegt NUR der SHA-256-Hash des Tokens, nie der Token.
// Ein DB-Leak gibt damit keine gueltigen Links preis. Der Token ist
// hoch-entropisch (32 Byte), daher reicht SHA-256 (kein bcrypt noetig).

const TOKEN_TTL_RESET_MS  = 60 * 60 * 1000;   // 60 Minuten
const TOKEN_TTL_INVITE_MS = 60 * 60 * 1000;   // 60 Minuten

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Erzeugt einen Einmal-Token fuer einen Zweck ('reset' | 'invite') und gibt
// den KLARTEXT-Token zurueck (nur dieser Moment - danach nur noch der Hash).
export function createAuthToken(userId, purpose) {
  if (purpose !== 'reset' && purpose !== 'invite') throw new Error(`Unbekannter Zweck: ${purpose}`);
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = purpose === 'invite' ? TOKEN_TTL_INVITE_MS : TOKEN_TTL_RESET_MS;
  // Alte, noch offene Token desselben Zwecks entwerten (nur einer gueltig).
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(`INSERT INTO auth_tokens (token_hash, user_id, purpose, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?)`).run(hashToken(token), userId, purpose, now, now + ttl);
  return { token, expiresMinutes: Math.round(ttl / 60000) };
}

// Loest einen Token ein. Rueckgabe: { userId, purpose } oder null.
// Der Token wird als verbraucht markiert (Einmalverwendung).
export function consumeAuthToken(token, purpose) {
  if (!token || typeof token !== 'string') return null;
  const h = hashToken(token);
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(h);
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.used_at) return null;
  if (row.expires_at < Date.now()) return null;
  db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), h);
  return { userId: row.user_id, purpose: row.purpose };
}

export function setUserEmail(id, email) {
  const v = email ? String(email).trim() : null;
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(v, id);
}

export function getUserByEmail(email) {
  if (!email) return null;
  const row = db.prepare('SELECT id, username, role, email FROM users WHERE email = ?').get(String(email).trim());
  return row ?? null;
}

export function getUserById(id) {
  const row = db.prepare('SELECT id, username, role, email FROM users WHERE id = ?').get(id);
  return row ?? null;
}

// Entfernt abgelaufene/verbrauchte Token (Hausputz bei jedem Aufruf).
export function pruneAuthTokens() {
  const n = db.prepare('DELETE FROM auth_tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(Date.now());
  return n.changes;
}

export function setRole(id, role) {
  if (!ROLES.includes(role)) throw new Error(`Ungültige Rolle: ${role}`);
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

// --- Express-Middleware ----------------------------------------------------

export function requireAuth(req, res, next) {
  const user = getSessionUser(req.cookies?.armory_session);
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  req.user = user;
  next();
}

// Mindest-Rang erforderlich, z.B. requireRole('admin') oder requireRole('moderator')
// Kompatibilitaet: bleibt bestehen (Stufe 1). Neue Routen nutzen requirePerm.
export function requireRole(minRole) {
  const minLevel = ROLE_LEVEL[minRole];
  return (req, res, next) => {
    const user = getSessionUser(req.cookies?.armory_session);
    if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' });

    // Audit-Fix 2026-10-30 (D107): Fail-closed statt Fail-open.
    // Vorher: ROLE_LEVEL[user.role] war fuer eine unbekannte Rolle `undefined`;
    // `undefined < 3` ist false, also ging die Anfrage DURCH. Eine Rolle, die
    // nicht in der Liste steht (Altbestand nach Umbenennung, Manipulation an der
    // DB), bekam damit jedes Recht. Jetzt gilt: unbekannte Rolle oder unbekannte
    // Mindestrolle = kein Zugriff.
    const userLevel = ROLE_LEVEL[user.role];
    if (typeof userLevel !== 'number' || typeof minLevel !== 'number') {
      console.error(
        `[auth] Unbekannte Rolle abgewiesen: user.role=${String(user.role)}, `
          + `minRole=${String(minRole)}`,
      );
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    if (userLevel < minLevel) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    req.user = user;
    next();
  };
}

// Rechte-basierte Middleware (Rechte-Matrix 2.0): prueft ein NAMENTLICHES Recht
// statt einen Rang, z.B. requirePerm('sword.control.stop').
//   401 nicht eingeloggt, 403 Recht fehlt, sonst req.user setzen.
// superuser liefert ueber roleHasPerm IMMER true.
export function requirePerm(perm) {
  return (req, res, next) => {
    const user = getSessionUser(req.cookies?.armory_session);
    if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' });
    if (!roleHasPerm(user.role, perm)) {
      return res.status(403).json({ error: 'Keine Berechtigung' });
    }
    req.user = user;
    next();
  };
}

// Rechte-Matrix initialisieren/migrieren (idempotent). Wird beim Start gerufen,
// damit die Tabellen existieren, bevor requirePerm sie liest.
loadPermissions();

export function cleanupExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}


// --- Brute-Force-Schutz ------------------------------------------------------
// Zaehlt Login-Fehlversuche je Client-IP. Ueberschreitet die Zahl innerhalb des
// Beobachtungsfensters das Limit, wird die IP fuer die Sperrdauer blockiert.
// Die Schwellen kommen aus den (Admin-)Einstellungen; Defaults siehe
// settings.js -> NUMERIC_SETTINGS.

// IPs, die NIE gesperrt werden. Vorgabe: nur lokal - so kann sich niemand
// durch eine hinterlegte Adresse dauerhaft freihalten.
//
// Frueher standen hier die Adressen des Betreibers fest im Code. Das gehoert
// nicht ins Repository: eine IP verraet, welche Maschine das Panel betreibt.
// Wer sich selbst vor Sperren schuetzen will, traegt seine Adressen in der
// Einstellung 'login_whitelist' ein (kommagetrennt).
export function getLoginWhitelist() {
  const base = new Set(['127.0.0.1', '::1']);
  let raw = '';
  try {
    raw = getSetting('login_whitelist') ?? '';
  } catch {
    raw = '';
  }
  for (const part of String(raw).split(',')) {
    const ip = part.trim();
    if (ip) base.add(ip);
  }
  return base;
}

function rowForIp(ip) {
  return db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
}

// Ist die IP aktuell gesperrt? Liefert die Restzeit in ms (0 = nicht gesperrt).
export function loginBanRemainingMs(ip, now = Date.now()) {
  if (!ip || getLoginWhitelist().has(ip)) return 0;
  const row = rowForIp(ip);
  if (!row || !row.banned_until) return 0;
  const rest = row.banned_until - now;
  if (rest <= 0) {
    db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
    return 0;
  }
  return rest;
}

// Fehlversuch verbuchen. Gibt zurueck, ob dadurch eine Sperre aktiv wurde.
export function recordLoginFailure(ip, { maxFails, windowMs, banMs }, now = Date.now()) {
  if (!ip || getLoginWhitelist().has(ip)) return { banned: false };
  const row = rowForIp(ip);
  let fails = 1;
  let firstFailAt = now;
  if (row) {
    // Fenster abgelaufen -> Zaehler neu starten.
    if (now - row.first_fail_at > windowMs) {
      fails = 1;
    } else {
      fails = row.fails + 1;
      firstFailAt = row.first_fail_at;
    }
  }
  const banned = fails >= maxFails;
  const bannedUntil = banned ? now + banMs : null;
  db.prepare(`
    INSERT INTO login_attempts (ip, fails, first_fail_at, banned_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      fails = excluded.fails,
      first_fail_at = excluded.first_fail_at,
      banned_until = excluded.banned_until
  `).run(ip, fails, firstFailAt, bannedUntil);
  return { banned, fails };
}

// Nach erfolgreichem Login den Zaehler der IP loeschen.
export function clearLoginFailures(ip) {
  if (!ip) return;
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

// Aufraeumen abgelaufener Eintraege (periodisch aufrufen).
export function cleanupLoginAttempts(now = Date.now()) {
  const n = db.prepare(
    'DELETE FROM login_attempts WHERE banned_until IS NOT NULL AND banned_until < ?'
  ).run(now).changes;
  return n;
}
