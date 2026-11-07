// Tests für die Anzeige von Racks im Shop und in der Rack-Verwaltung
// (public/app.js), Stand 2026-11-07.
//
// Ausgangslage: Beide Stellen zeigten fest `r.game` als Badge und
// `r.installMethod · r.defaultRoot` als Metazeile. Ein Dienst-Rack
// (kind 'service', z.B. Nextcloud) hat diese Felder nicht - live belegt:
//
//   <span class="badge">undefined</span>
//   Dateien, Deck, Kalender ... · undefined ·
//
// Das ist kein Schoenheitsfehler: "undefined" ist die Aussage "hier steht
// nichts", und der Nutzer soll "Dienst" lesen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const appUrl = new URL('../public/app.js', import.meta.url);

async function quelle() {
  return await readFile(appUrl, 'utf8');
}

test('es gibt eine gemeinsame Funktion fuer die Rack-Beschriftung', async () => {
  const q = await quelle();
  assert.match(q, /function rackKindBadge\b/,
    'eine Funktion fuer das Badge muss es geben - sonst stehen zwei Stellen wieder getrennt');
  assert.match(q, /function rackMetaLine\b/,
    'eine Funktion fuer die Metazeile muss es geben');
});

test('die Badge-Funktion kennt Dienst-Racks', async () => {
  const q = await quelle();
  const start = q.indexOf('function rackKindBadge');
  assert.ok(start > 0, 'rackKindBadge fehlt');
  const rumpf = q.slice(start, q.indexOf('\n}', start) + 2);
  assert.match(rumpf, /service/,
    'die Badge-Funktion muss kind "service" behandeln');
  assert.match(rumpf, /Dienst/,
    'fuer einen Dienst muss "Dienst" dastehen, nicht "undefined"');
});

test('kein festes r.game-Badge mehr im Rack-Rendering', async () => {
  const q = await quelle();
  // Die alte Zeile stand einmal im Shop. Sie darf nicht mehr vorkommen -
  // sonst zeigt ein Dienst-Rack wieder "undefined".
  const alteBadge = /<span class="badge">\$\{esc\(r\.game\)\}<\/span>/;
  assert.ok(!alteBadge.test(q),
    'das Badge muss ueber rackKindBadge() laufen, nicht fest ueber r.game');
});

