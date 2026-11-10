// Tests fuer den Schreibpfad der Adoption (Karte 28).
//
// Wichtig: `pruefeSchreibbar` wird GEGEN das echte validateSword geprueft.
// Ein Test, der nur die eigene Kopie der Regeln testet, beweist nichts -
// wenn swords.js:64 etwas anderes verlangt, merkt es niemand.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  baueAdoptiertenSword,
  pruefeSchreibbar,
  schreibeSword,
  schreibeHerkunft,
  markerFuer,
  MARKER,
  SWORDS_DIR,
} from '../app/adoptschreiben.js';

// --- Bauen ---------------------------------------------------------------

test('ein adoptierter Sword nennt seine Herkunft als "existing"', () => {
  // Der Unterschied zwischen "installiert" und "vorgefunden" ist der Kern
  // der Adoption. Geht das Feld verloren, weiss das Panel nicht, dass es
  // keine Pack-Version kennen kann.
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'Nextcloud', port: 8088,
    control: { type: 'docker', compose: '/opt/nextcloud/docker-compose.yml' },
    logs: { type: 'docker', service: 'nc-app' },
  });
  assert.equal(s.installedVersionSource, 'existing');
  assert.equal(s.id, 'nextcloud');
  assert.equal(s.rack, 'nextcloud');
  assert.ok(s.installedVersion, 'installedVersion muss gesetzt sein, sonst laedt der Sword nicht');
});

// --- Pruefen -------------------------------------------------------------

test('ein vollstaendiger Sword ist schreibbar', () => {
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'Nextcloud', port: 8088,
    control: { type: 'docker' }, logs: { type: 'docker', service: 'nc-app' },
  });
  assert.deepEqual(pruefeSchreibbar(s, []), []);
});

test('ohne installedVersion wird abgelehnt', () => {
  // Harte Regel aus swords.js:64. Ohne diese Angabe laedt der Sword beim
  // naechsten loadSwords() nicht - er waere unsichtbar.
  const s = baueAdoptiertenSword({
    id: 'x1', rackId: 'nextcloud', name: 'X', port: 8088, control: {}, logs: {},
  });
  delete s.installedVersion;
  const f = pruefeSchreibbar(s, []);
  assert.ok(f.some((x) => /installedVersion/.test(x)), `erwartet installedVersion-Fehler, kam: ${f.join('; ')}`);
});

test('ohne rack wird abgelehnt', () => {
  // game/eula kommen aus dem Rack (swords.js:135). Ohne Rack kein Sword.
  const s = baueAdoptiertenSword({
    id: 'x1', rackId: 'nextcloud', name: 'X', port: 8088, control: {}, logs: {},
  });
  delete s.rack;
  const f = pruefeSchreibbar(s, []);
  assert.ok(f.some((x) => /rack/.test(x)), `erwartet rack-Fehler, kam: ${f.join('; ')}`);
});

test('eine bereits vergebene id wird abgelehnt', () => {
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'N', port: 8088, control: {}, logs: {},
  });
  const f = pruefeSchreibbar(s, ['nextcloud', 'atm11']);
  assert.ok(f.some((x) => /bereits vergeben/.test(x)));
});

test('ein Port ausserhalb 1024-65535 wird abgelehnt', () => {
  const s = baueAdoptiertenSword({
    id: 'x1', rackId: 'nextcloud', name: 'X', port: 80, control: {}, logs: {},
  });
  const f = pruefeSchreibbar(s, []);
  assert.ok(f.some((x) => /Port/.test(x)), `erwartet Port-Fehler, kam: ${f.join('; ')}`);
});

test('eine id mit Unterstrich wird abgelehnt (Dateiname == id)', () => {
  const s = baueAdoptiertenSword({
    id: 'next_cloud', rackId: 'nextcloud', name: 'X', port: 8088, control: {}, logs: {},
  });
  const f = pruefeSchreibbar(s, []);
  assert.ok(f.some((x) => /id/.test(x)));
});

// --- Gegenprobe gegen das ECHTE validateSword ---------------------------

