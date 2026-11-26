// Tests fuer die Docker-Versionspruefung (2026-11-26).
//
// Gegenstand: checkDocker(), parseImageRef(), dockerTagFamily() in
// versionCheck.js - und der Weg ueber den Dispatcher.
//
// Warum: Nextcloud stand im Sword mit installedVersion 34.0.5, waehrend
// nc-app live nextcloud:35.0.2-apache faehrt (occ status: 35.0.2). Die
// Pruefung fiel in den manual-Zweig ("keine Soll-Version eingetragen"), weil
// es fuer update.source "docker" gar keinen Zweig gab. Live gemessen am
// 2026-11-26: Docker Hub fuehrt 35.0.3-apache (24.11.), also ein echtes
// Update.
//
// Die Hub-Antwort ist eine Attrappe mit der echten Tagliste (Stand 24.11.),
// damit der Test ohne Netz laeuft und trotzdem die realen Fallen enthaelt:
//   * Alias-Tags (stable-apache, apache) ohne Version
//   * Hauptversionen 32/33/34/35 durcheinander
//   * zweistellige Patch-Nummer (35.0.10) - als String kleiner als 35.0.9
//
// Mutation, die diesen Test rot macht: Sortierung als String statt numerisch
// (dann gewinnt 35.0.9 statt 35.0.10), oder Filter auf Hauptversion entfernen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const REPO = new URL('..', import.meta.url).pathname;
const quelle = async (pfad) => readFile(`${REPO}${pfad}`, 'utf8');

const { checkDocker, parseImageRef, dockerTagFamily, checkSwordVersion } = await import(`${REPO}app/versionCheck.js`);

const HUB_TAGS = {
  results: [
    'stable-apache', 'production-apache', 'apache',
    '35.0.3-apache', '35.0-apache', '35-apache',
    '34.0.6-apache', '34.0-apache', '34-apache',
    '33.0.11-apache', '33-apache',
    '32.0.15-apache', '32-apache',
    '35.0.2-apache', '34.0.5-apache', '33.0.10-apache',
    '35.0.1-apache', '34.0.4-apache', '33.0.9-apache',
    '35.0.0-apache', '34.0.3-apache', '33.0.8-apache',
  ].map((name) => ({ name })),
};

function mitDockerHub(antwort, fn) {
  const original = globalThis.fetch;
  const aufrufe = [];
  globalThis.fetch = async (url) => {
    aufrufe.push(String(url));
    return { ok: true, status: 200, json: async () => antwort };
  };
  return Promise.resolve(fn(aufrufe)).finally(() => { globalThis.fetch = original; });
}

// --- Bildname zerlegen ------------------------------------------------------

test('parseImageRef liest offizielle Images und User-Images', () => {
  assert.deepEqual(parseImageRef('nextcloud:35.0.2-apache'), { user: 'library', repo: 'nextcloud', tag: '35.0.2-apache' });
  assert.deepEqual(parseImageRef('linuxserver/mariadb:11.8'), { user: 'linuxserver', repo: 'mariadb', tag: '11.8' });
  assert.deepEqual(parseImageRef('docker.io/library/redis:8-alpine'), { user: 'library', repo: 'redis', tag: '8-alpine' });
  assert.equal(parseImageRef(''), null);
  assert.equal(parseImageRef(null), null);
});

test('dockerTagFamily trennt Version vom Suffix und lehnt Aliase ab', () => {
  assert.deepEqual(dockerTagFamily('35.0.3-apache'), { base: '35.0.3', suffix: '-apache' });
  assert.deepEqual(dockerTagFamily('34-apache'), { base: '34', suffix: '-apache' });
  assert.deepEqual(dockerTagFamily('11.8'), { base: '11.8', suffix: '' });
  assert.equal(dockerTagFamily('stable-apache'), null);
  assert.equal(dockerTagFamily('apache'), null);
});

// --- Die Pruefung -----------------------------------------------------------

test('live-Fall: installiert 35.0.2 -> outdated auf 35.0.3-apache', async () => {
  await mitDockerHub(HUB_TAGS, async (aufrufe) => {
    const r = await checkDocker({ image: 'nextcloud:35.0.2-apache', installed: '35.0.2' });
    assert.equal(r.state, 'outdated', `state war ${r.state}: ${r.reason ?? ''}`);
    assert.equal(r.available, '35.0.3-apache');
    assert.equal(r.source, 'docker-hub');
    assert.match(aufrufe[0], /hub\.docker\.com\/v2\/repositories\/library\/nextcloud\/tags/);
  });
});

