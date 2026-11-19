// Tests fuer das GitHub-Binary-Update (2026-11-19).
//
// Gegenstand: POST /api/swords/:id/update mit {type:'github'} und
// updateFromGithub() in updater.js.
//
// Warum diese Datei existiert: Der Erstinstall kannte GitHub-Racks
// (installMethod 'github', z.B. TeamSpeak 6), die Update-Route kannte nur
// zip/upload/curseforge/steam. Folge: bei einer neuen TS6-Version musste die
// Binary von Hand getauscht werden - live erlebt am 2026-11-19 bei
// beta13.1 -> beta14.
//
// Die Tests haengen an der WAHRNEHMBAREN Route und an der Funktion, nicht an
// einer Kopie der Logik (Projektregel: "ein Test fuer die Funktion beweist
// nicht, dass die Route sie nutzt" - beide pruefen).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REPO = new URL('..', import.meta.url).pathname;
const quelle = async (pfad) => readFile(`${REPO}${pfad}`, 'utf8');

// ---------------------------------------------------------------------------
// 1. Die Route kennt den github-Zweig
// ---------------------------------------------------------------------------

test('die Update-Route ruft updateFromGithub fuer type=github', async () => {
  const src = await quelle('app/installRoutes.js');

  // Der Zweig muss existieren UND auf dem richtigen Weg aufgerufen werden.
  const block = src.slice(
    src.indexOf("body.type === 'github'"),
    src.indexOf("body.type === 'steam'"),
  );
  assert.ok(block.length > 0, 'kein github-Zweig vor dem steam-Zweig');
  assert.match(block, /updateFromGithub\(sword/, 'github-Zweig ruft updateFromGithub nicht');
});

test('der github-Zweig steht VOR dem steam-Zweig', async () => {
  const src = await quelle('app/installRoutes.js');
  const iGithub = src.indexOf("body.type === 'github'");
  const iSteam = src.indexOf("body.type === 'steam'");
  assert.ok(iGithub > 0, 'github-Zweig fehlt');
  assert.ok(iSteam > 0, 'steam-Zweig fehlt');
  // Ein github-Rack kann ebenfalls Felder tragen, die den steam-Zweig
  // ausloesen (body.appId). Die eindeutigere Aussage muss zuerst greifen,
  // sonst landet ein GitHub-Update ueber SteamCMD.
  assert.ok(iGithub < iSteam, 'github-Zweig steht nach dem steam-Zweig');
});

test('updateFromGithub ist importiert (sonst ReferenceError beim echten Start)', async () => {
  const src = await quelle('app/installRoutes.js');
  const importZeile = src.split('\n').find((l) => l.startsWith('import') && l.includes('./updater.js'));
  assert.ok(importZeile, 'kein Import aus ./updater.js');
  assert.match(importZeile, /\bupdateFromGithub\b/, 'updateFromGithub fehlt in der Import-Liste');
});

test('die Fehlermeldung nennt den github-Weg', async () => {
  const src = await quelle('app/installRoutes.js');
  assert.match(
    src,
    /Quelle fehlt:[^'"`]*type:github/,
    'die 400-Meldung nennt {type:github} nicht - der Aufrufer erfaehrt den Weg nicht',
  );
});

// ---------------------------------------------------------------------------
// 2. updateFromGithub tut das Richtige (und nur das)
// ---------------------------------------------------------------------------

test('updateFromGithub ist exportiert und nimmt repo/assetPattern an', async () => {
  const src = await quelle('app/updater.js');
  assert.match(src, /export async function updateFromGithub\(sword,/);
  assert.match(src, /updateFromGithub\(sword, \{ repo = null, assetPattern = null/);
});

test('updateFromGithub tauscht ueber replace-tree, damit Daten stehen bleiben', async () => {
  const src = await quelle('app/updater.js');
  const start = src.indexOf('export async function updateFromGithub');
  const ende = src.indexOf('\nasync function ', start + 10);
  const block = src.slice(start, ende > 0 ? ende : undefined);

  // replace-tree kopiert die QUELLE ueber das Ziel: was im Release fehlt
  // (files/, *.sqlitedb, *.yaml, Keys), bleibt unberuehrt. Ein replace-pack
  // oder rm waere hier falsch - es wuerde die Datendateien mitloeschen.
  assert.match(block, /runHelper\('replace-tree'/, 'replace-tree wird nicht benutzt');
  assert.doesNotMatch(block, /remove-tree/, 'remove-tree wuerde die Datendateien loeschen');
});

test('updateFromGithub sichert die im Sword genannten Pfade, nicht eine feste Liste', async () => {
  const src = await quelle('app/updater.js');
  const start = src.indexOf('export async function updateFromGithub');
  const ende = src.indexOf('\nasync function ', start + 10);
  const block = src.slice(start, ende > 0 ? ende : undefined);

  assert.match(block, /sword\.update\?\.keep/, 'die keep-Liste des Swords wird nicht gelesen');
  assert.match(block, /createBackup\(/, 'kein Backup-Aufruf');
});

test('updateFromGithub stoppt NICHT, wenn schon aktuell', async () => {
  const src = await quelle('app/updater.js');
  const start = src.indexOf('export async function updateFromGithub');
  const block = src.slice(start);

  // Der Punkt ist der RUECKGABEPFAD, nicht eine Textposition: bevor der
  // already-current-Zweig zurueckkehrt, darf gar nichts passiert sein - kein
  // Stop, kein setState, kein Backup, kein Download. Ein Stop fuer "nichts zu
  // tun" waere unnoetiger Ausfall.
  //
  // Ein Vergleich "Index von already-current < Index von stop" reichte NICHT:
  // wird der Stop hinter den already-current-Return gezogen, bleibt die
  // Reihenfolge wahr, obwohl jetzt jeder Aufruf den Dienst anhaelt. Diese
  // Schwaeche ist am 2026-11-19 durch eine Mutation aufgefallen.
  const iSkip = block.indexOf('already-current');
  assert.ok(iSkip > 0, 'kein already-current-Zweig');
  const vorDemReturn = block.slice(0, iSkip);
  for (const aufruf of ['serviceAction(', 'setState(', 'createBackup(', 'downloadGithubAsset(']) {
    assert.equal(
      vorDemReturn.includes(aufruf), false,
      `${aufruf} steht VOR der Versionspruefung - der Dienst wird also auch bei "schon aktuell" angefasst`,
    );
  }
});

test('updateFromGithub startet den Dienst wieder, wenn das Update scheitert', async () => {
  const src = await quelle('app/updater.js');
  const start = src.indexOf('export async function updateFromGithub');
  const ende = src.indexOf('\nasync function ', start + 10);
  const block = src.slice(start, ende > 0 ? ende : undefined);

  // Ein gestoppter Dienst darf bei einem Fehler nicht unten bleiben.
  const catchBlock = block.slice(block.indexOf('} catch (err) {'));
  assert.match(catchBlock, /serviceAction\(service, 'start'\)/, 'kein Wiederstart im Fehlerfall');
});

test('updateFromGithub schreibt die Version ueber setInstalledVersion', async () => {
  const src = await quelle('app/updater.js');
  const start = src.indexOf('export async function updateFromGithub');
  const ende = src.indexOf('\nasync function ', start + 10);
  const block = src.slice(start, ende > 0 ? ende : undefined);

  // Direktes writeFile laesst den Modul-Cache veraltet (Lehre 2026-11-07):
  // das Panel zeigt dann weiter die alte Zahl.
  assert.match(block, /setInstalledVersion\(/, 'setInstalledVersion fehlt');
});

// ---------------------------------------------------------------------------
// 3. Die Hilfsfunktionen (repoPath, getLatestGithubRelease)
//
// Diese werden aus der Datei EXTRAHIERT und ausgefuehrt, nicht nachgebaut.
// Ein Nachbau wuerde nur beweisen, dass eine Kopie funktioniert.
// ---------------------------------------------------------------------------

async function ladeHelfer() {
  const src = await quelle('app/updater.js');
  const m1 = src.match(/function repoPath\(url\) \{[\s\S]*?\n\}/);
  const m2 = src.match(/async function getLatestGithubRelease\(url\) \{[\s\S]*?\n\}/);
  assert.ok(m1, 'repoPath nicht in updater.js gefunden');
  assert.ok(m2, 'getLatestGithubRelease nicht in updater.js gefunden');
  const { writeFile, unlink } = await import('node:fs/promises');
  const pfad = `/tmp/ts6-test-${process.pid}.cjs`;
  await writeFile(pfad, `${m1[0]}\n${m2[0]}\nmodule.exports = { repoPath, getLatestGithubRelease };\n`);
  const mod = await import(`file://${pfad}`);
  await unlink(pfad).catch(() => {});
  return mod;
}

test('repoPath liest owner/repo aus der Rack-URL', async () => {
  const { repoPath } = await ladeHelfer();
  assert.equal(repoPath('https://github.com/teamspeak/teamspeak6-server'), 'teamspeak/teamspeak6-server');
  assert.equal(repoPath('https://github.com/a/b.git'), 'a/b');
  assert.equal(repoPath('https://github.com/a/b/releases/tag/v1'), 'a/b');
  assert.equal(repoPath('https://example.com/x'), null, 'fremde Hosts duerfen nicht durchgehen');
  assert.equal(repoPath(null), null);
});

test('getLatestGithubRelease liefert null statt zu werfen, wenn die URL kein Repo ist', async () => {
  const { getLatestGithubRelease } = await ladeHelfer();
  assert.equal(await getLatestGithubRelease('https://example.com/nichts'), null);
  assert.equal(await getLatestGithubRelease(null), null);
});

// ---------------------------------------------------------------------------
// 4. Das Frontend: ein GitHub-Rack darf nicht den ZIP-Tab anbieten
//
// Ohne diesen Tab muesste der Nutzer eine ZIP selbst auf den Server legen -
// obwohl das Panel die Datei laengst selbst laden kann. Der Tab wird aus der
// ECHTEN app.js extrahiert und ausgefuehrt, nicht nachgebaut.
// ---------------------------------------------------------------------------

async function ladeTabLogik() {
  const src = await quelle('public/app.js');
  const mTab = src.match(/const METHOD_TO_TAB = \{[^}]*\};/);
  const mTfr = src.match(/const ARCHIVE_TAB = 'upload';\s*function tabsForRack\(rack\) \{[\s\S]*?\n    \}/);
  assert.ok(mTab, 'METHOD_TO_TAB nicht in app.js gefunden');
  assert.ok(mTfr, 'tabsForRack nicht in app.js gefunden');

  const { writeFile, unlink } = await import('node:fs/promises');
  const p1 = `/tmp/ts6-m2t-${process.pid}.cjs`;
  const p2 = `/tmp/ts6-tfr-${process.pid}.cjs`;
  await writeFile(p1, `${mTab[0]}\nmodule.exports = METHOD_TO_TAB;\n`);
  await writeFile(p2, `const METHOD_TO_TAB = require('${p1}');\n${mTfr[0]}\nmodule.exports = tabsForRack;\n`);
  const tabsForRack = (await import(`file://${p2}?v=${Date.now()}`)).default;
  await unlink(p1).catch(() => {});
  await unlink(p2).catch(() => {});
  return { tabsForRack, methodToTab: mTab[0] };
}

test('ein GitHub-Rack bekommt den github-Tab, nicht den ZIP-Tab', async () => {
  const { tabsForRack, methodToTab } = await ladeTabLogik();
  assert.match(methodToTab, /github:\s*'github'/, 'METHOD_TO_TAB mappt github nicht auf github');
  const tabs = tabsForRack({ installMethod: 'github' });
  assert.equal(tabs[0], 'github', `erster Tab ist "${tabs[0]}" statt "github"`);
  assert.ok(!tabs.includes('zip'), 'der ZIP-Pfad-Tab wird fuer GitHub-Racks angeboten');
});

test('ein Steam-Rack bekommt weiterhin den Steam-Tab (Normalfall unveraendert)', async () => {
  const { tabsForRack } = await ladeTabLogik();
  assert.equal(tabsForRack({ installMethod: 'steamcmd' })[0], 'steam');
});

test('buildSource kennt den github-Weg und schickt repo + assetPattern', async () => {
  const src = await quelle('public/app.js');
  assert.match(src, /if \(tab === 'github'\)/, 'kein github-Zweig in buildSource');
  assert.match(src, /type: 'github', rackId: rack\.id, repo: rack\.source\.url/, 'buildSource schickt repo nicht mit');
});

test('der Dialog befuellt die GitHub-Anzeige aus dem Rack', async () => {
  const src = await quelle('public/app.js');
  assert.match(src, /upGhRepo/, 'upGhRepo wird nicht befuellt');
  assert.match(src, /swordRack\.source\.assetPattern/, 'der Asset-Name wird nicht angezeigt');
});

test('der github-Tab existiert im HTML', async () => {
  const html = await quelle('public/app.html');
  assert.match(html, /data-tab="github"/, 'kein github-Tab im Update-Dialog');
  assert.match(html, /id="upTabGithub"/, 'kein Inhaltsbereich fuer den github-Tab');
});
