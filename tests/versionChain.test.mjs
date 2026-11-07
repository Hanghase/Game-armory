// Tests fuer die Versions-Ermittlung beim ZIP-Update (Kette ueber vier Dateien).
//
// Hintergrund (2026-11-07): beim atm11-Update am 2026-10-30 23:25 stand im Log
//   "[update] Keine neue Version ermittelbar - Sword-Version bleibt unveraendert."
// obwohl der Pack-Dateiname "0.12.0-beta" enthielt. Ursache war NICHT der
// Parser (der erkennt den Namen korrekt), sondern dass runUpdate damals nur
// basename(zipPath) kannte - und der Upload heisst upload-<uuid>.zip. Genau
// diesen Namen weist extractCurseForgeVersion absichtlich ab (kein Raten).
// Der Fix (6b37b64, 2026-10-31 00:50) reicht seither originalName durch.
//
// Diese Tests sichern die Kette ab, damit ein verlorenes Feld sie nicht wieder
// reisst: uploads.js -> installRoutes.js -> updater.js (updateFromZip) -> runUpdate.

import { test, assert } from './_fixtures.mjs';
import { readFile } from 'node:fs/promises';
import { extractCurseForgeVersion } from '../app/installer.js';

const lies = (name) => readFile(new URL(`../app/${name}`, import.meta.url), 'utf8');

test('Parser erkennt die reale ATM11-Packversion aus dem Dateinamen', () => {
  // Die Namen, die CurseForge fuer ATM11 tatsaechlich vergibt.
  const faelle = {
    'All the Mods 11 - 0.12.0-beta.zip': '0.12.0-beta',
    'All the Mods 11-0.12.0-beta.zip': '0.12.0-beta',
    'ATM11-0.12.0-beta.zip': '0.12.0-beta',
    'ServerFiles-0.12.0-beta.zip': '0.12.0-beta',
    'All the Mods 11 - 8.5.zip': '8.5',
    'ServerFiles-8.5.zip': '8.5',
  };
  for (const [name, erwartet] of Object.entries(faelle)) {
    assert.equal(extractCurseForgeVersion({ fileName: name }), erwartet,
      `Dateiname "${name}" muss ${erwartet} ergeben`);
  }
});

test('Parser weist den Plattennamen eines Uploads ab (kein Raten)', () => {
  // Der Upload liegt als upload-<uuid>.zip. Daraus ist KEINE Version ableitbar.
  // Wuerde der Parser hier raten, stuende im Sword eine erfundene Zahl.
  assert.equal(extractCurseForgeVersion({ fileName: 'upload-7051434d-763c-48ee-9a9d-297f00819acd.zip' }), null);
});

test('uploads.js haelt den Originalnamen fest', async () => {
  const q = await lies('uploads.js');
  assert.match(q, /originalname/, 'uploads.js muss file.originalname lesen');
  assert.match(q, /originalName\s*,/, 'originalName muss in die Metadaten geschrieben werden');
});

test('installRoutes.js reicht den Originalnamen ans Update weiter', async () => {
  const q = await lies('installRoutes.js');
  assert.match(q, /up\.originalName/, 'installRoutes.js muss originalName aus den Upload-Metadaten lesen');
  assert.match(q, /updateFromZip\([^)]*originalName/s,
    'installRoutes.js muss originalName an updateFromZip uebergeben');
});

test('updater.js: updateFromZip nimmt den Originalnamen und reicht ihn an runUpdate', async () => {
  const q = await lies('updater.js');
  // Wichtig: hier NICHT mit .*?-Regex arbeiten. Es gibt mehrere runUpdate()-Aufrufe
  // (Zeile 726 aus updateFromZip, Zeile 755 aus updateFromCurseForge-OHNE
  // originalName). Ein gieriger/schluckender Ausdruck findet dann den falschen
  // und die Mutation "originalName entfernen" bliebe unbemerkt. Deshalb: den
  // echten Body von updateFromZip ausschneiden und nur DORT suchen.
  const ufzStart = q.indexOf('export async function updateFromZip');
  assert.notEqual(ufzStart, -1, 'updateFromZip nicht gefunden');
  const ufzEnde = q.indexOf('export async function updateFromCurseForge', ufzStart);
  assert.notEqual(ufzEnde, -1, 'Ende von updateFromZip nicht gefunden');
  const ufz = q.slice(ufzStart, ufzEnde);

  assert.match(ufz, /originalName = null/, 'updateFromZip muss originalName als Parameter annehmen');
  assert.match(ufz, /runUpdate\(sword,\s*\{[^}]*\boriginalName\b[^}]*\}\s*\)/,
    'updateFromZip muss originalName an seinen runUpdate-Aufruf uebergeben - sonst '
    + 'faellt runUpdate auf basename(zipPath) zurueck und findet nichts (atm11-Fall)');
});

test('updater.js: runUpdate bevorzugt den Originalnamen vor dem Plattennamen', async () => {
  const q = await lies('updater.js');
  assert.match(q, /originalName\s*\|\|\s*basename\(zipPath\)/,
    'runUpdate muss originalName vor basename(zipPath) bevorzugen');
});

test('updater.js: die Version wird ueber setInstalledVersion geschrieben', async () => {
  // Zweiter, davon unabhaengiger Fehler (2026-11-07): direktes writeFile liess
  // den Modul-Cache in swords.js veraltet, das Panel zeigte die alte Version.
  const q = await lies('updater.js');
  const start = q.indexOf('Version im Sword fortschreiben');
  assert.notEqual(start, -1, 'Versionsblock nicht gefunden');
  const block = q.slice(start, start + 3000);
  assert.equal(/writeFile\(\s*swordPath/.test(block), false,
    'der Versionsblock darf nicht selbst schreiben - setInstalledVersion benutzen');
  assert.match(block, /setInstalledVersion\(/,
    'der Versionsblock muss setInstalledVersion aufrufen');
});
