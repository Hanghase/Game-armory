// Tests für Live-Logs eines Docker-Swords (2026-11-07).
//
// Ausgangslage: streamLogs() kannte nur 'file' und 'journald'. Alles andere
// fiel in den journald-Zweig, und der liest `sword.control.service`. Ein
// Docker-Sword HAT keinen systemd-Service. Live belegt:
//
//   streamLogs({logs:{type:'docker',service:'nc-app'},control:{type:'docker'}}, ...)
//   -> Fehler: Ungültige Unit: undefined
//
// Der Log-Knopf im Panel war für NC also tot. Genau wie der Stop-Knopf.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const controlPath = new URL('../app/control.js', import.meta.url);

// Minimaler ChildProcess-Ersatz: streamLogs gibt ein Handle mit .kill() zurueck.
function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => { c.killed = true; };
  return c;
}

test('streamLogs kennt den Typ docker und liest ueber den Helfer', async () => {
  const { streamLogs } = await import(controlPath);
  const child = fakeChild();
  const calls = [];

  const h = streamLogs(
    { control: { type: 'docker', compose: '/opt/nextcloud/docker-compose.yml' }, logs: { type: 'docker', service: 'nc-app' } },
    () => {},
    { spawn: (cmd, args) => { calls.push([cmd, ...args]); return child; } },
  );

  assert.equal(calls.length, 1, 'genau ein Prozess');
  assert.equal(calls[0][0], 'sudo', 'ueber den Helfer, nicht direkt an docker');
  assert.ok(calls[0].includes('/usr/local/bin/armory-docker-ctl'));
  assert.ok(calls[0].includes('logs'));
  assert.ok(calls[0].includes('nc-app'));
  assert.equal(typeof h.kill, 'function', 'Handle muss .kill() haben wie ein ChildProcess');
});

test('streamLogs docker leitet die Ausgabe weiter', async () => {
  const { streamLogs } = await import(controlPath);
  const child = fakeChild();
  const teile = [];

  streamLogs(
    { control: { type: 'docker', compose: '/opt/nextcloud/docker-compose.yml' }, logs: { type: 'docker', service: 'nc-app' } },
    (d) => teile.push(d),
    { spawn: () => child },
  );

  child.stdout.emit('data', Buffer.from('erste zeile\n'));
  child.stderr.emit('data', Buffer.from('warnung\n'));

  assert.equal(teile.length, 2, 'stdout UND stderr muessen durchkommen');
  assert.match(teile[0], /erste zeile/);
  assert.match(teile[1], /warnung/);
});

test('streamLogs docker weist unbekannte Dienste ab, bevor ein Prozess startet', async () => {
  const { streamLogs } = await import(controlPath);
  const calls = [];

  assert.throws(
    () => streamLogs(
      { control: { type: 'docker' }, logs: { type: 'docker', service: 'böser name;rm -rf /' } },
      () => {},
      { spawn: (cmd, args) => { calls.push([cmd, ...args]); return fakeChild(); } },
    ),
    /(ung(ü|u)ltig|nicht erlaubt)/i,
  );
  assert.equal(calls.length, 0, 'bei ungueltigem Namen darf kein Prozess starten');
});

test('REGRESSION: journald-Weg bleibt unveraendert', async () => {
  const { streamLogs } = await import(controlPath);
  const child = fakeChild();
  const calls = [];

  streamLogs(
    { control: { type: 'systemd', service: 'atm11.service' }, logs: { type: 'journald' } },
    () => {},
    { spawn: (cmd, args) => { calls.push([cmd, ...args]); return child; } },
  );

  assert.deepEqual(calls[0],
    ['sudo', '-n', '/usr/local/bin/armory-service-ctl', 'logs', 'atm11.service'],
    'der systemd-Logweg muss exakt so bleiben wie vorher');
});
