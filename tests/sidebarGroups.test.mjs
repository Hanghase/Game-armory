// Tests für die Sidebar-Gruppierung (public/app.js).
//
// Ausgangslage: groupRacks() gruppierte ausschliesslich nach `r.game`. Ein
// Dienst-Rack (Nextcloud, kind 'service') hat kein `game` und fiel unter
// "andere". Das Frontend ist Browser-JS ohne Module-Export, deshalb wird die
// Funktion hier aus dem Quelltext geholt und in einem eigenen Kontext
// ausgewertet - nicht nachgebaut. Eine Nachbildung wuerde nur beweisen, dass
// die Nachbildung stimmt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appUrl = new URL('../public/app.js', import.meta.url);

async function ladeFunktionen() {
  const q = await readFile(appUrl, 'utf8');
  // NUR die Tabellen und groupRacks - nicht das Startup-IIFE daneben, das
  // `api()` ruft und ohne DOM/Netz scheitert (erster Versuch, live gesehen).
  const tabellenAnfang = q.indexOf('const GAME_LABELS = {');
  const tabellenEnde = q.indexOf('const GAME_ORDER');
  assert.ok(tabellenAnfang > 0 && tabellenEnde > tabellenAnfang, 'GAME_LABELS nicht gefunden');
  const tabellen = q.slice(tabellenAnfang, q.indexOf('\n', tabellenEnde) + 1);

  const fnAnfang = q.indexOf('const SERVICE_LABEL');
  const fnEnde = q.indexOf('function visibleRacks()');
  assert.ok(fnAnfang > 0 && fnEnde > fnAnfang, 'groupRacks nicht gefunden');
  const fn = q.slice(fnAnfang, fnEnde);

  const stueck = tabellen + '\n' + fn;

  const ctx = vm.createContext({ console });
  // GAME_LABELS, GAME_ORDER, SERVICE_LABEL und groupRacks im leeren Kontext
  // auswerten. Kein DOM, kein Netz - die Funktion rechnet nur.
  vm.runInContext(stueck + '\n; this.groupRacks = groupRacks; this.SERVICE_LABEL = SERVICE_LABEL;', ctx);
  return ctx;
}

const racks = [
  { id: 'atm11', kind: 'game', game: 'minecraft', name: 'ATM11' },
  { id: '7d2d', kind: 'game', game: '7d2d', name: '7d2d' },
  { id: 'nextcloud', kind: 'service', name: 'Nextcloud' },
];

test('Dienst-Racks bilden die Gruppe "Home Lab"', async () => {
  const ctx = await ladeFunktionen();
  const gruppen = ctx.groupRacks(racks);
  const homeLab = gruppen.find((g) => g.key === 'homelab');
  assert.ok(homeLab, 'es muss eine Home-Lab-Gruppe geben');
  assert.equal(homeLab.label, 'Home Lab');
  // Arrays aus vm.createContext stammen aus einem anderen Realm; deepEqual
  // prueft dann auch den Prototyp. Deshalb in den Test-Realm kopieren.
  assert.deepEqual([...homeLab.racks.map((r) => r.id)], ['nextcloud']);
});

test('"Home Lab" steht VOR den Spielen', async () => {
  const ctx = await ladeFunktionen();
  const gruppen = ctx.groupRacks(racks);
  assert.equal(gruppen[0].key, 'homelab', 'Dienste stehen oben - was laeuft, sieht man zuerst');
});

test('Spiel-Racks bleiben unveraendert gruppiert', async () => {
  const ctx = await ladeFunktionen();
  const gruppen = ctx.groupRacks(racks);
  const keys = gruppen.map((g) => g.key);
  assert.ok(keys.includes('minecraft'));
  assert.ok(keys.includes('7d2d'));
  // Kein Dienst-Rack darf in einer Spiel-Gruppe landen.
  const mc = gruppen.find((g) => g.key === 'minecraft');
  assert.deepEqual([...mc.racks.map((r) => r.id)], ['atm11']);
});

test('ohne Dienst-Racks gibt es KEINE leere Home-Lab-Gruppe', async () => {
  const ctx = await ladeFunktionen();
  const gruppen = ctx.groupRacks([{ id: 'atm11', kind: 'game', game: 'minecraft' }]);
  assert.equal(gruppen.find((g) => g.key === 'homelab'), undefined);
});

test('ein Rack ohne kind gilt als Spiel-Rack (Bestand)', async () => {
  const ctx = await ladeFunktionen();
  const gruppen = ctx.groupRacks([{ id: 'alt', game: 'minecraft' }]);
  assert.equal(gruppen.find((g) => g.key === 'homelab'), undefined);
  assert.ok(gruppen.find((g) => g.key === 'minecraft'));
});
