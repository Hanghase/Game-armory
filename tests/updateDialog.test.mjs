// Tests fuer den Update-Dialog (public/app.html + public/app.js).
//
// Hintergrund (2026-11-07, live gemeldet): der Dialog sagte an zwei Stellen
// gegensaetzliches ueber den Server-Neustart.
//   app.js:1878   "er wird fuer das Update gestoppt und danach wieder gestartet."
//   app.html:1077 "gestoppt und danach nicht automatisch gestartet."
// Der Code (app/updater.js:401) startet IMMER neu: Phase 'starting',
// serviceAction(service, 'start'). Live belegt: atm11 lief nach dem Update.
// Also war der Hinweis in app.html falsch - und beim Betreiber genau die
// Unsicherheit, die er nicht braucht.

import { test, assert } from './_fixtures.mjs';
import { readFile } from 'node:fs/promises';

const html = () => readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const js = () => readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('Der Dialog behauptet nicht, dass der Server ausbleibt', async () => {
  const q = await html();
  assert.equal(/danach nicht\s*\n?\s*automatisch gestartet/i.test(q), false,
    'public/app.html enthaelt "danach nicht automatisch gestartet" - das ist '
    + 'falsch: app/updater.js:401 startet den Server nach dem Update immer neu '
    + '(Phase "starting", serviceAction(service, "start")). Live belegt an atm11 '
    + 'am 2026-11-07: der Server lief nach dem Update.');
});

test('Der Dialog sagt an beiden Stellen dasselbe ueber den Neustart', async () => {
  const a = await html();
  const b = await js();
  // Die Aussage im statischen Hinweis (app.html) muss den Neustart nennen.
  const hintStart = a.indexOf('Bei laufendem Server');
  assert.notEqual(hintStart, -1, 'Hinweis im Upload-Tab nicht gefunden');
  const hint = a.slice(hintStart, hintStart + 320);
  assert.match(hint, /wieder gestartet|neu gestartet/,
    'der Hinweis "Bei laufendem Server ..." muss sagen, dass der Server wieder '
    + 'gestartet wird - sonst widerspricht er der Warnung und dem Preflight.');

  // Und der Preflight in app.js darf nicht das Gegenteil behaupten.
  assert.match(b, /gestoppt und danach wieder gestartet/,
    'der Preflight muss den Neustart nennen');
});

test('Nach einem Update wird die Sword-Liste neu geladen (Karte aktualisiert)', async () => {
  // Sonst zeigt die Karte hinter dem Dialog weiter den eingefrorenen Stand:
  // upSword wird beim Oeffnen gesetzt (app.js:1808) und nie aufgefrischt.
  const q = await js();
  assert.match(q, /reloadSwords/,
    'app.js muss reloadSwords kennen');

  // NICHT mit einem grossen Suchfenster arbeiten: scheduleSwordsRefresh wird an
  // vielen Stellen aufgerufen, ein weites Umfeld bleibt gruen, auch wenn der
  // Update-Pfad ihn verliert. Deshalb den Body von finishProgress ausschneiden
  // und NUR dort suchen (Lehre aus der Mutationsprobe 2026-11-07).
  const start = q.indexOf('function finishProgress');
  assert.notEqual(start, -1, 'finishProgress nicht gefunden');
  const ende = q.indexOf('function renderUpdateResult', start);
  assert.notEqual(ende, -1, 'Ende von finishProgress nicht gefunden');
  const body = q.slice(start, ende);

  assert.match(body, /scheduleSwordsRefresh\(|reloadSwords\(/,
    'finishProgress muss nach einem erfolgreichen Update die Sword-Liste neu '
    + 'laden - sonst zeigt die Karte weiter den Stand von vor dem Update');
});
