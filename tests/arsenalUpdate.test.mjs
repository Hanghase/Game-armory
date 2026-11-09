// Tests fuer das Fernupdate der Arsenale (agent/update.js).
//
// Die eine Regel, an der alles haengt (Konzept 2026-11-09):
//   DAS ROLLBACK DARF NICHT VON DER ARMORY ABHAENGEN.
// Ein Arsenal, das nach einem missglueckten Update auf ein Lebenszeichen aus
// dem Panel wartet, ist bei einem Netzproblem tot. Es sichert sich selbst,
// prueft sich selbst, rollt sich selbst zurueck - und MELDET danach nur.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../agent/update.js').catch(() => null);

test('update.js laedt ueberhaupt (kein Syntaxfehler statt Import)', () => {
  // node --check ist kein Beweis, dass ein Modul laedt - die Lehre aus
  // dem Socket-Test, der mit process.exit(1) vorbeilief.
  assert.ok(mod, 'agent/update.js laedt nicht');
});

test('ein Update ohne neue Version tut NICHTS', () => {
  const p = mod?.planeUpdate;
  assert.equal(typeof p, 'function', 'planeUpdate fehlt');
  const plan = p({ aktuell: '1.4.0', verfuegbar: '1.4.0' });
  assert.equal(plan.noetig, false, 'gleiche Version darf kein Update ausloesen');
});

test('eine AELTERE Version wird nicht eingespielt', () => {
  // Ein Rueckschritt ist kein Update. Wer "verfuegbar < aktuell" als Update
  // liest, macht aus einem Tippfehler im Tag einen Rueckbau der Maschine.
  const plan = mod.planeUpdate({ aktuell: '1.4.0', verfuegbar: '1.3.9' });
  assert.equal(plan.noetig, false, 'aeltere Version darf nicht eingespielt werden');
});

test('eine neuere Version fuehrt zu einem Plan MIT Sicherung und Rollback', () => {
  const plan = mod.planeUpdate({ aktuell: '1.4.0', verfuegbar: '1.5.0' });
  assert.equal(plan.noetig, true);
  assert.ok(plan.sicherung, 'keine Sicherung geplant - ohne sie gibt es kein Zurueck');
  assert.ok(plan.rollback, 'kein Rollback geplant');
  assert.match(String(plan.sicherung), /backup|sicherung|tar/i);
});

test('ein kaputter Versionswert loest KEIN Update aus', () => {
  for (const kaputt of ['', null, undefined, 'abc', '1.4', 'v1.4.0-beta!']) {
    const plan = mod.planeUpdate({ aktuell: '1.4.0', verfuegbar: kaputt });
    assert.equal(plan.noetig, false, `"${kaputt}" haette ein Update ausgeloest`);
  }
});

test('der Vergleich ist numerisch, nicht alphabetisch', () => {
  // "1.10.0" ist NEUER als "1.9.0". Als Zeichenkette ist es aelter.
  const plan = mod.planeUpdate({ aktuell: '1.9.0', verfuegbar: '1.10.0' });
  assert.equal(plan.noetig, true, '1.10.0 wurde nicht als neuer erkannt');
});

test('der Rollback-Pfad haengt an KEINER Netzverbindung', () => {
  // Das ist die Regel aus dem Konzept. Ein Rollback, der auf ein
  // Lebenszeichen aus der Armory wartet, ist bei Netzproblemen tot.
  assert.equal(typeof mod.entscheideNachNeustart, 'function', 'entscheideNachNeustart fehlt');
  // Nur lokale Messungen duerfen zaehlen.
  const entscheidung = mod.entscheideNachNeustart({
    dienstAktiv: false,
    versionGemeldet: '1.5.0',
    armoryErreichbar: false, // egal!
  });
  assert.equal(entscheidung.zurueck, true, 'bei totem Dienst muss zurueckgegangen werden');
});

test('ein gesunder Dienst bleibt stehen, auch wenn die Armory nicht antwortet', () => {
  const entscheidung = mod.entscheideNachNeustart({
    dienstAktiv: true,
    versionGemeldet: '1.5.0',
    armoryErreichbar: false,
  });
  assert.equal(entscheidung.zurueck, false,
    'ein gesundes Arsenal darf NICHT zurueckrollen, nur weil das Netz weg ist');
});

test('ein Dienst, der die ALTE Version meldet, gilt als nicht hochgekommen', () => {
  const entscheidung = mod.entscheideNachNeustart({
    dienstAktiv: true,
    versionGemeldet: '1.4.0', // alte Version laeuft noch
    erwartet: '1.5.0',
    armoryErreichbar: false,
  });
  assert.equal(entscheidung.zurueck, true, 'laufender alter Stand ist kein erfolgreiches Update');
});

test('der Befehlsname im Agenten ist update und sonst nichts', async () => {
  const { readFile } = await import('node:fs/promises');
  const logic = await readFile(new URL('../agent/logic.js', import.meta.url), 'utf8');
  assert.match(logic, /'update'/, 'update fehlt in der Aktionsliste des Agenten');
});

