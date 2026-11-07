// Test: keine ASCII-Ersatzschreibweisen in SICHTBAREN Texten (2026-11-07).
//
// Hintergrund: Im Panel standen Woerter wie "Neoforge-Version pruefen",
// "Server laeuft", "Eintraege", "aeltere werden danach geloescht", "Loeschen",
// "Spaeter". Die Dateien waren korrekt UTF-8 kodiert - es standen einfach
// ae/oe/ue im Text. Einzelne Stellen von Hand zu suchen hat zwei Runden
// gedauert; dieser Test sucht systematisch.
//
// Abgrenzung: Kommentare (//  *  /*  <!--) bleiben ASCII - dort ist das
// Absicht und niemand sieht es. Der Test prueft nur gerenderten Text:
// HTML-Textknoten und String-Literale in app.js.
//
// Bekannte Ausnahmen: Woerter, in denen ae/oe/ue zufaellig vorkommt und
// richtig ist (neue, Quelle, aktuell, zuerst, ...).

import { test, assert } from './_fixtures.mjs';
import { readFile } from 'node:fs/promises';

// Woerter, die ohne Umlaut korrekt sind (Substring-Treffer ausschliessen).
const ERLAUBT = [
  'neue', 'neuen', 'neuer', 'neues', 'neuem', 'neueste', 'neuere',
  'quelle', 'quellen', 'quelle', 'aktuell', 'aktuelle', 'aktuelles',
  'zuerst', 'dauern', 'dauer', 'virtueller', 'manuell',
  'segue', 'segou', 'queue', 'true', 'false', 'value', 'source',
  'request', 'require', 'unique', 'continue', 'issue', 'guess', 'guest',
];

// Die typischen deutschen Ersatzschreibweisen. Bewusst eine Liste von
// Wortstaemmen statt einer Heuristik - so gibt es keine Fehlalarme bei
// Bezeichnern wie `querySelector`, `cfQuery` oder `menuErrors`.
const VERDACHT = [
  'aeltere', 'aender', 'Aender', 'Empfaenger', 'geprueft', 'Geprueft',
  'geloesch', 'loesch', 'Loesch', 'Verfuegbar', 'verfuegbar',
  'unveraendert', 'vorausgewaehlt', 'gewaehlt', 'gueltig', 'zurueckgesetzt',
  'Bloecke', 'Eintraege', 'Flaechen', 'Flaeche', 'Grundflaeche', 'Kaesten',
  'Menues', 'Oeffnen', 'hochfaehrt', 'koennen', 'ueber', 'fuer', 'gruen',
  'pruefen', 'laeuft', 'Spaeter', 'drueckt', 'waehlen', 'moeglich',
];

function istKommentarZeile(zeile) {
  const s = zeile.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')
    || s.startsWith('<!--') || s.endsWith('-->')
    // Zeilen AUSSERHALB eines CSS/HTML-Kommentarblocks enden nicht mit */,
    // mittlere Zeilen eines Blocks auch nicht - deshalb merken wir uns den
    // Zustand (siehe findeVerstoesse).
    || s.endsWith('*/');
}

// In JS nur String-Literale pruefen: '...', "...", `...`
function jsSichtbarerText(zeile) {
  const teile = [];
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(zeile)) !== null) teile.push(m[2]);
  return teile.join(' ');
}

// In HTML: Textknoten (ausserhalb von <...>) und Attributwerte wie
// placeholder="...", title="..."
function htmlSichtbarerText(zeile) {
  const ohneTags = zeile.replace(/<[^>]*>/g, ' ');
  const attrs = [];
  const re = /(?:placeholder|title|alt|aria-label)="([^"]*)"/g;
  let m;
  while ((m = re.exec(zeile)) !== null) attrs.push(m[1]);
  return ohneTags + ' ' + attrs.join(' ');
}

function findeVerstoesse(quelle, sichtbarFn) {
  const treffer = [];
  let imBlock = false;   // CSS/HTML-Kommentarblock offen?
  quelle.split('\n').forEach((zeile, i) => {
    const s = zeile.trim();
    // Blockzustand führen: /* ... */ ueber mehrere Zeilen, <!-- ... -->
    if (!imBlock && (s.startsWith('/*') || s.startsWith('<!--'))) {
      imBlock = !(s.includes('*/') || s.includes('-->'));
      return;
    }
    if (imBlock) {
      if (s.includes('*/') || s.includes('-->')) imBlock = false;
      return;
    }
    if (istKommentarZeile(zeile)) return;
    const text = sichtbarFn(zeile);
    if (!text.trim()) return;
    for (const wort of VERDACHT) {
      const re = new RegExp(`\\b${wort}`, 'i');
      if (re.test(text)) {
        treffer.push(`${i + 1}: "${wort}" in: ${text.trim().slice(0, 90)}`);
        break;
      }
    }
  });
  return treffer;
}

test('app.js: sichtbare Texte benutzen Umlaute, keine ae/oe/ue-Ersatzformen', async () => {
  const q = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const treffer = findeVerstoesse(q, jsSichtbarerText);
  assert.deepEqual(treffer, [],
    'In sichtbaren Texten von app.js stehen ASCII-Ersatzformen statt Umlauten:\n'
    + treffer.join('\n'));
});

test('app.html: sichtbare Texte benutzen Umlaute, keine ae/oe/ue-Ersatzformen', async () => {
  const q = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  const treffer = findeVerstoesse(q, htmlSichtbarerText);
  assert.deepEqual(treffer, [],
    'In sichtbaren Texten von app.html stehen ASCII-Ersatzformen statt Umlauten:\n'
    + treffer.join('\n'));
});

