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
