// Tests für docker-Swords (Stand 2026-11-07).
//
// Das Sword-Schema verlangte für `control` immer service/user/workingDir/
// startScript - also systemd. Ein docker-Sword (Nextcloud) hat keinen Service,
// sondern eine Compose-Datei. Beides wird hier geprüft, weil das Schema
// nirgends im Code validiert wird: es ist Dokumentation, und Dokumentation
// ohne Test veraltet still (siehe atm11: Pack-Version "angegeben", obwohl sie
// wie erkannt aussah).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schemaUrl = new URL('../swords/sword.schema.json', import.meta.url);

async function schema() {
  return JSON.parse(await readFile(schemaUrl, 'utf8'));
}

test('control kennt zwei Zweige: systemd und docker', async () => {
  const s = await schema();
  const c = s.properties.control;

  assert.ok(Array.isArray(c.oneOf) && c.oneOf.length === 2,
    'control braucht einen oneOf-Zweig fuer systemd und einen fuer docker');

  const mitDocker = c.oneOf.find((z) => (z.properties?.type?.enum ?? []).includes('docker'));
  assert.ok(mitDocker, 'es muss einen docker-Zweig geben');
  assert.deepEqual(mitDocker.required.sort(), ['compose', 'type'].sort(),
    'der docker-Zweig verlangt nur type und compose - kein service, kein startScript');

  const mitSystemd = c.oneOf.find((z) => (z.properties?.type?.enum ?? []).includes('systemd'));
  assert.ok(mitSystemd, 'es muss einen systemd-Zweig geben');
  assert.ok(mitSystemd.required.includes('service'),
    'der systemd-Zweig MUSS service verlangen - sonst entfaellt die Pruefung');
  assert.ok(mitSystemd.required.includes('startScript'),
    'der systemd-Zweig MUSS startScript verlangen');
});

test('compose und services sind im Schema deklariert', async () => {
  const s = await schema();
  const c = s.properties.control;
  assert.ok(c.properties.compose, 'compose fehlt in control.properties');
  assert.ok(c.properties.services, 'services fehlt in control.properties');
  assert.equal(c.properties.compose.type, 'string');
  assert.equal(c.properties.services.type, 'array');
});

test('compose verlangt einen absoluten Pfad', async () => {
  const s = await schema();
  const z = s.properties.control.oneOf
    .find((x) => (x.properties?.type?.enum ?? []).includes('docker'));
  assert.equal(z.properties.compose.pattern, '^/',
    'ein relativer compose-Pfad ist relativ zum cwd des Dienstes - unbrauchbar');
});

test('die type-Enum enthaelt weiterhin alle fuenf Arten', async () => {
  const s = await schema();
  const e = s.properties.control.properties.type.enum;
  for (const t of ['systemd', 'screen', 'tmux', 'docker', 'process']) {
    assert.ok(e.includes(t), `${t} fehlt in der type-Enum`);
  }
});

test('ein docker-Sword hat keinen systemd-Service - der Code darf ihn nicht erwarten', async () => {
  const { controlKind } = await import(new URL('../app/control.js', import.meta.url));
  const ncSword = {
    id: 'nextcloud', rack: 'nextcloud', name: 'Nextcloud', port: 8088, protocol: 'tcp',
    control: { type: 'docker', compose: '/opt/nextcloud/docker-compose.yml',
      services: ['nc-app', 'nc-db', 'nc-redis'] },
  };
  assert.equal(controlKind(ncSword), 'docker');
  assert.equal(ncSword.control.service, undefined,
    'der Test-Sword soll bewusst KEINEN service haben - genau das war der Fehler');
});