test('installiert == neuestes -> current', async () => {
  await mitDockerHub(HUB_TAGS, async () => {
    const r = await checkDocker({ image: 'nextcloud:35.0.3-apache', installed: '35.0.3' });
    assert.equal(r.state, 'current');
  });
});

test('Alias-Tag als Image (stable-apache) -> unknown mit Grund statt falscher Zahl', async () => {
  await mitDockerHub(HUB_TAGS, async () => {
    const r = await checkDocker({ image: 'nextcloud:stable-apache', installed: '35.0.2' });
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /kein Versionsstand/);
  });
});

test('keine falsche Hauptversion: 34er Image wird nicht auf 35 angeboten', async () => {
  await mitDockerHub(HUB_TAGS, async () => {
    const r = await checkDocker({ image: 'nextcloud:34.0.6-apache', installed: '34.0.6' });
    assert.equal(r.available, '34.0.6-apache');
    assert.equal(r.state, 'current');
  });
});

test('zweistellige Patch-Nummer wird numerisch sortiert, nicht alphabetisch', async () => {
  const tags = { results: ['35.0.9-apache', '35.0.10-apache', '35.0.2-apache'].map((name) => ({ name })) };
  await mitDockerHub(tags, async () => {
    const r = await checkDocker({ image: 'nextcloud:35.0.2-apache', installed: '35.0.2' });
    assert.equal(r.available, '35.0.10-apache', 'String-Sortierung wuerde 35.0.9 nehmen');
  });
});

test('anderer Suffix (fpm) wird nicht als Update fuer apache gemeldet', async () => {
  const tags = { results: ['35.0.9-fpm', '35.0.3-apache', '35.0.2-apache'].map((name) => ({ name })) };
  await mitDockerHub(tags, async () => {
    const r = await checkDocker({ image: 'nextcloud:35.0.2-apache', installed: '35.0.2' });
    assert.equal(r.available, '35.0.3-apache');
  });
});

// --- Dispatcher -------------------------------------------------------------

test('Dispatcher kennt source docker und nimmt das Image aus dem Sword', async () => {
  await mitDockerHub(HUB_TAGS, async () => {
    const r = await checkSwordVersion(
      { id: 'nextcloud', installedVersion: '35.0.2', update: { source: 'docker', image: 'nextcloud:35.0.2-apache' } },
      { rack: { source: {} } },
    );
    assert.equal(r.state, 'outdated');
    assert.equal(r.available, '35.0.3-apache');
  });
});

// --- Der Erstinstaller-Fall: source "url" + GitHub-Rack ---------------------

test('source "url" bei GitHub-Rack faellt auf GitHub zurueck, nicht auf manual', async () => {
  // Live so gefunden am 2026-11-26 (TS6-Sword vor dem Fix). Ohne diesen
  // Fallback haette ein frisch installiertes GitHub-Rack dauerhaft
  // "keine Soll-Version eingetragen" gemeldet.
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => [{ tag_name: 'v6.0.0-beta14' }],
  });
  try {
    const r = await checkSwordVersion(
      { id: 'x', installedVersion: '6.0.0-beta14', update: { source: 'url' } },
      { rack: { source: { type: 'github', url: 'https://github.com/teamspeak/teamspeak6-server' } } },
    );
    assert.equal(r.state, 'current', `state war ${r.state}: ${r.reason ?? ''}`);
    assert.equal(r.source, 'github-release');
  } finally {
    globalThis.fetch = original;
  }
});

test('source "url" ohne Rack-Quelle bleibt manual', async () => {
  const r = await checkSwordVersion(
    { id: 'y', installedVersion: '1.0.0', update: { source: 'url' } },
    { rack: {} },
  );
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /keine Soll-Version/);
});

test('der Nextcloud-Sword nennt als Quelle docker mit einem Versions-Tag', async () => {
  const sword = JSON.parse(await quelle('swords/nextcloud.sword.json'));
  assert.equal(sword.update?.source, 'docker');
  assert.match(sword.update?.image ?? '', /:\d+\.\d+\.\d+-apache$/);
});