test('die Metazeile laesst fehlende Felder weg statt "undefined"', async () => {
  const q = await quelle();
  const start = q.indexOf('function rackMetaLine');
  assert.ok(start > 0);
  const rumpf = q.slice(start, q.indexOf('\n}', start) + 2);
  // Fuer Dienst-Racks darf installMethod/defaultRoot nicht auftauchen.
  assert.match(rumpf, /service|kind/,
    'die Metazeile muss die Art beruecksichtigen');
  assert.match(rumpf, /filter\(Boolean\)|\.filter\(/,
    'leere Teile muessen wegfallen, sonst entstehen "· ·"-Ketten');
});

test('Dienst-Racks zeigen ihren Kern statt Installer-Angaben', async () => {
  const q = await quelle();
  const start = q.indexOf('function rackMetaLine');
  const rumpf = q.slice(start, q.indexOf('\n}', start) + 2);
  // Bei Diensten ist die Port-Angabe die sinnvolle Information.
  assert.match(rumpf, /port/i,
    'ein Dienst-Rack hat Ports, keine Installationswurzel');
});

// --- Beweis mit echten Racks --------------------------------------------------
//
// Die Funktionen werden aus dem Quelltext geholt und in einem eigenen Kontext
// ausgewertet - nicht nachgebaut. Eine Nachbildung wuerde nur beweisen, dass
// die Nachbildung stimmt.

async function ladeAnzeige() {
  const q = await quelle();
  // Die Funktion endet bei der ERSTEN Zeile, die nur aus "}" besteht und
  // dabei weniger eingerueckt ist als der Rumpf. Ein blosses indexOf('\n}\n')
  // schneidet zu weit und reisst den naechsten Block mit (erster Versuch:
  // "Identifier 'configSword' has already been declared").
  const stueck = (name) => {
    const zeilen = q.split('\n');
    const start = zeilen.findIndex((z) => z.includes(`function ${name}(`));
    assert.ok(start >= 0, `${name} nicht gefunden`);
    const einrueckung = zeilen[start].match(/^ */)[0].length;
    let ende = start + 1;
    for (; ende < zeilen.length; ende += 1) {
      const z = zeilen[ende];
      if (z.trim() === '}' && z.match(/^ */)[0].length === einrueckung) break;
    }
    assert.ok(ende < zeilen.length, `Ende von ${name} nicht gefunden`);
    return zeilen.slice(start, ende + 1).join('\n');
  };
  const ctx = vm.createContext({ console });
  vm.runInContext(
    'function esc(s){return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;");}\n'
    + stueck('rackKindBadge') + '\n' + stueck('rackMetaLine')
    + '\n; this.badge = rackKindBadge; this.meta = rackMetaLine;',
    ctx,
  );
  return ctx;
}

test('ein Dienst-Rack rendert "Dienst" und den Port, kein undefined', async () => {
  const ctx = await ladeAnzeige();
  const nc = {
    kind: 'service', id: 'nextcloud', name: 'Nextcloud',
    description: 'Dateien, Deck, Kalender', ports: { web: 8088 },
  };
  const badge = ctx.badge(nc);
  const meta = ctx.meta(nc);

  assert.match(badge, /Dienst/, 'Badge muss "Dienst" zeigen');
  assert.ok(!/undefined/.test(badge), `Badge enthaelt undefined: ${badge}`);
  assert.ok(!/undefined/.test(meta), `Metazeile enthaelt undefined: ${meta}`);
  assert.match(meta, /8088/, 'der Port ist die sinnvolle Angabe fuer einen Dienst');
});

test('ein Spiel-Rack rendert unveraendert Spiel, Methode und Wurzel', async () => {
  const ctx = await ladeAnzeige();
  const atm = {
    kind: 'game', id: 'atm11', name: 'ATM11', description: 'Pack',
    game: 'minecraft', installMethod: 'zip', defaultRoot: '/opt/minecraft',
  };
  assert.match(ctx.badge(atm), /minecraft/,
    'Spiel-Racks zeigen weiter ihr Spiel - Bestand darf sich nicht aendern');
  const meta = ctx.meta(atm);
  assert.match(meta, /zip/);
  assert.match(meta, /\/opt\/minecraft/);
});

test('ein Bestands-Rack ohne kind verhaelt sich wie ein Spiel-Rack', async () => {
  const ctx = await ladeAnzeige();
  const alt = { game: '7d2d', installMethod: 'steamcmd', defaultRoot: '/opt/7d2d' };
  assert.match(ctx.badge(alt), /7d2d/);
  assert.match(ctx.meta(alt), /steamcmd/);
});

test('ohne Port entstehen keine leeren Trenner in der Metazeile', async () => {
  const ctx = await ladeAnzeige();
  // Ein Dienst-Rack ohne ports: der Port-Teil faellt weg. Ohne filter(Boolean)
  // bliebe "Dateien ·  · " stehen (Mutation M2 blieb sonst gruen).
  const nc = { kind: 'service', name: 'Nextcloud', description: 'Dateien' };
  const meta = ctx.meta(nc);
  assert.equal(meta, 'Dateien', `erwartet "Dateien", kam "${meta}"`);
  assert.ok(!/·\s*·/.test(meta), `leere Trenner in "${meta}"`);
  assert.ok(!/undefined/.test(meta));
});

test('ein Spiel-Rack ohne defaultRoot haengt kein " · " an', async () => {
  const ctx = await ladeAnzeige();
  const r = { game: 'minecraft', installMethod: 'zip', description: 'Pack' };
  const meta = ctx.meta(r);
  assert.ok(!meta.endsWith('·'), `Metazeile endet mit Trenner: "${meta}"`);
  assert.equal(meta, 'Pack · zip');
});

test('eine fehlende description laesst keinen fuehrenden Trenner stehen', async () => {
  const ctx = await ladeAnzeige();
  // Das ist der EINZIGE Fall, in dem filter(Boolean) wirklich etwas tut: die
  // description geht immer als erster Teil hinein ('' wenn leer). Ohne Filter
  // entsteht " · zip" - live nachgemessen bei der Mutation.
  const meta = ctx.meta({ kind: 'game', installMethod: 'zip' });
  assert.equal(meta, 'zip', `erwartet "zip", kam "${meta}"`);
  assert.ok(!meta.startsWith('·'), `Metazeile beginnt mit Trenner: "${meta}"`);
});

// --- Rueckmeldung beim Steuern (start/stop/restart) --------------------------
//
// Ausgangslage 2026-11-07: Der Knopf wurde beim Klick deaktiviert, aber ohne
// sichtbare Aenderung. Beim Stop von Nextcloud vergingen ~3 Sekunden, in denen
// die Seite aussah wie vorher - der Nutzer wusste nicht, ob der Klick ankam.

test('es gibt eine Funktion fuer den Steuer-Text', async () => {
  const q = await quelle();
  assert.match(q, /function steuerText\b/,
    'die Beschriftung beim Steuern gehoert in EINE Funktion, nicht in den Handler');
});

test('der Text nennt die laufende Aktion im Partizip', async () => {
  const q = await quelle();
  const start = q.indexOf('function steuerText');
  assert.ok(start > 0);
  const rumpf = q.slice(start, q.indexOf('\n      }\n', start) + 8);
  for (const wort of ['Wird gestoppt', 'Wird gestartet', 'Wird neu gestartet']) {
    assert.ok(rumpf.includes(wort), `"${wort}" fehlt in steuerText`);
  }
});

test('der Klick-Handler zeigt den Text und stellt ihn danach wieder her', async () => {
  const q = await quelle();
  const anker = q.indexOf("card.querySelectorAll('[data-a]')");
  assert.ok(anker > 0, 'der Steuer-Handler fehlt');
  const rumpf = q.slice(anker, q.indexOf('swordsEl.appendChild(card)', anker));

  assert.match(rumpf, /steuerText\(/, 'der Handler muss steuerText benutzen');
  assert.match(rumpf, /btn\.textContent\s*=/, 'der Knopftext muss gesetzt werden');
  // Der urspruengliche Text muss gerettet werden - sonst steht danach
  // "Wird gestoppt" dauerhaft am Knopf.
  // ERSTER VERSUCH WAR ZU SCHWACH: geprueft wurde nur, dass irgendwo
  // "urtext =" steht. Die Mutation, die das Zuruecksetzen entfernt, blieb
  // damit gruen. Jetzt muss die ZUWEISUNG AN textContent im finally stehen.
  const sicherung = /const\s+(\w+)\s*=\s*btn\.textContent/.exec(rumpf);
  assert.ok(sicherung, 'der Originaltext muss gesichert werden');
  const name = sicherung[1];
  const imFinally = rumpf.slice(rumpf.indexOf('} finally {'));
  assert.match(imFinally, new RegExp(`btn\\.textContent\\s*=\\s*${name}`),
    `im finally muss btn.textContent = ${name} stehen, sonst bleibt "Wird gestoppt" stehen`);
});