test('was hier durchgeht, geht auch durch validateSword', async () => {
  // Das ist die eigentliche Zusicherung: die Kopie der Regeln darf nicht
  // strenger ODER lockerer sein als das Original. Ohne diesen Test waere
  // eine Adoption moeglich, die beim naechsten Laden verschwindet.
  const { validateSword } = await import('../app/swords.js');

  const s = baueAdoptiertenSword({
    id: 'probe1', rackId: 'nextcloud', name: 'Probe', port: 8088,
    control: { type: 'docker' }, logs: { type: 'docker', service: 'nc-app' },
  });

  assert.deepEqual(pruefeSchreibbar(s, []), [], 'unsere Pruefung muss zustimmen');

  const warnings = [];
  const ergebnis = validateSword(s, 'probe1.sword.json', warnings);
  // validateSword gibt bei Erfolg `true` zurueck (nicht null) - nachgesehen
  // in swords.js:80.
  assert.equal(ergebnis, true, `validateSword lehnt ab: ${JSON.stringify(ergebnis)}`);
});

test('was wir ablehnen, lehnt validateSword auch ab', async () => {
  const { validateSword } = await import('../app/swords.js');

  // validateSword WIRFT bei einem harten Fehler (nachgesehen: swords.js:68
  // wirft "installedVersion fehlt ..."). Frueher habe ich hier auf einen
  // Rueckgabewert geprueft - das war meine Annahme, nicht der Code.

  // Ohne installedVersion: beide muessen ablehnen.
  const s = baueAdoptiertenSword({
    id: 'probe2', rackId: 'nextcloud', name: 'Probe', port: 8088, control: {}, logs: {},
  });
  delete s.installedVersion;

  assert.ok(pruefeSchreibbar(s, []).length > 0, 'wir lehnen ab');
  assert.throws(
    () => validateSword(s, 'probe2.sword.json', []),
    /installedVersion/,
    'validateSword muss ebenfalls ablehnen - sonst waere unsere Regel zu lasch abgestimmt',
  );

  // Dateiname != id: ACHTUNG, eine gemessene Enttaeuschung.
  //
  // Ich hatte angenommen, validateSword pruefe das - der Kommentar in
  // swords.js:111 ("Audit-Fix 2026-10-30 D211") klingt auch so. Nachgemessen
  // 2026-11-10: die Pruefung steht im AUFRUFER (loadSwords, swords.js:118),
  // nicht in validateSword. Ein direkter Aufruf mit falschem Dateinamen gibt
  // `true` zurueck.
  //
  // Das ist der Grund, warum pruefeSchreibbar die id selbst prueft und
  // schreibeSword den Dateinamen AUS der id baut - dann koennen die beiden
  // gar nicht auseinanderlaufen.
  const s2 = baueAdoptiertenSword({
    id: 'probe3', rackId: 'nextcloud', name: 'Probe', port: 8088, control: {}, logs: {},
  });
  assert.equal(
    validateSword(s2, 'anders.sword.json', []), true,
    'gemessen: validateSword selbst prueft den Dateinamen NICHT - das macht loadSwords',
  );

  // Deshalb hier die eigentliche Zusicherung: der Dateiname entsteht aus der id.
  const r = await schreibeSword(s2, {
    dir: '/tmp/x', mkdir: async () => {}, writeFile: async () => {},
    rename: async () => {}, unlink: async () => {},
  });
  assert.match(r.pfad, /probe3\.sword\.json$/, 'der Dateiname muss aus der id folgen');
});

// --- Schreiben -----------------------------------------------------------

test('schreibeSword schreibt nach tmp und benennt um', async () => {
  const schritte = [];
  const deps = {
    dir: '/tmp/probe-swords',
    mkdir: async () => {},
    writeFile: async (pfad) => { schritte.push(['write', pfad]); },
    rename: async (von, nach) => { schritte.push(['rename', von, nach]); },
    unlink: async () => {},
  };
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'N', port: 8088, control: {}, logs: {},
  });
  const r = await schreibeSword(s, deps);

  assert.equal(r.ok, true);
  assert.match(r.pfad, /nextcloud\.sword\.json$/);
  assert.equal(schritte[0][0], 'write');
  assert.match(schritte[0][1], /\.tmp-/, 'erst in eine tmp-Datei');
  assert.equal(schritte[1][0], 'rename', 'dann umbenennen');
});

