// Tests fuer den Sword-Cache (app/swords.js).
//
// Hintergrund (2026-11-07): nach einem Update stand in der Sword-DATEI die
// richtige Version, das Panel zeigte aber weiter die alte. Ursache: updater.js
// schrieb die Datei direkt per writeFile, ohne den Modul-Cache zu erneuern;
// getSword() liest aus dem Cache. Der Betreiber sah eine falsche Zahl, trug
// die richtige von Hand nach - und damit stand die Herkunft auf 'manual'
// statt 'filename', obwohl der Code sie korrekt erkannt hatte.
//
// Diese Tests halten fest: wer eine Sword-Datei schreibt, muss dafuer sorgen,
// dass der Cache sie danach auch kennt.

import { test, assert } from './_fixtures.mjs';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('updater.js schreibt Sword-Dateien nicht am Cache vorbei', async () => {
  // Statische Pruefung: im Versionsblock von runUpdate darf kein direktes
  // writeFile auf eine .sword.json stehen. Stattdessen muss der Weg ueber
  // setInstalledVersion gehen - der sperrt, setzt 'by' und erneuert den Cache.
  const quelle = await readFile(new URL('../app/updater.js', import.meta.url), 'utf8');

  // Den Versionsblock finden: von "Version im Sword fortschreiben" bis zum
  // zugehoerigen catch.
  const start = quelle.indexOf('Version im Sword fortschreiben');
  assert.notEqual(start, -1, 'Versionsblock nicht gefunden');

  const block = quelle.slice(start, start + 3000);
  const schreibtDirekt = /writeFile\(\s*swordPath/.test(block);

  assert.equal(schreibtDirekt, false,
    'updater.js schreibt die Sword-Datei direkt per writeFile - der Cache '
    + 'bleibt dann veraltet und das Panel zeigt die alte Version. '
    + 'Stattdessen setInstalledVersion() aus swords.js benutzen.');
});

test('setInstalledVersion ist exportiert und nimmt eine Quelle an', async () => {
  const swords = await import('../app/swords.js');
  assert.equal(typeof swords.setInstalledVersion, 'function',
    'setInstalledVersion muss exportiert sein - es ist der einzige Weg, '
    + 'eine Version zu setzen, der Cache und Sperre beruecksichtigt.');

  // Signatur: (id, { version, source, by })
  assert.ok(swords.setInstalledVersion.length >= 1);
});

test('loadSwords ist exportiert (Cache kann erneuert werden)', async () => {
  const swords = await import('../app/swords.js');
  assert.equal(typeof swords.loadSwords, 'function',
    'loadSwords muss exportiert sein, sonst kann nach einem direkten '
    + 'Dateischreibvorgang niemand den Cache auffrischen.');
});
