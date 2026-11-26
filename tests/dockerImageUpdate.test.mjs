// Tests fuer das Docker-Image-Update (2026-11-26).
//
// Der Helfer /usr/local/bin/armory-docker-update und die Funktion
// dockerImageUpdate sind die Grenze zwischen Panel und Docker. Zwei Dinge
// muessen stimmen, sonst ist es gefaehrlich:
//
//   1) Die Anwendung prueft, BEVOR ein Prozess startet (billig und ehrlich).
//   2) Der Helfer prueft NOCHMAL, weil der armory-User ihn auch direkt
//      aufrufen kann. Eine Pruefung nur in der Anwendung schuetzt ihn nicht.
//
// Hier wird (1) geprueft, mit einer Attrappe fuer execFile - wie bei
// actionSafety.test.mjs, damit NIE ein echter sudo-Aufruf entsteht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const wegwerfDb = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-update-'));
process.env.ARMORY_DB_PATH = path.join(wegwerfDb, 'test.db');
process.on('exit', () => {
  try { fs.rmSync(wegwerfDb, { recursive: true, force: true }); } catch { /* egal */ }
});

const { dockerImageUpdate } = await import('../app/control.js');

const CONTROL = {
  compose: '/opt/nextcloud/docker-compose.yml',
  services: ['nc-app', 'nc-db', 'nc-redis'],
};

/** Sammelt Aufrufe und antwortet wie der Helfer. */
function attrappe(antwort = '{}') {
  const aufrufe = [];
  const run = async (cmd, args) => {
    aufrufe.push([cmd, ...args]);
    return { stdout: antwort, stderr: '' };
  };
  return { run, aufrufe };
}

test('check ruft den Helfer mit Stack, Aktion und Dienst - ohne Tag', async () => {
  const { run, aufrufe } = attrappe(JSON.stringify({ updateAvailable: true }));
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'check', null, { run });
  assert.equal(r.ok, true);
  assert.equal(r.info.updateAvailable, true);
  assert.deepEqual(aufrufe, [
    ['sudo', '-n', '/usr/local/bin/armory-docker-update', 'nextcloud', 'check'],
  ]);
});

test('apply haengt den Tag als letztes Argument an', async () => {
  const { run, aufrufe } = attrappe('fertig');
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'apply', '35.0.3-apache', { run });
  assert.equal(r.ok, true);
  assert.deepEqual(aufrufe, [
    ['sudo', '-n', '/usr/local/bin/armory-docker-update', 'nextcloud', 'apply', '35.0.3-apache'],
  ]);
});

