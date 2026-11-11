// Tests fuer die Spieleranzeige (seit 2026-11-11).
//
// Geprueft wird die Kette, die eine Zahl auf die Karte bringt:
//   Helfer  -> parsePlayerList() -> Route -> Anzeige
//
// Die drei Anzeige-Zustaende sind Absicht und duerfen NICHT zusammenfallen:
//   0 Spieler     -> "0 / 20"          (Server weiss es)
//   unlesbar      -> "? / ?"           (Server antwortet etwas anderes)
//   nicht erreichbar -> "—"            (Server aus)
// Ein Test, der nur "count === 0" prueft, kann diesen Unterschied nicht
// einfangen - deshalb steht er hier explizit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayerList, serverSpieler } from '../app/control.js';

test('parsePlayerList: niemand online', () => {
  const r = parsePlayerList('There are 0 of a max of 20 players online:');
  assert.equal(r.count, 0);
  assert.equal(r.max, 20);
  assert.deepEqual(r.online, []);
});

test('parsePlayerList: zwei Spieler', () => {
  const r = parsePlayerList('There are 2 of a max of 20 players online: Notch, Alex');
  assert.equal(r.count, 2);
  assert.equal(r.max, 20);
  assert.deepEqual(r.online, ['Notch', 'Alex']);
});

test('parsePlayerList: einer, Namen mit Ziffern/Unterstrich', () => {
  const r = parsePlayerList('There are 1 of a max of 100 players online: Spieler_1');
  assert.equal(r.count, 1);
  assert.equal(r.max, 100);
  assert.deepEqual(r.online, ['Spieler_1']);
});

test('parsePlayerList: altes Format "3/20"', () => {
  const r = parsePlayerList('There are 3/20 players online: A, B, C');
  assert.equal(r.count, 3);
  assert.equal(r.max, 20);
  assert.deepEqual(r.online, ['A', 'B', 'C']);
});

test('parsePlayerList: unbekannte Form ergibt NULL, nicht 0', () => {
  // Das ist der Kern: eine unlesbare Antwort darf nicht als "0 Spieler"
  // durchgehen. Sonst zeigt die Karte eine Zahl, die niemand gemessen hat.
  const r = parsePlayerList('Unknown or incomplete command, see below for error');
  assert.equal(r.count, null, 'unlesbare Antwort muss null sein, nicht 0');
  assert.equal(r.max, null);
  assert.match(r.raw, /Unknown/);
});

test('parsePlayerList: leerer String ergibt count 0 (Server sagt: leer)', () => {
  const r = parsePlayerList('');
  assert.equal(r.count, 0);
  assert.equal(r.max, null);
});

test('parsePlayerList: null/undefined stuerzt nicht ab', () => {
  assert.equal(parsePlayerList(null).count, 0);
  assert.equal(parsePlayerList(undefined).count, 0);
});

