// Speicherschicht fuer Arsenale (Kopplung + Lebenszeichen).
//
// Eigene DB-Verbindung wie in auth.js/settings.js/errorLog.js - das ist das
// Muster dieses Projekts, keine gemeinsame Verbindung.
//
// WAS HIER NIE LIEGT: der Kopplungscode im Klartext und der Arsenal-Schluessel
// im Klartext. Gespeichert wird ausschliesslich der SHA-256-Hash. Ein DB-Abzug
// bringt damit keinen gueltigen Schluessel hervor.

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
  PAIRING_TTL_MS,
  hashSecret,
  generatePairingCode,
  normalizePairingCode,
  isPairingExpired,
} from './arsenals.js';

// DB-Pfad: im Betrieb der feste Pfad. Ueber ARMORY_DB_PATH umlenkbar, damit
// Tests gegen eine Wegwerf-DB laufen und nicht gegen die echte. Ohne die
// Variable verhaelt sich das Modul exakt wie die uebrigen (hartkodiert).
const DB_PATH = process.env.ARMORY_DB_PATH || '/opt/game-armory/data/armory.db';
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS arsenals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    key_hash      TEXT    NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    last_version  TEXT,
    revoked_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_arsenals_last_seen ON arsenals(last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS arsenal_pairings (
    code_hash   TEXT    PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used_at     INTEGER
  );
`);

// ---------- Kopplungscode am Arsenal erzeugen ----------

// Gibt den Code im KLARTEXT zurueck - nur dieser eine Moment. Danach existiert
// nur noch der Hash. Ist ein alter, unbenutzter Code offen, wird er entwertet:
// es gilt immer genau ein Code.
export function createPairing({ now = Date.now() } = {}) {
  const code = generatePairingCode();
  const codeHash = hashSecret(code);
  const expiresAt = now + PAIRING_TTL_MS;
  db.prepare('DELETE FROM arsenal_pairings WHERE used_at IS NULL').run();
  db.prepare(`INSERT INTO arsenal_pairings (code_hash, created_at, expires_at)
              VALUES (?, ?, ?)`).run(codeHash, now, expiresAt);
  return { code, expiresAt, ttlMinutes: Math.round(PAIRING_TTL_MS / 60000) };
}

// ---------- Code in der Armory einloesen ----------

// Rueckgabe:
//   { ok: true, arsenal: {...}, key: '<Klartext, EINMAL>' }
//   { ok: false, reason: 'bad-code' | 'expired' | 'already-used' | 'bad-name' }
export function redeemPairing({ code, name, now = Date.now() } = {}) {
  const normalized = normalizePairingCode(code);
  if (!normalized) return { ok: false, reason: 'bad-code' };

  const cleanName = typeof name === 'string' ? name.trim() : '';
  if (cleanName.length === 0 || cleanName.length > 64) {
    return { ok: false, reason: 'bad-name' };
  }

  const codeHash = hashSecret(normalized);
  const row = db.prepare('SELECT * FROM arsenal_pairings WHERE code_hash = ?').get(codeHash);
  if (!row) return { ok: false, reason: 'bad-code' };
  if (row.used_at) return { ok: false, reason: 'already-used' };
  if (isPairingExpired(row.created_at, now)) return { ok: false, reason: 'expired' };

  // Der Schluessel entsteht IN DER ARMORY und geht an das Arsenal zurueck.
  // Anders als der Kopplungscode wird er nie angezeigt - nur einmal uebertragen.
  const key = crypto.randomBytes(32).toString('base64url');
  const keyHash = hashSecret(key);

  const tx = db.transaction(() => {
    // Einmalverwendung: erst als benutzt markieren, dann anlegen. Wenn das
    // Anlegen scheitert, ist der Code trotzdem verbraucht - ein zweiter
    // Versuch mit demselben Code darf nicht moeglich sein.
    db.prepare('UPDATE arsenal_pairings SET used_at = ? WHERE code_hash = ?').run(now, codeHash);
    const info = db.prepare(`INSERT INTO arsenals (name, key_hash, created_at)
                             VALUES (?, ?, ?)`).run(cleanName, keyHash, now);
    return info.lastInsertRowid;
  });

  let id;
  try {
    id = tx();
  } catch (err) {
    // Schluessel-Kollision ist praktisch ausgeschlossen (32 Byte), aber ein
    // Fehler hier darf nicht als "hat geklappt" nach aussen gehen.
    return { ok: false, reason: 'bad-code' };
  }

  return {
    ok: true,
    arsenal: { id, name: cleanName, created_at: now },
    key,
  };
}

// ---------- Lebenszeichen ----------

export function touchHeartbeat({ id, now = Date.now(), version = null } = {}) {
  const info = db.prepare(`UPDATE arsenals SET last_seen_at = ?, last_version = COALESCE(?, last_version)
                           WHERE id = ? AND revoked_at IS NULL`).run(now, version, id);
  return info.changes > 0;
}

export function getArsenal(id) {
  return db.prepare('SELECT * FROM arsenals WHERE id = ?').get(id) ?? null;
}

export function getArsenalByKeyHash(keyHash) {
  return db.prepare('SELECT * FROM arsenals WHERE key_hash = ?').get(keyHash) ?? null;
}

export function listArsenals() {
  return db.prepare('SELECT * FROM arsenals ORDER BY name ASC').all();
}

export function revokeArsenal(id, now = Date.now()) {
  const info = db.prepare('UPDATE arsenals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(now, id);
  return info.changes > 0;
}

// Raeumt abgelaufene, unbenutzte Kopplungscodes weg. Wird beim Erzeugen und
// Einloesen mit aufgerufen (siehe oben), damit die Tabelle nicht waechst.
export function pruneExpiredPairings(now = Date.now()) {
  const info = db.prepare('DELETE FROM arsenal_pairings WHERE used_at IS NULL AND expires_at <= ?')
    .run(now);
  return info.changes;
}

export { db };
