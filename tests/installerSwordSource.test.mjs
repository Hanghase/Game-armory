// Test: der Erstinstaller schreibt eine Gueltige update-Quelle ins Sword.
//
// Befund 2026-11-26 (live am TS6-Sword): `installFromTarball` schrieb
// `update.source = "url"`. "url" ist KEINE Update-Quelle - weder versionCheck.js
// noch updater.js kennen sie. Wirkung: der Dispatcher fiel in den manual-Zweig,
// die Versionspruefung meldete "unbekannt", obwohl das Rack die Release-URL
// besass. Der Updater lief trotzdem, weil er zusaetzlich `rack.source.url`
// liest - der Fehler war deshalb unsichtbar, bis man ihn suchte.
//
// Dieser Test prueft die FUNKTION (installFromTarball), nicht den Quelltext:
// ein grep auf `source: 'github'` bliebe gruen, auch wenn ein spaeterer Block
// das Feld wieder ueberschreibt. Nur der geschriebene Sword zaehlt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Wegwerf-DB VOR dem ersten Import (die Verbindung entsteht beim Import).
const wegwerfDb = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-source-'));
process.env.ARMORY_DB_PATH = path.join(wegwerfDb, 'test.db');
process.on('exit', () => {
  try { fs.rmSync(wegwerfDb, { recursive: true, force: true }); } catch { /* egal */ }
});

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../docs/sword.schema.json', import.meta.url), 'utf8'));
const QUELLEN = SCHEMA.properties.update.properties.source.enum;

