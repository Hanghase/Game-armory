// Panel-Tests fuer das Uebernehmen (Karte 28).
//
// Diese Tests lesen Quelltexte, sie fuehren die Oberflaeche nicht aus. Das
// ist hier die richtige Ebene: was ein Browser zeigt, kann ein node-Test
// nicht sehen - aber ob Knopf, Feld und Route dieselben NAMEN benutzen, schon.
// Genau daran sind am 2026-11-09 vier Fehler gescheitert.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wurzel = new URL('../', import.meta.url);
const html = await readFile(new URL('public/app.html', wurzel), 'utf8');
const js = await readFile(new URL('public/app.js', wurzel), 'utf8');
const route = await readFile(new URL('app/adoptroutes.js', wurzel), 'utf8');

// --- Der Knopf -----------------------------------------------------------

test('es gibt einen Uebernehmen-Knopf im HTML', () => {
  assert.match(html, /id="adoptBtn"/, 'der Knopf fehlt');
});

test('das Menue erscheint nur mit sword.create', () => {
  // Der Server prueft dasselbe Recht. Das hier ist nur, damit niemand ein
  // Menue sieht, das beim Klick 403 gibt.
  const stelle = js.slice(js.indexOf("if (can('sword.create'))"));
  assert.match(stelle.slice(0, 400), /newMenu/,
    'der Menue-Wrapper muss innerhalb der sword.create-Pruefung sichtbar werden');
});

test('beide Wege stehen im Menue, keiner ist ein toter Eintrag', () => {
  // "Neu bauen" und "Bestehenden uebernehmen" unter einem Knopf (2026-11-10).
  // Beide muessen im selben .menu-list stehen UND im JS verdrahtet sein -
  // ein Eintrag ohne Handler sieht klickbar aus und tut nichts.
  const menue = html.slice(html.indexOf('id="newMenu"'));
  const liste = menue.slice(0, menue.indexOf('</div>\n    </div>'));
  assert.match(liste, /id="newRackBtn"/, 'Neu bauen fehlt im Menue');
  assert.match(liste, /id="adoptBtn"/, 'Uebernehmen fehlt im Menue');

  assert.match(js, /getElementById\('newRackBtn'\)[\s\S]{0,120}addEventListener/,
    'Neu bauen hat keinen Klick-Handler');
  assert.match(js, /getElementById\('adoptBtn'\)[\s\S]{0,160}addEventListener/,
    'Uebernehmen hat keinen Klick-Handler');
});

