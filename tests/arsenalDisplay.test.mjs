// Tests fuer die Anzeige der Arsenale im Konto-Tab (public/app.js).
//
// Der interessante Teil ist nicht "steht ein Name da", sondern ob der Zustand
// ehrlich beschrieben wird. Aus dem Konzept (2026-11-09):
//   - "unbekannt" heisst "hat sich nie gemeldet"
//   - "offline" heisst "hat sich gemeldet und ist jetzt weg"
// Wer beides gleich beschriftet, behauptet einen Ausfall, den er nicht
// gemessen hat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appUrl = new URL('../public/app.js', import.meta.url);

async function quelle() {
  return await readFile(appUrl, 'utf8');
}

// Schneidet den Rumpf einer Funktion aus der Quelle. Grenze ist die naechste
// Zeile, die mit "}" beginnt - bei diesem Projekt durchgaengig so formatiert.
async function rumpf(name) {
  const q = await quelle();
  const start = q.indexOf(`function ${name}`);
  assert.ok(start > 0, `${name} fehlt in app.js`);
  const ende = q.indexOf('\n}', start);
  assert.ok(ende > start, `${name}: Rumpfende nicht gefunden`);
  return q.slice(start, ende + 2);
}

// Fuehrt einen Ausschnitt in einer Sandbox aus und liefert die Funktion.
async function lade(name, extra = {}) {
  const code = await rumpf(name);
  const ctx = { ...extra };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  const fn = ctx[name];
  assert.equal(typeof fn, 'function', `${name} liess sich nicht laden`);
  return fn;
}

test('es gibt eine Funktion fuer Zustandstext und eine fuer die Zeile', async () => {
  const q = await quelle();
  assert.match(q, /function arsenalStateLabel\b/,
    'ohne eigene Funktion entstehen mehrere Stellen mit eigenem Wortlaut');
  assert.match(q, /function arsenalMetaLine\b/,
    'die Metazeile braucht eine eigene Funktion');
});

test('alle vier Zustaende bekommen ein verstaendliches Wort', async () => {
  const label = await lade('arsenalStateLabel');
  assert.equal(label('online'), 'Online');
  assert.equal(label('offline'), 'Offline');
  assert.equal(label('unknown'), 'Noch nie gemeldet');
  assert.equal(label('revoked'), 'Gesperrt');
});

test('unbekannt und offline werden NICHT gleich beschriftet', async () => {
  // Der Kern der Sache: gleicher Text fuer zwei verschiedene Lagen waere eine
  // Behauptung ("der Server ist weg"), die im Fall "unknown" niemand geprueft hat.
  const label = await lade('arsenalStateLabel');
  assert.notEqual(label('unknown'), label('offline'));
});

test('ein unbekannter Zustandswert faellt nicht auf "Online" zurueck', async () => {
  // Fail-closed: ein Wert, den das Frontend nicht kennt, darf nie als gesund
  // gelesen werden. Sonst zeigt ein neuer Server-Zustand gruen an.
  const label = await lade('arsenalStateLabel');
  const text = label('irgendwas-neues');
  assert.notEqual(text, 'Online');
  assert.equal(text, 'Unbekannt');
});

test('fehlender Zustand wird nicht als Online gelesen', async () => {
  const label = await lade('arsenalStateLabel');
  for (const wert of [undefined, null, '', 0]) {
    assert.notEqual(label(wert), 'Online', `Zustand ${JSON.stringify(wert)} wurde gruen`);
  }
});

test('die Zustandsfunktion liefert einen CSS-Klassenhinweis', async () => {
  const q = await quelle();
  // Die Zeile muss den Zustand auch optisch tragen, sonst sieht der Kunde
  // bei "Offline" keinen Unterschied.
  const body = await rumpf('arsenalStateClass');
  for (const zustand of ['online', 'offline', 'unknown', 'revoked']) {
    assert.match(body, new RegExp(zustand), `${zustand} fehlt in arsenalStateClass`);
  }
});

test('die Metazeile nennt Version und Alter, wenn vorhanden', async () => {
  // arsenalMetaLine haengt an arsenalAge - beide zusammen laden, sonst prueft
  // der Test nur eine Funktion mit fehlender Abhaengigkeit.
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(await rumpf('arsenalAge'), ctx);
  vm.runInContext(await rumpf('arsenalMetaLine'), ctx);
  vm.runInContext(await rumpf('arsenalStateLabel'), ctx);

  const text = ctx.arsenalMetaLine({
    name: 'frankfurt-01',
    state: 'online',
    lastSeenAt: Date.now() - 5000,
    lastVersion: '1.3.70',
  });
  assert.match(text, /1\.3\.70/, 'die Version fehlt');
  assert.match(text, /Online/, 'der Zustand fehlt');
  assert.match(text, /vor \d+ s/, 'das Alter fehlt');
});

test('die Metazeile erfindet keine Version, wenn keine gemeldet wurde', async () => {
  const line = await lade('arsenalMetaLine', { arsenalStateLabel: () => 'Noch nie gemeldet' });
  const text = line({ name: 'neu', state: 'unknown', lastSeenAt: null, lastVersion: null });
  // Kein "undefined", kein "null", kein leeres Sternchen.
  assert.ok(!/undefined|null|NaN/.test(text), `unbrauchbare Zeile: ${text}`);
  assert.match(text, /Noch nie gemeldet/);
});

test('die Metazeile laesst leere Teile weg statt Trennzeichen zu haeufen', async () => {
  const line = await lade('arsenalMetaLine', { arsenalStateLabel: () => 'Offline' });
  const text = line({ name: 'x', state: 'offline', lastSeenAt: null, lastVersion: null });
  assert.ok(!/·\s*·/.test(text), `doppelte Trenner: ${text}`);
});

test('Arsenal-Daten werden escaped ausgegeben', async () => {
  // Der Name kommt vom Nutzer. Ohne esc() waere das ein Einfallstor im Panel.
  const q = await quelle();
  const start = q.indexOf('function renderArsenals');
  assert.ok(start > 0, 'renderArsenals fehlt');
  const ende = q.indexOf('\n}', start);
  const body = q.slice(start, ende + 2);
  assert.match(body, /esc\(/, 'renderArsenals muss esc() benutzen');
});

test('der Kopplungscode wird nie mit dem Schluessel verwechselt', async () => {
  // Der Schluessel darf nur einmal angezeigt werden - die Liste zeigt ihn nie.
  const q = await quelle();
  const start = q.indexOf('function renderArsenals');
  const body = q.slice(start, q.indexOf('\n}', start) + 2);
  assert.ok(!/\.key\b/.test(body), 'renderArsenals griff auf .key zu');
});
