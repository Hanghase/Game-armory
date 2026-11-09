// Game-Armory - Arsenal-Routen (Kopplung + Lebenszeichen)
//
// Eigener Router, wird in server.js unter /api gemountet.
//
//   POST /api/arsenals/pairing        (superuser) Kopplungscode erzeugen -> { code, expiresAt }
//   POST /api/arsenals/pair           (superuser) Code einloesen       -> { arsenal, key }
//   GET  /api/arsenals                (arsenal.read) Liste mit Zustand
//   POST /api/arsenals/:id/revoke     (arsenal.delete) Arsenal sperren
//   POST /api/arsenal/heartbeat       (Schluessel) Lebenszeichen vom Arsenal
//
// Die Reihenfolge der Kopplung ist bewusst umgedreht: das ARSENAL erzeugt den
// Code (POST /api/arsenals/pairing laeuft auf dem Arsenal), die ARMORY loest
// ihn ein. Dadurch muss am Arsenal kein Port nach aussen offen sein.
//
// Der Schluessel eines Arsenals wird genau EINMAL ausgegeben - beim Einloesen.
// Danach existiert nur noch sein Hash. Wer ihn verliert, muss neu koppeln.

import { Router } from 'express';

import { requirePerm } from './auth.js';
import {
  createPairing,
  redeemPairing,
  listArsenals,
  revokeArsenal,
  getArsenal,
  touchHeartbeat,
  pruneExpiredPairings,
} from './arsenalStore.js';
import { arsenalState, formatPairingCode, verifyHeartbeat } from './arsenals.js';
import { istVerbunden, frageArsenal, holeLeitung } from './arsenalSocket.js';
import { sendePull } from './arsenalTransferSend.js';
import { readUpload } from './uploads.js';
// Dieselbe Pruefung wie im Agenten - sonst laufen die zwei Seiten auseinander.
import { validateInstall, validateEinsetzen } from '../agent/logic.js';
import { getSwords } from './swords.js';
import { wrapRouter } from './routeWrap.js';

export const arsenalRouter = Router();

// --- Kopplungscode am Arsenal erzeugen --------------------------------------
// Laeuft auf dem ARSENAL. Deshalb requirePerm: nur ein angemeldeter
// Superuser der Armory darf hier einen Code erzeugen (der Agent ruft diesen
// Endpunkt lokal auf, nicht aus dem Internet).
arsenalRouter.post('/arsenals/pairing', requirePerm('arsenal.pair'), (req, res) => {
  const { code, expiresAt, ttlMinutes } = createPairing();
  res.json({
    code,
    codeFormatted: formatPairingCode(code),
    expiresAt,
    ttlMinutes,
  });
});

// --- Kopplungscode einloesen (Armory) ---------------------------------------
arsenalRouter.post('/arsenals/pair', requirePerm('arsenal.pair'), (req, res) => {
  const { code, name } = req.body ?? {};
  const result = redeemPairing({ code, name });

  if (!result.ok) {
    // Gleiche Antwort fuer "unbekannt" und "falsch": sonst liesse sich mit
    // geratenen Codes herausfinden, welche existieren.
    const status = result.reason === 'bad-name' ? 400 : 403;
    const text = result.reason === 'bad-name'
      ? 'Name fehlt oder ist zu lang (max. 64 Zeichen)'
      : result.reason === 'expired'
        ? 'Kopplungscode ist abgelaufen'
        : result.reason === 'already-used'
          ? 'Kopplungscode wurde bereits verwendet'
          : 'Kopplungscode ungültig';
    return res.status(status).json({ error: text, reason: result.reason });
  }

  // Der Schluessel geht EINMAL raus. Danach ist er in der DB nur noch ein Hash.
  res.status(201).json({
    arsenal: result.arsenal,
    key: result.key,
    hint: 'Schlüssel jetzt im Arsenal hinterlegen - er wird nicht erneut angezeigt.',
  });
});

// --- Liste --------------------------------------------------------------
arsenalRouter.get('/arsenals', requirePerm('arsenal.read'), (req, res) => {
  const now = Date.now();
  const rows = listArsenals().map((a) => ({
    id: a.id,
    name: a.name,
    state: arsenalState(a, now),
    lastSeenAt: a.last_seen_at,
    lastVersion: a.last_version,
    createdAt: a.created_at,
    revokedAt: a.revoked_at,
    // Bewusst NICHT ausgeliefert: key_hash. Der Hash hat keine Aufgabe in der
    // Anzeige und waere nur ein weiterer Anhaltspunkt.
  }));
  res.json({ arsenals: rows });
});