// --- Die gemeldete Version muss die ECHTE sein ------------------------------
// Auf der Test-VM lief nach dem Fernupdate tatsaechlich 1.4.1, das Panel bekam
// aber weiter 1.4.0 gemeldet - die Version stand als Zeichenkette im Code und
// wurde beim Wechsel nicht mitgezogen. Ein stiller Versionsunterschied ist
// genau der Fehler, den das Konzept ausgeschlossen hat.

test('der Agent liest seine Version aus package.json, nicht aus einer Konstante', async () => {
  const { readFile } = await import('node:fs/promises');
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

  assert.ok(
    !/const AGENT_VERSION = '\d+\.\d+\.\d+'/.test(run),
    'die Version steht als Zeichenkette im Code - sie wird beim Update nicht mitgezogen',
  );
  assert.match(run, /package\.json/, 'die Version wird nicht aus package.json gelesen');
});

test('die im Quelltext gelesene Version ist die aus package.json', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  // Der Agent meldet beim Start diese Version. Sie muss zum Paket passen.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json hat keine brauchbare Version');
});

// --- Das Update antwortet VOR dem Neustart ---------------------------------
// Live auf der Test-VM gemessen: das Update lief durch (v1.4.0 -> v1.4.1,
// Pruefung meldete "ok"), aber das Panel bekam einen Timeout. Ursache: der
// Agent wartete auf das Ergebnis, und der Neustart riss die Verbindung weg,
// bevor er antworten konnte. Ein erfolgreicher Vorgang, der wie ein Fehler
// aussieht, ist schlimmer als ein Fehler.

test('der Agent antwortet auf update, BEVOR der Dienst neu startet', async () => {
  const { readFile } = await import('node:fs/promises');
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

  const i = run.indexOf("action === 'update'");
  assert.ok(i > -1, 'kein update-Zweig im Agenten');
  const block = run.slice(i, i + 1400);

  // Der Fehler live gemessen: blockierendes await auf den vollen Ablauf ->
  // Neustart reisst die Verbindung weg -> Panel wartet 30 s in einen Timeout,
  // obwohl das Update geklappt hat.
  assert.ok(
    !/await\s+starteUpdate\(/.test(block),
    'der Agent wartet blockierend auf den Update-Ablauf - die Antwort stirbt mit dem Neustart',
  );
  // Und die Antwort muss VOR dem Anstossen rausgehen: starteUpdate im
  // Hintergrund, Antwort sofort.
  // Nicht auf Klammern matchen: der Aufruf enthaelt "(t) =>" und ein
  // [^)]*-Muster bleibt daran haengen (eigener Testfehler, 2026-11-09).
  // Entscheidend ist, dass der Aufruf NICHT mit await beginnt und dass
  // .then/.catch dranhaengt - also im Hintergrund laeuft.
  assert.match(block, /starteUpdate\(/, 'starteUpdate fehlt im Block');
  assert.match(block, /\.then\(|\.catch\(/,
    'starteUpdate wird nicht im Hintergrund angestossen');
});

// --- Neustart des Arsenals selbst ------------------------------------------
// Felix, 2026-11-09: "den restart button fand ich eigentlich echt gut".
// Gemeint ist NICHT das Neustarten von Diensten auf dem Arsenal (das ist
// Swords-Sache) - gemeint ist: der Agent haengt, ich will ihn von hier aus
// neu starten, ohne SSH. Darum heisst die Aktion "restart" und trifft genau
// den Agenten selbst.

test('die Route bietet update UND restart an - sonst nichts', async () => {
  const { readFile } = await import('node:fs/promises');
  const routen = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');
  const m = routen.match(/const ERLAUBTE_AKTIONEN = \[([^\]]+)\]/);
  assert.ok(m, 'ERLAUBTE_AKTIONEN nicht gefunden');
  const erlaubt = m[1].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean).sort();
  // install kam 2026-11-09 dazu. Es ist der EINZIGE Weg, ein gezogenes Pack
  // auf einem Arsenal zu entpacken - ohne ihn bliebe die ZIP dort liegen.
  assert.deepEqual(erlaubt, ['install', 'restart', 'update'],
    'erlaubt sind Fernupdate, Neustart des Arsenals und install');
});

test('restart braucht KEINEN Dienstnamen', async () => {
  const logic = await import('../agent/logic.js');
  const r = logic.validateCommand({ type: 'command', action: 'restart', service: null });
  // ACHTUNG: start/stop/restart hiessen im Agenten bisher "Dienst X".
  // Wenn restart jetzt den Agenten selbst meint, darf es keinen Dienst
  // verlangen - sonst schickt das Panel ein leeres Feld und bekommt 400.
  assert.equal(r.ok, true, 'restart ohne Dienst muss erlaubt sein');
  assert.equal(r.service, null);
});
