// Tests fuer das update-Schema im Sword (2026-11-26).
//
// Ausgangslage (belegt, nicht vermutet): `swords/sword.schema.json` erlaubte in
// `update.source` nur curseforge, modrinth, ftb, url, local. Der Code kannte
// laenger mehr - `versionCheck.js` prueft steam (Z.418), github (Z.425) und
// docker (Z.430), `installRoutes.js` nimmt github (Z.943) und steam (Z.948) an.
// Die echten Swords im Betrieb nutzen genau diese Quellen:
//   7d2d -> steam, teamspeak6 -> github, nextcloud -> docker
// Dazu fehlten im Schema Felder, die der Code schreibt und liest: `image`
// (nextcloud), `appId`/`branch` (7d2d), `keepConfigs` (atm10).
//
// Es hat bisher nichts gebissen, weil `app/swords.js` nur Pflichtfelder prueft.
// Der Kommentar an dieser Stelle hat schon einmal Unrecht gehabt (siehe
// GAME-ARMORY-NOTES.md, "hier wird NICHTS gestartet") - deshalb hier ein Test
// statt eines Kommentars.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Die Sword-Dateien selbst sind Laufzeitdaten und stehen in .gitignore
// (`swords/`). Ein Test, der nur gegen sie prueft, waere auf einem frischen
// Clone sofort rot. Deshalb zwei Standorte:
//   docs/sword.schema.json  - versioniert, die pruefbare Wahrheit
//   swords/sword.schema.json - Laufzeitkopie neben den Instanzen
// Die Tests unten verlangen, dass beide gleich sind. Aendert der Betrieb seine
// Kopie, faellt es hier auf statt still auseinanderzulaufen.
const schemaUrl = new URL('../docs/sword.schema.json', import.meta.url);
const laufzeitSchemaUrl = new URL('../swords/sword.schema.json', import.meta.url);
const swordsDir = fileURLToPath(new URL('../swords/', import.meta.url));
const appDir = fileURLToPath(new URL('../app/', import.meta.url));

async function schema() {
  return JSON.parse(await readFile(schemaUrl, 'utf8'));
}

test('Laufzeitkopie und versionierter Spiegel des Schemas sind gleich', async () => {
  const [versioniert, laufzeit] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(laufzeitSchemaUrl, 'utf8').catch(() => null),
  ]);
  if (laufzeit === null) return; // kein Betriebsstand hier (frischer Clone)
  assert.equal(laufzeit.trim(), versioniert.trim(),
    'swords/sword.schema.json weicht von docs/sword.schema.json ab - '
    + 'die Laufzeitkopie nachziehen oder die Abweichung begruenden');
});

test('update.source im Schema deckt jede Quelle ab, die der Code kennt', async () => {
  const s = await schema();
  const erlaubt = s.properties.update.properties.source.enum;

  // Quellen, die der Code nachweislich behandelt - hier fest eingetragen, damit
  // ein neuer Zweig im Code ohne Schema-Nachtrag auffaellt.
  const imCode = ['curseforge', 'modrinth', 'ftb', 'url', 'local', 'github', 'docker', 'steam'];
  for (const q of imCode) {
    assert.ok(erlaubt.includes(q), `"${q}" fehlt in update.source - der Code kennt sie`);
  }
});

test('jede Quelle im Code-Text steht auch im Schema', async () => {
  // Gegenprobe: im Code gefundene Quellen gegen das Schema halten. Findet
  // jemand spaeter ein neuntes (z.B. "ftpmirror"), faellt es hier auf.
  const s = await schema();
  const erlaubt = new Set(s.properties.update.properties.source.enum);

  // NUR die Update-Datei. Der erste Versuch las auch installRoutes.js und
  // meldete "zip" und "upload" als fehlend - das sind INSTALL-Quellen
  // (installRoutes.js:1058/1061, fuer eine neue Installation aus ZIP oder
  // Upload), keine Update-Quellen. Der Test war zu weit geschnitten, nicht
  // das Schema. Dieselbe Falle wie "Ausschnitt bis ins naechste Vorkommen".
  const dateien = ['versionCheck.js', 'updater.js'];
  const gefunden = new Set();
  for (const d of dateien) {
    let text;
    try {
      text = await readFile(`${appDir}${d}`, 'utf8');
    } catch {
      continue; // Datei umbenannt: der Test soll nicht am Namen scheitern
    }
    // Nur echte Quellenvergleiche: type === 'x' / source === 'x' / source.type === 'x'
    for (const m of text.matchAll(/(?:source(?:\.type)?|type)\s*===\s*'([a-z]+)'/g)) {
      gefunden.add(m[1]);
    }
  }

  const quellen = [...gefunden].filter((v) => erlaubt.size > 0);
  assert.ok(quellen.length > 0, 'keine Quelle im Code gefunden - das Muster ist veraltet');
  const fehlend = quellen.filter((q) => !erlaubt.has(q) && !['systemd', 'unknown', 'null'].includes(q));
  assert.deepEqual(fehlend, [],
    `im Code benutzt, im Schema unbekannt: ${fehlend.join(', ')}`);
});

test('update-Felder im Schema decken die echten Sword-Dateien ab', async () => {
  const s = await schema();
  const erlaubt = new Set(Object.keys(s.properties.update.properties));

  const dateien = (await readdir(swordsDir)).filter((f) => f.endsWith('.sword.json'));
  assert.ok(dateien.length > 0, 'keine Sword-Dateien gefunden');

  const fehlend = [];
  for (const datei of dateien) {
    const sword = JSON.parse(await readFile(`${swordsDir}${datei}`, 'utf8'));
    if (!sword.update) continue;
    for (const feld of Object.keys(sword.update)) {
      if (!erlaubt.has(feld)) fehlend.push(`${datei}: ${feld}`);
    }
  }
  // Das war der eigentliche Befund: image/appId/branch/keepConfigs standen in
  // den Dateien, aber nicht im Schema ("additionalProperties": false).
  assert.deepEqual(fehlend, [],
    `in den Sword-Dateien, im Schema unbekannt: ${fehlend.join(', ')}`);
});

test('source-Wert jeder echten Sword-Datei ist im Schema erlaubt', async () => {
  const s = await schema();
  const erlaubt = s.properties.update.properties.source.enum;

  const dateien = (await readdir(swordsDir)).filter((f) => f.endsWith('.sword.json'));
  for (const datei of dateien) {
    const sword = JSON.parse(await readFile(`${swordsDir}${datei}`, 'utf8'));
    if (!sword.update?.source) continue;
    assert.ok(erlaubt.includes(sword.update.source),
      `${datei}: source "${sword.update.source}" ist im Schema nicht erlaubt`);
  }
});

test('required im update-Block ist nicht strenger als die echten Dateien', async () => {
  // projectId war Pflicht - nextcloud (docker) hat es nicht, 7d2d (steam) auch
  // nicht. Ein Schema, das die eigenen Dateien ablehnt, ist kein Schema.
  const s = await schema();
  const pflicht = s.properties.update.required;

  const dateien = (await readdir(swordsDir)).filter((f) => f.endsWith('.sword.json'));
  for (const datei of dateien) {
    const sword = JSON.parse(await readFile(`${swordsDir}${datei}`, 'utf8'));
    if (!sword.update) continue;
    for (const feld of pflicht) {
      assert.ok(Object.hasOwn(sword.update, feld),
        `${datei}: Schema verlangt "${feld}", die Datei hat es nicht`);
    }
  }
});
