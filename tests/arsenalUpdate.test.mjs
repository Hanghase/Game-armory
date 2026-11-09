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
