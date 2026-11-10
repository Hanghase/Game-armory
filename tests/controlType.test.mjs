// Tests für die Auswertung von control.type (app/control.js).
//
// Ausgangslage 2026-11-07: `control.type` steht seit v1.0.0 im Schema
// (systemd | screen | tmux | docker | process), aber NIEMAND liest es.
// server.js holt sich blind `sword.control.service` und ruft den systemd-Helfer.
//
// Ein docker-Sword (Nextcloud: /opt/nextcloud/docker-compose.yml) hat keinen
// systemd-Service. Ohne Auswertung landet dort "undefined" beim Helfer, und
// statt einer klaren Meldung gibt es "Ungültiger Service-Name".
//
// Dieser Test hält zwei Dinge fest:
//   1. docker-Racks werden erkannt und NICHT an den systemd-Helfer geschickt.
//   2. systemd-Racks verhalten sich exakt wie vorher (keine Regression an
//      atm11/7d2d/teamspeak - das ist der eigentliche Zweck).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const controlPath = new URL('../app/control.js', import.meta.url);

test('control.js kennt docker und schickt es nicht an den systemd-Helfer', async () => {
  const q = await readFile(controlPath, 'utf8');

  // Es muss eine Funktion geben, die die Steuerart aus dem Sword liest.
  assert.match(q, /export\s+(async\s+)?function\s+controlKind\b/,
    'control.js muss controlKind(sword) exportieren - sonst bleibt control.type ungelesen');

  // Und eine Funktion, die den Status liefert, ohne systemd zu fragen.
  assert.match(q, /export\s+(async\s+)?function\s+dockerStatus\b/,
    'control.js muss dockerStatus(control) exportieren');

  // Der systemd-Helfer darf im docker-Zweig nicht aufgerufen werden.
  assert.ok(!/docker[\s\S]{0,400}?SERVICE_CTL/.test(q.slice(q.indexOf('dockerStatus'), q.indexOf('dockerStatus') + 1200)),
    'dockerStatus darf SERVICE_CTL nicht aufrufen');
});

test('systemd bleibt der Standard, wenn control.type fehlt oder unbekannt ist', async () => {
  const { controlKind } = await import(controlPath);

  assert.equal(controlKind({ control: { type: 'systemd', service: 'a.service' } }), 'systemd');
  assert.equal(controlKind({ control: { service: 'a.service' } }), 'systemd',
    'ohne type muss systemd angenommen werden (alle Bestands-Swords haben kein type)');
  assert.equal(controlKind({ control: { type: 'quatsch' } }), 'systemd',
    'unbekannter type darf nicht zu einem Absturz fuehren');
  assert.equal(controlKind({}), 'systemd');
  assert.equal(controlKind(null), 'systemd');
});

test('docker wird als docker erkannt', async () => {
  const { controlKind } = await import(controlPath);
  const nc = { control: { type: 'docker', compose: '/opt/nextcloud/docker-compose.yml',
    services: ['nc-app', 'nc-db', 'nc-redis'] } };
  assert.equal(controlKind(nc), 'docker');
});

// KORREKTUR 2026-11-07: Dieser Test hiess urspruenglich '...ohne sudo' und
// behauptete, Lesen brauche keine Root-Rechte. Das war falsch - er hielt
// meinen eigenen Irrtum fest. Der Zugriff geht ueber den Helfer.
test('dockerStatus liest den Zustand ueber den Helfer', async () => {
  const { dockerStatus } = await import(controlPath);
  const calls = [];
  const fakeRun = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // Was `docker compose ps --format json` liefert (ein Objekt pro Zeile).
    return { stdout: [
      JSON.stringify({ Service: 'nc-app', State: 'running', Health: '', Status: 'Up 34 hours' }),
      JSON.stringify({ Service: 'nc-db', State: 'running', Health: 'healthy', Status: 'Up 34 hours' }),
      JSON.stringify({ Service: 'nc-redis', State: 'running', Health: '', Status: 'Up 34 hours' }),
    ].join('\n') };
  };

  const st = await dockerStatus(
    { compose: '/opt/nextcloud/docker-compose.yml', services: ['nc-app', 'nc-db', 'nc-redis'] },
    { run: fakeRun },
  );

  assert.equal(calls.length, 1, 'genau ein Aufruf');
  assert.equal(calls[0][0], 'sudo', 'der Docker-Socket verlangt root - Weg ueber den Helfer');
  assert.ok(calls[0].includes('/usr/local/bin/armory-docker-ctl'), 'ueber den engen Helfer');
  assert.equal(st.kind, 'docker');
  assert.equal(st.state, 'running', 'alle laufen -> running');
  assert.equal(st.running, true);
  assert.equal(st.services.length, 3);
  assert.equal(st.services[0].name, 'nc-app');
});

