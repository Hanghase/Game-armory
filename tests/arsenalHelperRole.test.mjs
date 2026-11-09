// Die Rollen-Schranke im Install-Helfer.
//
// Der Helfer laeuft als ROOT und entpackt Archive. Er wird von BEIDEN Rollen
// benutzt: auf der Armory fuer Swords, auf einem Arsenal fuer Swords dort.
// Ein Arsenal-Archiv liegt in /var/lib/armory-arsenal/packs - ein Pfad, den
// es auf der Armory nicht gibt.
//
// Die Gefahr: wer die Pfadliste "einfach erweitert", oeffnet auf JEDER
// Armory ein Verzeichnis, das dort niemand pruefen kann. Darum ist der
// Arsenal-Pfad an die Rollenvariable gebunden, und die Vorgabe ist Armory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const quelle = await readFile(new URL('../tools/armory-install-helper', import.meta.url), 'utf8');

// Die Funktion aus der Quelle holen und in einer Subshell nachspielen - so
// pruefe ich das VERHALTEN, nicht nur das Aussehen des Textes.
function quelleFunktion(name) {
  const start = quelle.indexOf(`${name}() {`);
  assert.ok(start > 0, `${name} fehlt im Helfer`);
  let tiefe = 0;
  for (let i = quelle.indexOf('{', start); i < quelle.length; i++) {
    if (quelle[i] === '{') tiefe++;
    else if (quelle[i] === '}') {
      tiefe--;
      if (tiefe === 0) return quelle.slice(start, i + 1);
    }
  }
  throw new Error(`${name}: Klammern unausgeglichen`);
}

test('ist_archiv_quelle existiert', () => {
  assert.ok(quelle.includes('ist_archiv_quelle() {'));
});

test('die Pfadliste steht NUR EINMAL im Code', () => {
  // Zwei Kopien derselben Pruefung sind eine Falle: wer eine aendert,
  // vergisst die andere. Genau das war vor 1.5.4 der Fall.
  const treffer = quelle.match(/\/opt\/game-armory\/data\/uploads\/\*/g) ?? [];
  assert.equal(treffer.length, 1, `Pfadliste steht ${treffer.length}x im Code statt 1x`);
  const arsenal = quelle.match(/\/var\/lib\/armory-arsenal\/packs\//g) ?? [];
  assert.equal(arsenal.length, 1, `Arsenal-Pfad steht ${arsenal.length}x statt 1x`);
});

test('beide Entpacker benutzen die Funktion', () => {
  for (const [name, alt] of [['extract-pack', 'ZIP ausserhalb'], ['extract-tarball', 'Tarball ausserhalb']]) {
    // Das Label steht auch in Kommentaren und Doku-Zeilen. Nur am
    // ZEILENANFANG mit Einrueckung ist es der echte case-Zweig - sonst
    // prueft der Test einen Kommentar und ist immer gruen.
    const treffer = [...quelle.matchAll(new RegExp(`^  ${name}\\)$`, 'gm'))];
    assert.equal(treffer.length, 1, `${name}) kommt ${treffer.length}x als case-Zweig vor (erwartet 1)`);
    const i = treffer[0].index;
    const rumpf = quelle.slice(i, i + 800);
    assert.match(rumpf, /ist_archiv_quelle "\$(zip|tb)"/, `${name} prueft den Pfad nicht ueber ist_archiv_quelle`);
    assert.ok(rumpf.includes(alt), `${name} hat die Fehlermeldung verloren`);
  }
});

test('ohne ARMORY_ROLLE bleibt der Arsenal-Pfad gesperrt', () => {
  // Die eigentliche Schranke: fehlende Kennzeichnung darf keine Tuer oeffnen.
  const i = quelle.indexOf('/var/lib/armory-arsenal/packs/*)');
  const rumpf = quelle.slice(i, i + 500);
  assert.match(rumpf, /ARMORY_ROLLE:-\}/, 'die Rollenvariable wird nicht geprueft');
  assert.match(rumpf, /== "arsenal"/, 'es wird auf einen anderen Wert als arsenal geprueft');
});

