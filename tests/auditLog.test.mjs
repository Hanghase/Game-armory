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
    assert.match(rows[0].detail, /"role":"admin"/);
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
    assert.doesNotMatch(row.detail, /DAS-DARF-NICHT-REIN/);
    assert.doesNotMatch(row.detail, /geheim/);
    assert.doesNotMatch(row.detail, /abc123/);
    assert.match(row.detail, /darf rein/);
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
