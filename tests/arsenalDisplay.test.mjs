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
// 2026-11-09: Start/Stop wieder RAUS. Ein Sword laeuft auf dem Arsenal und
// wird ueber die Racks bewegt; das Arsenal soll sich selbst aktuell halten.
// Eine Zeile, ein Knopf: Fernupdate.

async function renderBlock() {
  const js = await quelle();
  const anfang = js.indexOf('function renderArsenals');
  assert.ok(anfang > -1, 'renderArsenals nicht gefunden');
  const ende = js.indexOf('async function loadArsenals', anfang);
  assert.ok(ende > anfang, 'Ende von renderArsenals nicht gefunden');
  return js.slice(anfang, ende);
}

test('die Arsenal-Zeile bietet Fernupdate an', async () => {
  const block = await renderBlock();
  assert.ok(
    block.includes('data-arsenal-action="update"'),
    'Fernupdate-Knopf fehlt',
  );
  assert.match(block, /Fernupdate/);
});

test('die Arsenal-Zeile bietet KEIN Start/Stop an', async () => {
  // Nicht weil es technisch nicht ginge, sondern weil es der falsche Ort ist:
  // ein Sword laeuft auf dem Arsenal und wird ueber die Racks bewegt. Wer das
  // wieder einbaut, soll hier stolpern.
  const block = await renderBlock();
  for (const falsch of ['start', 'stop']) {
    assert.ok(
      !block.includes(`data-arsenal-action="${falsch}"`),
      `"${falsch}" gehoert nicht an das Arsenal - das ist Swords-Sache`,
    );
  }
});

test('Neustart ist erlaubt - er meint das ARSENAL, nicht einen Dienst darauf', async () => {
  // Felix, 2026-11-09: "den restart button fand ich eigentlich echt gut".
  // Der Unterschied zu start/stop: Neustart betrifft den Agenten selbst.
  // Wer ihn wieder entfernt, entfernt die Moeglichkeit, einen haengenden
  // Agenten ohne SSH zu wecken.
  const block = await renderBlock();
  assert.ok(
    block.includes('data-arsenal-action="restart"'),
    'Neustart-Knopf fehlt',
  );
});

test('die angebotene Aktion ist genau die, die die Route durchlaesst', async () => {
  const routen = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');
  const m = routen.match(/const ERLAUBTE_AKTIONEN = \[([^\]]+)\]/);
  assert.ok(m, 'ERLAUBTE_AKTIONEN nicht gefunden');
  const erlaubt = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();

  const block = await renderBlock();
  const geboten = [...new Set(
    [...block.matchAll(/data-arsenal-action="([^"]+)"/g)].map((x) => x[1]),
  )].sort();

  assert.deepEqual(geboten, erlaubt, 'Knopf und Route sind sich uneinig');
});

test('Knopf-Klicks werden auch VERDRAHTET, nicht nur gezeichnet', async () => {
  const js = await quelle();
  assert.match(js, /data-arsenal-action/, 'Markup fehlt');
  assert.ok(
    js.includes("getElementById('arsenalList')?.addEventListener"),
    'kein Zuhoerer am Container - der Knopf tut nichts',
  );
  assert.ok(js.includes('runArsenalAction'), 'keine Funktion, die den Befehl absetzt');
});

test('ein Offline-Arsenal bietet kein Fernupdate an', async () => {
  // Ein Update auf einer schlafenden Maschine ist kein Update - es ist ein
  // Timeout, den jemand spaeter nicht mehr erklaeren kann.
  const block = await renderBlock();
  assert.ok(
    block.includes("a.state === 'online'"),
    'renderArsenals prueft den Zustand nicht',
  );
  assert.match(block, /online \? '' : 'disabled'/, 'Fernupdate ist nicht abschaltbar');
});

// --- Install-Knopf: die ZIP liegt auf dem Arsenal, wer entpackt sie? -----
// Ohne Knopf bleibt die gezogene ZIP auf der Platte liegen und niemand kann
// daraus einen Sword machen. Der Test haelt den Weg im Panel offen.

test('die Arsenal-Zeile bietet einen Install-Knopf', async () => {
  const block = await renderBlock();
  assert.match(block, /data-arsenal-action="install"/, 'kein Install-Knopf in der Zeile');
});

test('der Install-Knopf ist offline abgeschaltet wie die anderen', async () => {
  const block = await renderBlock();
  const i = block.indexOf('data-arsenal-action="install"');
  assert.ok(i > 0);
  const zeile = block.slice(i, block.indexOf('>', i) + 1);
  assert.match(zeile, /online \? '' : 'disabled'/, 'Install-Knopf bleibt ohne Verbindung klickbar');
});

test('install schickt pullId UND swordId, nicht nur eine Aktion', async () => {
  // Ein {action:'install'} ohne die beiden Felder waere beim Agenten
  // 'bad-pull'. Der Knopf muss fragen, WAS entpackt und WIE es heissen soll.
  const js = await quelle();
  const i = js.indexOf("aktion === 'install'");
  assert.ok(i > 0, 'kein install-Zweig in runArsenalAction');
  const rumpf = js.slice(i, i + 1800);
  assert.match(rumpf, /pullId/, 'pullId fehlt im Aufruf');
  assert.match(rumpf, /swordId/, 'swordId fehlt im Aufruf');
});

test('install laesst sich ohne pullId gar nicht erst abschicken', async () => {
  // Sonst kaeme ein 400 zurueck, das wie ein Serverfehler aussieht statt wie
  // "du hast noch nichts gezogen".
  const js = await quelle();
  const i = js.indexOf("aktion === 'install'");
  const rumpf = js.slice(i, i + 1800);
  assert.match(rumpf, /if \(!pullId\)|if \(!gezogen|keine gezogene/i, 'keine Pruefung auf fehlende pullId');
});

test('die Eingabefelder fuer pullId und swordId stehen im HTML', async () => {
  // Der Handler liest sie per getElementById. Fehlen sie, ist value immer ''
  // und jeder Klick sagt "Keine gezogene Datei" - ohne dass ein Test rot wird,
  // wenn man nur den JS-Quelltext prueft. Genau dieser Fehler war am
  // 2026-11-07 schon einmal da (Funktion gruen, Aufrufweg tot).
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  for (const id of ['arsenalPullId', 'arsenalSwordId']) {
    assert.match(html, new RegExp(`id="${id}"`), `Feld ${id} fehlt im HTML`);
  }
});

test('die Felder stehen im Arsenale-Tab, nicht irgendwo', async () => {
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  const i = html.indexOf('id="arsenalPullId"');
  const anfang = html.lastIndexOf('id="pTabArsenals"', i);
  assert.ok(anfang > 0, 'arsenalPullId steht ausserhalb des Arsenale-Tabs');
});