test('dockerStatus meldet stopped, wenn ein Dienst fehlt oder steht', async () => {
  const { dockerStatus } = await import(controlPath);
  const fakeRun = async () => ({ stdout: [
    JSON.stringify({ Service: 'nc-app', State: 'running' }),
    JSON.stringify({ Service: 'nc-db', State: 'exited' }),
    JSON.stringify({ Service: 'nc-redis', State: 'running' }),
  ].join('\n') });

  const st = await dockerStatus(
    { compose: '/opt/nextcloud/docker-compose.yml', services: ['nc-app', 'nc-db', 'nc-redis'] },
    { run: fakeRun },
  );
  assert.equal(st.state, 'degraded');
  assert.equal(st.running, false, 'ein stehender Dienst -> nicht uneingeschraenkt laufend');
});

test('dockerStatus liefert bei Fehler einen Grund statt zu werfen', async () => {
  const { dockerStatus } = await import(controlPath);
  const st = await dockerStatus(
    { compose: '/pfad/gibt/es/nicht.yml', services: ['x'] },
    { run: async () => { throw new Error('no such file or directory'); } },
  );
  assert.equal(st.state, 'unknown');
  assert.equal(st.running, false);
  // Seit 2026-11-10 (Karte 28) prueft dockerStatus den Stacknamen, BEVOR der
  // Helfer laeuft. Bei /pfad/gibt/es/nicht.yml heisst das Verzeichnis 'es' -
  // das ist ein gueltiger Name, der Helfer wird also gefragt und liefert den
  // Fehler. Der Punkt des Tests bleibt derselbe: ein GRUND, kein Wurf.
  assert.ok(st.error, 'ein Fehler muss einen Grund tragen');
});

// --- Der Weg zum Helfer (2026-11-07) -----------------------------------------
//
// Erste Fassung von dockerStatus() rief `docker compose ps` DIREKT auf. Das war
// falsch, und der Fehler zeigte sich erst als armory-User:
//
//   permission denied while trying to connect to the Docker daemon socket
//
// "Lesen braucht keine Rechte" stimmt beim Docker-Socket nicht. Wer ihn
// beschreiben darf, ist de facto root. Deshalb geht der Weg ueber einen engen
// Helfer (sudo armory-docker-ctl status), der als root liest und nur die
// Auswertung zurueckgibt. Der armory-User sieht die compose-.env nie.

test('dockerStatus geht ueber den Helfer, nicht direkt an den Docker-Socket', async () => {
  const { dockerStatus } = await import(controlPath);
  const calls = [];
  const fakeRun = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { stdout: JSON.stringify({ Service: 'nc-app', State: 'running' }) };
  };

  await dockerStatus(
    { compose: '/opt/nextcloud/docker-compose.yml', services: ['nc-app'] },
    { run: fakeRun },
  );

  assert.equal(calls[0][0], 'sudo',
    'ohne sudo kein Zugriff auf den Docker-Socket - der Aufruf muss ueber den Helfer gehen');
  assert.ok(calls[0].includes('/usr/local/bin/armory-docker-ctl'),
    `erwartet wird der Helfer, kam: ${calls[0].join(' ')}`);
  assert.ok(calls[0].includes('status'), 'der Helfer bekommt die Aktion "status"');
  // Der Pfad muss IM Helfer stehen, nicht als Argument mitgehen. Ohne diese
  // Pruefung blieb die Mutation "status <pfad>" gruen (bemerkt 2026-11-07).
  const args = calls[0].slice(1);
  const hatPfad = args.some((a) => String(a).includes('/opt/nextcloud'));
  assert.equal(hatPfad, false,
    `der compose-Pfad darf NICHT als Argument kommen, kam aber: ${args.join(' ')}`);
  assert.equal(args[args.length - 1], 'status', 'status ist das LETZTE Argument');
});

test('dockerLogs geht ebenfalls ueber den Helfer und nennt den Dienst', async () => {
  const { dockerLogs } = await import(controlPath);
  const calls = [];
  const fakeRun = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: 'zeile1\nzeile2' }; };

  const out = await dockerLogs('nc-app', 50, {
    run: fakeRun,
    control: { compose: '/opt/nextcloud/docker-compose.yml' },
  });

  assert.equal(calls[0][0], 'sudo');
  assert.ok(calls[0].includes('/usr/local/bin/armory-docker-ctl'));
  assert.ok(calls[0].includes('logs'));
  assert.ok(calls[0].includes('nc-app'));
  assert.ok(calls[0].includes('50'));
  // Seit 2026-11-10 (Karte 28) geht der Stackname mit - der Pfad nie.
  assert.ok(calls[0].includes('nextcloud'),
    `der Stackname muss mitgehen, kam: ${calls[0].join(' ')}`);
  assert.match(out, /zeile1/);
});

test('dockerLogs weist unerlaubte Dienstnamen selbst ab (vor dem Helfer)', async () => {
  const { dockerLogs } = await import(controlPath);
  const calls = [];
  const fakeRun = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };

  const out = await dockerLogs('../../etc/passwd', 10, { run: fakeRun });
  assert.equal(calls.length, 0, 'bei ungueltigem Namen darf gar kein Prozess starten');
  assert.match(out, /nicht erlaubt|ung(ü|u)ltig/i);
});
