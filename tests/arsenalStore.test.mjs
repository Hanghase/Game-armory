// Tests fuer die Speicherschicht der Arsenale.
//
// Laufen gegen eine Wegwerf-DB (ARMORY_DB_PATH). Kein Test fasst die echte
// Datenbank an - sonst haengt das Ergebnis davon ab, was auf dem Server steht.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-test-'));
process.env.ARMORY_DB_PATH = path.join(tmpDir, 'test.db');

const store = await import('../app/arsenalStore.js');
const { hashSecret, PAIRING_TTL_MS, verifyHeartbeat } = await import('../app/arsenals.js');

after(() => {
  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function leereAlles() {
  store.db.exec('DELETE FROM arsenals; DELETE FROM arsenal_pairings;');
}

test('erzeugter Kopplungscode liegt nur als Hash in der DB', () => {
  leereAlles();
  const { code } = store.createPairing();

  // Der Klartext darf nirgends in der Tabelle stehen.
  const rows = store.db.prepare('SELECT * FROM arsenal_pairings').all();
  assert.equal(rows.length, 1);
  const zeile = JSON.stringify(rows[0]);
  assert.ok(!zeile.includes(code), 'Klartext-Code stand in der DB');

  // Der Hash schon - und er passt zum Code.
  assert.equal(rows[0].code_hash, hashSecret(code));
});

test('Einloesen legt ein Arsenal an und gibt genau einmal einen Schluessel', () => {
  leereAlles();
  const { code } = store.createPairing();
  const result = store.redeemPairing({ code, name: 'frankfurt-01' });

  assert.equal(result.ok, true);
  assert.equal(result.arsenal.name, 'frankfurt-01');
  assert.equal(typeof result.key, 'string');
  assert.ok(result.key.length >= 40, 'Schluessel zu kurz fuer 32 Byte');

  // Ein zweiter Versuch mit demselben Code muss scheitern.
  const zweiter = store.redeemPairing({ code, name: 'frankfurt-02' });
  assert.equal(zweiter.ok, false);
  assert.equal(zweiter.reason, 'already-used');
});

test('der Arsenal-Schluessel liegt nur als Hash in der DB', () => {
  leereAlles();
  const { code } = store.createPairing();
  const { key } = store.redeemPairing({ code, name: 'test' });

  const rows = store.db.prepare('SELECT * FROM arsenals').all();
  assert.equal(rows.length, 1);
  const zeile = JSON.stringify(rows[0]);
  assert.ok(!zeile.includes(key), 'Klartext-Schluessel stand in der DB');
  assert.equal(rows[0].key_hash, hashSecret(key));
});

test('abgelaufener Kopplungscode wird abgelehnt', () => {
  leereAlles();
  const jetzt = Date.now();
  const { code } = store.createPairing({ now: jetzt });
  // 1 ms nach Ablauf einloesen.
  const result = store.redeemPairing({ code, name: 'zu-spaet', now: jetzt + PAIRING_TTL_MS });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('Kopplungscode ist nach Ablauf auch kurz davor noch gueltig', () => {
  leereAlles();
  const jetzt = Date.now();
  const { code } = store.createPairing({ now: jetzt });
  const result = store.redeemPairing({ code, name: 'gerade-noch', now: jetzt + PAIRING_TTL_MS - 1 });
  assert.equal(result.ok, true);
});

test('falscher oder unbekannter Code wird abgelehnt', () => {
  leereAlles();
  store.createPairing();
  for (const bad of ['AAAAAAAA', 'ZZZZ-ZZZZ', '', null]) {
    const result = store.redeemPairing({ code: bad, name: 'x' });
    assert.equal(result.ok, false, `Code ${JSON.stringify(bad)} wurde akzeptiert`);
  }
});

test('Name ist Pflicht und darf nicht zu lang sein', () => {
  leereAlles();
  const { code } = store.createPairing();
  const ohne = store.redeemPairing({ code, name: '   ' });
  assert.equal(ohne.ok, false);
  assert.equal(ohne.reason, 'bad-name');

  const { code: c2 } = store.createPairing();
  const zuLang = store.redeemPairing({ code: c2, name: 'x'.repeat(65) });
  assert.equal(zuLang.ok, false);
  assert.equal(zuLang.reason, 'bad-name');
});

test('ein neuer Kopplungscode entwertet den alten', () => {
  leereAlles();
  const first = store.createPairing();
  const second = store.createPairing();

  const alt = store.redeemPairing({ code: first.code, name: 'zu-alt' });
  assert.equal(alt.ok, false, 'alter Code war noch gueltig');

  const neu = store.redeemPairing({ code: second.code, name: 'passt' });
  assert.equal(neu.ok, true);
});

test('Herzschlag setzt last_seen_at', () => {
  leereAlles();
  const { code } = store.createPairing();
  const { arsenal } = store.redeemPairing({ code, name: 'hb' });

  assert.equal(store.getArsenal(arsenal.id).last_seen_at, null);

  const jetzt = Date.now();
  const ok = store.touchHeartbeat({ id: arsenal.id, now: jetzt, version: '1.3.60' });
  assert.equal(ok, true);

  const frisch = store.getArsenal(arsenal.id);
  assert.equal(frisch.last_seen_at, jetzt);
  assert.equal(frisch.last_version, '1.3.60');
});

test('entzogenes Arsenal nimmt kein Lebenszeichen mehr an', () => {
  leereAlles();
  const { code } = store.createPairing();
  const { arsenal } = store.redeemPairing({ code, name: 'gesperrt' });

  // ERST ein gueltiger Herzschlag. Ohne diesen Schritt waere last_seen_at null,
  // und ein fehlender revoked_at-Filter im UPDATE waere im Test unsichtbar:
  // null bleibt null. Die Mutation vom 2026-11-09 hat genau das aufgedeckt.
  const vorher = Date.now() - 60_000;
  assert.equal(store.touchHeartbeat({ id: arsenal.id, now: vorher, version: '1.3.60' }), true);
  assert.equal(store.getArsenal(arsenal.id).last_seen_at, vorher);

  assert.equal(store.revokeArsenal(arsenal.id), true);
  // Zweiter Aufruf aendert nichts mehr (kein stilles Ueberschreiben).
  assert.equal(store.revokeArsenal(arsenal.id), false);

  const jetzt = Date.now();
  const ok = store.touchHeartbeat({ id: arsenal.id, now: jetzt, version: '9.9.9' });
  assert.equal(ok, false, 'gesperrtes Arsenal hat Lebenszeichen gesetzt');

  // Entscheidend: der GESPEICHERTE Wert darf sich nicht bewegt haben und die
  // Version auch nicht. Sonst haette ein gesperrtes Arsenal weiter geschrieben,
  // nur ohne dass es jemandem auffaellt.
  const gespeichert = store.getArsenal(arsenal.id);
  assert.equal(gespeichert.last_seen_at, vorher, 'last_seen_at wurde trotz Sperre ueberschrieben');
  assert.equal(gespeichert.last_version, '1.3.60', 'Version wurde trotz Sperre ueberschrieben');
  assert.equal(verifyHeartbeat({ presentedKey: 'egal', storedHash: gespeichert.key_hash, revokedAt: gespeichert.revoked_at }).ok, false);
});

test('abgelaufene Kopplungscodes werden aufgeraeumt', () => {
  leereAlles();
  const jetzt = Date.now();
  // EIN Code, dann Zeit vergehen lassen - KEIN neuer Code dazwischen.
  // Sonst wuerde createPairing() den alten schon selbst wegraeumen, und der
  // Test haette die Aufraeumfunktion nie erreicht.
  const alt = store.createPairing({ now: jetzt });

  const entfernt = store.pruneExpiredPairings(jetzt + PAIRING_TTL_MS + 1000);
  assert.equal(entfernt, 1);

  const rows = store.db.prepare('SELECT code_hash FROM arsenal_pairings').all();
  assert.equal(rows.length, 0);

  // Und der abgelaufene Code laesst sich auch nicht mehr einloesen.
  const result = store.redeemPairing({ code: alt.code, name: 'x', now: jetzt + PAIRING_TTL_MS + 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad-code');
});

test('ein gueltiger Code ueberlebt das Aufraeumen', () => {
  leereAlles();
  const jetzt = Date.now();
  const frisch = store.createPairing({ now: jetzt });

  // Zeitpunkt kurz vor Ablauf: der Code muss bleiben.
  const entfernt = store.pruneExpiredPairings(jetzt + PAIRING_TTL_MS - 1);
  assert.equal(entfernt, 0);

  const rows = store.db.prepare('SELECT code_hash FROM arsenal_pairings').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, hashSecret(frisch.code));
});

test('Arsenalliste ist stabil sortiert', () => {
  leereAlles();
  for (const name of ['zulu', 'alpha', 'mike']) {
    const { code } = store.createPairing();
    store.redeemPairing({ code, name });
  }
  const namen = store.listArsenals().map((a) => a.name);
  assert.deepEqual(namen, ['alpha', 'mike', 'zulu']);
});
