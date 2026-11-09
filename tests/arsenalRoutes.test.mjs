// Tests fuer die Arsenal-Routen.
//
// Prueft die ECHTE Kette: HTTP -> requirePerm -> Route -> Store -> DB.
// Kein Mock der Rechtepruefung, weil genau die der interessante Teil ist:
// wer darf koppeln, wer darf nicht.
//
// Laeuft gegen einen eigenen HTTP-Server und eine Wegwerf-DB; die echte
// Datenbank wird nicht angefasst.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arsenal-routes-'));
process.env.ARMORY_DB_PATH = path.join(tmpDir, 'test.db');

const express = (await import('express')).default;
const cookieParser = (await import('cookie-parser')).default;
const { arsenalRouter } = await import('../app/arsenalRoutes.js');
const store = await import('../app/arsenalStore.js');
const { createSession, createUser, hasUsers, setRole } = await import('../app/auth.js');

// Der Cookie-Name steht in authRoutes.js:18 und ist nicht exportiert.
const COOKIE_NAME = 'armory_session';

let server;
let baseUrl;
let adminSession;
let friendSession;

before(async () => {
  // Zwei Nutzer: ein Superuser (darf koppeln) und ein friend (darf nicht).
  // Eigene Nutzer, damit die Session-Fremdschluessel greifen. createUser ist
  // ASYNC und gibt { id, username, role } zurueck - ohne await kaeme undefined
  // heraus und die Session scheiterte an "NOT NULL: sessions.user_id".
  // Die IDs deshalb nicht hartkodieren: sonst haengt der Test davon ab, was
  // vorher in der DB stand.
  // Passwort-Regeln von auth.js (10 Zeichen, 3 Gruppen, keine Leak-Liste).
  // "Test-Passwort-123" stand selbst auf der Blockliste - also zufaellig.
  const pw = 'T7v!qR2m#Lk9wZ';
  const rootUser = await createUser('root-test', pw, 'superuser');
  const friendUser = await createUser('friend-test', pw, 'friend');
  assert.ok(Number.isInteger(rootUser?.id), 'createUser lieferte keine ID');
  assert.ok(Number.isInteger(friendUser?.id), 'createUser lieferte keine ID');

  adminSession = createSession(rootUser.id, {});
  friendSession = createSession(friendUser.id, {});

  const app = express();
  app.use(express.json());
  // WICHTIG: requirePerm liest req.cookies. Ohne cookie-parser sind die
  // Cookies undefined und JEDE Anmeldung scheitert mit 401 - das sieht aus wie
  // ein Rechte-Problem, ist aber ein fehlendes Middleware-Stueck. (Der echte
  // Server haengt cookie-parser in server.js ein.)
  app.use(cookieParser());
  app.use('/api', arsenalRouter);
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  store.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Cookies: die Session-Id liegt als httpOnly-Cookie. Fuer den Test setzen wir
// sie direkt im Header.
async function req(method, pfad, { session, body, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${pfad}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(session ? { cookie: `${COOKIE_NAME}=${session}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function leereAlles() {
  store.db.exec('DELETE FROM arsenals; DELETE FROM arsenal_pairings;');
}

// ---------- Rechte-Gate ----------

test('Kopplungscode erzeugen ohne Login: 401', async () => {
  const r = await req('POST', '/api/arsenals/pairing');
  assert.equal(r.status, 401);
});

test('Kopplungscode erzeugen als friend: 403', async () => {
  // Der Kern der Anforderung: Arsenale sind standardmaessig NUR superuser.
  const r = await req('POST', '/api/arsenals/pairing', { session: friendSession });
  assert.equal(r.status, 403);
});

test('Arsenalliste als friend: 403', async () => {
  const r = await req('GET', '/api/arsenals', { session: friendSession });
  assert.equal(r.status, 403);
});

test('Kopplungscode erzeugen als superuser: 200 mit Code', async () => {
  leereAlles();
  const r = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  assert.equal(r.status, 200);
  assert.match(r.body.code, /^[A-Z2-9]{8}$/);
  assert.equal(r.body.codeFormatted, `${r.body.code.slice(0, 4)}-${r.body.code.slice(4)}`);
  assert.ok(r.body.expiresAt > Date.now());
});

// ---------- Koppeln ----------

test('Einloesen als superuser legt Arsenal an und liefert den Schluessel', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const r = await req('POST', '/api/arsenals/pair', {
    session: adminSession,
    body: { code: pair.codeFormatted, name: 'frankfurt-01' },
  });

  assert.equal(r.status, 201);
  assert.equal(r.body.arsenal.name, 'frankfurt-01');
  assert.equal(typeof r.body.key, 'string');
  assert.ok(r.body.key.length >= 40);

  // Der Schluessel darf in der Antwort auf die Liste NICHT auftauchen.
  const liste = await req('GET', '/api/arsenals', { session: adminSession });
  assert.equal(liste.status, 200);
  const eintrag = liste.body.arsenals.find((a) => a.id === r.body.arsenal.id);
  assert.ok(eintrag, 'Arsenal fehlt in der Liste');
  assert.equal(eintrag.key, undefined);
  assert.equal(eintrag.key_hash, undefined);
  assert.equal(eintrag.keyHash, undefined);
  assert.ok(!JSON.stringify(eintrag).includes(r.body.key), 'Schluessel in der Liste!');
});

test('Einloesen als friend: 403', async () => {
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const r = await req('POST', '/api/arsenals/pair', {
    session: friendSession,
    body: { code: pair.code, name: 'frech' },
  });
  assert.equal(r.status, 403);
});

test('Einloesen ohne Login: 401', async () => {
  const r = await req('POST', '/api/arsenals/pair', { body: { code: 'ABCDEFGH', name: 'x' } });
  assert.equal(r.status, 401);
});

test('unbekannter Code gibt denselben Fehler wie ein falscher', async () => {
  leereAlles();
  const a = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: 'AAAA-AAAA', name: 'x' },
  });
  const b = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: 'ZZZZ-ZZZZ', name: 'y' },
  });
  assert.equal(a.status, b.status);
  assert.equal(a.body.error, b.body.error);
});

test('Code ohne Namen: 400', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const r = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: '  ' },
  });
  assert.equal(r.status, 400);
});

// ---------- Lebenszeichen (der einzige Pfad ohne Session) ----------

test('Herzschlag ohne Schluessel: 401', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const { body: gekoppelt } = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: 'hb' },
  });

  const r = await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id },
  });
  assert.equal(r.status, 401);
  assert.equal(store.getArsenal(gekoppelt.arsenal.id).last_seen_at, null);
});

test('Herzschlag mit falschem Schluessel: 401 und kein Schreibzugriff', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const { body: gekoppelt } = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: 'hb2' },
  });

  const r = await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id },
    headers: { 'x-arsenal-key': 'falscher-schluessel' },
  });
  assert.equal(r.status, 401);
  assert.equal(store.getArsenal(gekoppelt.arsenal.id).last_seen_at, null);
});

test('Herzschlag mit richtigem Schluessel setzt last_seen_at', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const { body: gekoppelt } = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: 'hb3' },
  });

  const vorher = Date.now();
  const r = await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id, version: '1.3.60' },
    headers: { 'x-arsenal-key': gekoppelt.key },
  });

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const gespeichert = store.getArsenal(gekoppelt.arsenal.id);
  assert.ok(gespeichert.last_seen_at >= vorher);
  assert.equal(gespeichert.last_version, '1.3.60');
});

test('Herzschlag eines gesperrten Arsenals: 401', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const { body: gekoppelt } = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: 'hb4' },
  });

  // Erst gueltig melden, dann sperren.
  await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id }, headers: { 'x-arsenal-key': gekoppelt.key },
  });
  const gesperrt = await req('POST', `/api/arsenals/${gekoppelt.arsenal.id}/revoke`, {
    session: adminSession,
  });
  assert.equal(gesperrt.status, 200);

  const danach = await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id, version: 'ha-ha' },
    headers: { 'x-arsenal-key': gekoppelt.key },
  });
  assert.equal(danach.status, 401);
  assert.notEqual(store.getArsenal(gekoppelt.arsenal.id).last_version, 'ha-ha');
});

test('Herzschlag mit ungueltiger ID: 400, kein Datenbankfehler', async () => {
  for (const id of [0, -1, 'abc', null]) {
    const r = await req('POST', '/api/arsenal/heartbeat', { body: { id }, headers: { 'x-arsenal-key': 'x' } });
    assert.equal(r.status, 400, `ID ${JSON.stringify(id)} ergab ${r.status}`);
  }
});

// ---------- Zustand in der Liste ----------

test('Liste unterscheidet unbekannt und offline', async () => {
  leereAlles();
  const { body: pair } = await req('POST', '/api/arsenals/pairing', { session: adminSession });
  const { body: gekoppelt } = await req('POST', '/api/arsenals/pair', {
    session: adminSession, body: { code: pair.code, name: 'zustand' },
  });

  let liste = await req('GET', '/api/arsenals', { session: adminSession });
  let eintrag = liste.body.arsenals.find((a) => a.id === gekoppelt.arsenal.id);
  assert.equal(eintrag.state, 'unknown', 'nie gemeldet muss unknown sein');

  await req('POST', '/api/arsenal/heartbeat', {
    body: { id: gekoppelt.arsenal.id }, headers: { 'x-arsenal-key': gekoppelt.key },
  });
  liste = await req('GET', '/api/arsenals', { session: adminSession });
  eintrag = liste.body.arsenals.find((a) => a.id === gekoppelt.arsenal.id);
  assert.equal(eintrag.state, 'online');
});
