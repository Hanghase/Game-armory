// Die zweite Stelle ist eine Entscheidung, keine Meldung des Fortschritts.
//
// Felix, 2026-11-09, zweimal:
//   "wieso ueberspringst du so große versionen?"
//   "warum wir so große release schritte wieder machen? bitte nutzt 1.5.81"
//   "nein ich will nicht solche risigen spruenge haben bitte schau das es
//    nicht noch einmal passiert!"
//
// Was passiert war:
//   1.5.4 - 1.5.8  fuenf Nummern fuer EINEN install-Schritt
//   1.6.0          eine "fertige" Faehigkeit, die live nie durchlief
//   1.6.1          die vier Nahtstellen-Fehler derselben Faehigkeit
//
// Die Regel steht in GAME-ARMORY-NOTES.md ("Release-Nummern"). Eine Regel im
// Notizbuch haelt niemanden auf - dieser Test schon. Er laeuft in der Suite
// und im pre-push-Hook.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const wurzel = new URL('../', import.meta.url);

async function lies(pfad) {
  return readFile(new URL(pfad, wurzel), 'utf8');
}

// --- Wie eine Nummer gelesen wird ---------------------------------------
// MAJOR.MINOR.PATCH, wobei PATCH mehrstellig sein darf (81, 82, 84).
// Genau das ist die gewuenschte Form: 1.5.8 -> 1.5.81 -> 1.5.82.
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// --- Die Sperre ---------------------------------------------------------
//
// Zwei Stufen, weil zwei verschiedene Fehler passiert sind:
//
//   1. ZWEITE STELLE (1.5.84 -> 1.6.0): nur erlaubt, wenn davor ein
//      ANKUENDIGUNGS-COMMIT steht ("Ansage: 1.6.0 - <was>"). Wer die zweite
//      Stelle hochzieht, muss vorher sagen, was fertig ist.
//
//   2. NACHKOMMA (1.6.0 -> 1.6.1): PATCH darf um hoechstens 1 wachsen, WENN
//      die zweite Stelle gleich bleibt. Also 1.6.0 -> 1.6.1 erlaubt,
//      1.5.8 -> 1.5.9 erlaubt, 1.5.8 -> 1.5.81 erlaubt (Sprung nach der
//      Patch-Regel), aber 1.6.0 -> 1.6.5 nicht.
//
// Bewusst KEIN "gilt nicht rueckwirkend": der Test prueft die TAG-KETTE, und
// die alten Tags bleiben, wie sie sind. Er greift ab dem naechsten Release.

function pruefeSprung(alt, neu) {
  const a = parseVersion(alt);
  const n = parseVersion(neu);
  if (!a || !n) return { ok: false, grund: `unlesbare Nummer: ${alt} -> ${neu}` };

  // Rueckwaerts geht gar nicht.
  const aZahl = a.major * 1e6 + a.minor * 1e3 + a.patch;
  const nZahl = n.major * 1e6 + n.minor * 1e3 + n.patch;
  if (nZahl <= aZahl) return { ok: false, grund: `kein Fortschritt: ${alt} -> ${neu}` };

  if (n.major !== a.major) {
    return { ok: false, grund: `Major-Sprung ${alt} -> ${neu}: nur mit Ansage und Begruendung` };
  }

  if (n.minor !== a.minor) {
    // Zweite Stelle: hoechstens EINE Stufe weiter.
    if (n.minor !== a.minor + 1) {
      return { ok: false, grund: `Sprung ueber mehr als eine Nebenstelle: ${alt} -> ${neu}` };
    }
    if (n.patch !== 0) {
      return {
        ok: false,
        grund: `neue Nebenstelle muss bei .0 beginnen: ${alt} -> ${neu} (${alt} -> ${a.minor + 1}.0)`,
      };
    }
    return { ok: true, neueNebenstelle: true };
  }

  // Zweite Stelle gleich: Patch darf wachsen.
  // Erlaubt: +1 (1.6.0 -> 1.6.1) oder Anhaengen einer Stelle (1.5.8 -> 1.5.81).
  const aText = String(a.patch);
  const nText = String(n.patch);
  if (n.patch === a.patch + 1) return { ok: true };
  if (nText.startsWith(aText) && nText.length > aText.length) return { ok: true };
  return {
    ok: false,
    grund: `Patch-Sprung ${alt} -> ${neu}: erlaubt ist +1 (${a.major}.${a.minor}.${a.patch + 1}) `
      + `oder eine angehaengte Stelle (${a.major}.${a.minor}.${aText}1)`,
  };
}

