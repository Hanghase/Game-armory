// Tests fuer das ZIEHEN einer Datei auf dem Arsenal (agent/transfer.js).
//
// Der Weg: das Arsenal zieht in Stuecken ueber die offene Leitung. Nicht die
// Armory schiebt. Wer zieht, bestimmt das Tempo, und am Arsenal ist kein
// Port offen (Konzept 2026-11-09).
//
// Die gefaehrlichen Faelle, die hier festgehalten werden:
//   - die Datei ist unvollstaendig, aber niemand merkt es
//   - die Pruefsumme stimmt nicht, aber es wird trotzdem installiert
//   - ein Stueck kommt doppelt oder in falscher Reihenfolge
//   - ein halb geschriebener Download sieht aus wie ein fertiger

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../agent/transfer.js').catch(() => null);

test('transfer.js laedt ueberhaupt', () => {
  assert.ok(mod, 'agent/transfer.js laedt nicht');
});

test('ein Stueck an der richtigen Stelle wird angenommen', () => {
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  const r = z.nimm({ offset: 0, daten: Buffer.alloc(40) });
  assert.equal(r.ok, true);
  assert.equal(z.stand().empfangen, 40);
});

test('ein Stueck an der FALSCHEN Stelle wird abgelehnt', () => {
  // Sonst schreibt ein verspaetetes Stueck Muell mitten in die Datei - und
  // die Pruefsumme schlaegt erst am Ende fehl, wenn niemand mehr weiss, wo.
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  z.nimm({ offset: 0, daten: Buffer.alloc(40) });
  const r = z.nimm({ offset: 80, daten: Buffer.alloc(10) });
  assert.equal(r.ok, false, 'Luecke wurde angenommen');
  assert.equal(r.grund, 'offset-falsch');
});

test('ein doppelt gesendetes Stueck wird erkannt, nicht doppelt gezaehlt', () => {
  // Bei einer wackeligen Leitung kommt ein Stueck schon mal zweimal. Es
  // stillschweigend zu addieren zerlegt den Zaehler.
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  z.nimm({ offset: 0, daten: Buffer.alloc(40) });
  const r = z.nimm({ offset: 0, daten: Buffer.alloc(40) });
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'schon-da');
  assert.equal(z.stand().empfangen, 40, 'doppelt gezaehlt');
});

test('mehr Bytes als angekuendigt werden abgelehnt', () => {
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  z.nimm({ offset: 0, daten: Buffer.alloc(100) });
  const r = z.nimm({ offset: 100, daten: Buffer.alloc(10) });
  assert.equal(r.ok, false, 'Daten ueber das Ende hinaus angenommen');
});

test('vor dem Ende ist die Datei NICHT fertig - auch bei 99 %', () => {
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  z.nimm({ offset: 0, daten: Buffer.alloc(99) });
  assert.equal(z.istFertig(), false, '99 % wurde als fertig gemeldet');
});

test('genau am Ende ist sie fertig', () => {
  const z = mod.erstelleEmpfaenger({ gesamt: 100, sha256: 'x' });
  z.nimm({ offset: 0, daten: Buffer.alloc(100) });
  assert.equal(z.istFertig(), true);
});

test('eine falsche Pruefsumme wird gemeldet, nicht verschluckt', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');

  const dir = await mkdtemp(join(tmpdir(), 'pull-'));
  const datei = join(dir, 'datei.bin');
  await writeFile(datei, 'inhalt');

  const richtig = createHash('sha256').update('inhalt').digest('hex');
  assert.equal(await mod.pruefeDatei(datei, richtig), true);
  assert.equal(await mod.pruefeDatei(datei, 'a'.repeat(64)), false,
    'falsche Pruefsumme wurde akzeptiert');
});

test('eine fehlende Datei ist ein Fehler, kein "stimmt schon"', async () => {
  const r = await mod.pruefeDatei('/tmp/gibt-es-nicht-xyz', 'a'.repeat(64));
  assert.equal(r, false, 'fehlende Datei wurde als gueltig gemeldet');
});

// --- Der echte Weg: schreiben, pruefen, umbenennen ------------------------
// Die Tests oben pruefen Entscheidungen. Diese pruefen, dass die Datei
// wirklich richtig auf der Platte landet - und im Fehlerfall NICHT.

import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const run = await import('../agent/transferRun.js').catch(() => null);

async function zielDatei(name = 'datei.zip') {
  const dir = await mkdtemp(join(tmpdir(), 'pullrun-'));
  return join(dir, name);
}