// --- Arsenal sperren --------------------------------------------------------
arsenalRouter.post('/arsenals/:id/revoke', requirePerm('arsenal.delete'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Ungültige Arsenal-ID' });
  }
  if (!getArsenal(id)) return res.status(404).json({ error: 'Arsenal nicht gefunden' });

  const changed = revokeArsenal(id);
  if (!changed) return res.status(409).json({ error: 'Arsenal war bereits gesperrt' });
  res.json({ ok: true });
});

// --- Befehl an ein Arsenal ---------------------------------------------------
// Schickt start/stop/restart/status durch die OFFENE Leitung und wartet auf
// die Antwort. Das Arsenal prueft den Befehl nochmal selbst gegen seine eigene
// Whitelist - hier wird nicht blind weitergereicht.
//
// Was von der Armory aus erreichbar ist: das Fernupdate und der NEUSTART DES
// ARSENALS SELBST.
//
// Start/Stop stehen bewusst NICHT hier (2026-11-09): ein Sword laeuft auf dem
// Arsenal und wird ueber die Racks bewegt. Das Arsenal ist die Maschine, die
// Racks traegt - kein Fernsteuerungszugang zu allem, was darauf laeuft.
//
// restart meint hier NICHT "Dienst X neu starten", sondern "der Agent haengt,
// starte ihn neu" (Felix: den Neustart fand er gut - er meinte das Arsenal,
// nicht die Dienste darauf). Die Bedeutung hat sich geaendert, nicht das Wort.
// Der Agent kann start/stop weiterhin (eigene Whitelist), die Armory bietet
// sie nicht mehr an. Weniger Angriffsflaeche ist der Zweck, nicht Bequemlichkeit.
// install (2026-11-09): ein gezogenes Paket auf dem Arsenal entpacken. Traegt
// pullId + swordId statt eines Dienstnamens - eigener Zweig weiter unten.
// Der Kommentar steht AUSSERHALB der Liste: Tests lesen sie als reine
// Aufzaehlung, und ein Kommentar darin wuerde mitgeparst.
const ERLAUBTE_AKTIONEN = ['update', 'restart', 'install', 'einsetzen'];

