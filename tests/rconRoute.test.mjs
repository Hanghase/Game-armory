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

  // Seit 2026-11-12 gibt es ZWEI Wege: RCON (Minecraft) und ServerQuery
  // (TeamSpeak 6). Der Test prueft deshalb, dass BEIDE Aufrufe im Block
  // stehen und der Weg davor entschieden wird.
  assert.match(block, /await rconBefehl\(/, 'Route ruft rconBefehl nicht auf');
  assert.match(block, /await ts6Befehl\(/, 'Route ruft ts6Befehl nicht auf');
  assert.match(block, /viaRcon/, 'Route entscheidet den Weg nicht');
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

  // Die Route muss Server OHNE jeden Konsolenweg abweisen - mit rcon ODER
  // query ist der Server erreichbar, mit keinem von beiden nicht.
  assert.match(block, /if \(!viaRcon && !viaQuery\)/, 'fehlende Konsolen-Konfiguration wird nicht geprueft');
  assert.match(block, /sword\.query/, 'query-Konfiguration wird nicht gelesen');
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

// --- TeamSpeak 6: Verbindungsfehler duerfen nicht als "Befehl falsch" gelten --
//
// Am 2026-11-12 sah Felix bei "clientlist" ein nacktes "HTTP 400". Ursache war
// NICHT der Befehl, sondern der Client: Node's fetch blockt Port 10080 als
// "bad port", die Verbindung scheiterte, und ts6Befehl() erkannte den Text
// "Verbindung fehlgeschlagen ... fetch failed" nicht als Verbindungsfehler.
// Die Route machte daraus ein 400 - also "dein Befehl ist falsch", obwohl in
// Wahrheit der Server nicht erreichbar war.
//
// Der Test haelt beide Wortlaute fest, damit die Zuordnung nicht wieder
// herausfaellt.
test('ts6Befehl: Verbindungsfehler wird als "nicht erreichbar" gemeldet', async () => {
  const { ts6Befehl } = await import(`${REPO}app/control.js`);

  // WICHTIG: Jeder Fall steht OHNE den Satz "Verbindung fehlgeschlagen" da.
  // Sonst matcht der Test schon ueber diesen einen Wortlaut, und das Entfernen
  // von "fetch failed"/"bad port" aus dem Regex bliebe unbemerkt. Genau diese
  // Falle ist beim ersten Anlauf am 2026-11-12 zugeschnappt: die Mutation war
  // wirkungslos und der Test blieb gruen, obwohl er haette rot werden muessen.
  for (const stderr of [
    'connect ECONNREFUSED 127.0.0.1:10080',
    'fetch failed',
    'fetch failed: bad port',
    'Zeitüberschreitung (127.0.0.1:10080).',
  ]) {
    const run = async () => {
      throw Object.assign(new Error('cmd failed'), { code: 2, stderr });
    };
    const r = await ts6Befehl('teamspeak6', 'clientlist', { run });
    assert.equal(r.ok, false, `haette scheitern muessen: ${stderr}`);
    assert.match(
      r.error,
      /nicht erreichbar \(ServerQuery\)/,
      `Verbindungsfehler nicht erkannt bei: ${stderr}`,
    );
  }
});

test('ts6Befehl: eine echte Ablehnung bleibt eine Ablehnung', async () => {
  const { ts6Befehl } = await import(`${REPO}app/control.js`);

  const run = async () => {
    throw Object.assign(new Error('cmd failed'), {
      code: 3,
      stderr: '[ts6-query] Server lehnt den Befehl ab (Code 1538): invalid parameter – unknown command',
    });
  };
  const r = await ts6Befehl('teamspeak6', 'list', { run });
  assert.equal(r.ok, false);
  // NICHT als Verbindungsfehler umdeuten - der Server war erreichbar.
  assert.doesNotMatch(r.error, /nicht erreichbar/);
  assert.match(r.error, /1538|unknown command/i);
});

test('ts6Befehl gibt die Server-Antwort zurueck', async () => {
  const { ts6Befehl } = await import(`${REPO}app/control.js`);

  let aufruf = null;
  const run = async (cmd, args) => {
    aufruf = { cmd, args };
    return { stdout: 'cid=1 clid=2 client_nickname=serveradmin\n' };
  };
  const r = await ts6Befehl('teamspeak6', 'clientlist', { run });

  assert.equal(r.ok, true);
  assert.match(r.antwort, /client_nickname=serveradmin/);
  assert.equal(aufruf.cmd, 'sudo');
  assert.deepEqual(aufruf.args, ['-n', '/usr/local/bin/armory-ts6-ctl', 'send', 'teamspeak6', 'clientlist']);
});

// --- TeamSpeak 6: Befehlsname wird normalisiert, Parameter nicht -----------
//
// TS6-Befehle sind case-sensitive und klein geschrieben: "Clientlist" lehnt der
// Server mit Code 1538 ab, "clientlist" geht. Am 2026-11-12 tippte Felix
// "Clientlist" und bekam "unknown command", obwohl der Befehl richtig gemeint
// war. Der Client normalisiert jetzt den Befehlsnamen.
//
// WICHTIG: Parameter duerfen NICHT mit kleingeschrieben werden - sonst wird aus
// "client_nickname=Teutates11" ein "teutates11" und der Nutzer aendert still
// Daten. Beide Richtungen sind hier festgehalten.
test('ts6-query: Befehlsname wird kleingeschrieben, Parameter bleiben', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // Ein winziger HTTP-Server, der den Pfad und die Query mitschreibt.
  const http = await import('node:http');
  let gesehen = null;
  const server = http.createServer((req, res) => {
    gesehen = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ body: [], status: { code: 0, message: 'ok' } }));
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const dir = mkdtempSync(join(tmpdir(), 'ts6test-'));
  const sword = join(dir, 'test.sword.json');
  writeFileSync(
    sword,
    JSON.stringify({ query: { host: '127.0.0.1', port, serverId: '1' } }),
  );

  try {
    // WICHTIG: asynchrones spawn, nicht spawnSync. spawnSync blockiert die
    // Event-Loop des Test-Prozesses - der Test-HTTP-Server im SELBEN Prozess
    // kann dann nie antworten, und der Client laeuft in seinen 15s-Timeout.
    // Genau das ist beim ersten Anlauf passiert.
    const { spawn } = await import('node:child_process');
    const r = await new Promise((resolve) => {
      const kind = spawn(
        process.execPath,
        ['tools/ts6-query.mjs', '--sword', sword, '--', 'ClientUpdate client_nickname=Teutates11'],
        { cwd: REPO },
      );
      let stderr = '';
      kind.stderr.on('data', (d) => { stderr += d; });
      kind.on('close', (status) => resolve({ status, stderr }));
      kind.stdin.end('testkey');
    });

    assert.equal(r.status, 0, `Client scheiterte: ${r.stderr}`);
    assert.ok(gesehen, 'Server wurde nie erreicht');
    // Befehl klein, Parameter unveraendert.
    assert.match(gesehen, /^\/1\/clientupdate\?/, `Pfad war: ${gesehen}`);
    assert.match(gesehen, /client_nickname=Teutates11/, `Query war: ${gesehen}`);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- TS6-Konsole: die Sperrliste darf nicht wieder loechrig sein -----------
//
// Am 2026-11-12 hat die Sperrliste VERSAGT: "serverprocessstop" stand nicht
// drauf, und die Panel-Konsole hat damit den TS6-Server beendet
// (serverprocessstop -> "ok", Unit inactive, VirtualServer 1 "stopped").
// Die Liste kannte nur serverstop/quit/exit/shutdown.
//
// Dieser Test prueft den HELFER direkt (der sperrt, bevor etwas rausgeht).
//
// GEFAHR: Der Helfer bekommt hier den ECHTEN Servernamen "teamspeak6". Versagt
// die Sperre, geht der Befehl an den LAUFENDEN Server und beendet ihn - genau
// das ist am 2026-11-12 bei einer Mutationsprobe passiert (VirtualServer 1
// "stopped", Unit inactive).
//
// Deshalb wird hier ein Server benutzt, den es NICHT gibt. Der Helfer prueft
// erst die Sperre; greift sie nicht, scheitert er an der unbekannten ID und
// sendet nichts. Der Test misst damit exakt das, was er messen soll: ob die
// Sperre greift - ohne den Server anfassen zu koennen.
test('armory-ts6-ctl: alle Stop-Varianten sind gesperrt (exit 5)', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');

  const HELFER = '/usr/local/bin/armory-ts6-ctl';
  if (!existsSync(HELFER)) {
    // Auf fremden Rechnern (CI) gibt es den Helfer nicht.
    return;
  }

  const gesperrt = [
    'serverprocessstop',
    'serverstop',
    'quit',
    'exit',
    'shutdown',
    'stop',
    'kill',
    'servershutdown',
    'instanceexit',
    'instancestop',
    'instancekill',
    // Grossschreibung und Argumente duerfen die Sperre nicht umgehen.
    'ServerProcessStop',
    'SERVERPROCESSTOP',
    'serverprocessstop x',
  ];

  for (const befehl of gesperrt) {
    const rc = await new Promise((resolve) => {
      // Absichtlich ein unbekannter Server: greift die Sperre nicht, kann der
      // Befehl trotzdem keinen echten Server erreichen.
      const p = spawn('sudo', ['-n', HELFER, 'send', 'gibtesnicht', befehl]);
      p.on('close', resolve);
    });
    assert.equal(rc, 5, `"${befehl}" haette gesperrt sein muessen (rc=${rc})`);
  }
});

test('armory-ts6-ctl: harmlose Befehle werden nicht gesperrt', async () => {
  const { existsSync } = await import('node:fs');
  const HELFER = '/usr/local/bin/armory-ts6-ctl';
  if (!existsSync(HELFER)) return;

  // Nur die Sperr-Pruefung: ein Aufruf mit unbekanntem Server scheitert
  // SPAETER (anderer Code), aber NICHT mit 5.
  const { spawn } = await import('node:child_process');
  for (const befehl of ['clientlist', 'version', 'serverinfo']) {
    const rc = await new Promise((resolve) => {
      const p = spawn('sudo', ['-n', HELFER, 'send', 'gibtesnicht', befehl]);
      p.on('close', resolve);
    });
    assert.notEqual(rc, 5, `"${befehl}" wurde faelschlich gesperrt`);
  }
});
