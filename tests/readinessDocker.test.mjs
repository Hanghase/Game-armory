// Regressionstest 2026-11-07: withReadiness wirft bei einem Docker-Status.
//
// Befund: dockerStatus() in app/control.js liefert `changedAt: null`, weil
// `docker compose ps` keinen systemd-Zeitstempel kennt (anders als der
// systemd-Helfer, der StateChangeTimestamp=@<epoch> liefert). withReadiness
// baute daraus mit Number.parseInt(String(null ?? '')) eine NaN, rechnete
// Date.now() - NaN = NaN, und weil `NaN < READY_FALLBACK_MS` falsch ist,
// fiel die ageMs-Zuweisung auf 0 - damit war 0 < 90000 WAHR, und
// `new Date(NaN).toISOString()` warf "RangeError: Invalid time value".
// Live-Folge: der Sword 'nextcloud' (control.type=docker) zeigte im Panel
// 'unknown' (oranger Punkt) statt 'running'.
//
// Erwartung hier: kein Throw, und state bleibt 'running'.
// Begründung: Ein laufender Container hat keinen "fährt gerade hoch"-Begriff
// wie ein 7d2d mit 60-90 s Weltladezeit. Ohne echte Startzeit gibt es kein
// Zeitfenster, in dem "starting" richtig wäre - also Status unverändert
// durchreichen, statt einen Zustand zu erfinden.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const controlPath = new URL('../app/control.js', import.meta.url);

const dockerSword = {
  id: 'nextcloud',
  control: { type: 'docker' },
  logs: { type: 'docker' },
};

// So sieht der Status aus dockerStatus() für einen laufenden Stack aus.
const dockerStatusRunning = {
  kind: 'docker',
  state: 'running',
  subState: '3/3',
  changedAt: null,
  running: true,
  services: [{ name: 'nc-app', state: 'running', up: true }],
};

test('withReadiness: Docker-Status ohne changedAt wirft nicht und bleibt "running"', async () => {
  const { withReadiness } = await import(controlPath);

  let fin;
  // Der eigentliche Bug war der Wurf - deshalb hier explizit abfangen,
  // damit die rote Ausgabe den RangeError zeigt statt nur "test failed".
  await assert.doesNotReject(async () => {
    fin = await withReadiness(dockerSword, { ...dockerStatusRunning }, []);
  }, 'withReadiness darf bei changedAt=null nicht werfen (RangeError: Invalid time value)');

  assert.equal(fin.state, 'running',
    'laufender Docker-Stack ohne Startzeit muss "running" bleiben, nicht "starting"');
  assert.equal(fin.ready, false, 'ohne readyMarkers im Rack ist die Spielbereitschaft nicht belegt');
  assert.equal(fin.readyError, 'keine readyMarkers im Rack',
    'der Grund (keine Marker) muss mitgegeben werden, nicht verschluckt');
  assert.equal(fin.startedAt, undefined,
    'ohne echte Startzeit darf kein erfundener Zeitstempel gesetzt werden');
});