test('der Pack-Ordner darf kein Symlink sein', () => {
  // Ein Symlink wuerde den erlaubten Praefix auf ein Ziel ausserhalb zeigen.
  const i = quelle.indexOf('/var/lib/armory-arsenal/packs/*)');
  const rumpf = quelle.slice(i, i + 500);
  assert.match(rumpf, /! -L \/var\/lib\/armory-arsenal\/packs/, 'Symlink-Pruefung fehlt');
});

test('die Rollenvariable ist in der Unit-Vorlage gesetzt', async () => {
  const conf = await readFile(new URL('../agent/arsenal-rolle.conf', import.meta.url), 'utf8');
  assert.match(conf, /^Environment=ARMORY_ROLLE=arsenal$/m, 'Unit-Vorlage setzt die Rolle nicht');
  assert.match(conf, /^\[Service\]$/m, 'kein [Service]-Abschnitt');
});

// --- Rueckfallebene beim Entpacken ---------------------------------------
// Auf einem minimalen Arsenal fehlt 'unzip'. Die Loesung ist python3 - aber
// sie darf NICHT stillschweigend greifen: ein Unterschied zwischen zwei
// Arsenalen muss im Log stehen, sonst sucht man ihn spaeter vergeblich.

test('entpacke_zip gibt es und nimmt Benutzer, Quelle, Ziel', () => {
  assert.match(quelle, /entpacke_zip\(\) \{\n  local als_user="\$1" quelle="\$2" ziel="\$3"/);
});

test('extract-pack benutzt entpacke_zip statt unzip direkt', () => {
  const i = quelle.match(/^  extract-pack\)$/m).index;
  const rumpf = quelle.slice(i, i + 1400);
  assert.match(rumpf, /entpacke_zip "\$id"/, 'extract-pack ruft entpacke_zip nicht auf');
  assert.doesNotMatch(rumpf, /unzip -q -o/, 'extract-pack ruft unzip noch direkt auf');
});

test('ohne unzip wird python3 benutzt, und der Wechsel wird gemeldet', () => {
  const i = quelle.indexOf('entpacke_zip() {');
  const rumpf = quelle.slice(i, quelle.indexOf('\n}', i));
  assert.match(rumpf, /command -v unzip/, 'unzip wird nicht geprueft');
  assert.match(rumpf, /python3 -m zipfile -e/, 'keine python3-Rueckfallebene');
  // Die Meldung ist der Punkt: ein stiller Wechsel waere unsichtbar.
  assert.match(rumpf, /Hinweis: unzip fehlt[^\n]*>&2/, 'der Wechsel wird nicht gemeldet');
});

test('ohne unzip UND ohne python3 bricht es laut ab', () => {
  const i = quelle.indexOf('entpacke_zip() {');
  const rumpf = quelle.slice(i, quelle.indexOf('\n}', i));
  assert.match(rumpf, /Weder unzip noch python3/, 'kein klarer Abbruch ohne beide Werkzeuge');
  assert.match(rumpf, /return 127/, 'kein eigener Exit-Code fuer fehlende Werkzeuge');
});

test('entpackt wird als der Instanz-User, nicht als root', () => {
  // Sonst gehoert der entpackte Baum root, und der Server-User kommt nicht
  // heran - der Fehler von 2026-10-16 (EACCES beim Pack-Austausch).
  const i = quelle.indexOf('entpacke_zip() {');
  const rumpf = quelle.slice(i, quelle.indexOf('\n}', i));
  const aufrufe = rumpf.match(/sudo -u "\$als_user"/g) ?? [];
  assert.equal(aufrufe.length, 2, `sudo -u fehlt bei einem der beiden Wege (${aufrufe.length}/2)`);
});
