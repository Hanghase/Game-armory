// Tests fuer die Konsolen-Route (2026-11-11).
//
// Gegenstand: POST /api/swords/:id/console und die Berechtigung
// sword.console.write.
//
// Die Pruefung der Befehlssicherheit (Zeichen, Sperrliste) liegt im Helfer und
// wird in rconConsole.test.mjs geprueft. HIER geht es um die Naht dazwischen:
//   - kommt nur durch, wer das Recht hat?
//   - wird rconBefehl ueberhaupt aufgerufen (die Route, nicht nur die Funktion)?
//   - wird ein Fehler des Helfers als passender HTTP-Status zurueckgegeben?
//
// Die letzte Frage ist die wichtigste: ein Test fuer rconBefehl() allein
// beweist NICHT, dass die Route sie nutzt. Genau dieses Muster (Funktion grün,
// Route falsch verdrahtet) war im Projekt schon mehrfach der Fehler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REPO = new URL('..', import.meta.url).pathname;

async function quelle(pfad) {
  return await readFile(`${REPO}${pfad}`, 'utf8');
}

test('das Recht sword.console.write existiert im Katalog', async () => {
  const src = await quelle('app/permissions.js');
  assert.match(src, /perm:\s*'sword\.console\.write'/, 'Recht fehlt im Katalog');
});

test('sword.console.write steht bei admin, aber nicht bei friend oder moderator', async () => {
  const src = await quelle('app/permissions.js');

  // ADMIN_PERMS enthaelt es
  const adminBlock = src.slice(src.indexOf('const ADMIN_PERMS'), src.indexOf('];', src.indexOf('const ADMIN_PERMS')));
  assert.match(adminBlock, /'sword\.console\.write'/, 'admin hat das Recht nicht');

  // friend hat es NICHT
  const friendZeile = src.split('\n').find((l) => /^\s*friend:\s*\[/.test(l));
  assert.ok(friendZeile, 'friend-Zeile nicht gefunden');
  assert.ok(!friendZeile.includes('sword.console.write'), 'friend darf Konsolen-Befehle senden!');

  // moderator hat es NICHT (MODERATOR_PERMS wird in ADMIN_PERMS gespreizt)
  const modBlock = src.slice(src.indexOf('const MODERATOR_PERMS'), src.indexOf('];', src.indexOf('const MODERATOR_PERMS')));
  assert.ok(!modBlock.includes('sword.console.write'), 'moderator darf Konsolen-Befehle senden!');
});

test('die Route prueft das Recht BEVOR sie etwas tut', async () => {
  const src = await quelle('app/server.js');
  const i = src.indexOf("app.post('/api/swords/:id/console'");
  assert.notEqual(i, -1, 'Route fehlt');

  // Ausschnitt bis zur naechsten Route
  const ende = src.indexOf('app.', i + 10);
  const block = src.slice(i, ende === -1 ? undefined : ende);

  assert.match(block, /roleHasPerm\(req\.user\.role,\s*'sword\.console\.write'\)/, 'Recht wird nicht geprueft');
  assert.match(block, /requireAuth/, 'Route ist nicht angemeldungsgeschuetzt');

  // Die Rechte-Pruefung muss VOR dem Aufruf von rconBefehl stehen.
  const permPos = block.indexOf("roleHasPerm(req.user.role, 'sword.console.write')");
  const callPos = block.indexOf('rconBefehl(');
  assert.ok(permPos < callPos, 'Recht wird erst NACH dem Senden geprueft!');
});

test('die Route ruft rconBefehl auf und gibt die Antwort weiter', async () => {
  const src = await quelle('app/server.js');
  const i = src.indexOf("app.post('/api/swords/:id/console'");
  const ende = src.indexOf('app.', i + 10);
  const block = src.slice(i, ende === -1 ? undefined : ende);

  assert.match(block, /const ergebnis = await rconBefehl\(/, 'Route ruft rconBefehl nicht auf');
  assert.match(block, /ergebnis\.antwort/, 'Antwort des Servers wird nicht zurueckgegeben');
});

test('ein Fehler der Sperrliste ergibt 403, ein Verbindungsfehler 502', async () => {
  const src = await quelle('app/server.js');
  const i = src.indexOf("app.post('/api/swords/:id/console'");
  const ende = src.indexOf('app.', i + 10);
  const block = src.slice(i, ende === -1 ? undefined : ende);

  assert.match(block, /ergebnis\.code === 5\)\s*status = 403/, 'Sperrliste ergibt nicht 403');
  assert.match(block, /status = 502/, 'Verbindungsfehler ergibt nicht 502');
});

test('Server ohne rcon-Konfiguration wird abgewiesen', async () => {
  const src = await quelle('app/server.js');
  const i = src.indexOf("app.post('/api/swords/:id/console'");
  const ende = src.indexOf('app.', i + 10);
  const block = src.slice(i, ende === -1 ? undefined : ende);

  assert.match(block, /if \(!sword\.rcon\)/, 'fehlende rcon-Konfiguration wird nicht geprueft');
});

test('rconBefehl weist ungueltige Server-IDs ab, ohne sudo zu rufen', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  let gerufen = false;
  const run = async () => { gerufen = true; return { stdout: '' }; };

  for (const boese of ['../etc', 'atm10;ls', 'a b', '']) {
    const r = await rconBefehl(boese, 'list', { run });
    assert.equal(r.ok, false, `"${boese}" wurde akzeptiert`);
  }
  assert.equal(gerufen, false, 'sudo wurde trotz ungueltiger ID gerufen!');
});

