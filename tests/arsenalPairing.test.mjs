// Tests fuer den Kopplungsteil der Arsenale.
//
// Diese Tests sind bewusst gegen das Verhalten geschrieben, nicht gegen die
// Implementierung: sie pruefen, was ein Angreifer NICHT schaffen darf.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAIRING_TTL_MS,
  HEARTBEAT_STALE_MS,
  CODE_LENGTH,
  hashSecret,
  generatePairingCode,
  normalizePairingCode,
  formatPairingCode,
  isPairingExpired,
  arsenalState,
  verifyHeartbeat,
} from '../app/arsenals.js';

// ---------- Kopplungscode ----------

test('Kopplungscode hat die erwartete Laenge und nur erlaubte Zeichen', () => {
  const code = generatePairingCode();
  assert.equal(code.length, CODE_LENGTH);
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
});

test('Kopplungscode enthaelt keine Verwechslungspaare (0/O, 1/I/L)', () => {
  // 200 Codes: bei einem Alphabet mit 0/O oder 1/I/L waere ein Treffer
  // praktisch sicher. So faellt eine versehentliche Rueckkehr ins volle
  // Alphabet sofort auf.
  const verboten = new Set(['0', 'O', '1', 'I', 'L']);
  for (let i = 0; i < 200; i += 1) {
    for (const ch of generatePairingCode()) {
      assert.ok(!verboten.has(ch), `verbotenes Zeichen ${ch} im Code`);
    }
  }
});

test('zwei Kopplungscodes sind nicht gleich', () => {
  const codes = new Set();
  for (let i = 0; i < 50; i += 1) codes.add(generatePairingCode());
  // Bei 31^8 Moeglichkeiten waere eine Kollision hier astronomisch unwahrscheinlich.
  assert.equal(codes.size, 50);
});

test('normalizePairingCode entfernt Trenner und Gross/Klein', () => {
  assert.equal(normalizePairingCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizePairingCode('ABCD EFGH'), 'ABCDEFGH');
  assert.equal(normalizePairingCode('  abcd-efgh  '), 'ABCDEFGH');
});

test('normalizePairingCode lehnt falsche Formen ab', () => {
  assert.equal(normalizePairingCode(''), null);
  assert.equal(normalizePairingCode('ABCD'), null);            // zu kurz
  assert.equal(normalizePairingCode('ABCDEFGHJ'), null);       // zu lang
  assert.equal(normalizePairingCode('ABCD0FGH'), null);        // 0 ist verboten
  assert.equal(normalizePairingCode(null), null);
  assert.equal(normalizePairingCode(undefined), null);
  assert.equal(normalizePairingCode(12345678), null);
});

test('formatPairingCode setzt den Trenner nach vier Zeichen', () => {
  assert.equal(formatPairingCode('ABCDEFGH'), 'ABCD-EFGH');
  // Kurze/ungueltige Eingaben werden nicht zerlegt, sondern durchgereicht.
  assert.equal(formatPairingCode('ABC'), 'ABC');
  assert.equal(formatPairingCode(null), null);
});

test('Kopplungscode laeuft nach der TTL ab', () => {
  const jetzt = 1_000_000;
  assert.equal(isPairingExpired(jetzt, jetzt), false);
  assert.equal(isPairingExpired(jetzt, jetzt + PAIRING_TTL_MS - 1), false);
  assert.equal(isPairingExpired(jetzt, jetzt + PAIRING_TTL_MS), true);
  assert.equal(isPairingExpired(jetzt, jetzt + PAIRING_TTL_MS + 1), true);
});

test('Kopplungscode ohne Zeitstempel gilt als abgelaufen', () => {
  // Kein "unbekannt = gueltig": ein fehlender Zeitstempel ist ein Fehler,
  // und im Zweifel wird abgelehnt.
  assert.equal(isPairingExpired(undefined), true);
  assert.equal(isPairingExpired(null), true);
  assert.equal(isPairingExpired(NaN), true);
  assert.equal(isPairingExpired('12345'), true);
});

