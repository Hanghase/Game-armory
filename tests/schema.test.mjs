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
  // Art des Racks (seit 2026-11-07): game | service. Steht im Schema und im
  // KNOWN-Set von app/racks.js.
  'kind',
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

// --- Enum-Werte: die Luecke im ersten Anlauf (2026-11-06) ----------------
//
// Der Feldnamen-Test oben war zu flach. Er verglich nur, WELCHE Felder es
// gibt, nicht WELCHE WERTE sie annehmen duerfen. Dabei waren beide Enums
// in beide Richtungen widerspruechlich:
//
//   game:          Code kannte 'satisfactory', das Schema nicht
//   installMethod: Schema erlaubte 'url' (vom Code am 2026-10-19 ersetzt,
//                  weil jeder http(s)-String als GitHub-Repo aufgeloest und
//                  per root-Helfer entpackt wurde) und verbot 'github'
//
// Wer nach dem Schema baut, waehlt 'url' und wird abgewiesen; wer 'github'
// nutzt, wird vom Schema abgewiesen, obwohl der Code es verlangt.

// Die Enum-Listen werden HIER gepflegt, nicht aus app/racks.js importiert -
// sonst verglichen sie sich selbst. Sie muessen bei jeder Erweiterung
// mitgezogen werden; genau das ist der Zweck.
const ERWARTETE_ENUMS = {
  game: ['minecraft', '7d2d', 'teamspeak3', 'teamspeak6', 'satisfactory'],
  loader: ['vanilla', 'neoforge', 'forge', 'fabric', 'quilt', 'paper', 'spigot', 'purpur', 'native'],
  tier: ['free', 'premium'],
  installMethod: ['curseforge', 'steamcmd', 'zip', 'upload', 'github'],
  eula: ['required', 'none'],
};

for (const [feld, werte] of Object.entries(ERWARTETE_ENUMS)) {
  test(`Schema-Enum "${feld}" passt zum Code`, async () => {
    const roh = await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8');
    const schema = JSON.parse(roh);
    const imSchema = schema.properties?.[feld]?.enum;

    assert.ok(Array.isArray(imSchema), `Schema hat kein enum fuer ${feld}`);
    assert.deepEqual([...imSchema].sort(), [...werte].sort(),
      `Schema-Enum "${feld}" weicht vom Code ab`);
  });
}

test('source.type im Schema erlaubt jede Install-Methode des Installers', async () => {
  const roh = await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8');
  const schema = JSON.parse(roh);
  const erlaubt = schema.properties?.source?.properties?.type?.enum;
  assert.ok(Array.isArray(erlaubt), 'Schema hat kein enum fuer source.type');

  const quelle = await readFile(join(REPO, 'app/installRoutes.js'), 'utf8');
  const block = quelle.match(/const INSTALL_TYPE_FOR_METHOD = \{([\s\S]*?)\};/);
  assert.ok(block, 'INSTALL_TYPE_FOR_METHOD nicht gefunden');
  const gebraucht = [...block[1].matchAll(/^\s*\w+:\s*'(\w+)'/gm)].map((m) => m[1]);

    // 'docker' bildet KEINEN source.type (Karte 28, 2026-11-10): ein laufender
    // Compose-Stack wird uebernommen, nicht geladen. Es gibt nichts, was eine
    // Quelle haette. Deshalb steht 'docker' auch nicht im Schema-enum - der
    // Test prueft, dass das so BLEIBT, statt den Wert dort einzutragen.
    const ohneQuelle = new Set(['docker']);

    for (const typ of gebraucht) {
      if (ohneQuelle.has(typ)) {
        assert.ok(!erlaubt.includes(typ),
          `"${typ}" braucht keine Quelle, steht aber im Schema-enum fuer source.type`);
        continue;
      }
      assert.ok(erlaubt.includes(typ),
        `installRoutes.js bildet source.type "${typ}", das Schema erlaubt es nicht`);
    }
});

// --- Frontend: jede Quelle, die das Schema erlaubt, ist auch waehlbar -----
//
// Der Editor bot 'zip' und 'upload' nicht an, obwohl der Installer beide
// bedient. Wer eine ZIP-Rack anlegen wollte, musste deshalb einen falschen
// source.type waehlen - und die Installation brach spaeter mit 400 ab
// ("erwartet: zip, im Rack: local"). Der Fehler kam erst beim Klick.

test('jeder source.type aus dem Schema steht im Rack-Editor zur Wahl', async () => {
  const schema = JSON.parse(await readFile(join(REPO, 'racks/rack.schema.json'), 'utf8'));
  const erlaubt = schema.properties?.source?.properties?.type?.enum ?? [];

  const html = await readFile(join(REPO, 'public/app.html'), 'utf8');
  const block = html.match(/<select id="reSourceType">([\s\S]*?)<\/select>/);
  assert.ok(block, 'reSourceType-Dropdown nicht gefunden');
  const waehlbar = [...block[1].matchAll(/<option value="([\w-]+)"/g)].map((m) => m[1]);

  const fehlend = erlaubt.filter((t) => !waehlbar.includes(t));
  assert.deepEqual(fehlend, [],
    `Diese source.type erlaubt das Schema, aber der Editor bietet sie nicht an: ${fehlend.join(', ')}`);
});

test('jede installMethod im Editor ist auch waehlbar', async () => {
  const quelle = await readFile(join(REPO, 'app/installRoutes.js'), 'utf8');
  const block = quelle.match(/const INSTALL_TYPE_FOR_METHOD = \{([\s\S]*?)\};/);
  const methoden = [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

  const html = await readFile(join(REPO, 'public/app.html'), 'utf8');
  const dd = html.match(/<select id="reInstallMethod">([\s\S]*?)<\/select>/);
  assert.ok(dd, 'reInstallMethod-Dropdown nicht gefunden');
  const waehlbar = [...dd[1].matchAll(/<option value="([\w-]+)"/g)].map((m) => m[1]);

  const fehlend = methoden.filter((m) => !waehlbar.includes(m));
  assert.deepEqual(fehlend, [],
    `Diese Install-Methoden bedient der Installer, der Editor bietet sie nicht an: ${fehlend.join(', ')}`);
});
