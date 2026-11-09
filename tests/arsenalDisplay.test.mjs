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

test('das Arsenal-CSS benutzt nur Theme-Variablen, die es wirklich gibt', async () => {
  // Fehler vom 2026-11-09: die Zeile stand auf var(--panel2), und --panel2
  // existierte im Theme nicht. Im dunklen Theme fiel das nicht auf, im hellen
  // war die Zeile unsichtbar. Ein Fallback-Wert verdeckt genau diesen Fehler.
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');

  // Alle definierten Variablen einsammeln.
  const definiert = new Set();
  for (const m of html.matchAll(/(--[a-z0-9-]+)\s*:/g)) definiert.add(m[1]);
  assert.ok(definiert.size > 5, 'Theme-Variablen nicht gefunden');

  // Alle benutzten Variablen im Arsenal-CSS pruefen.
  const start = html.indexOf('.arsenal-list');
  assert.ok(start > 0, 'Arsenal-CSS fehlt');
  const block = html.slice(start, start + 1400);
  const benutzt = [...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(benutzt.length > 0, 'keine Variablen im Arsenal-CSS');

  for (const v of benutzt) {
    assert.ok(definiert.has(v), `${v} wird benutzt, ist aber im Theme nicht definiert`);
  }
});

test('das Arsenal-CSS setzt keine festen Farben', async () => {
  // Feste Hex-Werte umgehen das helle Theme: --ok ist dort abgedunkelt,
  // #3fb950 waere zu blass.
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  const start = html.indexOf('.arsenal-list');
  assert.ok(start > 0);
  // Der Block endet beim naechsten schliessenden Kommentar/naechster Regel
  // ausserhalb - nicht bei </style>. Sonst sammelt der Ausschnitt das ganze
  // Theme ein und findet dessen Hex-Werte. (Eigener Fehlversuch 2026-11-09.)
  const ende = html.indexOf('</style>', start);
  const block = html.slice(start, Math.min(ende, start + 1400));
  assert.ok(!/#[0-9a-fA-F]{3,6}/.test(block),
    'feste Farbwerte im Arsenal-CSS - im hellen Theme stimmen sie nicht');
  // Gegenprobe: der Ausschnitt muss die Regeln wirklich enthalten, sonst ist
  // der Test gruen, weil er nichts gelesen hat.
  assert.match(block, /a-dot\.a-online/, 'Ausschnitt enthielt die Arsenal-Regeln nicht');
});

// --- Aktionen in der Arsenal-Zeile -----------------------------------------
// Ein Eintrag, den man nur ansehen kann, ist eine Anzeige, keine Verwaltung.
// Die API kann status/start/stop/restart - hier muss es auch klickbar sein.

// Quelle des Renderers, wie die anderen Tests sie lesen: async, ueber quelle().
async function renderBlock() {
  const js = await quelle();
  const anfang = js.indexOf('function renderArsenals');
  assert.ok(anfang > -1, 'renderArsenals nicht gefunden');
  const ende = js.indexOf('async function loadArsenals', anfang);
  assert.ok(ende > anfang, 'Ende von renderArsenals nicht gefunden');
  return js.slice(anfang, ende);
}

test('jede Arsenal-Zeile hat die vier Aktionen', async () => {
  // start/stop/restart laufen ueber den Helfer knopf(...), nur status steht
  // direkt im Markup. Ein Test auf das data-Attribut allein wuerde bei der
  // Helfer-Bauweise nie gruen - also die AUFRUFE pruefen.
  const block = await renderBlock();
  assert.ok(
    block.includes('data-arsenal-action="status"'),
    'Knopf fuer "status" fehlt in der Zeile',
  );
  for (const aktion of ['start', 'stop', 'restart']) {
    assert.ok(
      new RegExp(`knopf\\('${aktion}'`).test(block),
      `Aufruf knopf('${aktion}') fehlt - der Knopf wird nicht gezeichnet`,
    );
  }
});

test('die Knopf-Aktionen sind genau die, die die Route durchlaesst', async () => {
  // Wenn das HTML eine Aktion anbietet, die die Route mit 400 abweist, ist
  // der Knopf eine Falle. Beide Listen muessen deckungsgleich sein.
  const routen = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');
  const m = routen.match(/const ERLAUBTE_AKTIONEN = \[([^\]]+)\]/);
  assert.ok(m, 'ERLAUBTE_AKTIONEN nicht gefunden');
  const erlaubt = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean).sort();

  const block = await renderBlock();
  // Zwei Quellen: das direkte Attribut und die knopf('-Aufrufe.
  const direkt = [...block.matchAll(/data-arsenal-action="([^"]+)"/g)].map((x) => x[1]);
  const viaHelfer = [...block.matchAll(/knopf\('([^']+)'/g)].map((x) => x[1]);
  // '${aktion}' ist der Platzhalter IM Helfer, nicht eine Aktion. Ohne diesen
  // Filter meldet der Test eine Aktion, die es nie gibt.
  const eindeutig = [...new Set([...direkt, ...viaHelfer])]
    .filter((a) => !a.includes('${'))
    .sort();

  assert.deepEqual(eindeutig, erlaubt, 'Knopf und Route sind sich uneinig');
});

test('Knopf-Klicks werden auch VERDRAHTET, nicht nur gezeichnet', async () => {
  // Die Lehre aus dem Panel: ein Knopf, der aussieht wie ein Knopf und
  // keinen Zuhoerer hat, ist schlimmer als kein Knopf.
  const js = await quelle();
  assert.match(js, /data-arsenal-action/, 'Markup fehlt');
  assert.ok(
    js.includes("getElementById('arsenalList')?.addEventListener"),
    'kein Zuhoerer am Container - die Knoepfe tun nichts',
  );
  assert.ok(js.includes('runArsenalAction'), 'keine Funktion, die den Befehl absetzt');
});

test('ein Offline-Arsenal bietet keine Start/Stop-Knoepfe an', async () => {
  // Gegen ein schlafendes Arsenal zu klicken und in einen Timeout zu laufen
  // ist genau die Sorte stiller Fehler, die wir nicht wollen.
  const block = await renderBlock();
  assert.ok(
    block.includes("a.state === 'online'") || block.includes('a.state !== online'),
    'renderArsenals prueft den Zustand nicht',
  );
  assert.match(block, /online \? '' : 'disabled'/, 'Start/Stop sind nicht abschaltbar');
});
