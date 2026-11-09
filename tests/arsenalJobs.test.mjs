// Tests fuer Auftraege (Jobs) auf dem Arsenal.
//
// Der Grund (Felix, 2026-11-09): "koennen wir Fehler und Sucess nicht alle
// 30 sekunden mit uebermitteln lassen ... so verhindern wir dumme
// sperrzeiten". Genau das. Ein Install dauert Minuten; ein Befehl darf 30 s.
// Also: Auftrag anlegen, SOFORT antworten, Ergebnis kommt mit dem naechsten
// Lebenszeichen. Kein neues Modell - der Herzschlag traegt es schon.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../app/arsenalJobs.js').catch(() => null);

test('arsenalJobs.js laedt ueberhaupt', () => {
  assert.ok(mod, 'app/arsenalJobs.js laedt nicht');
});

test('ein neuer Auftrag ist offen und hat eine Kennung', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install', titel: 'ATM10 auf vm-test' });
  assert.match(job.id, /^[0-9a-f]{8,}$/, 'keine brauchbare Kennung');
  assert.equal(job.zustand, 'offen');
  assert.equal(job.art, 'install');
});

test('ein Auftrag wandert von offen nach laeuft nach fertig', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.setzeFortschritt(job.id, { prozent: 40, meldung: 'ziehe' });
  assert.equal(l.hole(job.id).zustand, 'laeuft');
  assert.equal(l.hole(job.id).prozent, 40);
  l.beende(job.id, { erfolg: true, meldung: 'fertig' });
  assert.equal(l.hole(job.id).zustand, 'fertig');
  assert.equal(l.hole(job.id).prozent, 100, 'fertig muss 100 % sein');
});

test('ein Fehlschlag ist ein eigener Zustand, nicht "fertig"', () => {
  // Wer Fehler als fertig meldet, laesst jemanden auf ein Ergebnis warten,
  // das nie kommt.
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.beende(job.id, { erfolg: false, fehler: 'Platte voll' });
  const j = l.hole(job.id);
  assert.equal(j.zustand, 'fehlgeschlagen');
  assert.equal(j.fehler, 'Platte voll');
  assert.equal(j.prozent, 100, 'auch ein Fehler ist "durch" - nur anders');
});

test('ein fertiger Auftrag wird NIE wieder offen', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.beende(job.id, { erfolg: true, meldung: 'fertig' });
  l.setzeFortschritt(job.id, { prozent: 10, meldung: 'nachzuegler' });
  const j = l.hole(job.id);
  assert.equal(j.zustand, 'fertig', 'Zustand wurde zurueckgedreht');
  // Auch der Balken darf nicht zurueckspringen: ein fertiger Auftrag, der
  // ploetzlich bei 10 % steht, sieht aus wie ein Fehler.
  assert.equal(j.prozent, 100, 'Fortschritt wurde nach dem Ende zurueckgedreht');
  assert.equal(j.meldung, 'fertig', 'Meldung wurde nach dem Ende ueberschrieben');
});

test('das Lebenszeichen traegt offene Auftraege und faellt weg, wenn keine da sind', () => {
  // Das ist der Kern: der Herzschlag bringt den Stand mit. Ein Lebenszeichen
  // mit leerer Liste ist ein paar Byte - ein Grund, es immer mitzuschicken.
  const l = mod.erstelleAuftragsliste();
  assert.deepEqual(l.fuerHerzschlag(), [], 'ohne Auftraege muss die Liste leer sein');

  const job = l.anlegen({ art: 'install', titel: 'ATM10' });
  l.setzeFortschritt(job.id, { prozent: 30, meldung: 'lade' });
  const imHerz = l.fuerHerzschlag();
  assert.equal(imHerz.length, 1);
  assert.equal(imHerz[0].id, job.id);
  assert.equal(imHerz[0].prozent, 30);
  assert.equal(imHerz[0].meldung, 'lade');
});

test('ein abgeschlossener Auftrag wird genau EINMAL gemeldet', () => {
  // Meldet der Agent "fertig" bei jedem Herzschlag neu, blinkt im Panel
  // jede Minute dieselbe Erfolgsmeldung auf. Nach der Bestaetigung durch
  // die Armory ist er weg.
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.beende(job.id, { erfolg: true, meldung: 'fertig' });

  const erste = l.fuerHerzschlag();
  assert.equal(erste.length, 1, 'das Ergebnis muss einmal mit');
  l.bestaetige(job.id);
  assert.deepEqual(l.fuerHerzschlag(), [], 'nach der Bestaetigung nicht nochmal');
});

test('ein offener Auftrag ueberlebt die Bestaetigung (nur Ergebnisse fallen weg)', () => {
  const l = mod.erstelleAuftragsliste();
  const a = l.anlegen({ art: 'install' });
  const b = l.anlegen({ art: 'update' });
  l.beende(a.id, { erfolg: true });
  l.bestaetige(a.id);
  const rest = l.fuerHerzschlag();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].id, b.id);
});