// --- Die Regeln selbst pruefen -----------------------------------------
// Ein Test, der nie rot werden kann, prueft nichts. Diese Faelle sind echt:
// die erste Spalte ist passiert oder waere passiert.

test('die Sprungpruefung erkennt die echten Faelle', () => {
  const verboten = [
    ['1.5.8', '1.6.1', 'zweite Stelle UND Patch in einem Schritt'],
    ['1.5.84', '1.7.0', 'zwei Nebenstellen auf einmal'],
    ['1.0.0', '2.0.0', 'Major ohne Ansage'],
    ['1.6.0', '1.6.5', 'fuenf Patches fuer einen Schritt'],
    ['1.6.1', '1.6.0', 'rueckwaerts'],
    ['1.5.84', '1.5.86', 'zwei Patches'],
    ['1.5.84', '1.6.2', 'neue Nebenstelle mit Patch ungleich 0'],
  ];
  for (const [alt, neu, warum] of verboten) {
    const r = pruefeSprung(alt, neu);
    assert.equal(r.ok, false, `durchgelassen: ${alt} -> ${neu} (${warum})`);
  }

  const erlaubt = [
    ['1.6.0', '1.6.1', 'eine Korrektur'],
    ['1.5.8', '1.5.81', 'Nachkomma-Patch, wie von Felix verlangt'],
    ['1.5.81', '1.5.82', 'Nachkomma-Patch weiter'],
    ['1.5.84', '1.6.0', 'eine fertige Faehigkeit (mit Ansage)'],
    ['1.6.1', '1.7.0', 'naechste fertige Faehigkeit'],
  ];
  for (const [alt, neu, warum] of erlaubt) {
    const r = pruefeSprung(alt, neu);
    assert.equal(r.ok, true, `faelschlich verboten: ${alt} -> ${neu} (${warum}): ${r.grund}`);
  }
});

// --- Und jetzt gegen das echte Repo -------------------------------------

test('die Versionskette im Repo haelt die Regel ein', async () => {
  // Die Tags sind die Wahrheit ueber ausgelieferte Staende. Geprueft wird
  // paarweise in der Reihenfolge, in der sie entstanden sind.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ausfuehren = promisify(execFile);

  let roh;
  try {
    const r = await ausfuehren('git', ['tag', '--list', 'v*', '--sort=creatordate'], { cwd: new URL('.', wurzel).pathname });
    roh = r.stdout;
  } catch {
    assert.fail('git tags nicht lesbar - die Release-Kette ist nicht pruefbar');
  }

  const versionen = String(roh)
    .split('\n')
    .map((z) => z.trim())
    .filter(Boolean)
    .map((t) => t.replace(/^v/, ''))
    .filter((v) => parseVersion(v));

  assert.ok(versionen.length >= 2, 'zu wenige Tags zum Pruefen');

  const verstoesse = [];
  for (let i = 1; i < versionen.length; i += 1) {
    const r = pruefeSprung(versionen[i - 1], versionen[i]);
    if (!r.ok) verstoesse.push(`${versionen[i - 1]} -> ${versionen[i]}: ${r.grund}`);
  }

  // Die Altlasten von heute sind bekannt und werden NICHT stillschweigend
  // erlaubt: sie stehen hier mit Grund. Alles Neue muss die Regel halten.
  // Altlasten, alle VOR der Regel vom 2026-11-09 entstanden. Sie stehen
  // einzeln mit Grund hier, damit sie nicht verschwinden - und damit ein
  // NEUER Verstoss nicht in einer pauschalen Ausnahme untertaucht.
  const BEKANNT = [
    // Grosse Patch-Spruenge in der fruehen Bauphase.
    /^1\.1\.8 -> 1\.1\.92:/,
    /^1\.3\.57 -> 1\.3\.60:/,
    /^1\.3\.60 -> 1\.3\.70:/,
    // 1.5.x: fuenf Nummern fuer einen install-Schritt.
    /^1\.5\.4 -> 1\.5\.5:/,
    /^1\.5\.5 -> 1\.5\.6:/,
    /^1\.5\.6 -> 1\.5\.7:/,
    /^1\.5\.7 -> 1\.5\.8:/,
    // 1.6.0 lief nicht; die Korrektur kam als 1.6.1 statt als 1.6.01.
    // Genau dieser Fall soll sich NICHT wiederholen - deshalb steht er hier
    // als Mahnmal und nicht als erlaubtes Muster.
    /^1\.6\.0 -> 1\.6\.1:/,
  ];
  const neu = verstoesse.filter((v) => !BEKANNT.some((m) => m.test(v)));
  assert.deepEqual(neu, [], `Versionssprung gegen die Regel:\n  ${neu.join('\n  ')}`);
});

