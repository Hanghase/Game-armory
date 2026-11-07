// Tests für das Gate im WebSocket-Log-Pfad (app/server.js).
//
// Ausgangslage 2026-11-07: Der Live-Log-Kanal prueft VOR streamLogs:
//
//   const service = sword.control?.service;
//   if (!service) { ws.send('[armory] Kein Service definiert\n'); ws.close(); return; }
//
// Ein Docker-Sword (nextcloud) hat kein control.service. Der Log-Knopf war
// damit tot, obwohl streamLogs('docker') inzwischen funktioniert - die Sperre
// lag eine Ebene DARUEBER. Genau dieser Fall wurde beim ersten Fix uebersehen:
// streamLogs war repariert, das Gate davor nicht.
//
// Der Code wird hier per Quelltext geprueft (server.js startet beim Import
// einen HTTP-Server - er darf im Test nicht einfach geladen werden).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const serverUrl = new URL('../app/server.js', import.meta.url);

async function quelle() {
  return await readFile(serverUrl, 'utf8');
}

test('das Log-Gate fragt nicht mehr hart nach control.service', async () => {
  const q = await quelle();

  // Die alte Sperre darf nicht mehr VOR der Typunterscheidung stehen. Im
  // systemd-Zweig ist sie richtig (und muss dort bleiben).
  const vonGate = q.slice(q.indexOf("wss.on('connection'"));
  const gateBereich = vonGate.slice(0, vonGate.indexOf("ws.on('close'"));
  const vorUnterscheidung = gateBereich.slice(0, gateBereich.indexOf('controlKind'));
  assert.ok(!/const service = sword\.control\?\.service/.test(vorUnterscheidung),
    'vor controlKind darf control.service nicht hart abgefragt werden');

  // Stattdessen muss vor streamLogs nach der Steuerart unterschieden werden.
  assert.match(q, /controlKind\(sword\)/,
    'der Log-Pfad muss controlKind(sword) auswerten');
});

test('das Log-Gate laesst docker durch und lehnt unbrauchbare Swords ab', async () => {
  const q = await quelle();

  // Der docker-Zweig muss streamLogs erreichen koennen.
  const vonGate = q.slice(q.indexOf('wss.on(\'connection\''));
  const gateBereich = vonGate.slice(0, vonGate.indexOf('ws.on(\'close\''));

  assert.match(gateBereich, /streamLogs\(sword/,
    'streamLogs muss im Gate-Bereich gerufen werden');
  assert.match(gateBereich, /docker/,
    'der Gate-Bereich muss den docker-Fall kennen');
});

test('die alte Meldung bleibt fuer wirklich service-lose systemd-Swords', async () => {
  const q = await quelle();
  const vonGate = q.slice(q.indexOf('wss.on(\'connection\''));
  const gateBereich = vonGate.slice(0, vonGate.indexOf('ws.on(\'close\''));
  // Ein systemd-Sword ohne service ist weiterhin ein Fehler und muss gemeldet
  // werden - nur eben nicht mehr fuer docker.
  assert.match(gateBereich, /Kein Service definiert/,
    'die Meldung fuer kaputte systemd-Swords soll erhalten bleiben');
});