test('ein ungueltiger Sword wird gar nicht erst geschrieben', async () => {
  const geschrieben = [];
  const deps = {
    dir: '/tmp/probe-swords',
    mkdir: async () => {},
    writeFile: async () => { geschrieben.push(1); },
    rename: async () => { geschrieben.push(1); },
    unlink: async () => {},
  };
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'N', port: 8088, control: {}, logs: {},
  });
  delete s.installedVersion;

  const r = await schreibeSword(s, deps);
  assert.equal(r.ok, false);
  assert.equal(geschrieben.length, 0, 'bei Ablehnung darf keine Datei entstehen');
});

test('ein Schreibfehler raeumt die tmp-Datei weg', async () => {
  // Lehre aus dem Transfer: eine liegen bleibende .teil-Datei sieht aus wie
  // ein Fehler und niemand weiss, woher sie kommt.
  const entfernt = [];
  const deps = {
    dir: '/tmp/probe-swords',
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async () => { throw new Error('Platte voll'); },
    unlink: async (p) => { entfernt.push(p); },
  };
  const s = baueAdoptiertenSword({
    id: 'nextcloud', rackId: 'nextcloud', name: 'N', port: 8088, control: {}, logs: {},
  });
  const r = await schreibeSword(s, deps);

  assert.equal(r.ok, false);
  assert.match(r.fehler[0], /Platte voll/);
  assert.equal(entfernt.length, 1, 'die tmp-Datei muss weggeraeumt werden');
});

// --- Herkunft ------------------------------------------------------------

test('die Herkunftsdatei wird nur angelegt, wenn es sie noch nicht gibt', async () => {
  // Existiert sie, hat der Betreiber dort womoeglich eigene Angaben. Dann
  // melden statt plattmachen.
  const deps = {
    stat: async () => ({ isFile: () => true }),
    writeFile: async () => { throw new Error('darf nicht schreiben'); },
    rename: async () => { throw new Error('darf nicht umbenennen'); },
    unlink: async () => {},
  };
  const r = await schreibeHerkunft('/opt/minecraft/atm11', { herkunft: 'adopted' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.vorhanden, true);
  assert.match(r.grund, /bereits/);
});

test('die Herkunftsdatei nennt KEINE erfundene Pack-Version', async () => {
  let inhalt = '';
  const deps = {
    stat: async () => { throw new Error('gibt es nicht'); },
    writeFile: async (p, c) => { inhalt = c; },
    rename: async () => {},
    unlink: async () => {},
  };
  const r = await schreibeHerkunft('/opt/minecraft/atm11',
    { herkunft: 'adopted', erkanntAm: '2026-11-10' }, deps);

  assert.equal(r.ok, true);
  // Eine Pack-Version gibt es in der Installation nicht - sie darf hier
  // nicht auftauchen, auch nicht als null.
  assert.ok(!/packVersion|installedVersion/.test(inhalt),
    `die Herkunft darf keine Version behaupten: ${inhalt}`);
  assert.match(inhalt, /adopted/);
});

test('ohne absolutes Arbeitsverzeichnis wird nichts geschrieben', async () => {
  const r = await schreibeHerkunft('relativ/pfad', { a: 1 }, {});
  assert.equal(r.ok, false);
  assert.match(r.grund, /Arbeitsverzeichnis/);
});

// --- Marker --------------------------------------------------------------

test('fuer Nextcloud gibt es Struktur-Marker', () => {
  const m = markerFuer('nextcloud');
  assert.ok(Array.isArray(m) && m.includes('docker-compose.yml'));
});

test('fuer eine unbekannte Dienstart gibt es KEINE Marker (nicht pruefbar)', () => {
  // null heisst: nicht pruefbar. Das darf nie als bestanden gelten.
  assert.equal(markerFuer('irgendein-dienst'), null);
});

test('die ATM-Marker enthalten nicht die Dateien, die es dort nicht gibt', () => {
  // Live nachgemessen 2026-11-10: weder modrinth.index.json noch
  // manifest.json existieren in /opt/minecraft/atm11. Ein Marker, den es nie
  // gibt, macht jede Pruefung rot.
  const m = MARKER.atm11;
  assert.ok(!m.includes('modrinth.index.json'));
  assert.ok(!m.includes('manifest.json'));
  assert.ok(m.includes('startserver.sh'));
  assert.ok(m.includes('libraries/net/neoforged'));
});

test('der Sword-Ordner ist der echte Pfad', () => {
  assert.equal(SWORDS_DIR, '/opt/game-armory/swords');
});
