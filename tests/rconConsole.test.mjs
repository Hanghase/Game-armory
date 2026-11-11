// Tests fuer die RCON-Konsole (2026-11-11).
//
// Gegenstand: tools/armory-rcon-ctl schreibt genau EINEN Konsolen-Befehl in
// einen als Sword registrierten Minecraft-Server.
//
// Warum diese Tests: ein freies Eingabefeld, das Befehle an einen
// Spieleserver schickt, ist die klassische Hintertuer. Zwei Dinge muessen
// beweisbar sein:
//   1. Shell-Metazeichen erreichen keine Shell (;, |, $(), Backticks).
//   2. Bestimmte Befehle (stop/restart/end) gehen NUR ueber den Stop-Knopf.
//
// Die Tests rufen den Helfer direkt auf. Es wird KEINE RCON-Verbindung
// aufgebaut: alle Ablehnungsfaelle enden vor dem Node-Client (exit 2/3/4/5).
// Der Test "normaler Befehl" bricht absichtlich an der Verbindung ab (exit 2),
// weil in der Testumgebung kein Server lauscht - das beweist, dass die
// Pruefungen DURCHGELASSEN haben (sonst waere es exit 2 aus der Pruefung).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';

const REPO = new URL('..', import.meta.url).pathname;
const HELFER = `${REPO}tools/armory-rcon-ctl`;
const CLIENT = `${REPO}tools/rcon-send.mjs`;

function helfer(...args) {
  return spawnSync('bash', [HELFER, ...args], { encoding: 'utf8', timeout: 20000 });
}

test('Helfer und Client existieren und sind syntaktisch gueltig', async () => {
  await access(HELFER);
  await access(CLIENT);

  const bash = spawnSync('bash', ['-n', HELFER], { encoding: 'utf8' });
  assert.equal(bash.status, 0, `bash -n: ${bash.stderr}`);

  const node = spawnSync('node', ['--check', CLIENT], { encoding: 'utf8' });
  assert.equal(node.status, 0, `node --check: ${node.stderr}`);
});

test('unbekannte Aktion wird abgewiesen', () => {
  const r = helfer('explode', 'atm10', 'list');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unerlaubte Aktion/);
});

test('Server-ID mit Pfadanteil wird abgewiesen', () => {
  for (const boese of ['../etc/passwd', 'atm10/../../etc', 'atm 10', 'atm10;ls']) {
    const r = helfer('send', boese, 'list');
    assert.equal(r.status, 2, `"${boese}" haette abgewiesen werden muessen`);
    assert.match(r.stderr, /Ungültige Server-ID/);
  }
});

test('nicht registrierter Server wird abgewiesen (exit 3)', () => {
  const r = helfer('send', 'gibtsnicht', 'list');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /nicht als Sword registriert/);
});

test('Shell-Metazeichen werden abgewiesen (Kern der Absicherung)', () => {
  const angriffe = [
    'list; rm -rf /',
    'list | cat /etc/shadow',
    'list && whoami',
    'list $(whoami)',
    'list `id`',
    'say \\ntouch /tmp/pwned',
    'list > /etc/passwd',
  ];
  for (const a of angriffe) {
    const r = helfer('send', 'atm10', a);
    assert.equal(r.status, 2, `"${a}" haette abgewiesen werden muessen`);
    assert.match(r.stderr, /Unzulässige Zeichen/);
  }
});

test('Zeilenumbruch im Befehl wird abgewiesen', () => {
  const r = helfer('send', 'atm10', 'list\nstop');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Zeilenumbrüche/);
});

test('gesperrte Befehle gehen nicht ueber die Konsole', () => {
  for (const b of ['stop', 'restart', 'end', '/stop', 'STOP', 'Stop']) {
    const r = helfer('send', 'atm10', b);
    assert.equal(r.status, 5, `"${b}" haette gesperrt sein muessen`);
    assert.match(r.stderr, /gesperrt/);
  }
});

test('gesperrter Befehl mit Argument wird ebenfalls erkannt', () => {
  const r = helfer('send', 'atm10', 'stop now');
  assert.equal(r.status, 5);
});