test('das Menue klappt auf und wieder zu', () => {
  assert.match(js, /initNewMenu/, 'die Menue-Logik fehlt');
  assert.match(js, /wrap\.classList\.toggle\('open'/,
    'das Aufklappen muss ueber die Klasse open laufen');
  assert.match(js, /!wrap\.contains\(ev\.target\)/,
    'ein Klick daneben muss schliessen');
});

test('der Server verlangt sword.create fuer alle drei Wege', () => {
  const treffer = route.match(/requirePerm\('sword\.create'\)/g) || [];
  assert.ok(treffer.length >= 3,
    `erwartet 3x sword.create (kandidaten, vorschau, adopt), gefunden: ${treffer.length}`);
});

// --- Kein Inline-JavaScript (CSP) ----------------------------------------

test('das Modal benutzt kein onclick (CSP verbietet Inline-Skript)', () => {
  // server.js:63 setzt scriptSrc: ["'self'"] ohne unsafe-inline. Ein onclick
  // im HTML waere dort eine stille Blockade - der Knopf taete nichts.
  const modal = html.slice(html.indexOf('id="adoptModal"'));
  const ausschnitt = modal.slice(0, modal.indexOf('id="updateModal"'));
  assert.ok(!/on(click|change|input|submit)\s*=/.test(ausschnitt),
    'im Uebernehmen-Modal steht ein Inline-Handler - die CSP blockt ihn');
});

test('alle Handler werden per addEventListener verdrahtet', () => {
  for (const id of ['adoptBtn', 'adoptPruefen', 'adoptUebernehmen', 'adoptAbbrechen']) {
    assert.match(js, new RegExp(`getElementById\\('${id}'\\)`),
      `kein Bezug auf ${id} in app.js`);
  }
});

// --- Die Felder ----------------------------------------------------------

test('alle vier Eingabefelder existieren im HTML und werden im JS gelesen', () => {
  const felder = ['adoptId', 'adoptRack', 'adoptPort', 'adoptVerz'];
  for (const f of felder) {
    assert.match(html, new RegExp(`id="${f}"`), `Feld ${f} fehlt im HTML`);
    assert.match(js, new RegExp(`getElementById\\('${f}'\\)`), `Feld ${f} wird im JS nie gelesen`);
  }
});

test('der Port wird als Zahl geschickt, nicht als Text', () => {
  // Number('') ist 0 - und 0 ist kein gueltiger Port. Der Server lehnt dann
  // ab, statt zu raten. Das ist gewollt, aber es muss Number() sein.
  assert.match(js, /port:\s*Number\(document\.getElementById\('adoptPort'\)\.value\)/,
    'der Port muss durch Number() gehen');
});

// --- Der Vertrag zwischen Panel und Route ---------------------------------

test('das Panel ruft genau die Routen, die es gibt', () => {
  assert.match(js, /api\('\/api\/adopt\/kandidaten'\)/, 'die Kandidaten-Route wird nicht gerufen');
  assert.match(js, /api\('\/api\/adopt\/vorschau'/, 'die Vorschau-Route wird nicht gerufen');
  assert.match(js, /api\('\/api\/adopt',/, 'die Uebernehmen-Route wird nicht gerufen');

  // Und die Route muss sie anbieten.
  assert.match(route, /'\/adopt\/kandidaten'/);
  assert.match(route, /'\/adopt\/vorschau'/);
  assert.match(route, /'\/adopt'/);
});

test('das Panel schickt kandidat, id, rackId, port, arbeitsVerzeichnis', () => {
  // Die Feldnamen muessen zu dem passen, was die Route liest. Ein Tippfehler
  // hier ergibt keinen Fehler, sondern null-Werte - und die Pruefung schlaegt
  // dann an einer Stelle an, die nichts mit der Ursache zu tun hat.
  const eingabe = js.slice(js.indexOf('function adoptEingabe'));
  for (const feld of ['kandidat', 'id', 'rackId', 'port', 'arbeitsVerzeichnis']) {
    assert.match(eingabe.slice(0, 600), new RegExp(`${feld}:`),
      `adoptEingabe() schickt ${feld} nicht`);
  }
});

test('die Route liest dieselben Felder', () => {
  // rackId und arbeitsVerzeichnis werden in bauePruefling() gelesen, nicht
  // direkt im Handler - deshalb hier beide Stellen pruefen. Ein Test, der
  // nur `body.rackId` sucht, waere rot, obwohl der Code stimmt.
  for (const feld of ['kandidat', 'port', 'logs', 'control']) {
    assert.match(route, new RegExp(`body\\.${feld}`), `die Route liest ${feld} nicht`);
  }
  const baue = route.slice(route.indexOf('function bauePruefling'));
  for (const feld of ['rackId', 'arbeitsVerzeichnis']) {
    assert.match(baue.slice(0, 800), new RegExp(`eingabe\\.${feld}`),
      `bauePruefling liest eingabe.${feld} nicht`);
  }
  // Und der Herkunftsschreiber bekommt das Verzeichnis aus dem Body.
  assert.match(route, /body\.arbeitsVerzeichnis/);
});

// --- "unbekannt" ist nicht "ok" ------------------------------------------

test('ein unbekanntes Pruefergebnis wird im Panel als Fragezeichen gezeigt', () => {
  // Drei Zeichen, nicht zwei: bestanden / unbekannt / gescheitert. Zwei
  // Zeichen wuerden "ich weiss es nicht" als "in Ordnung" darstellen.
  assert.match(js, /p\.unbekannt \? '❔'/,
    'unbekannt muss sich von ok und von gescheitert unterscheiden');
});

test('der Uebernehmen-Knopf ist erst nach bestandener Pruefung frei', () => {
  // Ein Knopf, der immer klickbar ist, verleitet zum Klicken und Hoffen.
  assert.match(js, /disabled = !adoptPruefungOk/,
    'der Knopf muss an das Pruefergebnis gebunden sein');
});

test('eine Aenderung an den Feldern macht die Pruefung ungueltig', () => {
  // Sonst koennte man nach bestandener Pruefung das Verzeichnis aendern und
  // mit dem alten "ok" eintragen.
  assert.match(js, /addEventListener\('input'/,
    'Feld-Aenderungen muessen die Pruefung zuruecksetzen');
});
