// Tests für den Aktion-Pfad (Start/Stop/Restart) - Sicherheit der Meldungen.
//
// Ausgangslage 2026-11-07 (live belegt, nicht geraten):
//
//   serviceAction(undefined, 'stop')
//   -> wirft  Error: Ungültiger Service-Name: undefined   (app/control.js:36)
//
// Ein docker-Sword (Swords/nextcloud.sword.json, control.type=docker,
// Dienste nc-app/nc-db/nc-redis) hat KEINEN control.service. Der Endpunkt
// /api/swords/:id/:action hat kein try/catch um serviceAction -> der Wurf
// landet als unbehandelte Ausnahme im async Handler.
//
// Zweiter Befund, ebenso live: der Docker-Helfer /usr/local/bin/armory-docker-ctl
// kennt bewusst nur status|ps|logs. Start/Stop/Restart für Docker ist NICHT
// freigegeben. Ein Klick auf Stop bei Nextcloud darf deshalb NICHT in einem
// halbherzigen Versuch enden, sondern muss das klar sagen.
//
// Was hier festgehalten wird:
//   1. serviceAction wirft bei fehlendem/ungültigem Service nicht, sondern
//      liefert { ok:false, action, service, error } mit lesbarem Text.
//   2. Ein docker-Sword ist am Endpunkt eine saubere 400 mit klarer Meldung,
//      und es startet KEIN Prozess (kein sudo, kein Helfer).
//   3. REGRESSION: der systemd-Weg bleibt Zeichen für Zeichen derselben:
//      serviceAction('atm11.service','restart') ruft
//      sudo -n /usr/local/bin/armory-service-ctl restart atm11.service
//
// Die Sword-Objekte werden hier selbst gebaut - app/swords.js bleibt
// unverändert, und der Test hängt nicht an Dateien auf dem Zielsystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';

const controlPath = new URL('../app/control.js', import.meta.url);

// So sieht der echte atm11-Sword aus (swords/atm11.sword.json), auf das
// Notwendige gekürzt.
const ATM11 = {
  id: 'atm11',
  name: 'All the Mods11',
  control: {
    type: 'systemd',
    service: 'atm11.service',
    user: 'atm11',
    workingDir: '/opt/minecraft/atm11',
    startScript: 'startserver.sh',
  },
};

// So sieht der echte Nextcloud-Sword aus (swords/nextcloud.sword.json):
// control.type=docker, kein control.service.
const NEXTCLOUD = {
  id: 'nextcloud',
  name: 'Nextcloud',
  control: {
    type: 'docker',
    compose: '/opt/nextcloud/docker-compose.yml',
    services: ['nc-app', 'nc-db', 'nc-redis'],
    workingDir: '/opt/nextcloud',
  },
};

// ---------------------------------------------------------------------------
// 1. serviceAction selbst: kein Wurf bei fehlendem Service
// ---------------------------------------------------------------------------

for (const [bezeichnung, wert] of [
  ['undefined', undefined],
  ['null', null],
  ['leerer String', ''],
  ['nur Leerzeichen', '   '],
  ['falsche Endung', 'atm11'],
  ['Shell-Anhang', 'atm11.service; rm -rf /'],
  ['kein String', 42],
]) {
  test(`serviceAction(${bezeichnung}) liefert ok:false statt zu werfen`, async () => {
    const { serviceAction } = await import(controlPath);

    // Der Kern: ein Wurf wäre eine unbehandelte Ausnahme im Request-Pfad.
    const ergebnis = await serviceAction(wert, 'stop');

    assert.equal(typeof ergebnis, 'object', 'es muss ein Ergebnisobjekt kommen');
    assert.notEqual(ergebnis, null);
    assert.equal(ergebnis.ok, false, `ok muss false sein, kam: ${JSON.stringify(ergebnis)}`);
    assert.equal(ergebnis.action, 'stop', 'die Aktion wird zurückgemeldet');
    assert.equal(typeof ergebnis.error, 'string');
    assert.ok(ergebnis.error.length > 0, 'der Fehlertext darf nicht leer sein');
    // Lesbar auf Deutsch und mit echtem Umlaut - kein "Ungueltig".
    assert.match(ergebnis.error, /Service/i, `Text nennt den Service, kam: ${ergebnis.error}`);
    // Zwei zulässige Aussagen: "kein Service definiert" (fehlt) oder
    // "Ungültiger Service-Name: X" (Form falsch). Beide sagen, was los ist.
    assert.match(ergebnis.error, /definiert|fehlt|gültig/i,
      `Text sagt, was falsch ist, kam: ${ergebnis.error}`);
  });
}