arsenalRouter.post('/arsenals/:id/command', requirePerm('arsenal.update'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Ungültige Arsenal-ID' });
  }
  if (!getArsenal(id)) return res.status(404).json({ error: 'Arsenal nicht gefunden' });

  const { action, service } = req.body ?? {};
  if (!ERLAUBTE_AKTIONEN.includes(action)) {
    return res.status(400).json({ error: 'Unbekannte Aktion' });
  }
  // install braucht keinen Dienst, sondern pullId + swordId. Geprueft wird
  // hier UND beim Agenten: die Route darf nichts weiterreichen, was sie
  // selbst nicht versteht - sonst wird sie zur Weiterleitung ungepruefter
  // Daten. Die Pruefung ist dieselbe (validateInstall), damit beide Seiten
  // nicht auseinanderlaufen.
  if (action === 'install') {
    const { pullId, swordId } = req.body ?? {};
    const p = validateInstall({ type: 'install', pullId, swordId });
    if (!p.ok) {
      return res.status(400).json({ error: 'Ungültiger Install-Befehl', grund: p.reason });
    }
    if (!istVerbunden(id)) {
      return res.status(409).json({ error: 'Arsenal ist nicht verbunden', grund: 'arsenal-offline' });
    }
    const ergebnis = await frageArsenal(id, { action: 'install', pullId: p.pullId, swordId: p.swordId });
    if (ergebnis.ok === false && ergebnis.error) {
      const status = ergebnis.error === 'timeout' ? 504 : 502;
      return res.status(status).json({ error: 'Arsenal antwortet nicht', grund: ergebnis.error });
    }
    // Angestossen, nicht fertig: das Entpacken kann Sekunden dauern. Das
    // Ergebnis kommt mit dem naechsten Lebenszeichen.
    return res.json({ ok: true, action: 'install', pullId: p.pullId, swordId: p.swordId });
  }

  // einsetzen kopiert aus dem entpackten Pack ins Spielverzeichnis. Braucht
  // keinen Dienstnamen, sondern Quelle + Arbeitsordner + Teile.
  //
  // Der Arbeitsordner wird HIER aus der Sword-Datei gelesen, nicht aus dem
  // Request: die Armory weiss, wo ihre Swords liegen. Kaeme der Pfad vom
  // Client, waere die Route eine Weiterleitung beliebiger Pfade an einen
  // root-Helfer.
  //
  // Die Sicherung passiert auf dem ARSENAL, kurz vor dem Kopieren. Hier wird
  // nur geprueft, ob der Auftrag vollstaendig ist.
  if (action === 'einsetzen') {
    const { swordId, quelle, teile } = req.body ?? {};
    const schwert = getSwords().find((x) => x.id === swordId);
    if (!schwert) {
      return res.status(404).json({ error: 'Sword nicht gefunden', grund: 'unbekannter-sword' });
    }
    // Liegt der Sword auf DIESEM Arsenal? Sonst schoebe die Armory ein Pack
    // auf eine Maschine, auf der der Sword gar nicht laeuft.
    if (Number(schwert.arsenal) !== id) {
      return res.status(409).json({
        error: 'Sword liegt nicht auf diesem Arsenal',
        grund: 'falsches-arsenal',
        swordArsenal: schwert.arsenal ?? null,
      });
    }
    const p = validateEinsetzen({
      type: 'einsetzen',
      swordId,
      quelle,
      // Der Pfad steht unter control, nicht oben: swords/atm11.sword.json hat
      // "control": { "workingDir": "/opt/minecraft/atm11" }. Ein schwert.workingDir
      // gibt es nicht - live am 2026-11-09 nachgesehen, nachdem jeder Auftrag mit
      // "bad-arbeitsverzeichnis" endete und wie ein Eingabefehler aussah.
      arbeitsVerzeichnis: schwert.control?.workingDir,
      teile,
    });
    if (!p.ok) {
      return res.status(400).json({ error: 'Ungültiger Einsetz-Befehl', grund: p.reason });
    }
    if (!istVerbunden(id)) {
      return res.status(409).json({ error: 'Arsenal ist nicht verbunden', grund: 'arsenal-offline' });
    }
    const ergebnis = await frageArsenal(id, {
      action: 'einsetzen',
      swordId: p.swordId,
      quelle: p.quelle,
      arbeitsVerzeichnis: p.arbeitsVerzeichnis,
      teile: p.teile,
    });
    if (ergebnis.ok === false && ergebnis.error) {
      const status = ergebnis.error === 'timeout' ? 504 : 502;
      return res.status(status).json({ error: 'Arsenal antwortet nicht', grund: ergebnis.error });
    }
    return res.json({
      ok: true,
      action: 'einsetzen',
      swordId: p.swordId,
      teile: p.teile,
      arbeitsVerzeichnis: p.arbeitsVerzeichnis,
    });
  }


  // update und restart betreffen das Arsenal selbst und brauchen keinen
  // Dienstnamen.
  if (action !== 'status' && action !== 'update' && action !== 'restart'
      && (typeof service !== 'string' || service.length === 0)) {
    return res.status(400).json({ error: 'Dienst fehlt' });
  }

  if (!istVerbunden(id)) {
    // Ehrlich sagen statt in einen Timeout laufen zu lassen.
    return res.status(409).json({ error: 'Arsenal ist nicht verbunden', error2: 'arsenal-offline' });
  }

  const ergebnis = await frageArsenal(id, { action, service });
  if (ergebnis.ok === false && ergebnis.error) {
    const status = ergebnis.error === 'timeout' ? 504 : 502;
    return res.status(status).json({ error: 'Arsenal antwortet nicht', grund: ergebnis.error });
  }
  // update liefert seine Angaben direkt (gestartet/von/auf), nicht als
  // Fliesstext. Die Antwort ist bewusst "angestossen": der Rechner ist
  // danach kurz weg, das Ergebnis kommt beim naechsten Lebenszeichen.
  res.json({
    ok: true,
    action,
    service: service ?? null,
    output: ergebnis.output ?? null,
    ...(ergebnis.update ? { update: ergebnis.update } : {}),
  });
});

  // --- Datei auf ein Arsenal ziehen -----------------------------------------
  //
  // Der Weg, den Felix gewaehlt hat: die ZIP liegt auf der Armory (per Upload),
  // das Arsenal ZIEHT sie. Die Armory faengt an, weil das Arsenal sie danach
  // fragt - "bereit" oeffnet das Fenster, vorher geht nichts raus.
  //
  // Warum nicht "Armory schickt von sich aus": wer die Armory uebernimmt,
  // koennte sonst jedem Arsenal Dateien hinschieben. Der Pull haengt an einer
  // Anfrage des Arsenals, nicht an einem Befehl der Armory. Das ist derselbe
  // Gedanke wie beim Handshake: der Agent baut die Verbindung auf, nie umgekehrt.
  arsenalRouter.post('/arsenals/:id/pull', requirePerm('arsenal.update'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Ungültige Arsenal-ID' });
    }
    if (!getArsenal(id)) return res.status(404).json({ error: 'Arsenal nicht gefunden' });
    if (!istVerbunden(id)) {
      return res.status(409).json({ error: 'Arsenal ist nicht verbunden', grund: 'arsenal-offline' });
    }

    const { uploadId } = req.body ?? {};
    if (typeof uploadId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(uploadId)) {
      return res.status(400).json({ error: 'Upload-Kennung fehlt oder ist unbrauchbar' });
    }

    // Der Upload muss EXISTIEREN. Ein Pfad aus dem Request darf hier nicht
    // zum Dateisystem werden - darum wird ueber die Kennung nachgeschlagen,
    // nie ueber einen mitgeschickten Pfad.
    let upload;
    try {
      upload = await readUpload(uploadId);
    } catch {
      upload = null;
    }
    if (!upload) return res.status(404).json({ error: 'Upload nicht gefunden' });

    const leitung = holeLeitung(id);
    if (!leitung) {
      return res.status(409).json({ error: 'Arsenal ist nicht verbunden', grund: 'arsenal-offline' });
    }

    const ergebnis = await sendePull({
      arsenalId: id,
      dateiPfad: upload.path,
      name: upload.originalName,
      leitung,
      auftragId: null,
    });

    if (!ergebnis.ok) {
      return res.status(422).json({ error: 'Übertragung nicht gestartet', grund: ergebnis.grund });
    }

    res.json({
      ok: true,
      pullId: ergebnis.id,
      gesamt: ergebnis.gesamt,
      name: upload.originalName,
    });
  });

