// Tests fuer die Annahme der Arsenal-Verbindung im Panel (app/arsenalSocket.js).
//
// Hier liegt die Gegenseite des Agenten: die Armory nimmt die WebSocket-
// Verbindung eines Arsenals an und schickt Befehle durch sie hindurch.
//
// Der wichtigste Punkt: die Verbindung wird ueber den ARSENAL-SCHLUESSEL
// angenommen, nicht ueber die IP. Und ein gesperrtes Arsenal kommt nicht rein.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-socket-'));
process.env.ARMORY_DB_PATH = path.join(tmpDir, 'test.db');

const store = await import('../app/arsenalStore.js');
const { pruefeHandshake, registriere, abmelden, istVerbunden, sendeBefehl, anzahl,
        frageArsenal, verarbeiteNachricht } =
  await import('../app/arsenalSocket.js');
const { hashSecret } = await import('../app/arsenals.js');

after(() => {
  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function leereAlles() {
  store.db.exec('DELETE FROM arsenals; DELETE FROM arsenal_pairings;');
}

function neuesArsenal(name = 'test') {
  const { code } = store.createPairing();
  return store.redeemPairing({ code, name });
}

test('gueltiger Schluessel wird angenommen', () => {
  leereAlles();
  const { arsenal, key } = neuesArsenal();
  const r = pruefeHandshake({ id: arsenal.id, key });
  assert.equal(r.ok, true);
  assert.equal(r.arsenal.id, arsenal.id);
});

test('falscher Schluessel wird abgelehnt', () => {
  leereAlles();
  const { arsenal } = neuesArsenal();
  const r = pruefeHandshake({ id: arsenal.id, key: 'falsch' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('fehlender Schluessel wird abgelehnt', () => {
  leereAlles();
  const { arsenal } = neuesArsenal();
  for (const key of ['', null, undefined]) {
    const r = pruefeHandshake({ id: arsenal.id, key });
    assert.equal(r.ok, false, `Schluessel ${JSON.stringify(key)} akzeptiert`);
  }
});

test('unbekannte ID und falscher Schluessel sehen gleich aus', () => {
  // Sonst liesse sich mit geratenen IDs herausfinden, welche Arsenale es gibt.
  leereAlles();
  const { key } = neuesArsenal();
  const unbekannt = pruefeHandshake({ id: 99999, key });
  const falsch = pruefeHandshake({ id: 1, key: 'falsch' });
  assert.equal(unbekannt.ok, false);
  assert.equal(falsch.ok, false);
  assert.equal(unbekannt.reason, falsch.reason);
  assert.equal(unbekannt.httpStatus, falsch.httpStatus);
});

test('gesperrtes Arsenal wird abgelehnt, auch mit richtigem Schluessel', () => {
  leereAlles();
  const { arsenal, key } = neuesArsenal('gesperrt');
  store.revokeArsenal(arsenal.id);
  const r = pruefeHandshake({ id: arsenal.id, key });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('ungueltige ID wird abgelehnt', () => {
  for (const id of [0, -1, 'abc', null, undefined, 1.5]) {
    const r = pruefeHandshake({ id, key: 'irgendwas' });
    assert.equal(r.ok, false, `ID ${JSON.stringify(id)} akzeptiert`);
  }
});

test('registriere und abmelden verwalten die offenen Leitungen', () => {
  leereAlles();
  const { arsenal } = neuesArsenal('leitung');
  assert.equal(istVerbunden(arsenal.id), false);

  const gesendet = [];
  const fakeWs = { send: (d) => gesendet.push(d), close: () => {} };
  registriere(arsenal.id, fakeWs);
  assert.equal(istVerbunden(arsenal.id), true);
  assert.equal(anzahl(), 1);

  abmelden(arsenal.id);
  assert.equal(istVerbunden(arsenal.id), false);
  assert.equal(anzahl(), 0);
});

test('sendeBefehl schickt JSON an das richtige Arsenal', () => {
  leereAlles();
  const a = neuesArsenal('eins');
  const b = neuesArsenal('zwei');
  const gesendetA = [];
  const gesendetB = [];
  registriere(a.arsenal.id, { send: (d) => gesendetA.push(d), close: () => {} });
  registriere(b.arsenal.id, { send: (d) => gesendetB.push(d), close: () => {} });

  const ok = sendeBefehl(a.arsenal.id, { type: 'command', action: 'status' });
  assert.equal(ok, true);
  assert.equal(gesendetA.length, 1);
  assert.equal(gesendetB.length, 0, 'Befehl landete beim falschen Arsenal');

  const nachricht = JSON.parse(gesendetA[0]);
  assert.equal(nachricht.type, 'command');
  assert.equal(nachricht.action, 'status');
  // Jeder Befehl bekommt eine Referenz, damit die Antwort zuzuordnen ist.
  assert.ok(nachricht.ref, 'kein ref gesetzt');

  abmelden(a.arsenal.id);
  abmelden(b.arsenal.id);
});

test('sendeBefehl an ein nicht verbundenes Arsenal meldet false', () => {
  leereAlles();
  const ok = sendeBefehl(424242, { type: 'command', action: 'status' });
  assert.equal(ok, false);
});

test('sendeBefehl meldet false, wenn ws.send wirft', () => {
  // Eine Leitung kann zwischen Pruefung und Senden sterben.
  leereAlles();
  const { arsenal } = neuesArsenal('kaputt');
  registriere(arsenal.id, { send: () => { throw new Error('kaputt'); }, close: () => {} });
  assert.equal(sendeBefehl(arsenal.id, { type: 'command', action: 'status' }), false);
  abmelden(arsenal.id);
});

test('eine neue Verbindung ersetzt die alte Leitung desselben Arsenals', () => {
  // Sonst haengen bei jedem Reconnect Leitungen im Speicher.
  leereAlles();
  const { arsenal } = neuesArsenal('doppelt');
  let altGeschlossen = false;
  registriere(arsenal.id, { send: () => {}, close: () => { altGeschlossen = true; } });

  const zweiter = [];
  registriere(arsenal.id, { send: (d) => zweiter.push(d), close: () => {} });

  assert.equal(altGeschlossen, true, 'alte Leitung blieb offen');
  assert.equal(anzahl(), 1);

  sendeBefehl(arsenal.id, { type: 'command', action: 'status' });
  assert.equal(zweiter.length, 1, 'Befehl ging an die alte Leitung');
  abmelden(arsenal.id);
});

test('sendeBefehl an ein NICHT verbundenes Arsenal, waehrend ein anderes verbunden ist', () => {
  // Der schaerfere Fall: ein fremdes Arsenal haengt an der Leitung. Ein
  // Befehl an ein NICHT verbundenes Arsenal darf trotzdem nicht rausgehen.
  // Die Mutation vom 2026-11-09 ("nimm irgendeine Leitung") blieb beim
  // ersten Test gruen, weil es dort nur eine Leitung gab.
  leereAlles();
  const verbunden = neuesArsenal('verbunden');
  const fremd = neuesArsenal('fremd');

  const gesendet = [];
  registriere(verbunden.arsenal.id, { send: (d) => gesendet.push(d), close: () => {} });

  // ID, die es gibt, aber die keine Leitung hat.
  const ok = sendeBefehl(fremd.arsenal.id, { type: 'command', action: 'status' });
  assert.equal(ok, false, 'Befehl ging an die falsche Leitung');
  assert.equal(gesendet.length, 0, 'Befehl landete bei einem fremden Arsenal');
  assert.equal(abmelden, abmelden); // noop, damit der Block lesbar bleibt
  abmelden(verbunden.arsenal.id);
});

test('frageArsenal an ein offenes Arsenal wartet nicht ewig ohne Antwort', () => {
  // Ohne Deckel haengt der Klick im Panel fuer immer.
  leereAlles();
  const { arsenal } = neuesArsenal('stumm');
  const gesendet = [];
  registriere(arsenal.id, { send: (d) => gesendet.push(d), close: () => {} });

  const p = frageArsenal(arsenal.id, { action: 'status' });
  assert.equal(gesendet.length, 1, 'Befehl wurde nicht geschickt');
  assert.equal(typeof p.then, 'function');

  // Antwort simulieren: dann muss das Promise aufloesen.
  const geschickt = JSON.parse(gesendet[0]);
  assert.ok(geschickt.ref, 'kein ref am Befehl');
  verarbeiteNachricht(arsenal.id, JSON.stringify({
    type: 'result', ref: geschickt.ref, ok: true, output: 'active',
  }));

  return p.then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.output, 'active');
    abmelden(arsenal.id);
  });
});

test('frageArsenal ohne Leitung antwortet sofort mit arsenal-offline', async () => {
  leereAlles();
  const r = await frageArsenal(999999, { action: 'status' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'arsenal-offline');
});