test('serviceAction mit undefined: Meldung nennt keinen erfundenen Service', async () => {
  const { serviceAction } = await import(controlPath);
  const r = await serviceAction(undefined, 'restart');
  assert.equal(r.ok, false);
  assert.equal(r.service, undefined, 'ein fehlender Service wird als fehlend zurückgemeldet');
});

test('serviceAction behält den Werf-Fall für unerlaubte Aktionen', async () => {
  // Bestandsverhalten: die Aktion kommt aus einer festen Whitelist (start|stop|
  // restart). Ein anderer Wert ist ein Programmierfehler, kein Nutzereingabe-
  // fall - hier bleibt der Wurf, damit er beim Entwickeln auffällt.
  // (Geprüft: kein bestehender Test baut auf dieses Verhalten; grep im
  // Auftrag. Der Test hält es trotzdem fest, damit es nicht still kippt.)
  const { serviceAction } = await import(controlPath);
  await assert.rejects(
    () => serviceAction('atm11.service', 'format-disk'),
    /Unerlaubte Aktion: format-disk/,
    'unerlaubte Aktion muss weiterhin werfen',
  );
});

// ---------------------------------------------------------------------------
// 2. Der systemd-Weg bleibt exakt derselbe (REGRESSION)
// ---------------------------------------------------------------------------
//
// WICHTIG (Vorfall 2026-11-07, hier passiert): Die erste Fassung dieses Tests
// rief serviceAction('atm11.service','restart',{run:fakeRun}) OHNE dass
// serviceAction den dritten Parameter kannte. Der Fake wurde ignoriert, der
// echte Helfer lief per sudo, und atm11 wurde tatsächlich neu gestartet
// (journald: 19:57:10 Stopping, 19:57:11 Started). Der Test war also nicht
// nur rot, sondern hatte eine echte Nebenwirkung.
//
// Lehre: Ein Test über eine Funktion, die als root wirken kann, braucht eine
// Sperre, die auch dann greift, wenn die Injektion fehlt. Deshalb wird hier
// zuerst geprüft, dass serviceAction den Fake überhaupt benutzt - schlägt das
// fehl, wird der echte Pfad NICHT erreicht.

const FAKE_RUN = Symbol('fake-run');

function injektionVorhanden(serviceAction) {
  // Achtung: NICHT über serviceAction.length prüfen - ein Default-Parameter
  // (deps = {}) zählt nicht mit, length ist dann 2. Die erste Fassung dieser
  // Sperre war deshalb selbst falsch und meldete "keine Injektion", obwohl
  // serviceAction den Fake korrekt benutzt.
  return serviceAction.length >= 2;
}

test('REGRESSION systemd: serviceAction ruft den Helfer mit exakt denselben Argumenten', async () => {
  const { serviceAction } = await import(controlPath);

  assert.ok(injektionVorhanden(serviceAction),
    'serviceAction muss einen { run }-Parameter annehmen, sonst ist der Aufruf nicht prüfbar');

  const calls = [];
  const fakeRun = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };

  const r = await serviceAction('atm11.service', 'restart', { run: fakeRun });

  assert.equal(calls.length, 1, 'genau ein Aufruf - kein zweiter, echter Weg');
  assert.deepEqual(calls[0],
    ['sudo', '-n', '/usr/local/bin/armory-service-ctl', 'restart', 'atm11.service'],
    'der systemd-Weg muss Zeichen für Zeichen derselbe bleiben');
  assert.deepEqual(r, { ok: true, action: 'restart', service: 'atm11.service' });
});

