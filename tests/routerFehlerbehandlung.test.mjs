// Ein Fehler in einer Route darf die VERBINDUNG nicht ohne Antwort lassen.
//
// Live am 2026-11-09 gefunden: ein POST auf /api/arsenals/6/command mit
// action=einsetzen gab kein einziges Byte zurueck - kein 500, kein Fehlertext,
// gar nichts. curl stand 20 Sekunden und brach ab.
//
// Ursache: installRouter wird per wrapRouter() abgesichert, arsenalRouter
// nicht. Express 4 faengt abgelehnte Promises in async-Handlern NICHT ab; der
// Fehler geht an den Prozess, die Verbindung bleibt offen, und im Panel sieht
// es aus, als haette der Server nie geantwortet.
//
// Diese Datei prueft ALLE Router, nicht nur den einen - der naechste Router
// haette sonst dasselbe Problem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const ORDNER = new URL('../app/', import.meta.url);

test('jeder Router mit async-Handlern wird gewrappt', async () => {
  const dateien = (await readdir(ORDNER)).filter((f) => f.endsWith('Routes.js'));
  assert.ok(dateien.length >= 2, 'es sollten mindestens zwei Router-Dateien sein');

  const ohne = [];
  for (const f of dateien) {
    const src = await readFile(new URL(f, ORDNER), 'utf8');
    const hatAsync = /\.(get|post|put|delete|patch)\([^)]*async/m.test(src) || /async \(req/.test(src);
    if (!hatAsync) continue;
    if (!/wrapRouter\(/.test(src)) ohne.push(f);
  }
  assert.deepEqual(ohne, [], `Router ohne wrapRouter: ${ohne.join(', ')}`);
});

test('wrapRouter steht in jeder Router-Datei als Aufruf, nicht nur im Kommentar', async () => {
  const dateien = (await readdir(ORDNER)).filter((f) => f.endsWith('Routes.js'));
  for (const f of dateien) {
    const src = await readFile(new URL(f, ORDNER), 'utf8');
    if (!/async \(req/.test(src)) continue;
    // Ein Aufruf ist "wrapRouter(xxx);", nicht "// wrapRouter() macht ...".
    const ohneKommentar = src.split('\n').filter((z) => !z.trim().startsWith('//')).join('\n');
    assert.match(ohneKommentar, /wrapRouter\([a-zA-Z]+\);/, `${f}: kein wrapRouter-Aufruf`);
  }
});

// --- Jeder benutzte Name muss auch importiert sein ----------------------
// Live am 2026-11-09: "getSwords is not defined" als 500 im Panel. Die Route
// war fertig, die Pruefungen liefen, aber der Import fehlte - und weil der
// Router nicht gewrappt war, kam nicht mal DAS beim Client an.
//
// Ein Test, der die Route ausfuehrt, haette es sofort gezeigt. Ohne HTTP-Server
// geht das nicht; also wird hier der statische Weg genommen: jeder Aufruf
// einer exportierten Funktion muss in der Datei importiert oder deklariert sein.

test('aufgerufene Funktionen sind importiert (kein "is not defined" im Betrieb)', async () => {
  // Beschraenkt auf die ROUTER-Dateien. In control.js und installer.js sind
  // Rueckrufe wie onData/spawnFn/onLine Parameter, die als Objektfelder
  // uebergeben werden - ein Textmuster kann das nicht sicher unterscheiden und
  // meldete 10 Fehlalarme. Ein Test, der Fehlalarm gibt, wird abgeschaltet
  // statt beachtet; hier ist der Bereich dafuer zu gross.
  //
  // Die Frage "ist alles importiert" ist bei den Routern genau die richtige:
  // dort laufen HTTP-Handler, und ein fehlender Import ist eine 500 im Panel.
  const dateien = (await readdir(ORDNER)).filter((f) => f.endsWith('Routes.js'));
  const fehlend = [];

  for (const f of dateien) {
    const src = await readFile(new URL(f, ORDNER), 'utf8');
    const ohneKommentar = src
      .split('\n')
      .filter((z) => !z.trim().startsWith('//') && !z.trim().startsWith('*'))
      .join('\n');

    // Was die Datei importiert
    const importiert = new Set();
    for (const m of ohneKommentar.matchAll(/import\s+(?:([\w*{}\s,]+?))\s+from/g)) {
      for (const teil of m[1].replace(/[{}*]/g, ' ').split(',')) {
        const name = teil.trim().split(/\s+as\s+/).pop().trim();
        if (name && name !== 'default') importiert.add(name);
      }
    }
    // Dynamische Importe: const { createWriteStream } = await import('node:fs')
    // Die sind genauso vorhanden, nur nicht in der Kopfzeile. Ohne diesen Block
    // meldete der Test sie als fehlend - falscher Alarm, und ein Test, der
    // Fehlalarm gibt, wird abgeschaltet statt beachtet.
    for (const m of ohneKommentar.matchAll(/const\s*\{([^}]+)\}\s*=\s*await\s+import\(/g)) {
      for (const teil of m[1].split(',')) {
        const name = teil.trim().split(':').pop().trim().split(/\s+as\s+/).pop().trim();
        if (name) importiert.add(name);
      }
    }

    // Was sie selbst deklariert
    for (const m of ohneKommentar.matchAll(/(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
      importiert.add(m[1]);
    }
    // Was sie als Parameter bekommt (grob, deckt die wichtigsten Faelle)
    for (const m of ohneKommentar.matchAll(/(?:\(|,)\s*([A-Za-z_$][\w$]*)\s*(?:[,)=])/g)) {
      importiert.add(m[1]);
    }
    for (const m of ohneKommentar.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) importiert.add(m[1]);

    // Welche camelCase-Funktionen werden FREI aufgerufen - also ohne Punkt
    // davor? buf.writeUInt32BE() und hash.update() sind Methoden fremder
    // Objekte, nicht fehlende Importe. Der erste Anlauf nahm sie mit und
    // meldete 10 Treffer, von denen nur einer echt war.
    for (const m of ohneKommentar.matchAll(/(?<![.\w$])([a-z][a-zA-Z0-9]*[A-Z][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof'].includes(name)) continue;
      if (/^[A-Z]/.test(name)) continue;
      if (!importiert.has(name)) fehlend.push(`${f}: ${name}`);
    }
  }

  // Eingebaute Funktionen sind keine Modul-Funktionen. Der erste Anlauf
  // meldete toString, isFinite, isInteger, randomBytes - alles Sprache oder
  // node:crypto. Eine Liste ist hier ehrlicher als ein Muster, das zu viel
  // durchlaesst: was fehlt, wird hier eingetragen.
  const EINGEBAUT = new Set([
    'toString', 'isFinite', 'isInteger', 'isNaN', 'randomBytes', 'parseInt', 'parseFloat',
    'fromCharCode', 'now', 'stringify', 'assign', 'freeze', 'isArray', 'from', 'of',
    'hasOwnProperty', 'toISOString', 'getTime', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'queueMicrotask', 'encodeURIComponent',
    'decodeURIComponent', 'structuredClone', 'abort',
  ]);
  const echte = fehlend.filter((x) => !EINGEBAUT.has(x.split(': ')[1]));
  assert.deepEqual(echte.slice(0, 10), [], `nicht importiert: ${echte.slice(0, 10).join(', ')}`);
});
