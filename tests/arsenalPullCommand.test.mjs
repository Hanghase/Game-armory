// Der 'pull'-Befehl: was das Arsenal annimmt und was nicht.
//
// Hier steht ein PFAD drin. Ein Pfad aus dem Netz ist der klassische Weg fuer
// "schreib mir mal was nach /etc/cron.d" - darum wird jedes Feld einzeln
// geprueft, und jedes Feld hat hier einen Test, der bei Lockerung rot wird.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePull, ZIEL_WURZEL, MAX_PULL_BYTES } from '../agent/logic.js';

const SHA = 'a'.repeat(64);

function gut(extra = {}) {
  return { type: 'pull', id: 'abc123def456', gesamt: 1024, sha256: SHA, name: 'pack.zip', ...extra };
}

test('ein sauberer Befehl wird angenommen', () => {
  const r = validatePull(gut());
  assert.equal(r.ok, true);
  assert.equal(r.ziel, `${ZIEL_WURZEL}/pack.zip`);
});

test('die Pruefsumme wird auf Kleinbuchstaben gebracht', () => {
  const r = validatePull(gut({ sha256: 'A'.repeat(64) }));
  assert.equal(r.ok, true);
  assert.equal(r.sha256, 'a'.repeat(64), 'Grossbuchstaben nicht normalisiert');
});

test('ein Name mit Schraegstrich wird abgelehnt', () => {
  // Waere sonst "pack.zip" in einem Unterordner - oder bei ../ ganz woanders.
  const r = validatePull(gut({ name: '../etc/passwd' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-name');
});

test('ein Name mit .. wird abgelehnt, auch ohne Schraegstrich', () => {
  assert.equal(validatePull(gut({ name: '..pack.zip' })).ok, false);
});

test('ein versteckter Name (Punkt am Anfang) wird abgelehnt', () => {
  // .bashrc, .ssh - ein Name, der mit Punkt beginnt, ist nichts, was ein
  // Modpack heisst, und darf nicht in Sonderbehandlung rutschen.
  assert.equal(validatePull(gut({ name: '.bashrc' })).reason, 'bad-name');
});

test('ein Name mit Nullbyte wird abgelehnt', () => {
  // Wird im Dateisystem abgeschnitten: geprueft waere "pack.zip\0.exe",
  // geschrieben "pack.zip". Genau so umgeht man Pruefungen.
  assert.equal(validatePull(gut({ name: 'pack.zip\u0000.exe' })).reason, 'bad-name');
});

test('ein Name mit Zeilenumbruch wird abgelehnt', () => {
  assert.equal(validatePull(gut({ name: 'pack\n.zip' })).reason, 'bad-name');
});

test('ein leerer oder zu langer Name wird abgelehnt', () => {
  assert.equal(validatePull(gut({ name: '' })).ok, false);
  assert.equal(validatePull(gut({ name: 'x'.repeat(201) })).ok, false);
});

test('das Ziel kommt NIE aus dem Befehl', () => {
  // Auch ein Feld "ziel" im Befehl darf nichts bewirken. Sonst waere die
  // ganze Namenspruefung umgehbar.
  const r = validatePull(gut({ ziel: '/etc/passwd' }));
  assert.equal(r.ok, true);
  assert.equal(r.ziel, `${ZIEL_WURZEL}/pack.zip`, 'ein mitgeschicktes Ziel wurde uebernommen');
});

test('eine unbrauchbare Kennung wird abgelehnt', () => {
  for (const id of ['', 'ABC', '../x', 'a'.repeat(65), 'zzzz1234', 12345, null]) {
    assert.equal(validatePull(gut({ id })).ok, false, `Kennung akzeptiert: ${JSON.stringify(id)}`);
  }
});

test('eine unbrauchbare Groesse wird abgelehnt', () => {
  for (const gesamt of [0, -1, 1.5, '1024', null, undefined, MAX_PULL_BYTES + 1]) {
    assert.equal(validatePull(gut({ gesamt })).ok, false, `Groesse akzeptiert: ${JSON.stringify(gesamt)}`);
  }
});

test('eine unbrauchbare Pruefsumme wird abgelehnt', () => {
  // Ohne Pruefsumme gaebe es keine Moeglichkeit zu merken, dass eine ZIP
  // unterwegs kaputtgegangen ist - und eine kaputte ZIP installiert sich.
  for (const sha256 of ['', 'abc', 'z'.repeat(64), 'a'.repeat(63), null, 123]) {
    assert.equal(validatePull(gut({ sha256 })).ok, false, `Pruefsumme akzeptiert: ${JSON.stringify(sha256)}`);
  }
});

test('etwas, das kein pull ist, wird abgelehnt', () => {
  assert.equal(validatePull({ ...gut(), type: 'command' }).ok, false);
  assert.equal(validatePull(null).ok, false);
  assert.equal(validatePull('pull').ok, false);
});

// --- Der Verteiler: kommt der pull-Befehl ueberhaupt an? -------------------
//
// Der Fehler vom 2026-11-09 auf der VM: der Agent verwarf jeden pull-Befehl
// als "Stueck mit unmoeglicher Laenge". Ursache: die Pruefung lautete
// "istBinaer || Buffer.isBuffer(data)" - und 'ws' liefert JEDE Nachricht als
// Buffer, auch JSON. Buffer.isBuffer ist damit immer true, das Flag war die
// einzige verlaessliche Auskunft, wurde aber nicht allein benutzt.
//
// Der Test prueft deshalb den QUELLTEXT des Verteilers, nicht nur die
// Hilfsfunktion: die Luecke war genau zwischen beiden.

import { readFile } from 'node:fs/promises';

test('der Verteiler prueft nur istBinaer, nicht Buffer.isBuffer', async () => {
  const quelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

  // Der Zweig, der Stuecke behandelt, darf Buffer.isBuffer NICHT als
  // zusaetzliche Bedingung enthalten - sonst schluckt er jede JSON-Nachricht.
  // Nicht mehr "if (...) { await nimmDateistueck" - seit 1.5.2 steht die
  // Warteschlange dazwischen. Der Zweck ist derselbe: die BEDINGUNG darf nur
  // istBinaer sein, sonst schluckt der Zweig jede JSON-Nachricht.
  const zeilen = quelle.split('\n');
  const von = zeilen.findIndex((z) => z.trim() === 'if (istBinaer) {');
  assert.ok(von >= 0, 'der Verteiler-Zweig fuer Stuecke wurde nicht gefunden');
  const bis = zeilen.findIndex((z, i) => i > von && z.trim() === 'return;');
  const zweig = zeilen.slice(von, bis).join('\n');
  assert.match(zweig, /nimmDateistueck/, 'der Zweig ruft nimmDateistueck nicht auf');

});

test('der pull-Befehl wird VOR validateCommand behandelt', async () => {
  const quelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const pullStelle = quelle.indexOf("msg.type === 'pull'");
  const cmdStelle = quelle.indexOf('validateCommand(msg)');
  assert.ok(pullStelle > 0, 'pull wird im Verteiler nicht behandelt');
  assert.ok(
    pullStelle < cmdStelle,
    'pull wird erst nach validateCommand geprueft - validateCommand kennt pull nicht und lehnt es ab',
  );
});

test('der Binaer-Zweig steht VOR dem JSON-Parse', async () => {
  const quelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const binaerStelle = quelle.indexOf('await nimmDateistueck');
  const parseStelle = quelle.indexOf('JSON.parse(String(data))');
  assert.ok(
    binaerStelle < parseStelle,
    'das Stueck wird erst nach dem JSON-Parse behandelt - eine ZIP als JSON zu parsen wirft',
  );
});