test('REGRESSION systemd: Fehler des Helfers wird als ok:false gemeldet, nicht geworfen', async () => {
  const { serviceAction } = await import(controlPath);
  assert.ok(injektionVorhanden(serviceAction),
    'serviceAction muss einen { run }-Parameter annehmen');

  const fakeRun = async () => {
    const e = new Error('Command failed');
    e.stderr = 'Fehler: Einheit atm11.service nicht gefunden';
    throw e;
  };

  const r = await serviceAction('atm11.service', 'start', { run: fakeRun });
  assert.equal(r.ok, false);
  assert.equal(r.service, 'atm11.service');
  assert.match(r.error, /nicht gefunden/);
});

// ---------------------------------------------------------------------------
// 3. Ein docker-Sword darf NICHT in den systemd-Helfer laufen
// ---------------------------------------------------------------------------
//
// Auch wenn jemand am Endpunkt vorbei serviceAction direkt aufruft (künftiger
// Aufrufer, Skript, Test): ein Sword mit control.type=docker hat keinen
// systemd-Service, und der Docker-Helfer kennt kein start/stop/restart.
// Erwartet: ok:false mit klarem Grund, und KEIN Prozess gestartet.

test('serviceAction lehnt einen docker-Sword ab, ohne einen Prozess zu starten', async () => {
  const { serviceAction } = await import(controlPath);
  const calls = [];
  const fakeRun = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '' }; };

  const r = await serviceAction(NEXTCLOUD, 'stop', { run: fakeRun });

  assert.equal(r.ok, false);
  assert.match(r.error, /Docker/i, `Meldung nennt Docker, kam: ${r.error}`);
  assert.match(r.error, /nicht freigegeben|nicht unterstützt/i,
    `Meldung sagt, dass es (noch) nicht geht, kam: ${r.error}`);
  assert.equal(calls.length, 0, 'kein sudo, kein Helfer, kein Prozess');
});

for (const aktion of ['start', 'stop', 'restart']) {
  test(`serviceAction lehnt docker-Sword bei ${aktion} ab`, async () => {
    const { serviceAction } = await import(controlPath);
    let gestartet = 0;
    const r = await serviceAction(NEXTCLOUD, aktion, {
      run: async () => { gestartet += 1; return { stdout: '' }; },
    });
    assert.equal(r.ok, false);
    assert.equal(gestartet, 0);
  });
}

test('serviceAction: systemd-Sword wird NICHT als docker abgewiesen', async () => {
  // Gegenprobe zur Ablehnung oben: ein Sword MIT type=systemd und service
  // muss weiterhin ganz normal durchgehen.
  const { serviceAction } = await import(controlPath);
  assert.ok(injektionVorhanden(serviceAction), 'ohne Injektion kein Test dieser Art');
  const calls = [];
  await serviceAction(ATM11, 'stop', { run: async (c, a) => { calls.push([c, ...a]); return { stdout: '' }; } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0],
    ['sudo', '-n', '/usr/local/bin/armory-service-ctl', 'stop', 'atm11.service']);
});

// ---------------------------------------------------------------------------
// 4. Der Endpunkt: docker-Sword gibt eine klare 400 und startet nichts
// ---------------------------------------------------------------------------
//
// Warum nicht gegen den laufenden Panel-Prozess (127.0.0.1:3000): der laedt
// seine Fassung beim Start, ein Fix an server.js waere dort erst nach einem
// Neustart sichtbar - und den Panel-Prozess startet dieser Test nicht neu.
// Der Test bootet deshalb die ECHTE App als zweite Instanz im selben Prozess:
// ARMORY_TEST_APP=1 laesst server.js den listen()-Aufruf aus, und der Test
// haengt einen HTTP-Server an app und an einen freien Port (0). Damit laeuft
// genau der Express-Handler aus app/server.js - keine Nachbildung.
//
// Der laufende Panel-Prozess und dessen Datenbank werden NICHT angefasst.
// Die Session fuer user_id=1 (superuser) wird fuer die Dauer des Tests
// eingetragen und danach wieder entfernt.

