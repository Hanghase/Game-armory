// Tests fuer die Uebertragung einer ZIP von der Armory zum Arsenal.
//
// Der Weg: das Arsenal ZIEHT in Stuecken ueber die offene Leitung. Nicht die
// Armory schiebt - wer zieht, bestimmt das Tempo, und der Agent bleibt der,
// der anruft (Konzept 2026-11-09).
//
// Warum Stuecke und nicht "eine Nachricht mit 2 GB":
//   - eine WebSocket-Nachricht muss komplett im Speicher liegen, auf BEIDEN
//     Seiten. 2 GB im Heap ist bei einem kleinen Arsenal ein Abschuss.
//   - bricht die Leitung bei 90 %, muss man wieder aufsetzen koennen.
//   - der Fortschritt muss sichtbar sein, sonst sitzt jemand 7 Minuten vor
//     einem Balken, der sich nicht bewegt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../app/arsenalTransfer.js').catch(() => null);

test('arsenalTransfer.js laedt ueberhaupt', () => {
  assert.ok(mod, 'app/arsenalTransfer.js laedt nicht');
});

test('die Stueckelung deckt die Datei genau ab, ohne Luecke und ohne Dopplung', () => {
  const { planeStuecke } = mod;
  assert.equal(typeof planeStuecke, 'function', 'planeStuecke fehlt');

  // 10 Bytes in 3er-Stuecken: 3+3+3+1. Wer hier 4 Stuecke mit 3,3,3,3
  // rechnet, liest 2 Bytes ueber das Ende hinaus - und schreibt Muell.
  const teile = planeStuecke(10, 3);
  assert.deepEqual(teile, [
    { offset: 0, laenge: 3 },
    { offset: 3, laenge: 3 },
    { offset: 6, laenge: 3 },
    { offset: 9, laenge: 1 },
  ]);
  const summe = teile.reduce((s, t) => s + t.laenge, 0);
  assert.equal(summe, 10, 'Stuecke decken die Datei nicht genau ab');
});

test('eine leere Datei ergibt keine Stuecke - und keinen Absturz', () => {
  const teile = mod.planeStuecke(0, 1024);
  assert.deepEqual(teile, []);
});

test('eine Datei kleiner als ein Stueck ergibt genau ein Stueck', () => {
  const teile = mod.planeStuecke(5, 1024);
  assert.deepEqual(teile, [{ offset: 0, laenge: 5 }]);
});

test('die Pruefsumme erkennt eine veraenderte Datei', async () => {
  // Ohne Pruefsumme merkt niemand, dass die ZIP unterwegs beschädigt wurde -
  // die Installation scheitert dann mit "kein gueltiges Archiv" und alle
  // suchen am falschen Ende.
  const { sha256VonDatei } = mod;
  assert.equal(typeof sha256VonDatei, 'function', 'sha256VonDatei fehlt');

  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'arsenal-xfer-'));
  const a = join(dir, 'a.bin');
  const b = join(dir, 'b.bin');
  await writeFile(a, 'inhalt');
  await writeFile(b, 'inhalt!'); // ein Zeichen mehr

  const ha = await sha256VonDatei(a);
  const hb = await sha256VonDatei(b);
  assert.match(ha, /^[0-9a-f]{64}$/, 'kein SHA-256');
  assert.notEqual(ha, hb, 'verschiedene Dateien haben dieselbe Pruefsumme');

  // WICHTIG: die kleinen Dateien oben beweisen NICHT, dass stueckweise
  // gelesen wird - sie passen in den ersten Block. Eine Pruefsumme, die nur
  // den Anfang liest, waere damit gruen. Darum zwei grosse Dateien, die sich
  // NUR in der letzten Zeile unterscheiden.
  const grossA = join(dir, 'gross-a.bin');
  const grossB = join(dir, 'gross-b.bin');
  const fuellung = Buffer.alloc(200 * 1024, 0x41); // 200 KiB, > 1 Block
  await writeFile(grossA, Buffer.concat([fuellung, Buffer.from('ENDE-A')]));
  await writeFile(grossB, Buffer.concat([fuellung, Buffer.from('ENDE-B')]));

  const gha = await sha256VonDatei(grossA);
  const ghb = await sha256VonDatei(grossB);
  assert.notEqual(gha, ghb,
    'Dateien, die sich nur in der letzten Zeile unterscheiden, haben dieselbe Pruefsumme - '
    + 'die Pruefsumme liest nicht bis zum Ende');
});

test('ein abgebrochener Transfer wird NICHT als fertig gemeldet', () => {
  // Der gefaehrliche Fall: 90 % da, Verbindung weg, und irgendwo steht
  // "fertig". Dann installiert das Arsenal eine halbe ZIP.
  const { istVollstaendig } = mod;
  assert.equal(typeof istVollstaendig, 'function', 'istVollstaendig fehlt');
  assert.equal(istVollstaendig({ empfangen: 900, gesamt: 1000 }), false);
  assert.equal(istVollstaendig({ empfangen: 1000, gesamt: 1000 }), true);
  assert.equal(istVollstaendig({ empfangen: 1001, gesamt: 1000 }), false,
    'mehr Bytes als angekuendigt ist auch nicht in Ordnung');
});
