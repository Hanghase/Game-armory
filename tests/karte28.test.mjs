// Karte 28, die zwei offenen Punkte (2026-11-10).
//
// Befund: der Kandidat kennt seine Compose-Datei (unter `quellen`), aber die
// Route baut daraus kein `control`. Folge live gemessen:
//   dockerStatus({}) -> state "unknown", "Ungueltiger compose-Pfad: (fehlt)"
// Status lesen und start/stop funktionieren also nur, wenn ein Mensch den
// Pfad von Hand einsetzt. Das ist nicht "fertig".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wurzel = new URL('../', import.meta.url);
const route = await readFile(new URL('app/adoptroutes.js', wurzel), 'utf8');

test('aus dem Kandidaten wird ein control gebaut', () => {
  // Ohne das traegt der Sword kein control.compose, und dockerStatus kann
  // nichts anzeigen.
  //
  // ACHTUNG: hier reicht NICHT, dass "baueControl" irgendwo in der Datei
  // steht. Die erste Fassung prueft genau das - und blieb gruen, als ich den
  // Aufruf durch `body.control` ersetzt hatte, weil der IMPORT den Namen
  // weiter enthaelt. Deshalb: der AUFRUF muss da sein, mit dem Kandidaten.
  assert.match(route, /control\s*=\s*baueControl\(\s*kandidat\b/,
    'die Route ruft baueControl NICHT mit dem Kandidaten auf');
});

test('der Body darf kein control unterschieben', () => {
  // Gegenprobe: kaeme control aus dem Body, koennte ein Aufrufer einen
  // beliebigen Pfad setzen - und dockerStatus wuerde auf eine fremde Datei
  // zeigen. Das ist die gefaehrlichere der beiden Varianten.
  assert.ok(!/control:\s*body\.control/.test(route),
    'control kommt aus dem Body statt aus der Erkennung');
});

test('der Compose-Pfad kommt aus den quellen des Kandidaten', () => {
  assert.match(route, /kandidat\.quellen/, 'der Pfad wird nicht aus den quellen gelesen');
});

test('ein Kandidat ohne Compose-Datei wird abgelehnt, nicht geraten', () => {
  // Ein geratener Pfad waere schlimmer als keiner: dockerStatus wuerde auf
  // eine fremde Datei zeigen.
  assert.match(route, /keine Compose-Datei|compose.*fehlt|ohne Compose/i,
    'es fehlt die Ablehnung fuer Kandidaten ohne Compose-Datei');
});

test('docker ist eine bekannte Install-Methode', () => {
  // Karte 28: "installMethod 'docker' als zweiter Zweig".
  // Geprueft in installRoutes.js, hier nur der Nachweis, dass es dort steht.
  return readFile(new URL('app/installRoutes.js', wurzel), 'utf8').then((s) => {
    assert.match(s, /docker:\s*'docker'/,
      'INSTALL_TYPE_FOR_METHOD kennt docker nicht');
  });
});

// --- baueControl selbst --------------------------------------------------
//
// Die Tests oben lesen nur Quelltext. Ob die Funktion WIRKT, sehen sie nicht.
// Genau hier blieb eine Mutation gruen: baueControl gab immer null zurueck,
// und kein Test merkte es. Also die Funktion wirklich aufrufen.

const { baueControl } = await import(new URL('app/adoptschreiben.js', wurzel));

test('aus einem Docker-Kandidaten entsteht ein control mit Compose-Pfad', () => {
  const control = baueControl({
    quelle: 'docker',
    id: 'nextcloud',
    quellen: ['/opt/nextcloud/docker-compose.yml'],
    dienste: ['nc-app', 'nc-db', 'nc-redis'],
  }, '/opt/nextcloud');

  assert.equal(control.type, 'docker');
  assert.equal(control.compose, '/opt/nextcloud/docker-compose.yml');
  assert.deepEqual(control.services, ['nc-app', 'nc-db', 'nc-redis']);
  assert.equal(control.workingDir, '/opt/nextcloud');
});

test('ein Kandidat ohne Compose-Datei ergibt null, keinen geratenen Pfad', () => {
  assert.equal(baueControl({ quelle: 'docker', id: 'x', quellen: [] }, '/opt/x'), null);
  assert.equal(baueControl({ quelle: 'docker', id: 'x' }, '/opt/x'), null);
  assert.equal(baueControl(null, '/opt/x'), null);
});

test('zwei Compose-Dateien sind ein Konflikt, kein Muenzenwurf', () => {
  // Eine auswaehlen waere geraten. Lieber laut scheitern.
  assert.throws(
    () => baueControl({
      quelle: 'docker', id: 'x',
      quellen: ['/opt/a/docker-compose.yml', '/opt/b/docker-compose.yml'],
    }, '/opt/x'),
    /2 Compose-Dateien/,
  );
});

test('eine systemd-Unit wird als systemd abgebildet, nicht als docker', () => {
  const control = baueControl({ quelle: 'systemd', id: 'atm11' }, '/opt/atm11');
  assert.equal(control.type, 'systemd');
  assert.equal(control.unit, 'atm11.service');
});

test('das control passt zu dem, was dockerStatus erwartet', () => {
  // Der Beweis, dass die Nahtstelle stimmt: dockerStatus liest control.compose.
  // Ohne diese Zeile waere der Sword geschrieben und der Status trotzdem
  // "unknown" - genau der Zustand, den ich am 2026-11-10 gemessen habe.
  const control = baueControl({
    quelle: 'docker', id: 'nextcloud',
    quellen: ['/opt/nextcloud/docker-compose.yml'], dienste: ['nc-app'],
  }, '/opt/nextcloud');
  assert.ok(control.compose, 'ohne compose liefert dockerStatus "Ungueltiger compose-Pfad"');
});
