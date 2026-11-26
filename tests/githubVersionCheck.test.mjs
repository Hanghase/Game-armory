// Tests fuer die GitHub-Versionspruefung in versionCheck.js (2026-11-26).
//
// Gegenstand: checkGithub() und der Weg dorthin (checkSwordVersion mit rack).
//
// Warum diese Datei existiert: die Pruefung las /tags und nahm den ERSTEN Tag.
// Der TS6-Repo fuehrt seine Tags um (v6.0.0-beta14 -> v6.0.0/beta8), der erste
// Tag war also nicht als Version lesbar - Ergebnis: dauerhaft "unknown", obwohl
// installiert und verfuegbar dieselbe Version waren. Live gemessen am
// 2026-11-26 im Sword teamspeak6.json:
//   installedVersion: 6.0.0-beta14
//   versionState:     unknown
//   reason:           "keine Soll-Version eingetragen"
//
// Die Tests ersetzen fetch durch eine Attrappe und pruefen drei Faelle:
//   1. Umbenannter Tag oben, echtes Release darunter  -> current
//   2. Neue Version verfuegbar                         -> outdated
//   3. Kein Release, nur Tags                          -> unknown + Grund
//
// Mutation, die diesen Test rot macht: `/releases?per_page=5` zurueck auf
// `/tags` aendern (dann kommt der unlesbare Tag) oder `find(...isVersionLike)`
// durch `[0]` ersetzen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REPO = new URL('..', import.meta.url).pathname;
const quelle = async (pfad) => readFile(`${REPO}${pfad}`, 'utf8');

// --- fetch-Attrappe --------------------------------------------------------
// Die echte Reihenfolge aus dem TS6-Repo am 2026-11-26 (per API gesehen).
const TS6_RELEASES = [
  { tag_name: 'v6.0.0-beta14', prerelease: false },
  { tag_name: 'v6.0.0-beta13.1', prerelease: false },
  { tag_name: 'v6.0.0-beta13', prerelease: false },
];

function mitFetch(antwort, fn) {
  const original = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async (url) => {
    aufrufe.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => antwort,
    };
  };
  return Promise.resolve(fn(aufrufe)).finally(() => { globalThis.fetch = original; });
}

// Das Modul nutzt fetch erst beim Aufruf - ein Import einmal oben reicht,
// vorausgesetzt die Attrappe steht vor dem Aufruf.
const { checkGithub, checkSwordVersion } = await import(`${REPO}app/versionCheck.js`);

test('installiert == neuestes Release -> current (der TS6-Fall live)', async () => {
  await mitFetch(TS6_RELEASES, async (aufrufe) => {
    const r = await checkGithub({ repo: 'teamspeak/teamspeak6-server', installed: '6.0.0-beta14' });
    assert.equal(r.state, 'current', `state war ${r.state}: ${r.reason ?? ''}`);
    assert.equal(r.available, 'v6.0.0-beta14');
    assert.equal(r.source, 'github-release');
    // Die Quelle muss /releases sein, nicht /tags. Genau dieser Unterschied
    // war der Fehler.
    assert.match(aufrufe[0], /\/releases\?/, `Quelle war ${aufrufe[0]}`);
    assert.doesNotMatch(aufrufe[0], /\/tags/);
  });
});

test('aeltere installierte Version -> outdated mit dem Release-Tag', async () => {
  await mitFetch(TS6_RELEASES, async () => {
    const r = await checkGithub({ repo: 'teamspeak/teamspeak6-server', installed: '6.0.0-beta13.1' });
    assert.equal(r.state, 'outdated');
    assert.equal(r.available, 'v6.0.0-beta14');
  });
});

test('unlesbarer Tag oben blockiert die Pruefung nicht', async () => {
  const gemischt = [
    { tag_name: 'v6.0.0/beta8' }, // so benennt der Repo seine Tags um
    { tag_name: 'v6.0.0-beta14' },
  ];
  await mitFetch(gemischt, async () => {
    const r = await checkGithub({ repo: 'teamspeak/teamspeak6-server', installed: '6.0.0-beta14' });
    assert.equal(r.state, 'current', `erster lesbarer Release muss genommen werden, nicht der erste Eintrag (${r.reason ?? ''})`);
  });
});

test('nur Tags, kein Release -> unknown mit lesbarem Grund', async () => {
  await mitFetch([], async () => {
    const r = await checkGithub({ repo: 'irgendwas/repo', installed: '1.0.0' });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /keine Releases/);
  });
});

// --- Der Weg dorthin: die Route schickt das Rack mit ------------------------

test('die Pruef-Route uebergibt rack und installDir an checkSwordVersion', async () => {
  const src = await quelle('app/installRoutes.js');
  const block = src.slice(
    src.indexOf("'/swords/:id/version-check'"),
    src.indexOf('// POST /api/swords/version-check-all'),
  );
  assert.ok(block.length > 0, 'Pruef-Route nicht gefunden');
  assert.match(block, /checkSwordVersion\(sword, \{ rack: getRack\(sword\.rack\)/);
});

test('der github-Zweig im Dispatcher nimmt die URL aus Sword ODER Rack', async () => {
  const src = await quelle('app/versionCheck.js');
  const block = src.slice(src.indexOf("type === 'github'"), src.indexOf("type === 'curseforge'"));
  assert.match(block, /repoFromUrl\(src\.url \?\? rack\?\.source\?\.url\)/);
});

// --- Die Automatik muss dieselbe Antwort geben wie der Knopf -----------------
//
// Gefunden am 2026-11-26: runVersionChecks() in server.js rief
// checkSwordVersion(sword, { installDir }) OHNE Rack. Fuer TS6 (Repo nur aus
// der Rack-URL ableitbar) kam so "kein GitHub-Repo im Rack" - der Knopf sagte
// "aktuell", die taegliche Automatik "unbekannt". Ein Test fuer
// checkSwordVersion() allein haette das nicht gefangen (Projektregel: Funktion
// UND Aufrufer pruefen).

test('die Automatik in server.js uebergibt das Rack an checkSwordVersion', async () => {
  const src = await quelle('app/server.js');
  const start = src.indexOf('async function runVersionChecks');
  assert.ok(start > 0, 'runVersionChecks nicht gefunden');
  const block = src.slice(start, src.indexOf('function scheduleVersionChecks'));
  assert.match(
    block,
    /checkSwordVersion\(sword, \{ rack: getRack\(sword\.rack\)/,
    'Automatik ruft checkSwordVersion ohne rack auf - dann weicht sie vom Panel-Knopf ab',
  );
});

test('der TS6-Sword nennt als Quelle github, nicht url', async () => {
  // Widerspruch live gefunden am 2026-11-26: source "url" + projectId
  // "teamspeak/teamspeak6-server" schickte den Dispatcher in den manual-Zweig,
  // waehrend der Updater laengst den GitHub-Release pflegte.
  const sword = JSON.parse(await quelle('swords/teamspeak6.sword.json'));
  assert.equal(sword.update?.source, 'github');
  assert.equal(sword.update?.projectId, 'teamspeak/teamspeak6-server');
});
