// Tests fuer den Docker-Tab im Update-Dialog (2026-11-26).
//
// Anlass: Der Helfer und die API standen fertig, aber Felix konnte im Panel
// kein Update ausloesen - der Stack hat kein Archiv zum Hochladen, und der
// Dialog kannte nur cf/zip/upload/steam/github. "Bau den Updater" heisst
// offenbar nicht "bau eine URL" - die Oberflaeche gehoert dazu.
//
// Geprueft wird die VERDRAHTUNG, nicht das Aussehen: kommt der Tab beim
// Docker-Rack an, schickt der Start den richtigen Koerper, und faellt der
// Start nicht in den 202/Polling-Zweig, der hier nichts anzeigen kann.

import { test, assert } from './_fixtures.mjs';
import { readFile } from 'node:fs/promises';

const html = () => readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const js = () => readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('Der Dialog hat einen Docker-Tab mit Knopf und Flaeche', async () => {
  const q = await html();
  assert.match(q, /data-tab="docker"/,
    'kein Tab-Button fuer Docker - der Dialog kann den Stack nicht aktualisieren');
  assert.match(q, /id="upTabDocker"/, 'kein Inhaltsbereich fuer den Docker-Tab');
  assert.match(q, /id="upDkStand"/, 'keine Zeile fuer den Image-Stand');
});

test('installMethod "docker" waehlt den Docker-Tab', async () => {
  const b = await js();
  // Ohne diesen Eintrag bleibt tabsForRack bei der Standardliste (cf/zip/
  // upload/steam) - der Docker-Tab waere dann nie sichtbar.
  assert.match(b, /docker:\s*'docker'/,
    'METHOD_TO_TAB kennt docker nicht -> der Tab erscheint nie');
});

test('Beim Oeffnen des Tabs wird der Stand geholt', async () => {
  const b = await js();
  assert.match(b, /if \(tab === 'docker'\) dockerTabLaden\(\)/,
    'upTab() holt fuer docker keinen Stand - die Box bliebe leer');
  // Der Abruf muss den Endpunkt des Helfers treffen, nicht die Update-Route.
  assert.match(b, /\/api\/swords\/\$\{upSword\.id\}\/docker-update/,
    'dockerTabLaden fragt nicht den docker-update-Endpunkt');
});

test('Ohne Backup oder ohne Update sperrt die Oberflaeche den Knopf', async () => {
  const b = await js();
  const i = b.indexOf('async function dockerTabLaden');
  assert.notEqual(i, -1, 'dockerTabLaden nicht gefunden');
  const rumpf = b.slice(i, i + 3500);
  assert.match(rumpf, /startBtn\.disabled = !d\.updateAvailable \|\| !d\.backupPath/,
    'der Start-Knopf muss ohne Backup oder ohne Update gesperrt sein - sonst '
    + 'klickt der Nutzer in eine Ablehnung des Helfers');
});

test('buildSource schickt Dienst und Tag, keine Datei', async () => {
  const b = await js();
  const i = b.indexOf("if (tab === 'docker') {", b.indexOf('function buildSource'));
  assert.notEqual(i, -1, 'buildSource kennt den Docker-Tab nicht');
  const zweig = b.slice(i, i + 700);
  assert.match(zweig, /type:\s*'docker'/,
    'der Koerper muss type:docker tragen, sonst landet er im falschen Zweig');
  assert.match(zweig, /dienst:\s*dockerStand\.service/,
    'der Dienst muss aus dem Stand kommen, nicht geraten werden');
  assert.match(zweig, /tag:\s*dockerStand\.latestTag/,
    'der Tag muss aus dem Stand kommen');
});

test('Der Start geht an docker-update und faellt nicht in den 202-Zweig', async () => {
  const b = await js();
  const i = b.indexOf("if (upMode === 'update' && source.type === 'docker')");
  assert.notEqual(i, -1, 'startAction hat keinen eigenen Docker-Zweig');
  const zweig = b.slice(i, i + 1600);
  assert.match(zweig, /\/api\/swords\/\$\{upSword\.id\}\/docker-update/,
    'der Docker-Start muss den eigenen Endpunkt rufen');
  assert.match(zweig, /method: 'POST'/);
  // Der Rueckweg muss NACH dem Erfolgs-Toast stehen. Ein blosses /return;/
  // genuegt nicht: im selben Block steht auch der catch-Rueckweg, und der
  // Test blieb gruen, als ich den Erfolgs-Rueckweg entfernte (Probe
  // 2026-11-26). Deshalb die Reihenfolge pruefen: Toast ... reloadSwords ...
  // return.
  const iToast = zweig.indexOf('aktualisiert.');
  const iReload = zweig.indexOf('await reloadSwords();');
  assert.notEqual(iToast, -1, 'Erfolgs-Toast fehlt');
  assert.notEqual(iReload, -1, 'reloadSwords fehlt nach dem Erfolg');
  const nachReload = zweig.slice(iReload);
  assert.match(nachReload.slice(0, 200), /^await reloadSwords\(\);\s*return;/,
    'nach reloadSwords muss der Zweig zurueckkehren - sonst laeuft er in den '
    + '202/Polling-Weg, der auf einen Fortschritt wartet, den der Helfer nie meldet');
});