test('"apply" ist KEINE dockerAction - der alte Weg bleibt geschlossen', async () => {
  // Wichtig: wer apply ueber dockerAction versucht, muss abgelehnt werden.
  // Das ist die Trennung zwischen Serversteuerung und Code-Wechsel.
  const { dockerAction } = await import('../app/control.js');
  const { run, aufrufe } = attrappe();
  const r = await dockerAction(CONTROL, 'nc-app', 'apply', { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Nicht erlaubt: apply/);
  assert.deepEqual(aufrufe, [], 'Bei "apply" darf kein Prozess starten');
});

test('Ungueltiger Tag: kein Prozess, klare Meldung', async () => {
  const boese = [
    '35.0.3-apache; rm -rf /',
    '../../etc/passwd',
    'latest',
    '35.0.3-apache\n',
    '',
    '35.0.3-apache --force',
    'nextcloud:35.0.3-apache',
  ];
  for (const tag of boese) {
    const { run, aufrufe } = attrappe();
    const r = await dockerImageUpdate(CONTROL, 'nc-app', 'apply', tag, { run });
    assert.equal(r.ok, false, `Tag "${tag}" haette abgelehnt werden muessen`);
    assert.deepEqual(aufrufe, [], `Tag "${tag}" hat einen Prozess gestartet`);
  }
});

test('apply ohne Tag: kein Prozess', async () => {
  const { run, aufrufe } = attrappe();
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'apply', null, { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ungültiger Image-Tag/);
  assert.deepEqual(aufrufe, []);
});

test('Dienst ausserhalb des Stacks: kein Prozess', async () => {
  const { run, aufrufe } = attrappe();
  const r = await dockerImageUpdate(CONTROL, 'nc-db', 'apply', '35.0.3-apache', { run });
  // nc-db steht in services, ist also erlaubt - der Helfer lehnt es ab, weil
  // dort nc-app eingetragen ist. Hier nur: die Anwendung laesst es durch den
  // Stack-Filter und schickt es. Fuer einen FREMDEN Dienst muss sie selbst
  // ablehnen:
  const fremd = await dockerImageUpdate(CONTROL, 'evil', 'apply', '35.0.3-apache', { run });
  assert.equal(fremd.ok, false);
  assert.match(fremd.error, /Dienst gehört nicht zu diesem Stack|Dienst nicht erlaubt/);
  assert.equal(r.ok, true, 'nc-db ist Teil des Stacks - die Anwendung darf es weiterreichen');
});

test('Aktion "down" wird abgelehnt, bevor ein Prozess startet', async () => {
  const { run, aufrufe } = attrappe();
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'down', null, { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Nicht erlaubt: down/);
  assert.deepEqual(aufrufe, []);
});

test('Kaputte Helfer-Antwort bei check wird zum Fehler, nicht zum leeren Erfolg', async () => {
  const { run } = attrappe('das ist kein json');
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'check', null, { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /nicht lesbar/);
});

test('Fehler des Helfers kommt als ok:false mit seinem Text', async () => {
  const run = async () => {
    const err = new Error('Command failed');
    err.stderr = 'Kein DB-Backup gefunden in /opt/nextcloud/backups/db - Update abgelehnt.';
    throw err;
  };
  const r = await dockerImageUpdate(CONTROL, 'nc-app', 'apply', '35.0.3-apache', { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /Kein DB-Backup/);
});

// --- Die Route muss die Funktion auch BENUTZEN -----------------------------
// Aus GAME-ARMORY-NOTES: "Funktion UND ihre Nutzung pruefen". Ein gruener
// Test fuer dockerImageUpdate beweist nicht, dass der Endpunkt ihn aufruft.
test('Die Route /docker-update ruft dockerImageUpdate auf und prueft die Berechtigung', () => {
  const quelle = fs.readFileSync(new URL('../app/server.js', import.meta.url), 'utf8');
  // GET (check) und POST (apply) muessen existieren.
  assert.match(quelle, /app\.get\('\/api\/swords\/:id\/docker-update', requireAuth/,
    'GET-Route fuer den Check fehlt');
  assert.match(quelle, /app\.post\('\/api\/swords\/:id\/docker-update', requireAuth/,
    'POST-Route fuer das Update fehlt');

  // Beide muessen die Berechtigung pruefen - ein Login allein genuegt nicht.
  const blockGet = quelle.slice(quelle.indexOf("app.get('/api/swords/:id/docker-update'"));
  const blockPost = quelle.slice(quelle.indexOf("app.post('/api/swords/:id/docker-update'"));
  assert.match(blockGet.slice(0, 400), /roleHasPerm/,
    'GET-Route prueft keine Berechtigung');
  assert.match(blockPost.slice(0, 400), /roleHasPerm/,
    'POST-Route prueft keine Berechtigung');

  // Nicht-Docker-Swords muessen abgewiesen werden - sonst laeuft der Helfer
  // mit einem Stacknamen, den er nicht kennt, und die Meldung ist irrefuehrend.
  assert.match(blockGet.slice(0, 800), /controlKind\(sword\) !== 'docker'/,
    'GET-Route prueft nicht, ob es ein Docker-Stack ist');
  assert.match(blockPost.slice(0, 800), /controlKind\(sword\) !== 'docker'/,
    'POST-Route prueft nicht, ob es ein Docker-Stack ist');

  // Die Doppelklick-Sperre muss GEPRUEFT werden - `laeufendeDockerUpdates`
  // taucht im Block auch beim `add`/`delete` auf. Ein Test, der nur das Wort
  // sucht, bleibt gruen, wenn die Pruefung entfernt wird (Mutationsprobe
  // 2026-11-26: gruen). Deshalb die Pruefzeile im Wortlaut.
  assert.match(blockPost, /if \(laeufendeDockerUpdates\.has\(sword\.id\)\)/,
    'POST-Route prueft die Sperre nicht (nur add/delete vorhanden)');

  // Die Route muss die Funktion AUFRUFEN, nicht nur importieren. Wortlaut
  // statt Namenssuche: bei der Probe "Aufruf durch ein Dummy-Objekt ersetzt"
  // blieb der Test vorher gruen (2026-11-26).
  assert.match(blockGet, /const result = await dockerImageUpdate\(sword\.control, dienst, 'check'\)/,
    'GET-Route ruft dockerImageUpdate nicht wirklich auf');
  assert.match(blockPost, /const result = await dockerImageUpdate\(sword\.control, dienst, 'apply', tag\)/,
    'POST-Route ruft dockerImageUpdate nicht wirklich auf');
});

// --- Nach dem Update muss die gefahrene Version im Sword stehen (2026-11-26) --
//
// Live-Fall: das Image-Update auf 35.0.3 lief durch, der Container war gesund,
// aber die Sword-Kachel blieb GELB. `installedVersion` stand weiter auf 35.0.2,
// die Versions-Gegenprobe verglich 35.0.2 gegen 35.0.3 -> "outdated".
// Die Route schrieb nach dem apply nichts zurueck.
//
// Die Probe liest den Quelltext der POST-Route und verlangt die beiden
// Schreibaufrufe IM Erfolgszweig - und zwar vor der Rueckgabe der Antwort.
test('Docker-apply traegt die neue Version ins Sword ein', async () => {
  const server = await readFile(new URL('../app/server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.post('/api/swords/:id/docker-update'");
  assert.ok(start > 0, 'POST-Route fehlt');
  const ende = server.indexOf('laeufendeDockerUpdates = new Set', start);
  const route = server.slice(start, ende > 0 ? ende : start + 4000);

  const iApply = route.indexOf("dockerImageUpdate(sword.control, dienst, 'apply', tag)");
  const iSet = route.indexOf('setInstalledVersion(');
  const iReturn = route.indexOf('return res.status(result.ok');

  assert.ok(iApply > 0, 'apply-Aufruf nicht gefunden');
  assert.ok(iSet > 0, 'setInstalledVersion wird nach dem Update nicht aufgerufen');
  assert.ok(iReturn > 0, 'Rueckgabe der Route nicht gefunden');
  assert.ok(iApply < iSet && iSet < iReturn,
    'setInstalledVersion muss NACH dem apply und VOR der Antwort stehen');

  // Nur im Erfolgszweig - bei einem Fehlschlag darf keine Version geschrieben
  // werden, sonst behauptet das Sword einen Stand, der nicht laeuft.
  assert.match(route.slice(iApply, iSet), /if \(result\.ok\)/,
    'Version wird auch bei fehlgeschlagenem Update geschrieben');

  // Die nackte Version, nicht der Tag mit Variante.
  assert.match(route, /latestVersion/,
    'es wird der Tag statt der nackten Version geschrieben - der naechste Vergleich kippt');
});
