// Tests fuer die Rack-Validierung (app/racks.js).
//
// Warum genau hier: validateRack ist die Stelle, an der ein Kundenrack
// scheitern kann, und sie ist eine reine Funktion - kein Server, kein
// Dateisystem, kein sudo. Alles hier laeuft in Millisekunden.
//
// Der wichtigste Test ist "defaultRoot ausserhalb /opt": dort steht die
// Sicherheitsregel. Geht die kaputt, kann ein Rack-JSON nach /etc schreiben,
// und der Install-Helfer laeuft als root.

import { test, assert, rack } from './_fixtures.mjs';
import { validateRackDraft, RackError } from '../app/racks.js';

// --- Hilfen -------------------------------------------------------------

// Erwartet, dass validateRackDraft wirft, und gibt die Meldung zurueck.
// Scheitert der Test, wenn NICHT geworfen wird - das ist der Punkt:
// eine Pruefung, die nicht ablehnt, ist keine Pruefung.
function wirft(rackObj) {
  try {
    validateRackDraft(rackObj);
  } catch (err) {
    return err;
  }
  assert.fail('validateRackDraft haette werfen muessen, hat aber akzeptiert: '
    + JSON.stringify(rackObj).slice(0, 120));
}

// --- Der Normalfall -----------------------------------------------------

test('gueltiges Rack wird akzeptiert', () => {
  const { rack: out, warnings } = validateRackDraft(rack());
  assert.equal(out.id, 'testrack');
  assert.deepEqual(warnings, []);
});

test('validateRackDraft veraendert die Eingabe nicht', () => {
  const eingabe = rack();
  const kopie = structuredClone(eingabe);
  validateRackDraft(eingabe);
  assert.deepEqual(eingabe, kopie);
});

test('eula wird auf "none" voreingestellt', () => {
  const { rack: out } = validateRackDraft(rack());
  assert.equal(out.eula, 'none');
});

// --- Pflichtfelder ------------------------------------------------------

for (const feld of ['id', 'name', 'description', 'icon', 'game', 'loader',
  'tier', 'licenseRequired', 'installMethod', 'defaultRoot', 'source',
  'javaRequired']) {
  test(`Pflichtfeld fehlt: ${feld}`, () => {
    const r = rack();
    delete r[feld];
    const err = wirft(r);
    assert.ok(err instanceof RackError, 'sollte ein RackError sein');
    assert.match(err.message, /Pflichtfelder fehlen/);
    assert.match(err.message, new RegExp(feld));
  });
}

test('RackError traegt Status 400 (Eingabefehler, kein Serverfehler)', () => {
  const err = wirft(rack({ game: 'tetris' }));
  assert.equal(err.status, 400);
});

// --- Die Sicherheitsregel: defaultRoot ----------------------------------

test('defaultRoot ausserhalb /opt wird abgelehnt (Sicherheitsregel)', () => {
  const err = wirft(rack({ defaultRoot: '/etc' }));
  assert.match(err.message, /defaultRoot muss unter \/opt liegen/);
});

test('defaultRoot mit ".." wird abgelehnt', () => {
  const err = wirft(rack({ defaultRoot: '/opt/../etc' }));
  assert.match(err.message, /defaultRoot ungueltig/);
});

test('defaultRoot relativ wird abgelehnt', () => {
  const err = wirft(rack({ defaultRoot: 'opt/test' }));
  assert.match(err.message, /defaultRoot ungueltig/);
});

test('defaultRoot "/opt" selbst ist erlaubt', () => {
  const { rack: out } = validateRackDraft(rack({ defaultRoot: '/opt' }));
  assert.equal(out.defaultRoot, '/opt');
});

test('defaultRoot "/opt/minecraft/instanz" ist erlaubt', () => {
  const { rack: out } = validateRackDraft(rack({ defaultRoot: '/opt/minecraft/instanz' }));
  assert.equal(out.defaultRoot, '/opt/minecraft/instanz');
});

// --- Enums --------------------------------------------------------------

test('unbekanntes Spiel wird abgelehnt', () => {
  const err = wirft(rack({ game: 'tetris' }));
  assert.match(err.message, /game ungueltig/);
});

test('unbekannter Loader wird abgelehnt', () => {
  const err = wirft(rack({ loader: 'mojang' }));
  assert.match(err.message, /loader ungueltig/);
});

test('unbekannte Install-Methode wird abgelehnt', () => {
  const err = wirft(rack({ installMethod: 'apt' }));
  assert.match(err.message, /installMethod ungueltig/);
});

