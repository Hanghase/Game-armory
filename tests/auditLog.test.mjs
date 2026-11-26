// Tests fuer die Audit-Spur (2026-11-26).
//
// Anlass war eine Frage, die ich nicht beantworten konnte: "hast du die
// beiden User angelegt?" Das Panel schrieb Benutzer-Aenderungen nirgends auf
// - nur Fehler (errorLog.js) und nur ins rotierende Log.
//
// Zwei Dinge muessen stimmen, sonst ist die Spur gefaehrlicher als keine:
//   1) Sie darf NIE die eigentliche Aktion zum Scheitern bringen.
//   2) Sie darf NIE ein Geheimnis mitschreiben.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';

const WURZEL = path.resolve(import.meta.dirname, '..');

// Jeder Test bekommt eine eigene Wegwerf-DB: die Module lesen ARMORY_DB_PATH
// beim Import, deshalb muss die Variable VOR dem dynamischen Import stehen.
async function mitDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const dbPfad = path.join(dir, 'armory.db');
  const vorher = process.env.ARMORY_DB_PATH;
  process.env.ARMORY_DB_PATH = dbPfad;
  try {
    const m = await import(`../app/auditLog.js?t=${Date.now()}-${Math.random()}`);
    return await fn(m, dbPfad);
  } finally {
    if (vorher === undefined) delete process.env.ARMORY_DB_PATH;
    else process.env.ARMORY_DB_PATH = vorher;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('audit schreibt eine Zeile und listAudit liest sie', async () => {
  await mitDb(async (m) => {
    const ok = m.audit({
      action: m.AUDIT_ACTIONS.USER_CREATE,
      user: { id: 7, username: 'Kaiser' },
      target: 'user:57',
      detail: { username: 'neu', role: 'admin' },
      ip: '127.0.0.1',
    });
    assert.equal(ok, true);

    const rows = m.listAudit({ limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'user.create');
    assert.equal(rows[0].username, 'Kaiser');
    assert.equal(rows[0].user_id, 7);
    assert.equal(rows[0].target, 'user:57');
    assert.equal(rows[0].result, 'ok');
    assert.deepEqual(rows[0].detail, { username: 'neu', role: 'admin' });
  });
});

test('Geheimnisse landen nicht in detail', async () => {
  await mitDb(async (m) => {
    m.audit({
      action: m.AUDIT_ACTIONS.USER_DELETE,
      user: { id: 1, username: 'root' },
      detail: {
        password: 'DAS-DARF-NICHT-REIN',
        password_hash: '$2b$12$geheim',
        api_key: 'abc123',
        harmlos: 'darf rein',
      },
    });
    const row = m.listAudit({ limit: 1 })[0];
    // detail ist ein Objekt - die Schwaerzung muss sich darin zeigen, nicht im Rohtext.
    const roh = JSON.stringify(row.detail);
    assert.doesNotMatch(roh, /DAS-DARF-NICHT-REIN/);
    assert.doesNotMatch(roh, /geheim/);
    assert.doesNotMatch(roh, /abc123/);
    assert.match(roh, /darf rein/);
  });
});

test('ein Audit-Fehler wirft nicht - die Aktion darf nicht sterben', async () => {
  await mitDb(async (m) => {
    // Leere Aktion: wird verworfen, darf aber keinen Fehler werfen.
    assert.equal(m.audit({}), false);
    assert.equal(m.audit({ action: '' }), false);
    // Unsinnige Zustaende ebenso.
    assert.equal(m.audit({ action: 'x', user: 'kein-objekt', detail: undefined }), true);
  });
});

test('listAudit filtert nach Aktion und Benutzer', async () => {
  await mitDb(async (m) => {
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 1, username: 'a' } });
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_FAIL, result: 'fail', user: { id: 1, username: 'b' } });
    m.audit({ action: m.AUDIT_ACTIONS.USER_DELETE, user: { id: 1, username: 'a' } });

    assert.equal(m.listAudit({ action: 'login.ok' }).length, 1);
    assert.equal(m.listAudit({ username: 'a' }).length, 2);
    assert.equal(m.countAudit(), 3);
  });
});