test('transferRun.js laedt ueberhaupt', () => {
  assert.ok(run, 'agent/transferRun.js laedt nicht');
});

test('eine vollstaendige Datei landet unter ihrem echten Namen', async () => {
  const inhalt = Buffer.from('0123456789abcdef');
  const sha = createHash('sha256').update(inhalt).digest('hex');
  const ziel = await zielDatei();

  const p = run.startePull({ id: 't1', gesamt: inhalt.length, sha256: sha, ziel });
  await p.oeffne();

  // In zwei Stuecken, wie ueber die Leitung.
  await run.nimmStueck('t1', { offset: 0, daten: inhalt.subarray(0, 8) });
  await run.nimmStueck('t1', { offset: 8, daten: inhalt.subarray(8) });

  const r = await run.beendePull('t1');
  assert.equal(r.ok, true, `beendePull scheiterte: ${JSON.stringify(r)}`);
  assert.equal(r.groesse, inhalt.length);
  assert.deepEqual(await readFile(ziel), inhalt, 'Dateiinhalt stimmt nicht');
});

test('eine falsche Pruefsumme hinterlaesst KEINE Datei', async () => {
  const inhalt = Buffer.from('inhalt');
  const ziel = await zielDatei();
  const falsch = 'a'.repeat(64);

  const p = run.startePull({ id: 't2', gesamt: inhalt.length, sha256: falsch, ziel });
  await p.oeffne();
  await run.nimmStueck('t2', { offset: 0, daten: inhalt });
  const r = await run.beendePull('t2');

  assert.equal(r.ok, false);
  assert.equal(r.grund, 'pruefsumme-falsch');
  // Weder die echte Datei noch die .teil-Datei darf bleiben. Eine kaputte
  // ZIP liegen zu lassen laedt dazu ein, sie irgendwann zu installieren.
  await assert.rejects(access(ziel), 'Datei existiert trotz falscher Pruefsumme');
  await assert.rejects(access(`${ziel}.teil`), '.teil-Datei wurde nicht aufgeraeumt');
});

test('ein unvollstaendiger Pull hinterlaesst KEINE Datei', async () => {
  const inhalt = Buffer.from('0123456789');
  const sha = createHash('sha256').update(inhalt).digest('hex');
  const ziel = await zielDatei();

  const p = run.startePull({ id: 't3', gesamt: inhalt.length, sha256: sha, ziel });
  await p.oeffne();
  await run.nimmStueck('t3', { offset: 0, daten: inhalt.subarray(0, 5) }); // nur die Haelfte
  const r = await run.beendePull('t3');

  assert.equal(r.ok, false);
  assert.equal(r.grund, 'unvollstaendig');
  await assert.rejects(access(ziel), 'halbe Datei liegt unter dem echten Namen');
});

test('ein Abbruch raeumt auf', async () => {
  const inhalt = Buffer.from('0123456789');
  const sha = createHash('sha256').update(inhalt).digest('hex');
  const ziel = await zielDatei();

  const p = run.startePull({ id: 't4', gesamt: inhalt.length, sha256: sha, ziel });
  await p.oeffne();
  await run.nimmStueck('t4', { offset: 0, daten: inhalt.subarray(0, 5) });
  await run.brichAb('t4');

  await assert.rejects(access(`${ziel}.teil`), '.teil-Datei blieb liegen');
  assert.deepEqual(run.offenePulls(), [], 'Pull blieb registriert');
});

test('ein Stueck an falscher Stelle wird NICHT geschrieben', async () => {
  const inhalt = Buffer.from('0123456789abcdef');
  const sha = createHash('sha256').update(inhalt).digest('hex');
  const ziel = await zielDatei();

  const p = run.startePull({ id: 't5', gesamt: inhalt.length, sha256: sha, ziel });
  await p.oeffne();
  await run.nimmStueck('t5', { offset: 0, daten: inhalt.subarray(0, 8) });
  const r = await run.nimmStueck('t5', { offset: 0, daten: inhalt.subarray(0, 8) }); // doppelt
  assert.equal(r.ok, false);
  assert.equal(r.grund, 'schon-da');

  // Die Datei muss weiter genau 8 Bytes haben, nicht 16.
  const zwischenstand = await readFile(`${ziel}.teil`);
  assert.equal(zwischenstand.length, 8, `doppelt geschrieben (${zwischenstand.length} Bytes)`);
});