test('tier muss free oder premium sein', () => {
  const err = wirft(rack({ tier: 'gold' }));
  assert.match(err.message, /tier/);
});

test('id mit Grossbuchstaben wird abgelehnt', () => {
  const err = wirft(rack({ id: 'TestRack' }));
  assert.match(err.message, /id ungueltig/);
});

test('id mit Schraegstrich wird abgelehnt (waere ein Pfad)', () => {
  const err = wirft(rack({ id: '../etc' }));
  assert.match(err.message, /id ungueltig/);
});

// --- Typen --------------------------------------------------------------

test('licenseRequired als String "false" wird abgelehnt', () => {
  const err = wirft(rack({ licenseRequired: 'false' }));
  assert.match(err.message, /licenseRequired muss boolean sein/);
});

test('singleton als String "true" wird abgelehnt', () => {
  const err = wirft(rack({ singleton: 'true' }));
  assert.match(err.message, /singleton muss boolean sein/);
});

test('Rack das kein Objekt ist wird abgelehnt', () => {
  assert.match(wirft(null).message, /kein JSON-Objekt/);
  assert.match(wirft([]).message, /kein JSON-Objekt/);
  assert.match(wirft('rack').message, /kein JSON-Objekt/);
});

// --- Ports --------------------------------------------------------------

test('Port 0 wird abgelehnt', () => {
  const err = wirft(rack({ ports: { game: 0 } }));
  assert.match(err.message, /ports\.game muss ein Port/);
});

test('Port 70000 wird abgelehnt', () => {
  const err = wirft(rack({ ports: { game: 70000 } }));
  assert.match(err.message, /ports\.game muss ein Port/);
});

test('Port als String wird abgelehnt', () => {
  const err = wirft(rack({ ports: { game: '25565' } }));
  assert.match(err.message, /ports\.game muss ein Port/);
});

test('gueltige Ports werden akzeptiert', () => {
  const { rack: out } = validateRackDraft(rack({ ports: { game: 1, rcon: 65535 } }));
  assert.deepEqual(out.ports, { game: 1, rcon: 65535 });
});

// --- source: die Bezugsquelle ------------------------------------------

test('installMethod steamcmd ohne appId wird abgelehnt', () => {
  const err = wirft(rack({ source: { type: 'steam', projectId: null } }));
  assert.match(err.message, /steamcmd.*verlangt source\.appId/);
});

// Der wichtigste source-Test: die github-Methode laedt ein Archiv und
// entpackt es per Helfer als root. Ein fremder Host darf nicht durchrutschen.
test('installMethod github mit fremdem Host wird abgelehnt', () => {
  const err = wirft(rack({
    installMethod: 'github',
    configTemplate: 'test.yaml',
    source: { type: 'github', projectId: 'x', url: 'https://evil.example/x/y' },
  }));
  assert.match(err.message, /verlangt source\.url als https:\/\/github\.com/);
});

test('installMethod github mit github.com-URL wird akzeptiert', () => {
  const { rack: out } = validateRackDraft(rack({
    installMethod: 'github',
    configTemplate: 'test.yaml',
    source: { type: 'github', projectId: 'x', url: 'https://github.com/owner/repo' },
  }));
  assert.equal(out.installMethod, 'github');
});

test('installMethod github mit "owner/repo" wird akzeptiert', () => {
  const { rack: out } = validateRackDraft(rack({
    installMethod: 'github',
    configTemplate: 'test.yaml',
    source: { type: 'github', projectId: 'x', url: 'owner/repo' },
  }));
  assert.equal(out.installMethod, 'github');
});

test('installMethod github ohne configTemplate wird abgelehnt', () => {
  const err = wirft(rack({
    installMethod: 'github',
    source: { type: 'github', projectId: 'x', url: 'owner/repo' },
  }));
  assert.match(err.message, /verlangt configTemplate/);
});