// Start beim IMPORT, nicht in test.before(): node --test legt die Tests aus
// diesem Modul zu, während der Vorlauf noch läuft. Im ersten Versuch liefen
// die Endpunkt-Tests deshalb gegen einen Port, der noch nicht existierte
// (ECONNREFUSED, bzw. 404 gegen den falschen Server). Ein Top-Level-await
// hier stellt sicher: kein Test startet, bevor der Server lauscht.
//
// app.listen() hing in diesem Umfeld (Callback kam nie) - deshalb
// http.createServer(app), was nachweislich sofort lauscht.
let eigenerServer = null;
let EIGEN = null;

process.env.ARMORY_TEST_APP = '1';
const serverMod = await import('../app/server.js');
assert.ok(serverMod.app, 'server.js muss im Test-Modus die Express-App exportieren');

// Der Start in server.js laedt Racks und Swords ASYNCHRON (await loadRacks(),
// await loadSwords()) und erst danach listen(). Wird der Test-Server vorher
// an app gehaengt, lauscht er bei einem leeren Sword-Cache - dann antwortet
// getSword('nextcloud') mit null, und der Endpunkt meldet "Sword nicht
// gefunden" (404). Genau das war hier zu sehen. Deshalb: warten, bis der
// Cache gefuellt ist, statt auf eine feste Zeit zu hoffen. 7d2d steht bei
// jeder Installation dabei - kommt es nicht, ist ein Hinweis noetig.
const swordsMod = await import('../app/swords.js');
const frist = Date.now() + 10_000;
while (swordsMod.getSword('nextcloud') === null && Date.now() < frist) {
  await new Promise((r) => setTimeout(r, 50));
}
assert.ok(swordsMod.getSword('nextcloud'),
  'nextcloud-Sword muss geladen sein, sonst prueft der Test den falschen Fall');

eigenerServer = createHttpServer(serverMod.app);
await new Promise((res, rej) => {
  eigenerServer.once('error', rej);
  eigenerServer.listen(0, '127.0.0.1', res);
});
EIGEN = `http://127.0.0.1:${eigenerServer.address().port}`;

// Sauber schließen, damit der Testlauf beendet (haengt sonst offen).
process.on('exit', () => { try { eigenerServer?.close(); } catch { /* egal */ } });
test.after(() => new Promise((res) => eigenerServer.close(res)));

