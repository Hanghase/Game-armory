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

test('Die Dateien sind UTF-8 dekodierbar (keine kaputten Sequenzen)', async () => {
  for (const name of ['app.js', 'app.html']) {
    const buf = await readFile(new URL(`../public/${name}`, import.meta.url));
    const alsUtf8 = buf.toString('utf8');
    assert.equal(alsUtf8.includes('\uFFFD'), false,
      `${name} enthaelt Ersatzzeichen (U+FFFD) - die Datei ist nicht sauber UTF-8`);
    // Doppelkodierung: "Ã¤" statt "ä"
    assert.equal(/Ã[¤¶¼Ÿ]/.test(alsUtf8), false,
      `${name} enthaelt doppelt kodierte Umlaute (z.B. "Ã¤" statt "ä")`);
  }
});