// ---------- Schluessel-Pruefung ----------

test('richtiger Schluessel wird akzeptiert', () => {
  const key = 'geheimer-schluessel-des-arsenals';
  const result = verifyHeartbeat({ presentedKey: key, storedHash: hashSecret(key) });
  assert.deepEqual(result, { ok: true });
});

test('falscher Schluessel wird abgelehnt', () => {
  const result = verifyHeartbeat({
    presentedKey: 'falsch',
    storedHash: hashSecret('richtig'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-key');
});

test('leerer oder fehlender Schluessel wird abgelehnt', () => {
  const stored = hashSecret('irgendwas');
  for (const key of ['', null, undefined, 0, {}, []]) {
    const result = verifyHeartbeat({ presentedKey: key, storedHash: stored });
    assert.equal(result.ok, false, `Schluessel ${JSON.stringify(key)} wurde akzeptiert`);
  }
});

test('gesperrtes Arsenal wird abgelehnt, auch mit richtigem Schluessel', () => {
  // Der wichtigste Test: ein entzogenes Arsenal darf nicht weiterreden,
  // selbst wenn es den alten Schluessel noch kennt.
  const key = 'geheimer-schluessel';
  const result = verifyHeartbeat({
    presentedKey: key,
    storedHash: hashSecret(key),
    revokedAt: 1_700_000_000_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'revoked');
});

test('unbekanntes Arsenal wird abgelehnt, nicht stillschweigend akzeptiert', () => {
  const result = verifyHeartbeat({ presentedKey: 'irgendwas', storedHash: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-arsenal');
});

test('Pruefung ist nicht anfaellig fuer Praefix-Treffer', () => {
  // Ein Hash-Praefix des richtigen Schluessels darf NICHT durchgehen.
  // Wird mit timingSafeEqual verglichen, aber nur bei gleicher Pufferlaenge.
  const key = 'geheimer-schluessel';
  const fullHash = hashSecret(key);
  const result = verifyHeartbeat({
    presentedKey: key,
    storedHash: fullHash.slice(0, fullHash.length - 2), // verkuerzt -> andere Laenge
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-key');
});

test('hashSecret ist deterministisch und SHA-256', () => {
  assert.equal(hashSecret('abc'), hashSecret('abc'));
  assert.notEqual(hashSecret('abc'), hashSecret('abd'));
  assert.equal(hashSecret('abc').length, 64); // 32 Byte als Hex
});

// ---------- Zustand ----------

test('Arsenal ohne Lebenszeichen ist unbekannt, nicht offline', () => {
  // Unterschied ist wichtig: "unbekannt" heisst "hat sich nie gemeldet",
  // "offline" heisst "hat sich gemeldet und ist jetzt weg". Wer beides
  // gleich behandelt, behauptet einen Ausfall, den er nicht gemessen hat.
  assert.equal(arsenalState({ last_seen_at: null }), 'unknown');
  assert.equal(arsenalState({}), 'unknown');
  assert.equal(arsenalState(null), 'unknown');
});

test('Arsenal mit frischem Lebenszeichen ist online', () => {
  const jetzt = 1_700_000_000_000;
  assert.equal(arsenalState({ last_seen_at: jetzt }, jetzt), 'online');
  assert.equal(arsenalState({ last_seen_at: jetzt - 1000 }, jetzt), 'online');
});

test('Arsenal wird nach HEARTBEAT_STALE_MS offline', () => {
  const jetzt = 1_700_000_000_000;
  assert.equal(arsenalState({ last_seen_at: jetzt - HEARTBEAT_STALE_MS }, jetzt), 'offline');
  assert.equal(arsenalState({ last_seen_at: jetzt - HEARTBEAT_STALE_MS - 1 }, jetzt), 'offline');
});

test('entzogenes Arsenal ist gesperrt, unabhaengig vom Lebenszeichen', () => {
  const jetzt = 1_700_000_000_000;
  assert.equal(
    arsenalState({ last_seen_at: jetzt, revoked_at: jetzt }, jetzt),
    'revoked',
  );
});