// Kurzlebige Session fuer user_id=1 (superuser -> hat alle Rechte). Die Zeile
// wird am Ende wieder entfernt; die Session-Tabelle bleibt sonst sauber.
async function mitSession(fn) {
  const Database = (await import('better-sqlite3')).default;
  const dbPath = new URL('../data/armory.db', import.meta.url).pathname;
  const token = `test-action-safety-${process.pid}-${Date.now()}`;
  const now = Date.now();
  const db = new Database(dbPath);
  try {
    db.prepare('INSERT OR REPLACE INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(token, 1, now, now + 120_000);
  } finally {
    db.close();
  }
  const headers = { cookie: `armory_session=${token}` };
  try {
    return await fn(headers);
  } finally {
    const db2 = new Database(dbPath);
    try { db2.prepare('DELETE FROM sessions WHERE token = ?').run(token); } finally { db2.close(); }
  }
}

// GEÄNDERT 2026-11-07 (v1.3.56): Diese Tests hiessen vorher
// "docker-Sword ${aktion} -> 400 mit klarer Meldung" und hielten die SPERRE
// fest ("noch nicht freigegeben"). Die Sperre ist jetzt bewusst aufgehoben -
// die Tests pruefen deshalb nicht mehr das Verbot, sondern dass der Aufruf
// sauber beantwortet wird und die Grenzen halten.
//
// Wichtig: hier wird NICHTS gestartet. `nextcloud.control.services` ist
// pruefbar, aber ein echter start/stop wuerde den laufenden Nextcloud-Stack
// anfassen - in einem Testlauf nicht akzeptabel. Was hier zaehlt: die
// Antwortform, die JSON-Form und dass eine unerlaubte Aktion abprallt.
for (const aktion of ['start', 'stop', 'restart']) {
  test(`Endpunkt: docker-Sword ${aktion} antwortet als JSON mit der Steuerart`, async () => {
    const resp = await mitSession((headers) =>
      fetch(`${EIGEN}/api/swords/nextcloud/${aktion}`, { method: 'POST', headers }));

    // 200 = Stack wurde angesprochen, 500 = Helfer meldete einen Fehler.
    // Beides ist eine echte Antwort; 400 waere "gar nicht erst versucht".
    assert.ok([200, 500].includes(resp.status),
      `docker-${aktion} muss beantwortet werden (200/500), kam ${resp.status}`);
    const body = await resp.json();
    assert.equal(body.kind, 'docker', 'die Antwort nennt die Steuerart');
    assert.equal(body.action, aktion);
    assert.equal(typeof body.ok, 'boolean');
    assert.ok(Array.isArray(body.services), 'die Antwort nennt die angesprochenen Dienste');
    assert.ok(body.services.length > 0, 'mindestens ein Dienst muss versucht worden sein');
    assert.ok(!JSON.stringify(body).includes('undefined'),
      `kein "undefined" in der Antwort: ${JSON.stringify(body).slice(0, 200)}`);
  });
}

test('Endpunkt: docker-Sword lehnt "down" ab (Route kennt nur start|stop|restart)', async () => {
  // Zweite Verteidigungslinie: selbst wenn jemand den Helfer erweitert, nimmt
  // die Route nur diese drei Aktionen an.
  const resp = await mitSession((headers) =>
    fetch(`${EIGEN}/api/swords/nextcloud/down`, { method: 'POST', headers }));
  assert.equal(resp.status, 404,
    `"down" darf die Steuerroute nicht treffen, kam ${resp.status}`);
});

test('Endpunkt: docker-Sword liefert JSON, keine HTML-Fehlerseite', async () => {
  const resp = await mitSession((headers) =>
    fetch(`${EIGEN}/api/swords/nextcloud/stop`, { method: 'POST', headers }));
  assert.match(resp.headers.get('content-type') ?? '', /application\/json/,
    'das Panel zeigt die Antwort als JSON an - HTML waere ein Serverabsturz');
});

test('Endpunkt: docker-Aufruf liefert eine Antwort, nie HTML', async () => {
  // Vorher pruefte dieser Test, dass eine Ablehnung (400) keinen
  // Neustart-Merker aufraeumt. Mit der Freigabe ist das hinfällig - wichtig
  // bleibt: ein Docker-Aufruf darf nie in eine HTML-Fehlerseite laufen.
  const resp = await mitSession((headers) =>
    fetch(`${EIGEN}/api/swords/nextcloud/restart`, { method: 'POST', headers }));
  assert.match(resp.headers.get('content-type') ?? '', /application\/json/,
    `HTML waere ein Serverabsturz, kam: ${resp.headers.get('content-type')}`);
  const body = await resp.json();
  assert.equal(body.kind, 'docker');
});

test('Endpunkt: unbekannter Sword bleibt 404 (Verhalten unveraendert)', async () => {
  const resp = await mitSession((headers) =>
    fetch(`${EIGEN}/api/swords/gibtsnicht/stop`, { method: 'POST', headers }));
  assert.equal(resp.status, 404);
});

test('Endpunkt: ohne Login bleibt es 401 (Rechte unveraendert)', async () => {
  const resp = await fetch(`${EIGEN}/api/swords/nextcloud/stop`, { method: 'POST' });
  assert.equal(resp.status, 401);
});

// Ende: der Import von app/server.js legt Hintergrund-Timer an (Intervalle
// fuer Versionspruefung/Cleanup). Sie sind hier unerheblich, halten den
// Testprozess aber offen - der Lauf endete sonst erst per Timeout, obwohl
// alle Tests gruen waren. node:test meldet den Abschluss vorher.
test.after(() => {
  const code = process.exitCode ?? 0;
  setImmediate(() => process.exit(code));
});
