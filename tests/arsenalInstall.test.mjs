// Der 'install'-Befehl: entpacken auf dem Arsenal.
//
// Hier geht ein Name an einen Helfer, der als ROOT laeuft und useradd, chown
// und systemd-Units kann. Ein Pfad oder ein Name mit Sonderzeichen waere der
// direkte Weg zu root - darum hat jedes Feld einen Test, der bei Lockerung
// rot wird.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateInstall, PACK_HELFER, SWORD_ID_RE } from '../agent/logic.js';

const GUT = { type: 'install', pullId: 'abc123def456', swordId: 'atm11' };

test('ein sauberer Befehl wird angenommen', () => {
  const r = validateInstall(GUT);
  assert.equal(r.ok, true);
  assert.equal(r.swordId, 'atm11');
});

test('der Helferpfad steht fest im Code', () => {
  // Kein Pfad aus dem Befehl. Ein anderer Helfer waere ein anderer Befehl.
  assert.equal(PACK_HELFER, '/usr/local/bin/armory-install-helper');
});

test('ein Name mit Pfadanteil wird abgelehnt', () => {
  for (const swordId of ['../etc', 'a/b', 'x/..', 'atm11/evil']) {
    assert.equal(validateInstall({ ...GUT, swordId }).ok, false, `akzeptiert: ${swordId}`);
  }
});

test('ein Name mit Sonderzeichen wird abgelehnt', () => {
  // Der Name wird Systembenutzer UND Ordnername. Leerzeichen, Semikolon,
  // Backtick - alles, was in einer Shell oder einem Pfad Aerger macht.
  for (const swordId of ['atm 11', 'atm11;ls', 'atm`id`', 'atm11$(id)', 'ATM11', 'a', '']) {
    assert.equal(validateInstall({ ...GUT, swordId }).ok, false, `akzeptiert: ${swordId}`);
  }
});

test('ein Name mit . beginnt nicht - sonst waere es ein verstecktes Verzeichnis', () => {
  assert.equal(SWORD_ID_RE.test('.atm11'), false);
});

test('eine unbrauchbare pull-Kennung wird abgelehnt', () => {
  for (const pullId of ['', 'ABC', '../x', 'a'.repeat(65), 'zzzz1234', null, 42]) {
    assert.equal(validateInstall({ ...GUT, pullId }).ok, false, `akzeptiert: ${JSON.stringify(pullId)}`);
  }
});

test('etwas, das kein install ist, wird abgelehnt', () => {
  assert.equal(validateInstall({ ...GUT, type: 'pull' }).ok, false);
  assert.equal(validateInstall(null).ok, false);
});

// --- Der Agent ruft den Helfer NUR mit festen Argumenten ------------------
// Dieselbe Pruefung wie bei validateCommand, aber fuer den Install-Schritt:
// "Funktion getestet, Aufrufer ungeprueft" ist der Fehler, der in diesem
// Projekt am haeufigsten war.

const agentQuelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

test('der Agent ruft den Helfer mit extract-pack und fester Argumentfolge', () => {
  // PACK_HELFER ist eine Konstante, keine Zeichenkette im Aufruf - deshalb
  // ohne schliessendes Anfuehrungszeichen pruefen. Der Punkt ist die feste
  // Argumentfolge als ARRAY (kein Shell-String).
  assert.match(
    agentQuelle,
    /execFileP\(PACK_HELFER,\s*\[\s*'extract-pack'/,
    'extract-pack wird nicht (oder nicht mit festen Argumenten) aufgerufen',
  );
});

test('install steht VOR validateCommand im Verteiler', () => {
  // Sonst landet 'install' bei validateCommand, das es nicht kennt und
  // ablehnt - der Befehl kaeme nie beim Helfer an. Die Funktion waere
  // getestet und gruen, der Aufrufweg tot.
  const iInstall = agentQuelle.indexOf("msg.type === 'install'");
  const iCmd = agentQuelle.indexOf('validateCommand(msg)');
  assert.ok(iInstall > 0, 'install wird im Verteiler nicht behandelt');
  assert.ok(iInstall < iCmd, 'install wird erst nach validateCommand geprueft');
});

test('der Agent baut keine Shell um den Helfer', () => {
  const aufruf = agentQuelle.slice(agentQuelle.indexOf("'extract-pack'"));
  const bisEnde = aufruf.slice(0, aufruf.indexOf(']'));
  assert.doesNotMatch(bisEnde, /exec\(|spawn\(|`.*\$\{.*\}`[^,]*,?\s*\]/, 'Shell im Helferaufruf');
});
