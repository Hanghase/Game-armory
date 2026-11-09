// Arsenale: mehrere Maschinen unter einer Armory.
//
// Kopplung laeuft andersherum als man vermuten wuerde: das ARSENAL erzeugt den
// Kopplungscode, die Armory tippt ihn ein. Dadurch muss am Arsenal kein Port
// nach aussen offen sein, und es funktioniert im Heimnetz wie im Internet.
//
// Sicherheit (Muster uebernommen aus app/auth.js:auth_tokens):
// - in der DB liegt NUR der SHA-256-Hash, nie der Code oder der Schluessel
// - der Kopplungscode ist einmalig und kurz gueltig
// - der Schluessel ist hoch-entropisch (32 Byte) -> SHA-256 reicht
//
// ASCII in Kommentaren und Fehlertexten, deutsche Umlaute nur in sichtbaren
// Labels (Projektregel, siehe AGENTS.md).

import crypto from 'node:crypto';

// Ein Kopplungscode gilt 15 Minuten. Lang genug, um ihn abzutippen; kurz genug,
// dass ein abgelesener Code nichts mehr wert ist.
export const PAIRING_TTL_MS = 15 * 60 * 1000;

// Ein Arsenal gilt als "online", wenn sein letztes Lebenszeichen juenger ist
// als das Doppelte des Intervalls (30s Melden -> 90s Toleranz). Die Toleranz
// deckt einen verpassten Zyklus ab, ohne einen toten Rechner zu lange als
// lebendig zu zeigen.
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const HEARTBEAT_STALE_MS = 90 * 1000;

// Kopplungscode: 8 Zeichen aus einem Alphabet ohne Verwechslungspaare
// (kein 0/O, kein 1/I/L). Wird in Zweiergruppen gezeigt: XXXX-XXXX.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Erzeugt einen Kopplungscode im Klartext. Der Aufrufer zeigt ihn EINMAL an
// und speichert nur den Hash.
export function generatePairingCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

// Normalisiert eine Nutzereingabe: Grossbuchstaben, ohne Trenner.
// "abcd-efgh" -> "ABCDEFGH". Gibt null zurueck, wenn die Form nicht passt.
export function normalizePairingCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

export function formatPairingCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LENGTH) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Ist ein Kopplungscode abgelaufen? `now` ist injizierbar, damit Tests die
// Zeit steuern koennen, statt 15 Minuten zu warten.
export function isPairingExpired(createdAt, now = Date.now()) {
  if (!Number.isFinite(createdAt)) return true;
  return now - createdAt >= PAIRING_TTL_MS;
}

// Zustand eines Arsenals aus Sicht der Armory.
// Wichtig: 'unknown' und 'offline' sind NICHT dasselbe. Ein Arsenal, das noch
// nie ein Lebenszeichen geschickt hat, ist unbekannt - nicht bewiesen tot.
export function arsenalState(arsenal, now = Date.now()) {
  if (!arsenal || typeof arsenal !== 'object') return 'unknown';
  if (arsenal.revoked_at) return 'revoked';
  if (!Number.isFinite(arsenal.last_seen_at)) return 'unknown';
  const age = now - arsenal.last_seen_at;
  if (age >= HEARTBEAT_STALE_MS) return 'offline';
  return 'online';
}

// Prueft das Lebenszeichen eines Arsenals. Rueckgabe:
//   { ok: true } oder { ok: false, reason }
// Der Schluessel ist die Identitaet, nicht die IP: die IP taugt hoechstens als
// zusaetzliche Sperre, weil sie im selben Netz faelschbar ist.
export function verifyHeartbeat({ presentedKey, storedHash, revokedAt }) {
  if (revokedAt) return { ok: false, reason: 'revoked' };
  if (typeof presentedKey !== 'string' || presentedKey.length === 0) {
    return { ok: false, reason: 'missing-key' };
  }
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return { ok: false, reason: 'unknown-arsenal' };
  }
  const presented = Buffer.from(hashSecret(presentedKey), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length) return { ok: false, reason: 'bad-key' };
  // timingSafeEqual verhindert, dass die Vergleichsdauer den Schluessel verraet.
  if (!crypto.timingSafeEqual(presented, stored)) return { ok: false, reason: 'bad-key' };
  return { ok: true };
}