test('Befehle, die nur so AUSSEHEN wie gesperrt, gehen durch', () => {
  // "stopserver" ist kein Stop-Befehl; die Pruefung darf nur das erste Wort
  // exakt vergleichen, nicht per Praefix sperren.
  const r = helfer('send', 'atm10', 'stopserver test');
  assert.notEqual(r.status, 5, `"stopserver test" wurde faelschlich gesperrt: ${r.stderr}`);
});

test('leerer Befehl wird abgewiesen', () => {
  const r = helfer('send', 'atm10', '');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Leerer Befehl/);
});

test('nur Leerzeichen wird abgewiesen', () => {
  const r = helfer('send', 'atm10', '   ');
  assert.equal(r.status, 2);
});

test('zu langer Befehl wird abgewiesen', () => {
  const r = helfer('send', 'atm10', 'say ' + 'a'.repeat(300));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /zu lang/);
});

test('normale Befehle kommen durch die Pruefung bis zur Verbindung', () => {
  // Beweis, dass die Pruefung NICHT zu streng ist: diese Befehle duerfen die
  // Zeichen-/Sperrpruefung passieren.
  //
  // Wichtig (Fund 2026-11-11): Der Aufruf darf NICHT als Ganzes bewertet
  // werden. Der Node-Client meldet eine gescheiterte Verbindung ebenfalls mit
  // exit 2 - genau wie die Zeichenpruefung. "rc==2" beweist also nichts, es
  // kann beides heissen. Deshalb wird auf die MELDUNG geprueft: steht
  // "Unzulaessige Zeichen" oder "gesperrt" da, hat die Pruefung abgelehnt;
  // steht eine Verbindungsmeldung oder eine echte Server-Antwort da, kam der
  // Befehl durch. So ist der Test unabhaengig davon, ob der Server laeuft.
  const erlaubt = [
    'list',
    'save-all',
    'save-all flush',
    'op Notch',
    'deop Notch',
    'ban Griefer Griefing',
    'unban Notch',
    'whitelist add Notch',
    'whitelist remove Notch',
    'whitelist list',
    'kick Notch AFK',
    'say Server restartet in 5 Minuten',
    'time set day',
    'weather clear',
  ];
  for (const b of erlaubt) {
    const r = helfer('send', 'atm10', b);
    const text = `${r.stdout}${r.stderr}`;
    assert.ok(
      !/Unzulässige Zeichen/.test(text),
      `"${b}" wurde wegen Zeichen abgewiesen: ${text}`,
    );
    assert.ok(
      !/gesperrt/.test(text),
      `"${b}" wurde gesperrt: ${text}`,
    );
  }
});

test('check-Aktion meldet die Voraussetzungen ohne Verbindung', () => {
  const r = helfer('check', 'atm10');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK server=atm10/);
});

test('der Helfer reicht kein Passwort an den Aufrufer aus', async () => {
  // Das Passwort darf nie auf stdout erscheinen - sonst koennte jeder
  // Panel-Nutzer es lesen und direkt mit dem Server sprechen.
  const r = helfer('check', 'atm10');
  let pw = '';
  try {
    pw = (await readFile(`${REPO}data/atm10-rcon.password`, 'utf8')).trim();
  } catch {
    return; // keine Passwortdatei in dieser Umgebung
  }
  assert.ok(pw.length > 0);
  assert.ok(!r.stdout.includes(pw), 'Passwort stand auf stdout!');
  assert.ok(!r.stderr.includes(pw), 'Passwort stand auf stderr!');
});

test('der Befehl wird als EIN Argument an den Client gegeben', async () => {
  // Strukturpruefung des Aufrufs: ohne `--` wuerde der Befehl in mehrere
  // Argumente zerfallen und der Client koennte ihn falsch zusammensetzen.
  const src = await readFile(HELFER, 'utf8');
  assert.match(src, /--\s*"\$befehl"/, 'Aufruf ohne -- "\\$befehl"');
  assert.match(src, /< "\$PW_FILE"/, 'Passwort wird nicht per stdin uebergeben');
});