// --- Die Aufrufer: eine Spur, die niemand schreibt, ist keine Spur ---------
//
// Der Test ueber das Modul allein beweist nur, dass das Werkzeug funktioniert.
// Er beweist NICHT, dass es benutzt wird - genau der Fehler, den ich beim
// Docker-Update gemacht habe (Funktion getestet, Aufrufer nicht).
test('Benutzer-Aenderungen werden gespurt (create, role, delete)', async () => {
  const quelle = await readFile(path.join(WURZEL, 'app/authRoutes.js'), 'utf8');

  // Ab dem Ende des Import-Blocks suchen: die Funktionsnamen stehen auch im
  // Import (Zeilen 7-14). Ein Test, der dort anfaengt, prueft den Import und
  // nicht den Aufruf - genau daran ist die erste Fassung gruen geblieben,
  // obwohl der Audit-Aufruf entfernt war.
  const abImport = quelle.indexOf('} from \'./auth.js\'');
  assert.ok(abImport > 0, 'Import-Block nicht gefunden');

  for (const [aktion, muster] of [
    ['USER_CREATE', /createUser\(/],
    ['USER_ROLE', /setRole\(/],
    ['USER_DELETE', /deleteUser\(/],
  ]) {
    const treffer = quelle.slice(abImport).match(muster);
    const iAktion = treffer ? abImport + quelle.slice(abImport).search(muster) : -1;
    assert.ok(iAktion > 0, `${aktion}: Aufruf nicht gefunden`);
    // Die Audit-Zeile muss NACH der Aenderung stehen (sonst protokolliert sie
    // einen Vorgang, der noch scheitern kann) und VOR der Antwort.
    const iAudit = quelle.indexOf(`AUDIT_ACTIONS.${aktion}`, iAktion);
    assert.ok(iAudit > iAktion, `${aktion}: keine Audit-Zeile nach der Aenderung`);
    const iAntwort = quelle.indexOf('res.json', iAktion);
    if (iAntwort > 0) {
      assert.ok(iAudit < iAntwort, `${aktion}: Audit-Zeile steht nach der Antwort`);
    }
  }
});

test('Login-Erfolg und -Fehlschlag werden gespurt', async () => {
  const quelle = await readFile(path.join(WURZEL, 'app/authRoutes.js'), 'utf8');
  assert.match(quelle, /AUDIT_ACTIONS\.LOGIN_OK/);
  assert.match(quelle, /AUDIT_ACTIONS\.LOGIN_FAIL/);

  // Der Fehlschlag traegt result 'fail' - sonst sieht er in der Spur wie ein
  // Erfolg aus.
  const iFail = quelle.indexOf('AUDIT_ACTIONS.LOGIN_FAIL');
  assert.match(quelle.slice(iFail, iFail + 200), /result: 'fail'/);
});

test('Docker-Update wird mit Ergebnis gespurt', async () => {
  const quelle = await readFile(path.join(WURZEL, 'app/server.js'), 'utf8');
  const iRoute = quelle.indexOf("app.post('/api/swords/:id/docker-update'");
  assert.ok(iRoute > 0, 'POST-Route fehlt');
  const route = quelle.slice(iRoute, iRoute + 4000);

  const iAudit = route.indexOf('AUDIT_ACTIONS.DOCKER_UPDATE');
  const iReturn = route.indexOf('return res.status(result.ok');
  assert.ok(iAudit > 0, 'Docker-Update wird nicht gespurt');
  assert.ok(iAudit < iReturn, 'Audit-Zeile steht nach der Antwort');
  assert.match(route.slice(iAudit, iAudit + 250), /result: result\.ok \? 'ok' : 'fail'/,
    'Fehlschlag wird in der Spur als Erfolg gefuehrt');
});

test('die Lese-Route ist vorhanden und verlangt ein Recht', async () => {
  const quelle = await readFile(path.join(WURZEL, 'app/server.js'), 'utf8');
  const zeile = quelle.split('\n').find((l) => l.includes("app.get('/api/audit'"));
  assert.ok(zeile, 'GET /api/audit fehlt');
  assert.match(zeile, /requirePerm\(/,
    'Lese-Route ohne Rechtepruefung - die Spur enthaelt Benutzernamen und IPs');
});

// --- Verlauf je Nutzer (2026-11-26) ----------------------------------------
// Die Frage, die den ganzen Bau ausgeloest hat, lautet: "wer hat DIESEN
// Nutzer angelegt?" Sie richtet sich an eine Zeile, nicht an das Panel.
// Deshalb muss der Verlauf beide Richtungen kennen: was der Nutzer getan hat
// UND was an ihm getan wurde. Wer nur auf den Handelnden sieht, verpasst
// genau den Anlege-Eintrag.
test('Verlauf eines Kontos kennt beide Richtungen', async () => {
  await mitDb(async (m) => {
    m.audit({ action: m.AUDIT_ACTIONS.USER_CREATE, user: { id: 1, username: 'root' },
      target: 'user:9', detail: { username: 'Ziel' } });
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 9, username: 'Ziel' } });

    const aktionen = m.listAuditForUser('Ziel', 9).map((r) => r.action).sort();
    assert.deepEqual(aktionen, ['login.ok', 'user.create']);

    // Nur ueber target erreichbar: er hat selbst nichts getan.
    const nurZiel = m.listAuditForUser('Niemand', 9).map((r) => r.action);
    assert.deepEqual(nurZiel, ['user.create']);
  });
});

test('detail kommt als Objekt, nicht als Text', async () => {
  await mitDb(async (m) => {
    m.audit({ action: m.AUDIT_ACTIONS.USER_ROLE, user: { id: 1, username: 'root' },
      target: 'user:9', detail: { von: 'friend', auf: 'admin' } });
    const [zeile] = m.listAuditForUser('root', 1);
    assert.equal(typeof zeile.detail, 'object', 'detail muss geparst sein');
    assert.equal(zeile.detail.auf, 'admin');
  });
});

// Ursprünglich (v1.7.28) hing diese Route an user.read. Seit v1.7.31 ist
// audit.read ein eigenes, vergebbares Recht - die alte Erwartung ist damit
// veraltet, nicht der Code. Wer nur Konten verwalten darf, muss nicht
// zwingend sehen, wer sich wann eingeloggt hat - und umgekehrt.
test('Verlauf-Route verlangt audit.read', async () => {
  const quelle = await readFile(new URL('../app/server.js', import.meta.url), 'utf8');
  const i = quelle.indexOf("'/api/auth/users/:id/audit'");
  assert.ok(i > 0, 'Route fehlt');
  const bis = quelle.indexOf('app.', i);
  const block = quelle.slice(i, bis > 0 ? bis : i + 900);
  assert.match(block, /requirePerm\('audit\.read'\)/);
});

// --- Zuletzt angemeldet (2026-11-26) ---------------------------------------
// Die Spalte darf nur erfolgreiche Anmeldungen zeigen. Ein Fehlversuch ist
// keine Anmeldung - wer sich vertippt hat, war nicht online.
test('letzteAnmeldungen nimmt nur erfolgreiche Logins', async () => {
  await mitDb(async (m) => {
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_FAIL, user: { id: 2, username: 'Ziel' }, result: 'fail', ip: '::1' });
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 2, username: 'Ziel' }, ip: '::1' });
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 3, username: 'Anders' }, ip: '::1' });

    const karte = m.letzteAnmeldungen();
    assert.deepEqual(Object.keys(karte).sort(), ['Anders', 'Ziel']);
    assert.equal(typeof karte.Ziel, 'number');
  });
});