test('rconBefehl weist leere Befehle ab, ohne sudo zu rufen', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  let gerufen = false;
  const run = async () => { gerufen = true; return { stdout: '' }; };

  for (const leer of ['', '   ', null, undefined]) {
    const r = await rconBefehl('atm10', leer, { run });
    assert.equal(r.ok, false);
  }
  assert.equal(gerufen, false);
});

test('rconBefehl gibt die Server-Antwort zurueck', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  const run = async (cmd, args) => {
    assert.equal(cmd, 'sudo');
    assert.deepEqual(args, ['-n', '/usr/local/bin/armory-rcon-ctl', 'send', 'atm10', 'list']);
    return { stdout: 'There are 0 of a max of 20 players online: \n' };
  };

  const r = await rconBefehl('atm10', 'list', { run });
  assert.equal(r.ok, true);
  assert.match(r.antwort, /0 of a max of 20/);
});

test('rconBefehl uebersetzt einen Verbindungsfehler verstaendlich', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  const run = async () => {
    const e = new Error('Command failed');
    e.code = 2;
    e.stderr = '[rcon-send] Verbindung fehlgeschlagen (127.0.0.1:25575): connect ECONNREFUSED';
    throw e;
  };

  const r = await rconBefehl('atm10', 'list', { run });
  assert.equal(r.ok, false);
  assert.match(r.error, /nicht erreichbar/);
});

test('rconBefehl reicht die Meldung der Sperrliste durch', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  const run = async () => {
    const e = new Error('Command failed');
    e.code = 5;
    e.stderr = "Befehl 'stop' ist ueber die Konsole gesperrt (bitte Stop-Knopf verwenden).";
    throw e;
  };

  const r = await rconBefehl('atm10', 'stop', { run });
  assert.equal(r.ok, false);
  assert.equal(r.code, 5);
  assert.match(r.error, /gesperrt/);
});

test('der Befehl wird als EIN Argument uebergeben (kein Zerfallen)', async () => {
  const { rconBefehl } = await import(`${REPO}app/control.js`);

  let argsGesehen = null;
  const run = async (cmd, args) => { argsGesehen = args; return { stdout: 'ok' }; };

  await rconBefehl('atm10', 'ban Griefer Böses Griefing', { run });

  // run(cmd, args):  cmd = 'sudo',  args = ['-n', HELFER, 'send', 'atm10', 'ban Griefer ...']
  // -> 5 Elemente. Wuerde der Befehl in Woerter zerfallen, waeren es mehr;
  // dann saehe der Helfer nur "ban" und der Grund ginge verloren.
  assert.equal(argsGesehen.length, 5, `Befehl zerfiel in ${argsGesehen.length} Argumente`);
  assert.equal(argsGesehen[4], 'ban Griefer Böses Griefing');
});