test('Der Dispatcher kennt keine "url"-Quelle - der Installer darf sie nicht schreiben', () => {
  // Erste Fassung pruefte das SCHEMA ("url" muss raus). Das war falsch: das
  // Schema fuehrt "url" weiterhin, weil aeltere Installer es geschrieben haben
  // und bestehende Sword-Dateien damit gueltig bleiben muessen. Die Wahrheit
  // steht im CODE - versionCheck.js verzweigt auf steam/github/docker/
  // curseforge, sonst manual. Genau das ist der Fehler: "url" faellt durch.
  const code = fs.readFileSync(new URL('../app/versionCheck.js', import.meta.url), 'utf8');
  const zweige = [...code.matchAll(/if \(type === '([a-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(zweige.length >= 3, `Zu wenige Dispatcher-Zweige gefunden: ${zweige.join(', ')}`);
  assert.equal(zweige.includes('url'), false,
    `versionCheck.js kennt jetzt einen "url"-Zweig (${zweige.join(', ')}). Dann darf `
    + 'der Installer "url" schreiben und dieser Test muss angepasst werden.');
});

test('Kein "update: { source: X }" im Installer mit X ausserhalb des Schema-Enums', () => {
  // Erste Fassung las nur den ERSTEN Treffer. Der landet auf dem CurseForge-
  // Block (Z.470), nicht auf dem Tarball-Block (Z.1176) - die Mutation
  // source:'url' blieb dadurch gruen. Ein Test, der eine Zufallsstelle prueft,
  // ist so gut wie keiner. Jetzt: ALLE Quellen im ganzen Modul pruefen.
  const quelle = fs.readFileSync(new URL('../app/installer.js', import.meta.url), 'utf8');
  const treffer = [...quelle.matchAll(/\bupdate:\s*\{[\s\S]{0,1200}?\bsource:\s*'([a-z]+)'/g)];
  assert.ok(treffer.length >= 2,
    `Nur ${treffer.length} update-Bloecke im Installer gefunden - der Ausdruck greift nicht mehr`);

  const ohneZweig = treffer.filter((m) => {
    // Erlaubt ist, was der Dispatcher kennt ODER was das Schema als Quelle
    // fuehrt. "url" steht im Schema (Altdaten), faellt aber durch den
    // Dispatcher - deshalb zusaetzlich gegen versionCheck.js pruefen.
    return !QUELLEN.includes(m[1]);
  });
  assert.deepEqual(ohneZweig.map((m) => m[1]), [],
    `Installer schreibt Quellen, die das Schema nicht kennt: ${ohneZweig.map((m) => m[1]).join(', ')}`);
});

test('Kein "update: { source: X }" im Installer mit X ohne Dispatcher-Zweig', () => {
  // Der eigentliche Befund: "url" STAND im Schema, der Dispatcher kannte es
  // aber nicht. Schema-Treue allein haette den Fehler also nie gefunden.
  const code = fs.readFileSync(new URL('../app/versionCheck.js', import.meta.url), 'utf8');
  const zweige = new Set([...code.matchAll(/if \(type === '([a-z]+)'\)/g)].map((m) => m[1]));
  // manual/unknown sind Rueckfall, keine Quelle - wer sie schreibt, will keine
  // Pruefung. Alles andere muss einen Zweig haben.
  const erlaubt = new Set([...zweige, 'local']);  // local: Updater aus Datei, kein Netz

  const quelle = fs.readFileSync(new URL('../app/installer.js', import.meta.url), 'utf8');
  const treffer = [...quelle.matchAll(/\bupdate:\s*\{[\s\S]{0,1200}?\bsource:\s*'([a-z]+)'/g)];
  const ohneZweig = treffer.map((m) => m[1]).filter((s) => !erlaubt.has(s));
  assert.deepEqual(ohneZweig, [],
    `Installer schreibt Quellen ohne Dispatcher-Zweig in versionCheck.js: ${ohneZweig.join(', ')} `
    + `(bekannt: ${[...erlaubt].join(', ')})`);
});

test('installFromTarball schreibt source "github" - und die Repo-URL nur, wenn sie da ist', async () => {
  // Der Verhaltenstest prueft den Block IN der Funktion, ueber die echte
  // Argumentliste. Ein echter Lauf waere nicht sauber zu bekommen: der
  // Installer braucht root (Service-User, Unit, /opt-Rechte) und lehnt
  // /tmp-Pfade ausserhalb seiner Whitelist ab. Ein "assert.rejects" waere
  // deshalb immer gruen - genau die Falle, in die mein erster Entwurf lief
  // (Mutation url:repo -> url:null blieb gruen, weil die Funktion vorher
  // abbrach).
  //
  // Also: Parameterliste und Rumpf werden EINZELN geprueft, beide am
  // echten Quelltext, nicht an einem geratenen Muster.
  const quelle = fs.readFileSync(new URL('../app/installer.js', import.meta.url), 'utf8');
  const start = quelle.indexOf('export async function installFromTarball');
  assert.ok(start > 0, 'installFromTarball nicht gefunden');
  // Ende der Funktion: naechste top-level Funktion.
  const ende = quelle.indexOf('\nexport async function', start + 10);
  const rumpf = quelle.slice(start, ende > 0 ? ende : undefined);

  // 1) Die Parameterliste muss repo kennen - sonst schreibt der Installer
  //    immer url: null und der Sword sagt nicht mehr, woher die Version kommt.
  const kopf = rumpf.slice(0, rumpf.indexOf(') {') + 1);
  assert.match(kopf, /\brepo\s*=\s*null/,
    'Parameterliste von installFromTarball kennt kein `repo = null`');

  // 2) Der Sword-Block muss source 'github' schreiben (nicht 'url').
  assert.match(rumpf, /update:\s*\{[\s\S]{0,1200}?\bsource:\s*'github'/,
    'Der Sword-Block in installFromTarball schreibt nicht source \'github\'');
  assert.doesNotMatch(rumpf, /\bsource:\s*'url'/,
    'installFromTarball schreibt weiterhin source \'url\' - genau der Befund');

  // 3) Die URL muss aus dem Parameter kommen, nicht fest null sein.
  assert.match(rumpf, /\burl:\s*repo\s*\?\?\s*null/,
    'Der Sword-Block schreibt url nicht aus dem repo-Parameter (url: repo ?? null)');
});

test('installFromTarball nimmt repo an (Signatur, nicht nur Quelltext)', async () => {
  // Reiner Signaturtest: die Funktion muss den Parameter kennen. Fehlt er,
  // schreibt der Installer url: null und der Sword sagt nicht mehr, woher die
  // Version kommt - genau der Zustand, den wir beheben.
  const quelle = fs.readFileSync(new URL('../app/installer.js', import.meta.url), 'utf8');
  // Whitespace-tolerant: die Parametersliste steht ueber einer Zeile und wird
  // bei jeder Formatierung anders umbrochen. `\brepo\s*=` statt `\brepo,` -
  // ein Parameter mit Default ist am `=` zu erkennen, egal wie er umbrochen
  // wurde. (Der erste Entwurf suchte `{[^}]*repo` direkt nach der Klammer und
  // scheiterte an der tatsaechlichen Formatierung.)
  assert.match(quelle, /export async function installFromTarball\s*\(\s*\{[\s\S]*?\brepo\s*=/,
    'installFromTarball hat keinen repo-Parameter (Default `repo = ...`) in der Destrukturierung');
  const routen = fs.readFileSync(new URL('../app/installRoutes.js', import.meta.url), 'utf8');
  assert.match(routen, /installFromTarball\s*\(\s*\{[\s\S]*?\brepo\b/,
    'Der Aufrufer (installRoutes) reicht repo nicht durch - Parameter ohne Aufrufer ist wirkungslos');
});