test('letzteAnmeldungen kennt nur den letzten Eintrag je Nutzer', async () => {
  await mitDb(async (m) => {
    for (let i = 0; i < 3; i++) {
      m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 2, username: 'Ziel' } });
      await new Promise((r) => setTimeout(r, 3));
    }
    const karte = m.letzteAnmeldungen();
    assert.equal(Object.keys(karte).length, 1, 'ein Eintrag je Nutzer');
    const rows = m.listAuditForUser('Ziel', 2);
    assert.equal(rows[0].at, karte.Ziel, 'die neueste Zeit, nicht irgendeine');
  });
});

test('die Nutzerliste traegt last_login ein', async () => {
  const quelle = await readFile(new URL('../app/authRoutes.js', import.meta.url), 'utf8');
  const i = quelle.indexOf("authRouter.get('/users'");
  assert.ok(i > 0, 'Route fehlt');
  const block = quelle.slice(i, i + 800);
  assert.match(block, /letzteAnmeldungen\(\)/, 'Route muss die Spur fragen');
  assert.match(block, /last_login:/, 'Feld muss gesetzt werden');
  // Ein Fehler in der Spur darf die Liste nicht kippen.
  assert.match(block, /try\s*\{/);
});

// --- Kopf und Zellen muessen zusammenpassen --------------------------------
// Beim Einbau der Spalte "Zuletzt angemeldet" habe ich die Login-Zelle VOR das
// Rang-Feld gesetzt. Niemand hat es gemerkt: die Tabelle rendert, die Werte
// stehen nur unter der falschen Ueberschrift ("Rang: noch nie"). Ein Test, der
// nur auf Anwesenheit prueft, sieht das nie. Dieser hier vergleicht die
// Reihenfolge, nicht das Vorhandensein.
test('Nutzer-Tabelle: Kopf und Zellen in derselben Reihenfolge', async () => {
  const quelle = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const kopf = quelle.match(/<thead><tr>(.*?)<\/tr><\/thead>/)[1];
  const spalten = [...kopf.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(spalten, ['Benutzer', 'Rang', 'Zuletzt angemeldet', 'E-Mail', '']);

  const zeile = quelle.match(/<tr class="user-row"[\s\S]*?<\/tr>`\)/)[0];
  // Jede Zelle mit ihrem Kennzeichen: class-Attribut oder das Element darin.
  const zellen = [];
  const teile = zeile.split('<td').slice(1);
  for (const teil of teile) {
    if (teil.includes('class="name-cell"')) zellen.push('Benutzer');
    else if (teil.includes('class="last-login"')) zellen.push('Zuletzt angemeldet');
    else if (teil.includes('class="row-actions"')) zellen.push('');
    else if (teil.includes('roleSel')) zellen.push('Rang');
    else if (teil.includes('emailInp')) zellen.push('E-Mail');
    else zellen.push('?');
  }
  assert.deepEqual(zellen, spalten, 'Zellen folgen nicht der Kopfzeile');
});

// --- audit.read als vergebbares Recht (2026-11-26) -------------------------
// Felix: "ich wuerde das wieder als Vergebbares recht eintragen". Damit
// entsteht die Frage, die es vorher nicht gab: was sieht jemand, der das
// Recht hat, aber kein superuser ist?
test('audit.read steht im Katalog und ist nicht am Rang festgenagelt', async () => {
  const p = await import('../app/permissions.js');
  assert.ok(p.PERMISSIONS.some((x) => x.perm === 'audit.read'), 'Katalog-Eintrag fehlt');
  // Startbelegung: nur superuser - die anderen Rollen bekommen es NICHT.
  assert.ok(!p.DEFAULT_MATRIX.admin.includes('audit.read'), 'admin darf es nicht automatisch haben');
  assert.ok(!p.DEFAULT_MATRIX.moderator.includes('audit.read'));
  assert.ok(!p.DEFAULT_MATRIX.friend.includes('audit.read'));
  assert.ok(p.DEFAULT_MATRIX.superuser.includes('audit.read'));
});

test('die Routen pruefen audit.read, nicht settings.read/user.read', async () => {
  const quelle = await readFile(new URL('../app/server.js', import.meta.url), 'utf8');
  for (const muster of [/app\.get\('\/api\/audit',\s*requirePerm\('audit\.read'\)/,
    /app\.get\('\/api\/auth\/users\/:id\/audit',\s*requirePerm\('audit\.read'\)/]) {
    assert.match(quelle, muster);
  }
  // Alte Anbindung darf nicht mehr stehen.
  assert.doesNotMatch(quelle, /app\.get\('\/api\/audit',\s*requirePerm\('settings\.read'\)/);
  assert.doesNotMatch(quelle, /users\/:id\/audit',\s*requirePerm\('user\.read'\)/);
});

test('spurenSichtbar schuetzt IP und Passwort-Zeilen vor Nicht-Superuser', async () => {
  await mitDb(async (m) => {
    m.audit({ action: m.AUDIT_ACTIONS.LOGIN_OK, user: { id: 2, username: 'A' }, ip: '10.1.2.3' });
    m.audit({
      action: m.AUDIT_ACTIONS.USER_PASSWORD,
      user: { id: 1, username: 'root' },
      target: 'user:2',
      detail: { Ziel: 'A' },
      ip: '10.1.2.3',
    });
    const roh = m.listAudit({ limit: 10 });

    const fremd = m.spurenSichtbar(roh);
    assert.equal(fremd.length, roh.length, 'es darf keine Zeile verschwinden');
    for (const z of fremd) assert.equal(z.ip, null, 'IP muss weg sein');
    const pw = fremd.find((z) => z.action === 'user.password');
    assert.deepEqual(pw.detail, { geschuetzt: true }, 'Passwort-Detail muss geschuetzt sein');
    // Die Wirkung bleibt sichtbar: DASS jemand ein Passwort gesetzt hat.
    assert.equal(pw.username, 'root');
    assert.equal(pw.target, 'user:2');
    assert.ok(pw.at > 0);

    const voll = m.spurenSichtbar(roh, { voll: true });
    assert.equal(voll[0].ip, '10.1.2.3', 'superuser sieht alles');
    assert.notDeepEqual(voll.find((z) => z.action === 'user.password').detail, { geschuetzt: true });
  });
});

// --- Der Aufrufer muss den Rang auch wirklich weitergeben ------------------
// Probe M3 hat gezeigt, warum das hier stehen muss: setzt man in server.js
// "voll: false" statt "req.user?.role === 'superuser'", blieben alle Tests
// gruen - spurenSichtbar() war ja korrekt. Ein Test der Funktion beweist
// nicht, dass die Route sie richtig aufruft. Dieselbe Luecke wie bei
// dockerReihenfolge/dockerStatus am 2026-11-07.
test('die Route gibt den superuser-Rang an spurenSichtbar weiter', async () => {
  const quelle = await readFile(new URL('../app/server.js', import.meta.url), 'utf8');

  // Beide Routen, die die Spur ausliefern, muessen den Rang uebergeben.
  const stellen = [
    ["app.get('/api/audit'", 'allgemeine Spur'],
    ["app.get('/api/auth/users/:id/audit'", 'Verlauf eines Kontos'],
  ];
  for (const [anker, name] of stellen) {
    const i = quelle.indexOf(anker);
    assert.ok(i > 0, `${name}: Route fehlt`);
    // Ausschnitt bis zur naechsten Route (naechstes "app.get("), nicht bis zum
    // ersten "\n});" - der Block ist laenger als der innerste try/catch.
    const naechste = quelle.indexOf('app.get(', i + anker.length);
    const block = quelle.slice(i, naechste > 0 ? naechste : i + 2000);
    const aufruf = block.match(/spurenSichtbar\([^)]*\{[^}]*\}/);
    assert.ok(aufruf, `${name}: spurenSichtbar wird nicht aufgerufen`);
    assert.match(
      aufruf[0],
      /voll:\s*req\.user\?\.role\s*===\s*'superuser'/,
      `${name}: Maskierung muss vom Rang abhaengen, nicht fest an/aus sein. Gesehen: ${aufruf[0]}`,
    );
  }
});