test('die Auftragsliste waechst nicht unbegrenzt', () => {
  // Ein Agent, der monatelang laeuft, sonst Speicher ohne Ende.
  const l = mod.erstelleAuftragsliste({ max: 5 });
  const ids = [];
  for (let i = 0; i < 12; i += 1) {
    const j = l.anlegen({ art: 'install', titel: `nr${i}` });
    l.beende(j.id, { erfolg: true });
    ids.push(j.id);
  }
  assert.ok(l.alle().length <= 5, `Liste hat ${l.alle().length} Eintraege`);
  // Die NEUESTEN bleiben, die alten fallen weg.
  assert.ok(l.hole(ids[11]), 'der neueste Auftrag fehlt');
  assert.equal(l.hole(ids[0]), null, 'der aelteste haette wegfallen muessen');
});

test('der Fortschritt bleibt zwischen 0 und 100', () => {
  // Ein Fortschritt von 105 % oder -5 % laesst einen Balken ueberlaufen
  // oder rueckwaerts springen. Der Deckel ist keine Kosmetik.
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.setzeFortschritt(job.id, { prozent: 105 });
  assert.equal(l.hole(job.id).prozent, 100, '105 % wurde nicht gedeckelt');
  l.setzeFortschritt(job.id, { prozent: -5 });
  assert.equal(l.hole(job.id).prozent, 0, '-5 % wurde nicht gedeckelt');
});

// --- Das Taktgefuehl (Felix, 2026-11-09) -----------------------------------
// "im Idle oder normalem Tagesgeschaeft 30 Sekunden, bei installs oder server
// verschieben alle 15 Sekunden bis fertig".
//
// Das ist der Punkt: ein laufender Auftrag soll sich zuegig anfuehlen, ein
// ruhiges Arsenal soll die Armory nicht anfassen. Also haengt der Takt am
// ZUSTAND DER ARBEIT, nicht an einer Einstellung.

test('ohne Auftrag sind es 30 Sekunden', () => {
  const l = mod.erstelleAuftragsliste();
  assert.equal(l.taktMs(), 30_000, 'Leerlauf muss 30 s sein');
});

test('mit laufendem Auftrag sind es 15 Sekunden', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.setzeFortschritt(job.id, { prozent: 20 });
  assert.equal(l.taktMs(), 15_000, 'waehrend eines Auftrags muss es 15 s sein');
});

test('mit OFFENEM (noch nicht gestartetem) Auftrag sind es auch 15 Sekunden', () => {
  // Zwischen "angenommen" und "erster Fortschritt" darf es nicht 30 s dauern -
  // sonst wirkt der Start traege, obwohl er laengst laeuft.
  const l = mod.erstelleAuftragsliste();
  l.anlegen({ art: 'install' });
  assert.equal(l.taktMs(), 15_000);
});

test('nach dem Ende geht es zurueck auf 30 Sekunden', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.beende(job.id, { erfolg: true });
  assert.equal(l.taktMs(), 30_000, 'nach dem Ende muss es wieder 30 s sein');
});

test('ein Fehlschlag zaehlt nicht als laufende Arbeit', () => {
  const l = mod.erstelleAuftragsliste();
  const job = l.anlegen({ art: 'install' });
  l.beende(job.id, { erfolg: false, fehler: 'Platte voll' });
  assert.equal(l.taktMs(), 30_000);
});

test('zwei Auftraege sind nicht schneller als einer', () => {
  // 15 s ist die Untergrenze. Wer den Takt mit der Auftragszahl teilt, fragt
  // bei fuenf Auftraegen alle 3 s - und genau das soll nicht passieren.
  const l = mod.erstelleAuftragsliste();
  for (let i = 0; i < 5; i += 1) l.anlegen({ art: 'install' });
  assert.equal(l.taktMs(), 15_000, 'der Takt darf nicht mit der Zahl der Auftraege fallen');
});

// --- Der Takt muss auch BENUTZT werden, nicht nur vorhanden sein -----------
// Die Lehre aus dem Panel: eine Funktion, die richtig rechnet, und ihr
// Aufrufer, der sie nicht benutzt, sieht aus wie eine Loesung. Beides pruefen.

test('der Agent plant seinen Herzschlag ueber taktMs(), nicht mit fester Zeit', async () => {
  const { readFile } = await import('node:fs/promises');
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

  // Ein setInterval kann den Takt nicht aendern - egal in welcher Form.
  // (Erster Versuch pruefte nur "heartbeatTimer = setInterval" und uebersah,
  // dass die Kette selbst mit setInterval gebaut sein kann.)
  assert.ok(
    !/setInterval\(\s*\(\)\s*=>\s*\{?\s*\n?\s*sendeHeartbeat/.test(run)
    && !/setInterval\(\s*\(\)\s*=>\s*sendeHeartbeat/.test(run)
    && !/heartbeatTimer\s*=\s*setInterval/.test(run),
    'der Herzschlag laeuft ueber setInterval - der Takt kann sich so nie aendern',
  );
  assert.match(run, /heartbeatTimer\s*=\s*setTimeout/,
    'der Herzschlag wird nicht als Kette geplant');
  assert.match(run, /auftraege\.taktMs\(\)/, 'taktMs() wird nicht benutzt');
});

test('der Herzschlag traegt die Auftraege mit', async () => {
  const { readFile } = await import('node:fs/promises');
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  assert.match(run, /auftraege\.fuerHerzschlag\(\)/,
    'fuerHerzschlag() wird nicht benutzt - der Fortschritt kommt nie an');
  assert.match(run, /jobs:/, 'das Herzschlag-Paket hat kein jobs-Feld');
});
