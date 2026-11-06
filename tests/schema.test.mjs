// Tests fuer die Übereinstimmung von Schema und Code.
//
// Hintergrund (2026-11-06): racks/rack.schema.json und die Pruefung in
// app/racks.js sind zwei getrennte Darstellungen derselben Regeln. Sie waren
// auseinandergelaufen - das Schema kannte "configTemplate" nicht, obwohl der
// Code es verlangt (installMethod github). Wer sein Rack gegen das Schema
// prueft, bekam andere Ergebnisse als das Panel liefert.
//
// Diese Tests halten die beiden Seiten zusammen. Sie koennen nicht pruefen, ob
// die Regexe IDENTISCH sind (dafuer muesste man JavaScript-Regex gegen
// JSON-Schema-Pattern parsen), aber sie verhindern den haeufigsten Fall:
// ein Feld, das auf einer Seite fehlt.

import { test, assert } from './_fixtures.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const REPO = join(HIER, '..');

// Alle Felder, die validateRack kennt (KNOWN-Set in app/racks.js) plus die
// Pflichtfelder. Bewusst HIER als Liste gepflegt statt im Code exportiert:
// exportiert man das KNOWN-Set, wandert es beim naechsten Umbau mit und der
// Test vergleicht den Code mit sich selbst - dann prueft er nichts.
const CODE_FELDER = [
  // Pflichtfelder (REQUIRED_FIELDS)
  'id', 'name', 'description', 'icon', 'game', 'loader',
  'tier', 'licenseRequired', 'installMethod', 'defaultRoot',
  'source', 'javaRequired',
  // optional (KNOWN-Set)
  'singleton', 'ports', 'eula', 'configFile', 'startScript',
  'startArgs', 'saveDir', 'logFile', 'packMarkers', 'readyMarkers',
  'configTemplate',
];

test('jedes Feld, das der Code kennt, steht auch im Schema', async () => {
  const roh = await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8');
  const schema = JSON.parse(roh);
  const imSchema = new Set(Object.keys(schema.properties ?? {}));

  const fehlend = CODE_FELDER.filter((f) => !imSchema.has(f));
  assert.deepEqual(fehlend, [],
    `Diese Felder kennt app/racks.js, aber nicht racks/rack.schema.json: ${fehlend.join(', ')}`);
});

test('das Schema nennt kein Feld, das der Code nicht kennt', async () => {
  const roh = await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8');
  const schema = JSON.parse(roh);
  const imSchema = Object.keys(schema.properties ?? {});

  // $schema ist JSON-Schema-Metadaten, kein Rack-Feld.
  const ueberzaehlig = imSchema.filter((f) => f !== '$schema' && !CODE_FELDER.includes(f));
  assert.deepEqual(ueberzaehlig, [],
    `Diese Felder stehen im Schema, kennt aber app/racks.js nicht: ${ueberzaehlig.join(', ')}`);
});

test('Pflichtfelder im Schema sind genau die Pflichtfelder im Code', async () => {
  const roh = await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8');
  const schema = JSON.parse(roh);

  const CODE_PFLICHT = CODE_FELDER.slice(0, 12); // siehe Kommentar bei CODE_FELDER
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    [...CODE_PFLICHT].sort(),
    'Schema-required und REQUIRED_FIELDS in app/racks.js sind auseinandergelaufen',
  );
});

test('jedes mitgelieferte Rack validiert gegen den eigenen Code', async () => {
  // Die Racks in racks/ sind unsere eigenen Beispiele. Wenn eines davon die
  // eigene Validierung nicht besteht, ist entweder das Rack oder die Regel
  // kaputt - beides faellt beim Kunden auf.
  const { validateRackDraft } = await import('../app/racks.js');
  const { readdir } = await import('node:fs/promises');

  const dateien = (await readdir(join(REPO, 'racks')))
    .filter((f) => f.endsWith('.rack.json'));
  assert.ok(dateien.length > 0, 'es sollten Rack-Vorlagen im Repo liegen');

  for (const datei of dateien) {
    const roh = await readFile(join(REPO, 'racks', datei), 'utf8');
    const inhalt = JSON.parse(roh);
    assert.doesNotThrow(() => validateRackDraft(inhalt, datei),
      `Rack ${datei} besteht die eigene Validierung nicht`);
  }
});
