// Die Route /api/arsenals/:id/pull - was sie annimmt und was nicht.
//
// Hier kommt eine Kennung aus dem Netz, die zu einer Datei auf der Platte
// wird. Genau die Stelle, an der "ich nehme den Pfad aus dem Request" zur
// Luecke wird. Der Test prueft die Quelltext-Regel, weil die Route ohne
// laufenden Server und ohne Anmeldung sonst nicht erreichbar ist.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const quelle = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');

test('die Route existiert und verlangt ein Recht', () => {
  const m = quelle.match(/arsenalRouter\.post\('\/arsenals\/:id\/pull',\s*([^,]+),/);
  assert.ok(m, 'die pull-Route fehlt oder hat kein requirePerm');
  assert.match(m[1], /requirePerm\('arsenal\.update'\)/, 'die Route prueft kein Recht');
});

test('die Datei kommt aus der Upload-Ablage, nicht aus dem Request', () => {
  assert.match(quelle, /readUpload\(uploadId\)/, 'die Route schlaegt den Upload nicht nach');
  // Ein Pfad aus dem Request darf NIE direkt an sendePull gehen.
  assert.doesNotMatch(
    quelle,
    /dateiPfad:\s*req\.(body|query|params)\./,
    'ein Pfad aus dem Request geht direkt an sendePull',
  );
  assert.match(quelle, /dateiPfad:\s*upload\.path/, 'der Pfad kommt nicht aus dem Upload-Datensatz');
});

// Der Rumpf der Route: von der Route bis zum naechsten Routen-Anfang.
// NICHT bis zum ersten '});' - das steht schon im ersten res.status(400)
// und schnitt den Ausschnitt mitten in der Pruefung ab. Genau der Fehler,
// den ich beim Testen dauernd mache: der Ausschnitt ist zu kurz, der Test
// prueft dann etwas anderes als gemeint.
function routenBlock() {
  const start = quelle.indexOf("'/arsenals/:id/pull'");
  if (start < 0) throw new Error('pull-Route nicht gefunden');
  const rest = quelle.slice(start + 1);
  const ende = rest.indexOf('arsenalRouter.');
  return ende < 0 ? rest : rest.slice(0, ende);
}

test('ein nicht verbundenes Arsenal bekommt 409, keinen Timeout', () => {
  const bisEnde = routenBlock();
  assert.match(bisEnde, /istVerbunden\(id\)/, 'die Route prueft die Verbindung nicht');
  assert.match(bisEnde, /409/, 'ohne Verbindung kommt kein 409');
});

test('die Kennung wird geprueft, bevor sie benutzt wird', () => {
  const bisEnde = routenBlock();
  assert.match(bisEnde, /uploadId/, 'uploadId wird nicht geprueft');
  assert.match(bisEnde, /\[A-Za-z0-9_-\]\{4,64\}|readUpload/, 'die Kennung geht ungeprueft weiter');
});

test('ein unbekannter Upload ergibt 404, keinen Absturz', () => {
  // Nicht "404 kommt irgendwo vor" - das erfuellt auch ein toter Zweig wie
  // "if (false) return res.status(404)". Es muss am Upload haengen.
  const bisEnde = routenBlock();
  // Beide Formen zulassen (Einzeiler und Block) - aber der 404 MUSS an
  // !upload haengen.
  assert.match(
    bisEnde,
    /if \(!upload\)[\s\S]{0,80}?404/,
    'der 404 haengt nicht an einem fehlenden Upload',
  );
});