test('Der Server kennt body.type "docker" - sonst "Quelle fehlt"', async () => {
  const route = await readFile(new URL('../app/installRoutes.js', import.meta.url), 'utf8');
  assert.match(route, /body\.type === 'docker'/,
    'die Update-Route kennt type:docker nicht und antwortet "Quelle fehlt"');
});

test('Der Reset beim Oeffnen verwirft einen alten Docker-Stand', async () => {
  const b = await js();
  const i = b.indexOf('function openUpdateModal');
  const rumpf = b.slice(i, i + 3000);
  assert.match(rumpf, /dockerStand = null/,
    'ein alter Stand des vorigen Swords wuerde im neuen Dialog stehen');
});

// --- Preflight-Ablauf (2026-11-26, live von Felix gemeldet) ------------------
//
// Im Dialog stand bei einem Docker-Stack der Ablauf eines Minecraft-Archivs:
// "ZIP entpacken", "Neoforge-Version prüfen", "auf Done ( warten". Bei
// Nextcloud ist das nicht bloss ungenau, sondern falsch - es wird kein ZIP
// entpackt und kein Java-Server abgewartet.

test('Preflight: Docker-Sworte bekommen einen eigenen Ablauf, keinen ZIP-Weg', async () => {
  const q = await js();
  assert.match(q, /if \(controlKindVonSword\(sword\) === 'docker'\) \{\s*\n\s*dockerPreflight\(sword, stateInfo\);\s*\n\s*return;/,
    'renderPreflight muss bei Docker VOR der ZIP-Schrittliste abzweigen und zurueckkehren');
  // Die Reihenfolge trennt die beiden Wege: kaeme der Docker-Zweig nach den
  // ZIP-Schritten, waere er wirkungslos.
  const iDocker = q.indexOf("controlKindVonSword(sword) === 'docker'");
  const iZip = q.indexOf("'ZIP entpacken und Inhalte ersetzen'");
  assert.ok(iDocker > 0 && iZip > iDocker,
    'der Docker-Zweig steht hinter der ZIP-Liste und greift damit nie');
});

test('Docker-Preflight nennt keine ZIP- oder Minecraft-Schritte', async () => {
  const q = await js();
  const start = q.indexOf('function dockerPreflight');
  assert.ok(start > 0, 'dockerPreflight fehlt');
  const block = q.slice(start, start + 2600);
  for (const verboten of ['ZIP entpacken', 'Neoforge', 'Done (', 'libraries/']) {
    assert.ok(!block.includes(verboten),
      `der Docker-Preflight enthaelt "${verboten}" - das ist der Minecraft-Ablauf`);
  }
  for (const muss of ['docker compose pull', 'Datenbank', 'Backup']) {
    assert.ok(block.includes(muss), `der Docker-Preflight nennt "${muss}" nicht`);
  }
});

test('Docker-Preflight wird nach dem Laden des Stands neu gezeichnet', async () => {
  const q = await js();
  const start = q.indexOf('async function dockerTabLaden');
  assert.ok(start > 0, 'dockerTabLaden fehlt');
  const block = q.slice(start, start + 3000);
  assert.match(block, /if \(upMode === 'update' && upSword && controlKindVonSword\(upSword\) === 'docker'\) \{\s*\n\s*renderPreflight\(upSword, upStateInfo\);/,
    'beim Oeffnen ist dockerStand noch null - ohne Nachlauf fehlen Stand und Backup im Preflight');
});

test('openUpdateModal merkt sich den Lauf-Zustand fuer den Preflight', async () => {
  const q = await js();
  assert.match(q, /upStateInfo = stateInfo;/, 'upStateInfo wird nicht gesetzt');
});
