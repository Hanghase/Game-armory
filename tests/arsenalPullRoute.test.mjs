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

// --- Das Fenster muss wieder aufgehen -------------------------------------
//
// Live am 2026-11-09: 6 MB nach oben, 8 Stuecke (512 KiB) angekommen, dann
// Stillstand. quittiere() war gebaut und getestet - und wurde NIE aufgerufen.
// Dieselbe Luecke wie withReadiness/dockerStatus: Funktion gruen, Aufrufer
// existiert nicht. Diese Tests pruefen den AUFRUFER.

const socketQuelle = await readFile(new URL('../app/arsenalSocket.js', import.meta.url), 'utf8');
const agentQuelle = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');

test('die Armory oeffnet das Fenster bei "stand"', () => {
  assert.match(
    socketQuelle,
    /msg\?\.type === 'stand'[\s\S]{0,300}?quittiere\(msg\.id\)/,
    'kein "stand"-Zweig mit quittiere() - der Pull bleibt nach dem Fenster stehen',
  );
});

test('nach dem Quittieren wird weitergesendet', () => {
  const block = socketQuelle.slice(socketQuelle.indexOf("msg?.type === 'stand'"));
  const bisEnde = block.slice(0, block.indexOf('return true'));
  assert.match(bisEnde, /sendeWeiter\(msg\.id\)/, 'Fenster auf, aber nichts nachgeschickt');
});

test('der Agent quittiert jedes Stueck', () => {
  assert.match(
    agentQuelle,
    /type: 'stand'/,
    'der Agent schickt keine Quittung - die Armory erfaehrt nie, dass das Fenster frei ist',
  );
});

test('die Quittung kommt VOR dem Abschluss', () => {
  const iStand = agentQuelle.indexOf("type: 'stand'");
  const iFertig = agentQuelle.indexOf('await schliessePullAb(id)');
  assert.ok(iStand > 0 && iFertig > 0, 'Quittung oder Abschluss fehlt');
  assert.ok(
    iStand < iFertig,
    'die Quittung kommt nach dem Abschluss - beim letzten Stueck wartet die Armory vergebens',
  );
});

// --- Stuecke duerfen NICHT parallel geschrieben werden --------------------
//
// Live am 2026-11-09: der Agent stuerzte waehrend des Pulls ab.
//
//   Error [ERR_STREAM_DESTROYED]: Cannot call write after a stream was
//   destroyed
//     at nimmStueck (agent/transferRun.js:76:9)
//
// 'ws' ruft den message-Handler fuer JEDE Nachricht auf, ohne auf den
// vorigen zu warten. Zwei Stuecke schneller als das Schreiben = zwei
// gleichzeitige write() auf denselben Strom. Der Dienst startete neu, der
// Pull begann von vorn - bei 589824 Bytes, jedes Mal.

test('Stuecke laufen ueber eine Warteschlange, nicht parallel', () => {
  assert.match(
    agentQuelle,
    /stueckKette\s*=\s*stueckKette\s*\n?\s*\.then\(/,
    'kein Warteschlangen-Kette: zwei Stuecke koennen gleichzeitig schreiben',
  );
});

test('der Binaer-Zweig benutzt die Kette, nicht direkt nimmDateistueck', () => {
  // Zeilenweise schneiden statt mit einer Regex auf Einrueckung - die
  // Einrueckung hat sich beim Einbau verschoben und der Schnitt ging ins Leere.
  const zeilen = agentQuelle.split('\n');
  const von = zeilen.findIndex((z) => z.trim() === 'if (istBinaer) {');
  assert.ok(von >= 0, 'Binaer-Zweig nicht gefunden');
  const bis = zeilen.findIndex((z, i) => i > von && z.trim() === 'return;');
  assert.ok(bis > von, 'Ende des Binaer-Zweigs nicht gefunden');
  const zweig = zeilen.slice(von, bis).join('\n');
  assert.match(zweig, /stueckKette/, 'der Zweig ruft nimmDateistueck direkt auf - parallel moeglich');
});

test('ein Schreibfehler bricht den Agenten nicht um', () => {
  // Ein unbehandelter Fehler im message-Handler beendet den Prozess. Der
  // Dienst startet neu - und der Pull faengt von vorn an. Jeder Fehler beim
  // Stueck muss abgefangen werden.
  assert.match(
    agentQuelle,
    /\.then\(\(\) => nimmDateistueck\(data\)\)\s*\n?\s*\.catch\(/,
    'kein .catch an der Kette - ein Schreibfehler beendet den Agenten',
  );
});