test('configTemplate mit Pfad wird abgelehnt', () => {
  const err = wirft(rack({ configTemplate: 'templates/test.yaml' }));
  assert.match(err.message, /Dateiname unter templates\//);
});

// --- Relative Pfade -----------------------------------------------------

test('configFile mit ".." wird abgelehnt', () => {
  const err = wirft(rack({ configFile: '../../etc/passwd' }));
  assert.match(err.message, /configFile muss ein relativer Pfad/);
});

test('startScript absolut wird abgelehnt', () => {
  const err = wirft(rack({ startScript: '/bin/sh' }));
  assert.match(err.message, /startScript muss ein relativer Pfad/);
});

// --- Markers ------------------------------------------------------------

test('packMarkers als leerer Array wird abgelehnt', () => {
  const err = wirft(rack({ packMarkers: [] }));
  assert.match(err.message, /packMarkers muss eine nicht-leere Liste/);
});

test('packMarkers mit Pfadanteil wird abgelehnt', () => {
  const err = wirft(rack({ packMarkers: ['mods/x.jar'] }));
  assert.match(err.message, /packMarkers enthaelt einen ungueltigen Namen/);
});

test('readyMarkers mit leerem String wird abgelehnt', () => {
  const err = wirft(rack({ readyMarkers: ['   '] }));
  assert.match(err.message, /readyMarkers enthaelt einen ungueltigen Eintrag/);
});

// readyMarkers sind freie Log-Texte - "Done (" muss erlaubt sein.
test('readyMarkers mit Log-Text "Done (" wird akzeptiert', () => {
  const { rack: out } = validateRackDraft(rack({ readyMarkers: ['Done (', 'StartGame done'] }));
  assert.deepEqual(out.readyMarkers, ['Done (', 'StartGame done']);
});

// --- Unbekannte Felder --------------------------------------------------

test('unbekanntes Feld erzeugt eine Warnung, aber kein Scheitern', () => {
  const { warnings } = validateRackDraft(rack({ kundenfeld: 'eigen' }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unbekannte Felder: kundenfeld/);
});

test('Felder mit $ sind keine Warnung (z.B. $schema)', () => {
  const { warnings } = validateRackDraft(rack());
  assert.deepEqual(warnings, []);
});

// --- zip/upload: Racks ohne entfernte Quelle (2026-11-06) ----------------
//
// Befund: der Installer verzweigt nach source.type (installRoutes.js:1048
// 'zip' -> source.path, :1052 'upload' -> source.uploadId). Das Frontend
// mappt installMethod auf genau diesen Wert (INSTALL_TYPE_FOR_METHOD,
// installRoutes.js:977). Aber SOURCE_TYPES kannte 'zip' und 'upload' nicht -
// ein solches Rack liess sich deshalb gar nicht anlegen, obwohl der
// Installer den Fall implementiert hat.
//
// ZIP und Upload sind die beiden Methoden OHNE entfernte Quelle: der
// Betreiber stellt das Archiv selbst bereit. Der Wert im source.type ist
// derselbe wie die Methode, weil das Frontend ihn so bildet.

test('installMethod zip wird akzeptiert (Archiv liegt auf dem Server)', () => {
  const { rack: out } = validateRackDraft(rack({
    installMethod: 'zip',
    source: { type: 'zip', projectId: null },
    configTemplate: 'test.yaml',
  }));
  assert.equal(out.installMethod, 'zip');
  assert.equal(out.source.type, 'zip');
});

test('installMethod upload wird akzeptiert (Archiv kommt per Panel-Upload)', () => {
  const { rack: out } = validateRackDraft(rack({
    installMethod: 'upload',
    source: { type: 'upload', projectId: null },
    configTemplate: 'test.yaml',
  }));
  assert.equal(out.installMethod, 'upload');
  assert.equal(out.source.type, 'upload');
});

test('jede Install-Methode hat einen passenden source.type im Code', async () => {
  // Der Test, der die beiden Listen zusammenhaelt. Er liest die eine Liste
  // aus dem Code und die andere aus dem Code - aber er prueft, dass jede
  // Methode, die der Installer bedient, auch anlegbar ist.
  const { readFile } = await import('node:fs/promises');
  const quelle = await readFile(new URL('../app/installRoutes.js', import.meta.url), 'utf8');

  const block = quelle.match(/const INSTALL_TYPE_FOR_METHOD = \{([\s\S]*?)\};/);
  assert.ok(block, 'INSTALL_TYPE_FOR_METHOD nicht gefunden');
  const methoden = [...block[1].matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);

  assert.ok(methoden.length >= 5, `unerwartet wenige Methoden: ${methoden.join(', ')}`);

  for (const methode of methoden) {
    assert.doesNotThrow(
      () => validateRackDraft(rack({
        installMethod: methode,
        source: methode === 'steamcmd'
          ? { type: 'steam', projectId: null, appId: 1 }
          : { type: methode, projectId: null },
        configTemplate: methode === 'github' ? 'test.yaml' : undefined,
        ...(methode === 'github' ? { source: { type: 'github', projectId: null, url: 'owner/repo' } } : {}),
      })),
      `installMethod "${methode}" wird vom Installer bedient, ist aber nicht anlegbar`,
    );
  }
});
