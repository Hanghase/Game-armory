// Auf welchem Arsenal liegt dieser Sword?
//
// Felix am 2026-11-09: "aktuell sehe ich in der Sword uebersicht nicht ob ein
// Sword auf einem Arsenal liegt". Bis dahin kannte ein Sword gar kein
// Arsenal - alle lagen lokal auf der Armory. Mit dem install-Schritt entstehen
// Swords auf Arsenalen, und die Karte muss das zeigen: sonst klickt jemand
// Start und wundert sich, dass der Server auf einer anderen Maschine laeuft.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const swordsQuelle = await readFile(new URL('../app/swords.js', import.meta.url), 'utf8');
const uiQuelle = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('der Loader reicht das Arsenal-Feld durch', () => {
  // Es steht in der Sword-Datei und muss unveraendert in der Liste landen.
  assert.match(swordsQuelle, /arsenal/, 'swords.js kennt kein Arsenal-Feld');
});

test('ein Sword ohne Arsenal bleibt lokal - kein erfundenes Feld', () => {
  // Die ueberwiegende Mehrheit liegt auf der Armory. Ein 'arsenal: 0' oder
  // 'unbekannt' waere eine Luege in der Anzeige.
  const i = swordsQuelle.indexOf('sword.arsenal');
  assert.ok(i > 0, 'kein Umgang mit dem Arsenal-Feld im Loader');
});

test('die Sword-Karte zeigt das Arsenal an', () => {
  const i = uiQuelle.indexOf('function renderSwords');
  const rumpf = uiQuelle.slice(i, i + 3000);
  assert.match(rumpf, /arsenal/i, 'die Karte zeigt kein Arsenal');
});

test('ein lokaler Sword zeigt KEINEN Arsenal-Hinweis', () => {
  // Sonst steht an jeder der 15 lokalen Karten ein leeres Abzeichen, und das
  // Abzeichen verliert seine Bedeutung.
  const i = uiQuelle.indexOf('function renderSwords');
  const rumpf = uiQuelle.slice(i, i + 3000);
  // Genau die Bedingung: ${sword.arsenal ? '...' : ''}. Ein Test, der nur
  // irgendein "arsenal" im Ausschnitt sucht, bleibt auch bei
  // `${true ? ...}` gruen - und dann steht an allen 15 lokalen Karten ein
  // leeres Abzeichen. Nachgemessen mit genau dieser Mutation.
  assert.match(
    rumpf,
    /\$\{sword\.arsenal\s*\?\s*`[^`]*badge arsenal/,
    'das Abzeichen haengt nicht an sword.arsenal',
  );
});

// --- Der Name muss WIRKLICH ankommen ------------------------------------
// "Funktion gruen, Aufrufweg tot" ist der Fehler, der in diesem Projekt am
// haeufigsten war. Ein Abzeichen mit leerem Cache zeigt "Arsenal #6" - der
// Hinweis ist da, der Name fehlt, und kein Test wird rot, wenn man nur die
// Zeichenfunktion prueft.

test('reloadSwords laedt die Namen VOR dem Zeichnen', () => {
  const i = uiQuelle.indexOf('async function reloadSwords()');
  assert.ok(i > 0, 'reloadSwords fehlt');
  const rumpf = uiQuelle.slice(i, i + 400);
  assert.match(rumpf, /ladeArsenalNamen\(\)/, 'die Namen werden nicht geladen');

  const iLaden = rumpf.indexOf('ladeArsenalNamen()');
  const iApi = rumpf.indexOf("api('/api/swords')");
  assert.ok(iApi > 0, 'Sword-Liste wird nicht geladen');
  assert.ok(iLaden < iApi, 'die Namen werden erst nach der Liste geladen');
});

test('die Namensliste wird beim Laden geleert (kein Altstand)', () => {
  // Sonst bleibt ein geloeschtes Arsenal als Name stehen und ein neues
  // Arsenal mit derselben ID traegt den alten Namen.
  const i = uiQuelle.indexOf('async function ladeArsenalNamen()');
  const rumpf = uiQuelle.slice(i, i + 500);
  assert.match(rumpf, /arsenalNamen\.clear\(\)/, 'die Namensliste wird nie geleert');
});

test('ein unbekannter Name faellt auf die Kennung zurueck, nicht auf leer', () => {
  const i = uiQuelle.indexOf('function arsenalLabel');
  const rumpf = uiQuelle.slice(i, i + 300);
  assert.match(rumpf, /Arsenal #\$\{id\}/, 'kein Rueckfall auf die Kennung');
});

test('die Abzeichen-Klasse ist im Stylesheet vorhanden', async () => {
  // Ein span ohne Styling ist unsichtbarer Text - der Hinweis waere da, aber
  // niemand saehe ihn. Genau das war Felix' Beschwerde.
  //
  // Das CSS steht INLINE in public/app.html, es gibt keine eigene .css-Datei.
  // Der erste Anlauf las public/style.css, fand nichts, und der Test war
  // dadurch GRUEN OHNE ZU PRUEFEN (if (!css) return). Ein Test, der bei
  // fehlender Datei stillschweigend besteht, ist kein Test.
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.match(html, /\.badge\.arsenal/, '.badge.arsenal fehlt im Stylesheet (app.html)');
});
