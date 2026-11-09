// Sendeseite: was die Armory entscheidet, waehrend das Arsenal zieht.
//
// Kein Netz, keine Datei - nur die Entscheidungen. Was hier falsch ist, faellt
// sonst erst bei 2 GB auf, wenn niemand mehr hinsieht.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  erstellePull, naechstesStueck, darfSenden, haengtSeit, pullAnsage,
  FENSTER_STUECKE, PULL_STILL_MS,
} from '../app/arsenalTransferRun.js';

const SHA = 'a'.repeat(64);
const GUT = { id: 'abc123def456', gesamt: 300, sha256: SHA, name: 'atm11.zip', arsenalId: 6 };

test('ein sauberer Pull wird angenommen', () => {
  const p = erstellePull(GUT);
  assert.equal(p.gesendet, 0);
  assert.equal(p.bereit, false, 'ohne "bereit" darf nichts raus');
});

test('ohne "bereit" wird kein Stueck geplant', () => {
  const p = erstellePull(GUT);
  assert.equal(naechstesStueck(p, 100), null);
  assert.equal(darfSenden(p, 0), false);
});

test('nach "bereit" kommt das erste Stueck ab Offset 0', () => {
  const p = erstellePull(GUT);
  p.bereit = true;
  assert.deepEqual(naechstesStueck(p, 100), { offset: 0, laenge: 100 });
});

test('das LETZTE Stueck bekommt den Rest, nicht die volle Groesse', () => {
  // Der klassische Fehler: die Schleife liest ueber das Dateiende hinaus und
  // schreibt Muell ans Ende der Datei.
  const p = erstellePull({ ...GUT, gesamt: 250 });
  p.bereit = true;
  p.gesendet = 200;
  assert.deepEqual(naechstesStueck(p, 100), { offset: 200, laenge: 50 });
});

test('ist alles raus, kommt kein Stueck mehr', () => {
  const p = erstellePull(GUT);
  p.bereit = true;
  p.gesendet = 300;
  assert.equal(naechstesStueck(p, 100), null);
  assert.equal(darfSenden(p, 0), false);
});

test('das Fenster bremst, bevor der Puffer volllaeuft', () => {
  // Ohne Deckel schreibt die Schleife die ganze Datei in den Sendepuffer.
  const p = erstellePull(GUT);
  p.bereit = true;
  assert.equal(darfSenden(p, FENSTER_STUECKE - 1), true);
  assert.equal(darfSenden(p, FENSTER_STUECKE), false, 'Fenster deckelt nicht');
});

test('ein haengender Pull wird erkannt', () => {
  const p = erstellePull(GUT);
  const start = p.letzteAktion;
  assert.equal(haengtSeit(p, start + 1000), false);
  assert.equal(haengtSeit(p, start + PULL_STILL_MS + 1), true);
});

test('die Ansage enthaelt KEIN Ziel', () => {
  // Das Ziel legt das Arsenal selbst fest (agent/logic.js ZIEL_WURZEL).
  // Schickte die Armory einen Pfad mit, waere die Pruefung dort umgehbar.
  const a = pullAnsage(erstellePull(GUT));
  assert.equal(a.ziel, undefined, 'die Ansage schickt ein Ziel mit');
  assert.equal(a.type, 'pull');
  assert.equal(a.name, 'atm11.zip');
});

test('unbrauchbare Angaben werden sofort abgelehnt', () => {
  for (const kaputt of [
    { ...GUT, id: '../etc' },
    { ...GUT, gesamt: 0 },
    { ...GUT, gesamt: 1.5 },
    { ...GUT, sha256: 'zu-kurz' },
    { ...GUT, name: '' },
  ]) {
    assert.throws(() => erstellePull(kaputt), `akzeptiert: ${JSON.stringify(kaputt)}`);
  }
});

test('die Pruefsumme wird auf Kleinbuchstaben gebracht', () => {
  const p = erstellePull({ ...GUT, sha256: 'A'.repeat(64) });
  assert.equal(p.sha256, 'a'.repeat(64));
});

test('der Sender rechnet mit Offset, nicht mit Stueckzaehler', () => {
  // Ein Sender, der "Stueck Nummer n" denkt, liegt daneben, sobald ein Stueck
  // abgelehnt und wiederholt wird. Offset ist die einzige stabile Groesse.
  const p = erstellePull({ ...GUT, gesamt: 1000 });
  p.bereit = true;
  let offset = 0;
  for (let i = 0; i < 10; i++) {
    const s = naechstesStueck(p, 128);
    if (!s) break;
    assert.equal(s.offset, offset);
    offset += s.laenge;
    p.gesendet = offset;
  }
  assert.equal(p.gesendet, 1000, 'die Summe der Stuecke ergibt nicht die Gesamtgroesse');
});

// --- Nur EIN Sender je Pull -----------------------------------------------
//
// sendeWeiter ist async und wird von "bereit" UND von jeder "stand"-Quittung
// aufgerufen. Liefen zwei gleichzeitig, lesen beide pull.gesendet, bevor
// einer es hochzaehlt - und schicken dasselbe Stueck nochmal.
//
// Live am 2026-11-09: "Stueck abgelehnt (schon-da) bei Offset 589824".

const sendQuelle = await import('node:fs/promises').then((fs) =>
  fs.readFile(new URL('../app/arsenalTransferSend.js', import.meta.url), 'utf8'));

test('sendeWeiter haengt an einer Warteschlange je Pull', () => {
  assert.match(sendQuelle, /senderKette/, 'keine Kette - zwei Aufrufe koennen dasselbe Stueck senden');
  assert.match(
    sendQuelle,
    /const jetzt = vorher\.then\(/,
    'sendeWeiter verkettet nicht mit dem vorigen Aufruf',
  );
});

test('die Kette wird beim Aufraeumen geloescht', () => {
  // Sonst waechst die Map bei jedem Pull und haelt geschlossene Dateien fest.
  // Nicht nur zaehlen: die Loeschung muss in BEIDEN Aufraeumfunktionen stehen.
  // Ein blosser Zaehler akzeptiert auch zweimal dieselbe Funktion.
  for (const [name, marke] of [
    ['schliesseAb', 'export async function schliesseAb'],
    ['brichAb', 'export async function brichAb'],
  ]) {
    const von = sendQuelle.indexOf(marke);
    assert.ok(von >= 0, `${name} nicht gefunden`);
    const bis = sendQuelle.indexOf('\n}', von);
    const rumpf = sendQuelle.slice(von, bis);
    assert.match(rumpf, /senderKette\.delete\(id\)/, `${name} loescht die Kette nicht - sie waechst bei jedem Pull`);
  }
});