test('serverSpieler: ungueltige ID wird abgelehnt, ohne sudo', async () => {
  let gerufen = false;
  const r = await serverSpieler('../etc/passwd', {
    run: async () => { gerufen = true; return { stdout: '' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ungültige Server-ID/);
  assert.equal(gerufen, false, 'bei ungueltiger ID darf sudo nie laufen');
});

test('serverSpieler: gibt stdout an den Parser weiter', async () => {
  const r = await serverSpieler('atm10', {
    run: async (cmd, args) => {
      assert.equal(cmd, 'sudo');
      assert.deepEqual(args, ['-n', '/usr/local/bin/armory-rcon-ctl', 'players', 'atm10']);
      return { stdout: 'There are 2 of a max of 20 players online: Notch, Alex\n' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.deepEqual(r.online, ['Notch', 'Alex']);
});

test('serverSpieler: Server aus ergibt klare Meldung', async () => {
  const err = new Error('Command failed');
  err.stderr = '[rcon-send] Verbindung fehlgeschlagen (127.0.0.1:25575): ECONNREFUSED';
  err.code = 2;
  const r = await serverSpieler('atm10', { run: async () => { throw err; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /nicht erreichbar/);
});

test('serverSpieler: Helfer-Fehler wird durchgereicht', async () => {
  const err = new Error('Command failed');
  err.stderr = 'Server teamspeak6 hat keine rcon-Konfiguration im Sword.';
  err.code = 3;
  const r = await serverSpieler('teamspeak6', { run: async () => { throw err; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /keine rcon-Konfiguration/);
});

// --- Farbe nach Auslastung (Felix, 2026-11-11) -------------------------------
//
// Die Grenze ist genau der Punkt, an dem ein Test etwas wert ist:
// 10/20 ist NICHT "unter der Haelfte" -> gelb. Ohne diesen Fall wuerde eine
// Off-by-one-Variante (c <= m/2) unbemerkt durchgehen.

// playerColor() steht im Browser-Teil (public/app.js). Wir schneiden die
// Funktion heraus, statt eine Kopie zu pflegen - sonst testen wir eine
// zweite Wahrheit, die vom echten Code abweichen kann.
import { readFileSync } from 'node:fs';

const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = appJs.indexOf('function playerColor(');
assert.notEqual(start, -1, 'playerColor() muss in public/app.js stehen');
// Ende der Funktion: die erste Zeile, die nur "    }" ist.
const rest = appJs.slice(start);
const ende = rest.search(/\n    \}\n/);
assert.notEqual(ende, -1, 'playerColor() Ende nicht gefunden');
const quelltext = rest.slice(0, ende + '\n    }'.length);

// eslint-disable-next-line no-new-func
const playerColor = new Function(quelltext + '\nreturn playerColor;')();

test('playerColor: unter der Haelfte ist gruen', () => {
  assert.equal(playerColor(0, 20), 'p-low');
  assert.equal(playerColor(1, 20), 'p-low');
  assert.equal(playerColor(9, 20), 'p-low');
});

test('playerColor: GENAU die Haelfte ist gelb, nicht gruen', () => {
  // 10 von 20 ist nicht mehr "unter der Haelfte".
  assert.equal(playerColor(10, 20), 'p-mid');
});

test('playerColor: halb bis fast voll ist gelb', () => {
  assert.equal(playerColor(11, 20), 'p-mid');
  assert.equal(playerColor(19, 20), 'p-mid');
});

test('playerColor: voll ist rot', () => {
  assert.equal(playerColor(20, 20), 'p-full');
});

test('playerColor: andere Maximalwerte rechnen mit', () => {
  assert.equal(playerColor(49, 100), 'p-low');
  assert.equal(playerColor(50, 100), 'p-mid');
  assert.equal(playerColor(99, 100), 'p-mid');
  assert.equal(playerColor(100, 100), 'p-full');
  // 4 Slots: 2/4 ist die Haelfte -> gelb, 1/4 gruen, 4/4 rot
  assert.equal(playerColor(1, 4), 'p-low');
  assert.equal(playerColor(2, 4), 'p-mid');
  assert.equal(playerColor(4, 4), 'p-full');
});

test('playerColor: unbekannt ergibt KEINE Farbe', () => {
  // Lieber keine Farbe als eine geratene Auslastung.
  assert.equal(playerColor(null, 20), null);
  assert.equal(playerColor(5, null), null);
  assert.equal(playerColor(5, 0), null);
  assert.equal(playerColor(undefined, undefined), null);
  assert.equal(playerColor('x', 'y'), null);
});

test('playerColor: ueber max (z.B. nach Config-Aenderung) ist rot', () => {
  // Kann passieren, wenn max in der Config gesenkt wurde, waehrend Spieler
  // drauf waren. Nicht abstuerzen, sondern als "voll" behandeln.
  assert.equal(playerColor(22, 20), 'p-full');
});

// --- 7 Days to Die (Telnet, seit 2026-11-11) ---------------------------------
//
// 7d2d hat kein RCON. "lp" (= listplayers) antwortet "Total of N in the game".
// Das Maximum steht NICHT in der Antwort - deshalb ist max hier null, und die
// Karte zeigt nur die Zahl ohne "/20".

import { parse7d2dPlayers, telnetSpieler } from '../app/control.js';

test('parse7d2dPlayers: echte Antwort mit 0 Spielern', () => {
  // Woertlich so vom laufenden Server gekommen (der Helfer stellt MAXPLAYERS
  // aus der Config voran - der Telnet-Befehl selbst liefert es nicht).
  const r = parse7d2dPlayers('MAXPLAYERS=8\nTotal of 0 in the game');
  assert.equal(r.count, 0);
  assert.equal(r.max, 8, 'Max kommt aus der Config (ServerMaxPlayerCount)');
  assert.deepEqual(r.online, []);
});

test('parse7d2dPlayers: ohne MAXPLAYERS bleibt max null (keine geratene Zahl)', () => {
  const r = parse7d2dPlayers('Total of 0 in the game');
  assert.equal(r.count, 0);
  assert.equal(r.max, null);
});

test('parse7d2dPlayers: MAXPLAYERS allein reicht nicht fuer eine Ampel', () => {
  // Max bekannt, Zahl nicht -> count null, KEINE Farbe. Die Karte zeigt "?".
  const r = parse7d2dPlayers('MAXPLAYERS=8\n*** ERROR: unknown command');
  assert.equal(r.count, null);
  assert.equal(r.max, 8);
});

test('parse7d2dPlayers: Zahl mit Spielern', () => {
  const r = parse7d2dPlayers('Total of 3 in the game');
  assert.equal(r.count, 3);
});

test('parse7d2dPlayers: Namen werden NICHT geraten', () => {
  // Die Form der Spielerliste bei 7d2d habe ich nicht belegen koennen.
  // Lieber keine Namen als erfundene.
  const r = parse7d2dPlayers('Total of 2 in the game\n0. id=123, Name, steamid');
  assert.equal(r.count, 2);
  assert.deepEqual(r.online, []);
});

test('parse7d2dPlayers: unlesbare Antwort ergibt null, nicht 0', () => {
  assert.equal(parse7d2dPlayers('*** ERROR: unknown command').count, null);
  assert.equal(parse7d2dPlayers('').count, null);
  assert.equal(parse7d2dPlayers(null).count, null);
});

test('telnetSpieler: ungueltige ID wird abgelehnt', async () => {
  let gerufen = false;
  const r = await telnetSpieler('../etc/passwd', {
    run: async () => { gerufen = true; return { stdout: '' }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ungültige Server-ID/);
  assert.equal(gerufen, false);
});

test('telnetSpieler: ruft den Telnet-Helfer, nicht den RCON-Helfer', async () => {
  const r = await telnetSpieler('7d2d', {
    run: async (cmd, args) => {
      assert.equal(cmd, 'sudo');
      assert.deepEqual(args, ['-n', '/usr/local/bin/armory-telnet-ctl', 'players', '7d2d']);
      return { stdout: 'Total of 1 in the game\n' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.count, 1);
});

test('telnetSpieler: Server aus ergibt klare Meldung', async () => {
  const err = new Error('Command failed');
  err.stderr = '[telnet] Verbindung fehlgeschlagen (127.0.0.1:8081): ECONNREFUSED';
  err.code = 3;
  const r = await telnetSpieler('7d2d', { run: async () => { throw err; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /nicht erreichbar \(Telnet\)/);
});

test('telnetSpieler: Helfer-Meldung wird durchgereicht', async () => {
  const err = new Error('Command failed');
  err.stderr = 'Telnet verlangt ein Passwort - der Helfer unterstuetzt das nicht (bewusst).';
  err.code = 4;
  const r = await telnetSpieler('7d2d', { run: async () => { throw err; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Passwort/);
});
