// Tests für `kind` an Racks: Spiel vs. Dienst (2026-11-07).
//
// Ausgangslage: Ein Rack war immer ein INSTALLER. REQUIRED_FIELDS verlangt
// game, loader, installMethod, defaultRoot, source, javaRequired - fuer
// Nextcloud ist davon nichts sinnvoll:
//   game          -> 'nextcloud' steht nicht im Enum
//   installMethod -> curseforge|steamcmd|zip|upload|github (NC kommt per Docker)
//   defaultRoot   -> es wird nichts installiert, NC laeuft schon
//   source        -> keine Install-Quelle
//
// Deshalb blieb der Sword 'nextcloud' ohne Rack, und die Seitenleiste (die
// RACKS listet, nicht Swords) zeigte ihn nicht - obwohl er im Hauptbereich
// stand. Belegt: public/app.js `countFor = (rack) => allSwords.filter(...)`.
//
// Loesung: `kind` unterscheidet die zwei Arten. Ohne kind = 'game', damit
// alle Bestands-Racks unveraendert bleiben.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const racksPath = new URL('../app/racks.js', import.meta.url);

// Ein vollstaendiges Spiel-Rack (Felder wie racks/atm11.rack.json).
const spielRack = {
  id: 'atm11', name: 'All the Mods 11', description: 'Pack', icon: 'minecraft',
  game: 'minecraft', loader: 'neoforge', tier: 'premium', licenseRequired: true,
  installMethod: 'zip', defaultRoot: '/opt/minecraft', source: { type: 'curseforge', projectId: '12345' },
  javaRequired: 21,
};

test('ohne kind bleibt alles wie bisher: Spiel-Rack wird akzeptiert', async () => {
  const { validateRackDraft } = await import(racksPath);
  const { rack: r } = validateRackDraft({ ...spielRack });
  assert.equal(r.kind ?? 'game', 'game', 'fehlendes kind bedeutet game');
});

test('ein Dienst-Rack braucht KEINE Installer-Felder', async () => {
  const { validateRackDraft } = await import(racksPath);
  const nc = {
    kind: 'service', id: 'nextcloud', name: 'Nextcloud',
    description: 'Dateien, Deck, Kalender', icon: 'service',
    tier: 'premium', licenseRequired: false,
  };
  const { rack: r } = validateRackDraft(nc);
  assert.equal(r.kind, 'service');
});

test('ein Dienst-Rack darf auch kein game/loader/installMethod haben', async () => {
  const { validateRackDraft } = await import(racksPath);
  // Genau das war vorher unmoeglich: game ist Pflicht und der Enum kennt
  // 'nextcloud' nicht. Ein Dienst-Rack soll die Felder GAR NICHT brauchen.
  const nc = {
    kind: 'service', id: 'nextcloud', name: 'Nextcloud',
    description: 'Dateien, Deck, Kalender', icon: 'service',
    tier: 'premium', licenseRequired: false,
  };
  const { rack: r } = validateRackDraft(nc);
  assert.equal(r.game, undefined, 'game wird fuer Dienste nicht erfunden');
  assert.equal(r.installMethod, undefined, 'installMethod wird nicht erfunden');
  assert.equal(r.defaultRoot, undefined, 'defaultRoot wird nicht erfunden');
});

test('ein Dienst-Rack mit Installer-Feldern wird ABGELEHNT (keine Mischform)', async () => {
  const { validateRackDraft } = await import(racksPath);
  const gemischt = {
    kind: 'service', id: 'nextcloud', name: 'Nextcloud', description: 'x', icon: 's',
    tier: 'premium', licenseRequired: false,
    installMethod: 'zip', defaultRoot: '/opt/nextcloud',
  };
  // Warum ablehnen statt stillschweigend erlauben? Weil ein Dienst-Rack
  // nichts installiert - ein installMethod hier waere eine Luege im Datenmodell,
  // und der Installer wuerde es spaeter vielleicht sogar befolgen.
  assert.throws(() => validateRackDraft(gemischt), /kind|service|Install/i);
});

test('kind muss "game" oder "service" sein - nichts anderes', async () => {
  const { validateRackDraft } = await import(racksPath);
  assert.throws(
    () => validateRackDraft({ ...spielRack, kind: 'quatsch' }),
    /kind/i,
  );
  assert.throws(
    () => validateRackDraft({ ...spielRack, kind: 42 }),
    /kind/i,
  );
});

test('ein Spiel-Rack ohne game bleibt ein Fehler', async () => {
  const { validateRackDraft } = await import(racksPath);
  const ohneGame = { ...spielRack };
  delete ohneGame.game;
  assert.throws(() => validateRackDraft(ohneGame), /Pflichtfelder|game/i,
    'die Lockerung darf nicht auf Spiel-Racks durchschlagen');
});

test('id-Regeln gelten fuer beide Arten gleich', async () => {
  const { validateRackDraft } = await import(racksPath);
  const basis = { kind: 'service', name: 'X', description: 'x', icon: 's', tier: 'premium', licenseRequired: false };
  assert.throws(() => validateRackDraft({ ...basis, id: 'Gross' }), /id/i);
  assert.throws(() => validateRackDraft({ ...basis, id: '../boese' }), /id/i);
  assert.doesNotThrow(() => validateRackDraft({ ...basis, id: 'nextcloud' }));
});