test('die Arbeitsversion in package.json springt nicht', async () => {
  // Die Sperre ueber die TAG-Kette hat eine Luecke, live nachgemessen:
  // package.json auf 1.6.1 -> 1.6.9 geaendert, und alle Tests blieben gruen.
  // Grund: der Tag-Test prueft nur, was SCHON ausgeliefert ist. Der Sprung
  // entsteht aber im Augenblick des Bumpens, also lange vor dem Tag.
  //
  // Diese Pruefung vergleicht die Arbeitsversion mit dem JUENGSTEN Tag:
  // genau dort passiert der Fehler, den Felix zweimal gesehen hat.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ausfuehren = promisify(execFile);
  const cwd = new URL('.', wurzel).pathname;

  const arbeits = JSON.parse(await lies('package.json')).version;

  let letzterTag = '';
  try {
    const r = await ausfuehren('git', ['describe', '--tags', '--abbrev=0'], { cwd });
    letzterTag = String(r.stdout).trim();
  } catch {
    return; // noch kein Tag - nichts zu vergleichen
  }
  const alt = letzterTag.replace(/^v/, '');
  if (alt === arbeits) return; // nichts gebumpt

  const r = pruefeSprung(alt, arbeits);
  assert.equal(
    r.ok,
    true,
    `package.json springt von ${alt} (letzter Tag) auf ${arbeits}: ${r.grund}`,
  );
});

test('eine neue Nebenstelle wird VORHER angesagt', async () => {
  // Felix, 2026-11-09: "zweite Stelle nur fuer eine FERTIGE Faehigkeit und
  // VORHER angesagt". Die Ansage ist ein Commit mit "Ansage: <version> - ...",
  // der VOR dem Release-Commit steht. Ein CHANGELOG-Eintrag hinterher ist
  // keine Ansage.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ausfuehren = promisify(execFile);
  const cwd = new URL('.', wurzel).pathname;

  const version = JSON.parse(await lies('package.json')).version;
  const v = parseVersion(version);
  if (!v || v.patch !== 0) return; // nur relevant, wenn eine Nebenstelle aufgeht

  // Steht im letzten Commit oder davor eine Ansage fuer genau diese Nummer?
  const { stdout } = await ausfuehren(
    'git', ['log', '-20', '--format=%s%n%b'],
    { cwd },
  ).catch(() => ({ stdout: '' }));

  const muster = new RegExp(`Ansage:\\s*${version.replace(/\./g, '\\.')}\\b`, 'i');
  assert.match(
    stdout,
    muster,
    `Version ${version} oeffnet eine Nebenstelle, aber keine Ansage gefunden. `
      + `Setze eine Zeile "Ansage: ${version} - <was ist fertig>" in den Commit VOR dem Release.`,
  );
});
