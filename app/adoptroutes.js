// Routen fuer das Uebernehmen bestehender Dienste (Karte 28).
//
// Zwei Schritte, bewusst getrennt:
//   POST /api/adopt/vorschau  - nur pruefen, nichts schreiben
//   POST /api/adopt           - pruefen UND anlegen
//
// Warum getrennt: die fuenf Pruefungen sind der Wert der ganzen Sache. Wer
// nur anlegen kann, klickt und hofft. Wer vorher die Pruefliste sieht, weiss
// was passiert - und ob es passieren soll.

import { Router } from 'express';

import { requirePerm } from './auth.js';
import { wrapRouter } from './routeWrap.js';
import { findeKandidaten, erkenneDienstart } from './adopt.js';
import { pruefeAdoption, PRUEFUNGEN } from './adoptpruefung.js';
import { baueAdoptiertenSword, baueControl, schreibeSword, schreibeHerkunft,
  markerFuer, pruefeSchreibbar } from './adoptschreiben.js';
import { getSwords, loadSwords } from './swords.js';
import { getRack } from './racks.js';

export const adoptRouter = Router();

/**
 * Baut aus einem Kandidaten den vollstaendigen Pruefling.
 *
 * Der Kandidat aus der Erkennung kennt nur, was Docker hergibt. Was der
 * Betreiber ergaenzen muss (Port, Arbeitsverzeichnis, Dienstart), kommt aus
 * dem Request - und wird NICHT geraten.
 */
function bauePruefling(kandidat, eingabe) {
  const rackId = eingabe.rackId ?? kandidat.rackId;
  return {
    quelle: kandidat.quelle,
    id: kandidat.id,
    label: kandidat.label,
    rackId,
    quellen: kandidat.quellen,
    dienste: kandidat.dienste,
    // Was der Betreiber angibt:
    arbeitsVerzeichnis: eingabe.arbeitsVerzeichnis,
    port: eingabe.port,
    logs: eingabe.logs,
    control: eingabe.control,
    // Die Marker kommen aus der Dienstart, nicht aus dem Request: sonst
    // koennte man die Pruefung durch Weglassen bestehen.
    marker: rackId ? markerFuer(rackId) : null,
  };
}

// --- Vorschau ------------------------------------------------------------

adoptRouter.post('/adopt/vorschau', requirePerm('sword.create'), async (req, res) => {
  const body = req.body ?? {};
  const kandidat = body.kandidat;
  if (!kandidat || typeof kandidat !== 'object') {
    return res.status(400).json({ error: 'kandidat fehlt' });
  }

  const pruefling = bauePruefling(kandidat, body);
  const ergebnis = await pruefeAdoption(pruefling);

  return res.json({
    ok: ergebnis.ok,
    kandidat: { id: pruefling.id, label: pruefling.label, rackId: pruefling.rackId,
      quelle: pruefling.quelle },
    pruefungen: ergebnis.pruefungen,
    offen: ergebnis.offen,
    reihenfolge: PRUEFUNGEN,
  });
});

// --- Erkennung -----------------------------------------------------------

adoptRouter.get('/adopt/kandidaten', requirePerm('sword.create'), async (req, res) => {
  const kandidaten = await findeKandidaten();
  return res.json({ kandidaten });
});

// --- Uebernehmen ---------------------------------------------------------

adoptRouter.post('/adopt', requirePerm('sword.create'), async (req, res) => {
  const body = req.body ?? {};
  const kandidat = body.kandidat;
  if (!kandidat || typeof kandidat !== 'object') {
    return res.status(400).json({ error: 'kandidat fehlt' });
  }

  const pruefling = bauePruefling(kandidat, body);

  // 1) Erst pruefen. Nichts anlegen, was nicht fuenfmal ok ist.
  const ergebnis = await pruefeAdoption(pruefling);
  if (!ergebnis.ok) {
    return res.status(400).json({
      error: `Adoption nicht möglich: ${ergebnis.offen.join(', ')}`,
      pruefungen: ergebnis.pruefungen,
      offen: ergebnis.offen,
    });
  }

  // 2) Ohne Rack kein Sword - game und eula kommen von dort (swords.js:135).
  //    Das steht schon in pruefeSchreibbar, aber hier mit klarer Meldung,
  //    weil es der haeufigste Stolperstein beim Uebernehmen ist.
  const rackId = pruefling.rackId;
  if (!rackId) {
    return res.status(400).json({
      error: 'Ohne Rack kein Sword: die Dienstart ist unbekannt. Bitte rackId angeben.',
    });
  }
  if (!getRack(rackId)) {
    return res.status(400).json({
      error: `Rack "${rackId}" existiert nicht. Ein adoptierter Dienst braucht ein Rack `
        + '(daher kommen game und eula) - bitte zuerst das Rack anlegen.',
    });
  }

    // 3) control aus dem KANDIDATEN bauen, nicht aus dem Body (2026-11-10).
    //    Das Panel kennt den Compose-Pfad nicht - er steckt in den quellen der
    //    Erkennung. Wuerde er aus dem Body kommen, koennte ein Aufrufer einen
    //    beliebigen Pfad unterschieben.
    let control;
    try {
      control = baueControl(kandidat, body.arbeitsVerzeichnis);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!control) {
      return res.status(400).json({
        error: `Für "${kandidat.id}" ist keine Steuerung ermittelbar - `
          + 'ohne Compose-Datei kann die Armory ihn nicht starten oder stoppen. '
          + 'Ein geratener Pfad wäre schlimmer als keiner.',
      });
    }

    // 4) Sword bauen und schreiben.
    const id = body.id ?? kandidat.id;
    const sword = baueAdoptiertenSword({
      id,
      rackId,
      name: body.name ?? kandidat.label ?? id,
      port: Number(body.port),
      control,
      logs: body.logs,
      beschreibung: body.beschreibung,
    });

  const vorhandene = getSwords().map((s) => s.id);
  const fehler = pruefeSchreibbar(sword, vorhandene);
  if (fehler.length > 0) {
    return res.status(400).json({ error: `Sword nicht schreibbar: ${fehler.join('; ')}`, fehler });
  }

  const geschrieben = await schreibeSword(sword, { vorhandeneIds: vorhandene });
  if (!geschrieben.ok) {
    return res.status(500).json({ error: `Schreiben fehlgeschlagen: ${geschrieben.fehler.join('; ')}` });
  }

  // 4) Cache neu laden - sonst ist der Sword bis zum Neustart unsichtbar.
  //    Das ist die Nahtstelle, an der ich am 2026-11-09 vier Fehler hatte:
  //    geschrieben ist nicht geladen.
  await loadSwords();

  // 5) Herkunft vermerken, aber nicht erzwingen: schlaegt es fehl (z.B. weil
  //    das Verzeichnis dem Dienst gehoert und nicht dem armory-User), ist der
  //    Sword trotzdem da. Das wird gemeldet, nicht verschwiegen.
  const herkunft = await schreibeHerkunft(body.arbeitsVerzeichnis, {
    herkunft: 'adopted',
    quelle: pruefling.quelle,
    erkanntAm: new Date().toISOString(),
  });

  return res.status(201).json({
    ok: true,
    sword: { id: sword.id, rack: sword.rack, name: sword.name, port: sword.port },
    pfad: geschrieben.pfad,
    herkunft: herkunft.ok
      ? { geschrieben: herkunft.pfad }
      : { hinweis: herkunft.grund },
  });
});

wrapRouter(adoptRouter);
