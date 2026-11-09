// Einsetzen: aus dem entpackten Pack wird der Sword im Spielverzeichnis.
//
// Bisher endet der install-Weg beim Entpacken: das Pack liegt unter
// /var/lib/armory-arsenal/packs/entpackt/armory-pack-XXXXXX, der Sword unter
// /opt/minecraft/<id> bekommt davon nichts. Felix: "ja bitte" (2026-11-09).
//
// Das ist der Schritt, bei dem eine bestehende WELT verloren gehen kann.
// Deshalb steht die Sicherung VOR dem Kopieren, und zwar erzwungen - nicht
// als Option, die jemand vergessen kann.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateEinsetzen, sichereVorEinsetzen, EINSETZ_ORDNER } from '../agent/logic.js';

const quelle = await readFile(new URL('../agent/logic.js', import.meta.url), 'utf8');

test('ein gueltiger Auftrag wird angenommen', () => {
  const r = validateEinsetzen({
    type: 'einsetzen',
    swordId: 'atm11',
    arbeitsVerzeichnis: '/opt/minecraft/atm11',
    quelle: '/var/lib/armory-arsenal/packs/entpackt/armory-pack-k79c40',
    teile: ['mods', 'config'],
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.swordId, 'atm11');
  assert.deepEqual(r.teile, ['mods', 'config']);
});

test('eine Quelle ausserhalb des Pack-Ordners wird abgelehnt', () => {
  // Sonst darf die Armory das Arsenal bitten, /etc nach /opt/minecraft zu
  // kopieren - root-Helfer hin oder her, das ist der Weg zum Ueberschreiben
  // beliebiger Ziele.
  for (const boese of [
    '/etc',
    '/etc/nginx',
    '/var/lib/armory-arsenal/packs/entpackt/../../../etc',
    '/var/lib/armory-arsenal/packs/entpackt/armory-pack-x/../../..',
    '/root',
  ]) {
    const r = validateEinsetzen({ type: 'einsetzen', swordId: 'atm11', arbeitsVerzeichnis: '/opt/minecraft/atm11', quelle: boese, teile: ['mods'] });
    assert.equal(r.ok, false, `durchgelassen: ${boese}`);
    assert.equal(r.reason, 'bad-quelle', `falscher Grund fuer ${boese}: ${r.reason}`);
  }
});

test('ein Teilname darf kein Pfad sein', () => {
  // 'teile' sind Eintraege IM Pack (mods, config, ...). Ein Pfad oder '..'
  // wuerde aus dem Zielordner ausbrechen.
  for (const boese of ['../etc', 'mods/../..', '/etc/passwd', '', '.', '..', 'mods/x']) {
    const r = validateEinsetzen({
      type: 'einsetzen', swordId: 'atm11',
      arbeitsVerzeichnis: '/opt/minecraft/atm11',
      quelle: EINSETZ_ORDNER + '/armory-pack-k79c40', teile: [boese],
    });
    assert.equal(r.ok, false, `Teil durchgelassen: ${JSON.stringify(boese)}`);
    assert.equal(r.reason, 'bad-teil', `falscher Grund fuer ${JSON.stringify(boese)}: ${r.reason}`);
  }
});

test('mindestens ein Teil, hoechstens eine sinnvolle Zahl', () => {
  const ohne = validateEinsetzen({ type: 'einsetzen', swordId: 'atm11', arbeitsVerzeichnis: '/opt/minecraft/atm11', quelle: EINSETZ_ORDNER + '/armory-pack-k79c40', teile: [] });
  assert.equal(ohne.ok, false);
  assert.equal(ohne.reason, 'keine-teile');

  const viele = validateEinsetzen({
    type: 'einsetzen', swordId: 'atm11', arbeitsVerzeichnis: '/opt/minecraft/atm11', quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
    teile: Array.from({ length: 41 }, (_, i) => `d${i}`),
  });
  assert.equal(viele.ok, false);
  assert.equal(viele.reason, 'zu-viele-teile');
});

test('doppelte Teile werden zusammengefasst, nicht doppelt kopiert', () => {
  const r = validateEinsetzen({
    type: 'einsetzen', swordId: 'atm11', arbeitsVerzeichnis: '/opt/minecraft/atm11', quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
    teile: ['mods', 'mods', 'config', 'mods'],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.teile, ['mods', 'config']);
});

test('der Sword-Name wird wie beim Install geprueft', () => {
  for (const boese of ['a', 'Atm11', 'atm 11', '../x', 'atm/11', '']) {
    const r = validateEinsetzen({ type: 'einsetzen', swordId: boese, quelle: EINSETZ_ORDNER + '/armory-pack-k79c40', teile: ['mods'] });
    assert.equal(r.ok, false, `Sword durchgelassen: ${JSON.stringify(boese)}`);
    assert.equal(r.reason, 'bad-sword');
  }
});

test('die Sicherung steht VOR dem Kopieren - erzwungen, nicht als Option', async () => {
  // Der teuerste denkbare Fehler: Welt ueberschrieben, keine Sicherung.
  // Ein Test, der nur prueft, dass eine Sicherungsfunktion existiert, bliebe
  // gruen, wenn der Aufrufweg sie nie erreicht.
  const i = quelle.indexOf('export async function sichereVorEinsetzen');
  assert.ok(i > 0, 'sichereVorEinsetzen fehlt');

  // Der Aufrufweg im Agenten muss die Sicherung zuerst nennen.
  //
  // Der erste Anlauf prueft globalThis.__runQuelle - das nie jemand setzt,
  // also war der Test GRUEN OHNE ZU PRUEFEN. Jetzt wird die Datei gelesen.
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const j = run.indexOf('async function setzeEin');
  assert.ok(j > 0, 'setzeEin fehlt im Agenten');
  const rumpf = run.slice(j, j + 4000);
  const iSich = rumpf.indexOf('sichereVorEinsetzen');
  const iKopie = rumpf.indexOf("'replace-pack'");
  assert.ok(iSich > 0, 'setzeEin sichert nicht');
  assert.ok(iKopie > 0, 'setzeEin kopiert nicht');
  assert.ok(iSich < iKopie, 'es wird kopiert, bevor gesichert ist');
});

// --- Die zwei Luecken, die die Mutationen aufgedeckt haben ----------------
// Beide wurden erst durch eine Mutation sichtbar, nicht durch Nachdenken.

test('eine gescheiterte Sicherung bricht ab - es geht NICHT weiter', async () => {
  // Mutation "if (!sich.ok) -> if (false && !sich.ok)" blieb gruen: der Test
  // oben prueft nur die REIHENFOLGE im Quelltext. Dass ein Fehler bei der
  // Sicherung auch wirklich stoppt, war unbewacht. Genau der Fall, der eine
  // Welt ohne Rueckweg hinterlaesst.
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const j = run.indexOf('async function setzeEin');
  const rumpf = run.slice(j, j + 4000);

  const iSich = rumpf.indexOf('const sich = await sichereVorEinsetzen');
  assert.ok(iSich > 0, 'Sicherung fehlt');
  const rest = rumpf.slice(iSich);

  // Nach der Sicherung MUSS eine Pruefung kommen, die bei Mißerfolg abbricht
  // (return), und zwar VOR dem ersten replace-pack.
  const iPruef = rest.indexOf('if (!sich.ok)');
  assert.ok(iPruef > 0, 'die Sicherung wird nicht geprueft - sie darf scheitern');
  const pruefBlock = rest.slice(iPruef, iPruef + 500);
  assert.match(pruefBlock, /return;/, 'bei gescheiterter Sicherung wird nicht abgebrochen');

  const iKopie = rest.indexOf("'replace-pack'");
  assert.ok(iPruef < iKopie, 'die Pruefung steht nach dem Kopieren');
  // Und die Pruefung darf nicht mit false entschaerft sein.
  assert.doesNotMatch(pruefBlock, /if\s*\(\s*false\s*&&/, 'die Pruefung ist abgeschaltet');
});

test('ein Teil mit ".." wird abgelehnt', () => {
  // Mutation "if (t.includes('..')) return false entfernen" blieb gruen, weil
  // die uebrigen Regeln zufaellig schon zuschlugen: 'mods/..' faellt an '/',
  // '../etc' an '/'. Ein Name wie 'mods..old' haette sie aber passiert - kein
  // Ausbruch, aber auch kein Eintrag, den es im Pack gibt.
  const r = validateEinsetzen({
    type: 'einsetzen', swordId: 'atm11',
    arbeitsVerzeichnis: '/opt/minecraft/atm11',
    quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
    teile: ['mods..old'],
  });
  assert.equal(r.ok, false, "Teil 'mods..old' wurde durchgelassen");
  assert.equal(r.reason, 'bad-teil');
});

// --- Der Arbeitsordner kommt aus der Nachricht, aber geprueft -------------
// Der erste Anlauf las cfg.swords - ein Feld, das es in arsenal.json NICHT
// gibt. Jeder Auftrag waere mit "unbekannter-sword" abgebrochen, und kein Test
// wurde rot, weil er nur den Quelltext las. Live nachgesehen: die Konfiguration
// hat genau id, key, url.

test('ein Arbeitsordner ausserhalb der erlaubten Wurzeln wird abgelehnt', () => {
  for (const boese of ['/etc', '/root', '/opt/minecraft/../etc', '/var/lib/armory-arsenal', 'relativ/pfad', '']) {
    const r = validateEinsetzen({
      type: 'einsetzen', swordId: 'atm11',
      arbeitsVerzeichnis: '/opt/minecraft/atm11',
      quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
      arbeitsVerzeichnis: boese,
      teile: ['mods'],
    });
    assert.equal(r.ok, false, `Arbeitsordner durchgelassen: ${JSON.stringify(boese)}`);
  }
});

test('der Arbeitsordner muss ein Sword-Ordner sein, nicht die Wurzel', () => {
  // /opt/minecraft selbst waere der Elternordner aller Swords - dort zu
  // ersetzen wuerde alle Instanzen treffen.
  const r = validateEinsetzen({
    type: 'einsetzen', swordId: 'atm11',
    arbeitsVerzeichnis: '/opt/minecraft/atm11',
    quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
    arbeitsVerzeichnis: '/opt/minecraft',
    teile: ['mods'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-arbeitsverzeichnis');
});

test('ein gueltiger Arbeitsordner wird durchgereicht', () => {
  const r = validateEinsetzen({
    type: 'einsetzen', swordId: 'atm11',
    arbeitsVerzeichnis: '/opt/minecraft/atm11',
    quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
    arbeitsVerzeichnis: '/opt/minecraft/atm11',
    teile: ['mods'],
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.arbeitsVerzeichnis, '/opt/minecraft/atm11');
});

test('der Agent liest den Arbeitsordner NICHT aus cfg.swords', async () => {
  // Genau der Fehler von oben. Ein cfg.swords gibt es nicht; wer es spaeter
  // wieder einbaut, faellt hier auf.
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const j = run.indexOf('async function setzeEin');
  const rumpf = run.slice(j, j + 4000);
  // Nur echte ZUGRIFFE zaehlen, keine Kommentarzeilen: der Kommentar erklaert
  // den Fehler und nennt den Namen. Der erste Anlauf prueft den ganzen
  // Ausschnitt und wurde deshalb rot, obwohl der Code richtig war - ein Test,
  // der die Erklaerung mitbestraft, laedt dazu ein, die Erklaerung zu loeschen.
  const ohneKommentar = rumpf
    .split('\n')
    .filter((z) => !z.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(ohneKommentar, /cfg\.swords/, 'setzeEin liest cfg.swords - das Feld gibt es nicht');
  assert.match(rumpf, /p\.arbeitsVerzeichnis/, 'der gepruefte Arbeitsordner wird nicht benutzt');
});

test('ein Arbeitsordner tiefer als der Sword-Ordner wird abgelehnt', () => {
  // Mutation "rest.includes('/') entfernen" blieb gruen: kein Test schickte
  // einen Pfad UNTER dem Sword. Genau der Fall, in dem replace-pack den
  // Ordner 'mods' neben sich selbst ersetzt und der Server danach keine Mods
  // mehr hat - ohne dass irgendwo ein Fehler auftaucht.
  for (const boese of ['/opt/minecraft/atm11/mods', '/opt/minecraft/atm11/config', '/opt/minecraft/a/b']) {
    const r = validateEinsetzen({
      type: 'einsetzen', swordId: 'atm11',
      quelle: EINSETZ_ORDNER + '/armory-pack-k79c40',
      arbeitsVerzeichnis: boese,
      teile: ['mods'],
    });
    assert.equal(r.ok, false, `Arbeitsordner durchgelassen: ${boese}`);
    assert.equal(r.reason, 'bad-arbeitsverzeichnis');
  }
});

// --- Die Route muss die Pruefung auch BENUTZEN --------------------------
// Genau der Fehler, der in diesem Projekt am haeufigsten war: die Funktion ist
// richtig, aber die Route ruft sie nicht auf. Der Endpunkt wuerde dann alles
// weiterreichen, was ankommt.

const routeQuelle = await readFile(new URL('../app/arsenalRoutes.js', import.meta.url), 'utf8');

test('die Route einsetzen ruft validateEinsetzen auf', () => {
  const i = routeQuelle.indexOf("if (action === 'einsetzen')");
  assert.ok(i > 0, 'kein einsetzen-Zweig in der Route');
  const rumpf = routeQuelle.slice(i, i + 2500);
  assert.match(rumpf, /validateEinsetzen\(/, 'die Route prueft den Auftrag nicht');
});

test('die Route nimmt den Arbeitsordner NICHT aus dem Request', () => {
  // Kaeme er vom Client, waere die Route eine Weiterleitung beliebiger Pfade
  // an einen root-Helfer - die Pruefung saehe nur gut aus.
  const i = routeQuelle.indexOf("if (action === 'einsetzen')");
  const rumpf = routeQuelle.slice(i, i + 2500);
  assert.match(rumpf, /arbeitsVerzeichnis:\s*schwert\.control\?\.workingDir/,
    'Arbeitsordner kommt nicht aus der Sword-Datei (control.workingDir)');
  assert.doesNotMatch(rumpf, /arbeitsVerzeichnis\s*\}\s*=\s*req\.body/, 'Arbeitsordner kommt aus dem Request');
});

test('die Route prueft, ob der Sword auf diesem Arsenal liegt', () => {
  // Sonst schiebt die Armory ein Pack auf eine Maschine, auf der der Sword
  // gar nicht laeuft - und ueberschreibt dort womoeglich einen anderen.
  const i = routeQuelle.indexOf("if (action === 'einsetzen')");
  const rumpf = routeQuelle.slice(i, i + 2500);
  assert.match(rumpf, /Number\(schwert\.arsenal\)\s*!==\s*id/, 'das Arsenal des Swords wird nicht geprueft');
});

test('einsetzen steht in der Aktionsliste der Route', () => {
  const m = /const ERLAUBTE_AKTIONEN = \[([^\]]+)\];/.exec(routeQuelle);
  assert.ok(m, 'ERLAUBTE_AKTIONEN fehlt');
  assert.match(m[1], /'einsetzen'/, 'einsetzen fehlt in der Whitelist');
});

// --- Live am 2026-11-09 gefunden: der Helfer lehnt den Pack-Ordner ab ----
// Der ganze Weg war gebaut, die Pruefung guelte, und dann:
//   "Quelle muss unter /tmp liegen: /var/lib/armory-arsenal/packs/entpackt/armory-pack-k79c40/mods"
// replace-pack liess als Quelle NUR /tmp zu, waehrend einsetzen bewusst aus
// PACK_ORDNER liest (weil der Agent PrivateTmp=yes hat und sein /tmp mit dem
// Dienst verschwindet). Zwei richtige Entscheidungen, die zusammen nicht
// funktionieren. Kein Test konnte das sehen - beide Seiten waren fuer sich
// korrekt.

test('der Helfer erlaubt das Packverzeichnis als Quelle', async () => {
  // Der Test liest den Helfer im Repo, nicht die installierte Kopie: nur so
  // faellt eine Aenderung auf, die jemand nur an einer Stelle macht.
  const helfer = await readFile(new URL('../agent/armory-install-helper', import.meta.url), 'utf8')
    .catch(() => '');
  if (!helfer) {
    // Liegt der Helfer nicht im Repo, ist dieser Test nicht pruefbar. Er darf
    // dann NICHT stillschweigend gruen sein.
    assert.fail('armory-install-helper nicht im Repo - Vertrag mit dem Agenten nicht pruefbar');
  }
  const i = helfer.indexOf('replace-pack)');
  assert.ok(i > 0, 'replace-pack fehlt im Helfer');
  const rumpf = helfer.slice(i, i + 2000);
  assert.match(
    rumpf,
    /\/var\/lib\/armory-arsenal\/packs\/entpackt\/\*/,
    'replace-pack erlaubt das Packverzeichnis nicht - einsetzen scheitert immer',
  );
});

test('die erlaubte Quelle im Helfer ist genau PACK_ORDNER', async () => {
  // Zwei Stellen, die denselben Pfad kennen: logic.js (PACK_ORDNER) und der
  // Helfer. Laufen sie auseinander, scheitert jeder Auftrag erst im Betrieb.
  const { PACK_ORDNER: ordner } = await import('../agent/logic.js');
  const helfer = await readFile(new URL('../agent/armory-install-helper', import.meta.url), 'utf8');
  const i = helfer.indexOf('replace-pack)');
  const rumpf = helfer.slice(i, i + 2000);
  assert.ok(rumpf.includes(`${ordner}/*`), `Helfer kennt ${ordner} nicht als Quelle`);
});

test('die Route liest den Arbeitsordner aus control.workingDir', () => {
  // Live am 2026-11-09 gefunden: der Sword hat kein Feld "workingDir", sondern
  // "control": { "workingDir": "/opt/minecraft/atm11" }. Meine Route las
  // schwert.workingDir - immer undefined -, und jeder Auftrag endete mit
  // "bad-arbeitsverzeichnis", sah aber wie ein Pruefungsfehler des Nutzers aus.
  const i = routeQuelle.indexOf("if (action === 'einsetzen')");
  const rumpf = routeQuelle.slice(i, i + 2500);
  assert.match(
    rumpf,
    /schwert\.control\?\.workingDir|schwert\.control\.workingDir/,
    'der Arbeitsordner kommt nicht aus control.workingDir',
  );
  assert.doesNotMatch(
    rumpf.split('\n').filter((z) => !z.trim().startsWith('//')).join('\n'),
    /arbeitsVerzeichnis:\s*schwert\.workingDir/,
    'schwert.workingDir gibt es nicht - der Wert ist immer undefined',
  );
});

test('einsetzen steht in BEIDEN Aktionslisten des Agenten', async () => {
  // Live am 2026-11-09: "bad-action" aus dem Agenten, obwohl die Armory den
  // Auftrag durchgelassen hatte. Die Armory-Whitelist (arsenalRoutes.js) hatte
  // 'einsetzen', die Agenten-Whitelist (ALLOWED_ACTIONS in logic.js) nicht.
  //
  // Bei einer neuen Aktion sind es VIER Stellen: Armory-Route, Agenten-Liste,
  // OHNE_DIENST (sonst wird ein Dienstname verlangt) und der Verteiler in
  // run.js. Diese Pruefung deckt die beiden Listen ab - die anderen beiden
  // stehen in den Tests weiter oben.
  const { ALLOWED_ACTIONS, OHNE_DIENST } = await import('../agent/logic.js');
  assert.ok(ALLOWED_ACTIONS.includes('einsetzen'),
    'ALLOWED_ACTIONS kennt einsetzen nicht - der Agent antwortet "bad-action"');
  assert.ok(OHNE_DIENST.includes('einsetzen'),
    'OHNE_DIENST kennt einsetzen nicht - es wuerde ein Dienstname verlangt');
});

test('setzeEin benutzt die Auftragsliste so, wie es sie gibt', async () => {
  // Live am 2026-11-09: der Agent loggte "Befehl: einsetzen" und danach NICHTS.
  // Kein Fortschritt, kein Abbruch, keine Meldung an die Armory - der Request
  // war mit ok:true beantwortet, die Arbeit passierte nie.
  //
  // Ursache: ich hatte auftraege.starte(id, art) geschrieben. Die Liste hat
  // aber nur anlegen({ art, titel }), setzeFortschritt(id, …) und beende(id, …).
  // starte() gibt es nicht, der Aufruf warf, und der Fehler verschwand im
  // catch - der catch rief selbst wieder auftraege.beende(auftrag.id, …), wo
  // auftrag nie zugewiesen wurde.
  //
  // Ein Test, der die Route ausfuehrt, haette das sofort gezeigt. Ohne echten
  // Agenten geht hier der Vergleich mit der echten Liste.
  const { erstelleAuftragsliste } = await import('../app/arsenalJobs.js');
  const liste = erstelleAuftragsliste();
  for (const name of ['anlegen', 'setzeFortschritt', 'beende']) {
    assert.equal(typeof liste[name], 'function', `Auftragsliste hat kein ${name}`);
  }
  assert.equal(liste.starte, undefined, 'Auftragsliste hat doch ein starte() - Test anpassen');

  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const j = run.indexOf('async function setzeEin');
  const rumpf = run.slice(j, j + 4000);
  const ohneKommentar = rumpf.split('\n').filter((z) => !z.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(ohneKommentar, /auftraege\.starte\(/, 'setzeEin ruft auftraege.starte() - das gibt es nicht');
  assert.match(ohneKommentar, /auftraege\.anlegen\(\{/, 'setzeEin legt keinen Auftrag an');
});

test('setzeEin faengt Fehler, ohne selbst zu werfen', async () => {
  // Der catch rief auftraege.beende(auftrag.id, …) - mit auftrag ausserhalb
  // des try deklariert, im catch also erreichbar. Wird die Deklaration aber je
  // nach innen gezogen, wirft der catch erneut und der Fehler ist stumm.
  const run = await readFile(new URL('../agent/run.js', import.meta.url), 'utf8');
  const j = run.indexOf('async function setzeEin');
  const rumpf = run.slice(j, j + 4000);
  assert.match(rumpf, /catch \(err\)/, 'kein catch in setzeEin');
  // Im catch darf nicht auf eine im try deklarierte Variable zugegriffen werden.
  const iCatch = rumpf.indexOf('catch (err)');
  const catchBlock = rumpf.slice(iCatch, iCatch + 800);
  assert.match(catchBlock, /sende\(\{/, 'der catch meldet nichts an die Armory');
});