// Die drei Seiten abseits des Hauptpanels wurden in 1.3.5 VERGESSEN - der Test
// deckte nur app.js und app.html ab, und prompt stand in login.js noch
// "E-Mail-Adresse fuer den Reset-Link" und in reset.js "Kein gueltiger Link",
// "Die Passwoerter stimmen nicht ueberein", "Zurueck zum Login".
// Deshalb hier alle vier Dateien nacheinander, mit derselben Pruefung.
for (const [datei, sichtbar] of [
  ['login.js', jsSichtbarerText],
  ['login.html', htmlSichtbarerText],
  ['reset.js', jsSichtbarerText],
  ['reset.html', htmlSichtbarerText],
]) {
  test(`${datei}: sichtbare Texte benutzen Umlaute`, async () => {
    const q = await readFile(new URL(`../public/${datei}`, import.meta.url), 'utf8');
    const treffer = findeVerstoesse(q, sichtbar);
    assert.deepEqual(treffer, [],
      `In sichtbaren Texten von ${datei} stehen ASCII-Ersatzformen statt Umlauten:\n`
      + treffer.join('\n'));
  });
}

test('Alle vier Frontend-Dateien sind sauber UTF-8', async () => {
  for (const name of ['app.js', 'app.html', 'login.js', 'login.html', 'reset.js', 'reset.html']) {
    const buf = await readFile(new URL(`../public/${name}`, import.meta.url));
    const alsUtf8 = buf.toString('utf8');
    assert.equal(alsUtf8.includes('\uFFFD'), false,
      `${name} enthaelt Ersatzzeichen (U+FFFD) - die Datei ist nicht sauber UTF-8`);
    assert.equal(/Ã[¤¶¼Ÿ]/.test(alsUtf8), false,
      `${name} enthaelt doppelt kodierte Umlaute (z.B. "Ã¤" statt "ä")`);
  }
});

// --- Backend-Meldungen --------------------------------------------------------
//
// Die Meldungen aus app/*.js landen im Panel (error-JSON) oder im Live-Log
// (log('[praefix] ...')). Sie sind also sichtbar - und standen am 2026-11-07
// noch in 20 Dateien mit ae/oe/ue ("Ungueltige E-Mail-Adresse",
// "Der letzte Superuser kann nicht geloescht werden", "Eintraege ersetzt").
//
// Geprueft werden nur String-Literale. Kommentare (// * /*) bleiben ASCII.
// Ausgenommen sind ausserdem Bezeichner-artige Werte (Pfade, Keys, true/false)
// - erkennbar daran, dass sie kuerzer als 8 Zeichen sind oder nur aus
// [a-z0-9_.-/] bestehen.

const BACKEND_VERDACHT = [
  'Ungueltig', 'ungueltig', 'gueltig', 'Empfaenger', 'Pruefung', 'pruefung',
  'uebergeben', 'uebernommen', 'uebersprungen', 'Aufraeumen', 'aufgeraeumt',
  'Geschuetz', 'geschuetz', 'Eintraege', 'enthaelt', 'Enthaelt',
  'unveraendert', 'unveraenderlich', 'geaendert', 'aendern', 'aendert',
  'geloescht', 'Geloescht', 'loeschen', 'Loesch', 'bestaetigt', 'geprueft',
  'Geprueft', 'pruefen', 'laeuft', 'Laeuft', 'verfuegbar', 'zurueck',
  'noetig', 'ausgefuehrt', 'Eigentuemer', 'waere', 'koennen', 'koennte',
  'moeglich', 'spaeter', 'ausserhalb', 'Schluessel', 'Zeilenumbrueche',
];

function backendVerstoesse(quelle) {
  const treffer = [];
  let imBlock = false;
  const STR = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  quelle.split('\n').forEach((zeile, i) => {
    const s = zeile.trim();
    if (!imBlock && (s.startsWith('/*') || s.startsWith('<!--'))) {
      imBlock = !(s.includes('*/') || s.includes('-->'));
      return;
    }
    if (imBlock) {
      if (s.includes('*/') || s.includes('-->')) imBlock = false;
      return;
    }
    if (s.startsWith('//') || s.startsWith('*')) return;
    let m;
    STR.lastIndex = 0;
    while ((m = STR.exec(zeile)) !== null) {
      const txt = m[2];
      if (txt.length < 8) continue;
      if (/^[a-z0-9_.\-/]+$/.test(txt)) continue;   // Pfad, Key, Bezeichner
      for (const wort of BACKEND_VERDACHT) {
        if (txt.includes(wort)) {
          treffer.push(`${i + 1}: "${wort}" in: ${txt.slice(0, 90)}`);
          break;
        }
      }
    }
  });
  return treffer;
}

import { readdir } from 'node:fs/promises';

test('app/*.js: Meldungen und Log-Zeilen benutzen Umlaute', async () => {
  const dir = new URL('../app/', import.meta.url);
  const dateien = (await readdir(dir)).filter((n) => n.endsWith('.js')).sort();
  const alle = [];
  for (const name of dateien) {
    const q = await readFile(new URL(name, dir), 'utf8');
    for (const t of backendVerstoesse(q)) alle.push(`${name}:${t}`);
  }
  assert.deepEqual(alle, [],
    'In Meldungen/Log-Zeilen des Backends stehen ASCII-Ersatzformen statt '
    + 'Umlauten:\n' + alle.join('\n'));
});