// --- Lebenszeichen vom Arsenal ---------------------------------------------
// Absichtlich OHNE Session: das Arsenal hat kein Benutzerkonto in der Armory.
// Identitaet ist der Arsenal-Schluessel im Header, nicht die IP.
//
// Diese Route ist der einzige nicht-session-gebundene Schreibzugriff des
// Panels. Sie darf deshalb nichts anderes tun als last_seen_at setzen.
arsenalRouter.post('/arsenal/heartbeat', (req, res) => {
  const key = req.get('x-arsenal-key') ?? '';
  const arsenalId = Number(req.body?.id);

  if (!Number.isInteger(arsenalId) || arsenalId <= 0) {
    return res.status(400).json({ error: 'Ungültige Arsenal-ID' });
  }

  const arsenal = getArsenal(arsenalId);
  const check = verifyHeartbeat({
    presentedKey: key,
    storedHash: arsenal?.key_hash,
    revokedAt: arsenal?.revoked_at,
  });

  if (!check.ok) {
    // 401 fuer alles, was den Schluessel betrifft. Kein Hinweis darauf, ob es
    // das Arsenal gibt - das waere eine Auskunft fuer einen Angreifer.
    return res.status(401).json({ error: 'Nicht autorisiert' });
  }

  const version = typeof req.body?.version === 'string' ? req.body.version.slice(0, 40) : null;
  touchHeartbeat({ id: arsenalId, version });

  // Gelegenheit nutzen: abgelaufene Kopplungscodes wegraeumen.
  pruneExpiredPairings();

  res.json({ ok: true, nextHeartbeatMs: 30_000 });
});


// PRE-RELEASE-AUDIT 2026-11-09: Alle Routen dieses Routers absichern.
//
// Live gefunden: ein POST auf /api/arsenals/6/command (action=einsetzen) gab
// KEIN Byte zurueck - kein 500, kein Fehlertext, die Verbindung blieb offen.
// Ursache: installRouter wurde gewrappt, arsenalRouter nicht. Express 4 faengt
// abgelehnte Promises in async-Handlern nicht ab; der Fehler geht an den
// Prozess und der Client wartet bis zum Timeout.
//
// Bewusst HIER am Ende: so ist auch jede spaeter hinzugefuegte Route
// geschuetzt, ohne dass jemand daran denken muss. Der Test
// routerFehlerbehandlung.test.mjs prueft ALLE Router-Dateien, damit der
// naechste Router nicht wieder vergessen wird.
wrapRouter(arsenalRouter);
