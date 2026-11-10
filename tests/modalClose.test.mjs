// Jedes Fenster im Panel muss zu schliessen sein (2026-11-10).
//
// Felix sah das Uebernehmen-Fenster ohne Schliessen-Kreuz. Der Fehler war
// nicht "ein Knopf fehlt", sondern "niemand hat je geprueft, ob ein Fenster
// wieder zugeht". Diese Tests pruefen das fuer ALLE Fenster, nicht nur eins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wurzel = new URL('../', import.meta.url);
const html = await readFile(new URL('public/app.html', wurzel), 'utf8');
const js = await readFile(new URL('public/app.js', wurzel), 'utf8');

// Alle Fenster mit ihrer id.
function modale() {
  return [...html.matchAll(/<div class="modal" id="(\w+)"/g)].map((m) => m[1]);
}

// Der HTML-Block eines Fensters (bis zum naechsten Fenster).
function block(id) {
  const start = html.indexOf(`<div class="modal" id="${id}"`);
  const rest = html.slice(start + 10);
  const ende = rest.indexOf('<div class="modal" id=');
  return ende > 0 ? rest.slice(0, ende) : rest;
}

test('es gibt ueberhaupt Fenster', () => {
  assert.ok(modale().length >= 10, `nur ${modale().length} Fenster gefunden`);
});

test('JEDES Fenster hat ein Schliessen-Kreuz', () => {
  const ohne = modale().filter((id) => !block(id).includes(`id="${id}X"`));
  assert.deepEqual(ohne, [],
    `ohne Schliessen-Kreuz: ${ohne.join(', ')}`);
});

test('das Kreuz steht VOR dem Inhalt (Tastatur erreicht es zuerst)', () => {
  // Sonst muss man sich durch ein langes Formular tabben, um zu schliessen.
  for (const id of modale()) {
    const b = block(id);
    const posX = b.indexOf(`id="${id}X"`);
    const posH3 = b.indexOf('<h3');
    assert.ok(posX > 0, `${id}: kein Kreuz`);
    assert.ok(posX < posH3 || posH3 < 0,
      `${id}: das Kreuz steht nach der Ueberschrift`);
  }
});

test('das Kreuz traegt eine Beschriftung fuer Vorleser', () => {
  // Ein "&times;" wird von einer Sprachausgabe als "mal" vorgelesen.
  for (const id of modale()) {
    const b = block(id);
    const knopf = b.slice(b.indexOf(`id="${id}X"`) - 60, b.indexOf(`id="${id}X"`) + 90);
    assert.match(knopf, /aria-label="[^"]+"/, `${id}: aria-label fehlt`);
  }
});

test('kein onclick am Kreuz (CSP erlaubt nur \'self\')', () => {
  assert.ok(!/<button[^>]*modal-x[^>]*onclick/.test(html),
    'Inline-Handler am Kreuz - der Browser wuerde ihn blocken');
});

test('das CSS gibt dem Fenster position:relative und dem Kreuz absolute', () => {
  // Ohne relative landet das Kreuz am Bildschirmrand, nicht am Fenster.
  assert.match(html, /\.modal \.box \{[^}]*position:\s*relative/,
    '.modal .box braucht position:relative');
  assert.match(html, /\.modal-x \{[^}]*position:\s*absolute/,
    '.modal-x braucht position:absolute');
});

test('die Fenster werden automatisch verdrahtet (nicht einzeln aufgezaehlt)', () => {
  // Eine Liste "adoptModalX, updateModalX, ..." haette denselben Fehler beim
  // naechsten Fenster wieder. Deshalb eine Schleife ueber alle .modal.
  assert.match(js, /querySelectorAll\('\.modal'\)/,
    'die Kreuze muessen in einer Schleife ueber alle .modal verdrahtet werden');
  assert.match(js, /modal\.classList\.remove\('open'\)/);
});

test('Escape schliesst ein offenes Fenster', () => {
  assert.match(js, /e\.key !== 'Escape'/);
  assert.match(js, /querySelector\('\.modal\.open'\)/);
});

test('ein Klick auf den Rand schliesst, einer im Fenster nicht', () => {
  // e.target === modal: ein Klick auf ein Feld im Fenster sprudelt hierher.
  assert.match(js, /e\.target === modal/, 'ohne diese Pruefung schliesst jeder Klick im Fenster');
});
