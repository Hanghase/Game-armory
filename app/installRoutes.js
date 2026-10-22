// Game-Armory - Install & Update API-Routen
// Eigener Router, wird in server.js unter /api gemountet.
//
//   GET    /api/settings                    (admin)     Settings-Status
//   GET    /api/system/rights               (admin)     Sudo-/Helfer-Rechte (Cache)
//   PUT    /api/settings                    (admin)     curseforge_api_key setzen
//   GET    /api/curseforge/search?q=        (moderator) Modpack-Suche
//   GET    /api/curseforge/mod/:modId/files (moderator) Dateien/Versionen
//   POST   /api/swords/reload               (admin)     Sword-Cache mit Platte synchronisieren
//   GET    /api/swords/:id/config           (moderator) Config lesen + Felddefinitionen
//   PUT    /api/swords/:id/config           (moderator) Config schreiben (mit Backup)
//   POST   /api/swords/:id/pending-restart  (moderator) "Spaeter" beim Neustart-Hinweis merken
//   DELETE /api/swords/:id/pending-restart  (moderator) Merker loeschen (ohne Neustart)
//   GET    /api/version                     (auth)      Laufende Version (Git)
//   POST   /api/swords/:id/update           (moderator) Update anstossen -> 202
//   GET    /api/swords/:id/update-status    (auth)      Update-Status
//   POST   /api/installs                    (admin)     Neu-Install -> 202
//   GET    /api/installs/:id/status         (admin)     Install-Status
//   DELETE /api/swords/:id                  (admin)     Sword entfernen
//   POST   /api/swords/:id/eula             (admin)     EULA nachtragen (eula=true)
//
// Uploads: ZIPs koennen als multipart hochgeladen werden (POST /api/uploads,
// Feld "file"). Der Upload-Weg ist EINMALIG: die Datei wird per {uploadId} an
// einen Install-/Update-Vorgang uebergeben und danach geloescht. Zusaetzlich
// raeumt der Server Uploads weg, die aelter als 7 Tage sind. Daneben bleibt der
// pfadbasierte Weg {zipPath} bestehen (Datei liegt schon auf dem Server).

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { stat, rm } from 'node:fs/promises';

import { getSettingsStatus, setSetting, getSetting, SETTING_KEYS, SECRET_KEYS, getSidebarRacks, setSidebarRacks } from './settings.js';
import { verifyMail, sendTestMail } from './mailer.js';
import { searchModpacks, getFiles, CurseForgeError, verifyApiKey } from './curseforge.js';
import { requirePerm, requireAuth, requireRole } from './auth.js';
import { getSword, getSwords, loadSwords, getSwordDiagnostics, setInstalledVersion, setVersionCheck, setTargetVersion, setSwordProjectId } from './swords.js';
import { checkSwordVersion } from './versionCheck.js';
import { serviceStatus } from './control.js';
import { loadRacks, getRacks, getRack, getRackDiagnostics, createRack, updateRack, deleteRack, RackError } from './racks.js';
import { readConfig, writeConfig, getEditorFields, SUPPORTED_GAMES, ConfigEditorError } from './configEditor.js';
import { installFromZip, installFromCurseForge, installFromSteam, acceptEulaForRack, InstallerError } from './installer.js';
import { updateFromZip, updateFromCurseForge, getUpdateState, UpdaterError } from './updater.js';
import { removeSword, SwordDeleteError } from './swordDelete.js';
import { loadPendingRestarts, getPendingRestart, setPendingRestart, clearPendingRestart } from './pendingRestart.js';
import { getVersion } from './version.js';
import { getRightsStatus, recheckRights } from './systemRights.js';
import { getSelfUpdateState, runSelfUpdateCheck } from './selfUpdateCheck.js';
import { getSelfUpdateStatus, listSelfUpdateTags, dryRunSelfUpdate, applySelfUpdate, SelfUpdateError } from './selfUpdate.js';
import {
  uploadMiddleware, registerUpload, readUpload, deleteUpload, listUploads,
  cleanupOldUploads, UploadError, UPLOADS_DIR,
} from './uploads.js';

export const installRouter = Router();

// --- In-Memory Job-State fuer Neu-Installs ---------------------------------

const installJobs = new Map(); // id -> { phase, progress, message, startedAt, finishedAt, error, result }

function setJob(id, patch) {
  const prev = installJobs.get(id) ?? {
    id, phase: 'idle', progress: 0, message: '', startedAt: null, finishedAt: null, error: null, result: null,
  };
  const next = { ...prev, ...patch };
  installJobs.set(id, next);
  return next;
}

async function fileExists(p) {
  try { const s = await stat(p); return s.isFile(); } catch { return false; }
}

function sendError(res, err) {
  const status = err.status && Number.isInteger(err.status) ? err.status
    : (err instanceof CurseForgeError || err instanceof InstallerError || err instanceof UpdaterError || err instanceof RackError) ? 400
    : 500;
  res.status(status).json({ error: err.message, name: err.name });
}

// --- Config-Editor ------------------------------------------------------------
// GET  /api/swords/:id/config   - Felddefinitionen + aktuelle Werte
// PUT  /api/swords/:id/config   - Werte schreiben (mit Backup)
// Nur wenn das Spiel des Sword einen Editor unterstuetzt (aktuell: 7d2d).

installRouter.get('/swords/:id/config', requirePerm('sword.config.read'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  const game = sword.game ?? 'minecraft';
  if (!SUPPORTED_GAMES.includes(game)) {
    return res.status(400).json({ error: `Config-Editor fuer Spiel "${game}" nicht verfuegbar`, supported: SUPPORTED_GAMES });
  }
  const rack = getRack(sword.rack);
  const configFile = rack?.configFile ?? sword.configFile ?? null;
  const workingDir = sword.control?.workingDir;
  try {
    const data = await readConfig({ game, workingDir, configFile });
    res.json({ ...data, game, editable: true });
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

installRouter.put('/swords/:id/config', requirePerm('sword.config.write'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  const game = sword.game ?? 'minecraft';
  if (!SUPPORTED_GAMES.includes(game)) {
    return res.status(400).json({ error: `Config-Editor fuer Spiel "${game}" nicht verfuegbar` });
  }
  const rack = getRack(sword.rack);
  const configFile = rack?.configFile ?? sword.configFile ?? null;
  const workingDir = sword.control?.workingDir;
  try {
    const result = await writeConfig({ id: req.params.id, game, workingDir, configFile, values: req.body ?? {} });

    // Laeuft der Server gerade? Dann greifen die neuen Werte erst beim
    // naechsten Start (kein Spiel liest seine Config im Betrieb neu) - das
    // Frontend fragt daraufhin, ob jetzt neu gestartet werden soll.
    let restartRequired = false;
    const service = sword.control?.service;
    // Nur wenn sich WIRKLICH ein Wert geaendert hat (nicht nur "geschrieben") -
    // sonst poppt der Neustart-Dialog auch bei unveraendertem Speichern auf.
    if (result.reallyChanged && service) {
      try {
        const status = await serviceStatus(service);
        restartRequired = status.running === true;
      } catch { /* Status nicht ermittelbar: lieber nicht fragen */ }
    }

    res.json({ ...result, restartRequired });
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

// --- Version nachtragen (haendisch) ------------------------------------------
// PUT /api/swords/:id/version   - installedVersion setzen (moderator)
// Die Version wird normalerweise automatisch ermittelt (Dateiname, GitHub-Tag,
// Neoforge, Steam-Build, Binary). Ist sie NICHT erkennbar (z.B. Kundenpack mit
// unbekanntem Dateinamen), traegt der Mensch sie hier von Hand nach - das Feld
// ist Pflicht, ein Sword ohne Version ist unzulaessig.
installRouter.put('/swords/:id/version', requirePerm('sword.config.write'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });

  const raw = req.body?.version;
  const version = typeof raw === 'string' ? raw.trim() : '';
  if (version.length === 0) {
    return res.status(400).json({ error: 'version erforderlich (nicht leer)' });
  }
  if (version.length > 120) {
    return res.status(400).json({ error: 'version zu lang (max. 120 Zeichen)' });
  }

  try {
    const updated = await setInstalledVersion(req.params.id, {
      version,
      source: 'manual',
      by: req.user?.username ?? null,
    });
    res.json({ ok: true, sword: updated });
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

// POST /api/swords/:id/target-version   - Soll-Version manuell setzen
// Nur fuer Quellen ohne Abfragemoeglichkeit (CurseForge ohne API-Key).
// Leerer Wert loescht die Soll-Version wieder.
installRouter.post('/swords/:id/target-version', requirePerm('sword.config.write'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });

  const raw = req.body?.version;
  const version = typeof raw === 'string' ? raw.trim() : '';
  if (version.length > 120) {
    return res.status(400).json({ error: 'version zu lang (max. 120 Zeichen)' });
  }

  try {
    const updated = await setTargetVersion(req.params.id, {
      version: version || null,
      by: req.user?.username ?? null,
    });
    res.json({ ok: true, targetVersion: updated.update?.availableVersion ?? null });
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

// POST /api/swords/:id/project-id   - CurseForge-Pack-Nummer setzen
// Warum es dieses Feld gibt: Die Pack-Nummer ist ein Curse-Thema und steht
// NICHT im Serverpack/Manifest - sie laesst sich beim Install nicht erraten.
// Wer sie kennt und einen eigenen API-Key hat, traegt sie hier ein; dann laeuft
// der Versionscheck direkt gegen CurseForge. Leer = Nummer entfernen.
installRouter.post('/swords/:id/project-id', requirePerm('sword.config.write'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });

  const raw = req.body?.projectId;
  const asStr = typeof raw === 'string' ? raw.trim() : (raw === null || raw === undefined ? '' : String(raw));
  if (asStr.length > 80) {
    return res.status(400).json({ error: 'projectId zu lang (max. 80 Zeichen)' });
  }

  try {
    const updated = await setSwordProjectId(req.params.id, {
      projectId: asStr || null,
      by: req.user?.username ?? null,
    });
    res.json({ ok: true, projectId: updated.update?.projectId ?? null });
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
  }
});

// POST /api/swords/:id/version-check   - Versions-Gegenprobe jetzt ausfuehren
// Fragt die zum Rack passende Quelle (Steam/GitHub/CurseForge/manuell) und
// schreibt das Ergebnis ins Sword. Antwortet IMMER mit 200, auch wenn die
// Quelle "unknown" meldet - das ist ein Zustand, kein Fehler.
installRouter.post('/swords/:id/version-check', requirePerm('sword.config.read'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });

  try {
    const installDir = sword.control?.workingDir ?? null;
    const result = await checkSwordVersion(sword, { rack: getRack(sword.rack), installDir });
    const updated = await setVersionCheck(req.params.id, {
      state: result.state,
      available: result.available ?? null,
      reason: result.reason ?? null,
    });
    res.json({
      ok: true,
      state: result.state,
      installed: result.installed ?? sword.installedVersion ?? null,
      available: result.available ?? null,
      reason: result.reason ?? null,
      source: result.source ?? null,
      checkedAt: updated.versionCheckedAt,
    });
  } catch (err) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/swords/version-check-all  - alle Swords nacheinander pruefen
// Schreibt das Ergebnis je Sword fest. Antwortet IMMER mit 200: "unknown"
// ist ein Zustand, kein Fehler. Die Schleife laeuft bewusst sequenziell,
// damit GitHub/Steam/CurseForge nicht parallel angefunkt werden.
installRouter.post('/swords/version-check-all', requirePerm('sword.config.read'), async (req, res) => {
  const results = [];
  for (const sword of getSwords()) {
    try {
      const installDir = sword.control?.workingDir ?? null;
      // Das Rack muss mit: der Sword kennt oft nur source/projectId, das
      // Rack traegt url/appId. Ohne Rack kam fuer TS6 "kein GitHub-Repo".
      const r = await checkSwordVersion(sword, { rack: getRack(sword.rack), installDir });
      const updated = await setVersionCheck(sword.id, {
        state: r.state,
        available: r.available ?? null,
        reason: r.reason ?? null,
      });
      results.push({
        id: sword.id,
        name: sword.name ?? sword.id,
        state: r.state,
        installed: r.installed ?? sword.installedVersion ?? null,
        available: r.available ?? null,
        reason: r.reason ?? null,
        checkedAt: updated.versionCheckedAt,
      });
    } catch (err) {
      results.push({
        id: sword.id,
        name: sword.name ?? sword.id,
        state: 'unknown',
        installed: sword.installedVersion ?? null,
        available: null,
        reason: err.message,
        checkedAt: Date.now(),
      });
    }
  }
  res.json({ ok: true, count: results.length, results });
});

// Merker "Neustart ausstehend". Wird gesetzt, wenn der Nutzer nach dem
// Speichern "Spaeter" waehlt - sichtbar auf der Sword-Karte, bis ein Start/
// Stop/Restart ihn erledigt.
installRouter.post('/swords/:id/pending-restart', requirePerm('sword.restart_marker'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  const entry = await setPendingRestart(req.params.id, req.user?.username ?? null);
  res.json({ ok: true, pendingRestart: entry });
});

// Merker loeschen, ohne dass ein Neustart passiert (z.B. "Verwerfen").
installRouter.delete('/swords/:id/pending-restart', requirePerm('sword.restart_marker'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  const removed = await clearPendingRestart(req.params.id);
  res.json({ ok: true, removed });
});

// Laufende Version (aus Git). Login-pflichtig: eine oeffentlich abfragbare
// Version verraet einem Angreifer genau, welche Staende er gezielt testen kann.
installRouter.get('/version', requireAuth, async (_req, res) => {
  res.json(await getVersion());
});

// --- Diagnose ----------------------------------------------------------------
// Warum laedt ein Rack oder Sword nicht? Bisher stand das nur im Server-Log
// (journalctl per SSH). Hier bekommt der Betreiber es im Panel - genau die
// Frage, wegen der ein Kunde sonst den Admin anruft.
//
// WICHTIG: laedt frisch von der Platte, damit die Anzeige den AKTUELLEN Stand
// zeigt, nicht den letzten Start-Zustand. Der Cache wird dabei neu befuellt.
installRouter.get('/diagnostics', requirePerm('system.diagnostics'), async (_req, res) => {
  try {
    const racks = await loadRacks();
    const swords = await loadSwords();
    const rd = getRackDiagnostics();
    const sd = getSwordDiagnostics();
    res.json({
      racks: { count: racks.racks.length, errors: rd.errors, warnings: rd.warnings },
      swords: { count: swords.swords.length, errors: sd.errors, warnings: sd.warnings },
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Racks (Schablonen) -----------------------------------------------------
// Liste aller Rack-Schablonen fuer die Rack-Auswahl im Setup.
installRouter.get('/racks', requirePerm('rack.read'), async (req, res) => {
  // Sicherheitsnetz: Ist der Rack-Cache leer (z.B. frischer Prozess ohne
  // Start-Load), einmalig nachladen statt ein leeres Array zu liefern.
  if (getRacks().length === 0) await loadRacks();
  res.json(getRacks());
});

// Rack anlegen. Durchlaeuft dieselbe Validierung wie der Datei-Weg
// (validateRack in racks.js: Pflichtfelder, Enums, /opt-Whitelist, ..-Sperre).
installRouter.post('/racks', requirePerm('rack.create'), async (req, res) => {
  try {
    const result = await createRack(req.body ?? {});
    console.log(`[rack:create] ${result.id} von ${req.user?.username ?? '?'}`);
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// Rack bearbeiten (id unveraenderlich). Auch hier dieselbe Validierung.
// Seit 2026-10-22 eigenes Recht: vorher hing das am Anlegen-Recht, wodurch
// jeder mit 'rack.create' auch bestehende Racks umbiegen konnte (root, startScript).
installRouter.put('/racks/:id', requirePerm('rack.edit'), async (req, res) => {
  // Eine im Body mitgeschickte, ABWEICHENDE id nicht still ueberschreiben,
  // sondern klar ablehnen. Die URL ist die Identitaet; ein Widerspruch deutet
  // auf einen Aufrufer-Fehler (z.B. falsches Umbenennen) und darf nicht als
  // Erfolg durchgehen.
  const body = req.body ?? {};
  if (body.id !== undefined && String(body.id) !== String(req.params.id)) {
    return res.status(400).json({
      error: `Die id eines Racks ist unveraenderlich (URL: ${req.params.id}, Body: ${body.id})`,
      name: 'RackError',
    });
  }
  try {
    const result = await updateRack(req.params.id, { ...body, id: req.params.id });
    console.log(`[rack:update] ${result.id} von ${req.user?.username ?? '?'}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// Rack loeschen. Verweigert, solange noch Swords dieses Rack benutzen.
installRouter.delete('/racks/:id', requirePerm('rack.delete'), async (req, res) => {
  const id = String(req.params.id);
  const dependents = getSwords().filter((sw) => sw.rack === id).map((sw) => sw.id);
  try {
    const result = await deleteRack(id, { dependentSwordIds: dependents });
    console.log(`[rack:delete] ${result.id} von ${req.user?.username ?? '?'}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendError(res, err);
  }
});

// --- Sidebar-Auswahl: welche Racks im Panel sichtbar sind -------------------
// null = alle Racks. Sonst ein Array von Rack-IDs.

installRouter.get('/sidebar-racks', requirePerm('rack.read'), async (req, res) => {
  if (getRacks().length === 0) await loadRacks();
  const sel = getSidebarRacks();
  res.json({
    initialized: sel.initialized,
    selected: sel.ids,                         // null = alle
    all: getRacks().map((r) => ({ id: r.id, name: r.name, game: r.game,
      description: r.description, icon: r.icon, tier: r.tier, locked: r.locked })),
  });
});

installRouter.put('/sidebar-racks', requirePerm('rack.sidebar.write'), async (req, res) => {
  const body = req.body ?? {};
  if (getRacks().length === 0) await loadRacks();
  const known = new Set(getRacks().map((r) => r.id));

  // null/'all' = alle zuruecksetzen; sonst nur bekannte Rack-IDs akzeptieren.
  if (body.selected === null || body.selected === 'all') {
    setSidebarRacks(null);
    return res.json({ ok: true, selected: null });
  }
  if (!Array.isArray(body.selected)) {
    return res.status(400).json({ error: 'selected muss ein Array von Rack-IDs oder null sein' });
  }
  const unknown = body.selected.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Unbekannte Rack-IDs: ${unknown.join(', ')}` });
  }
  const clean = setSidebarRacks(body.selected);
  res.json({ ok: true, selected: clean });
});

// --- Settings ---------------------------------------------------------------

installRouter.get('/settings', requirePerm('settings.read'), (req, res) => {
  res.json(getSettingsStatus());
});

// Systemrechte: was darf diese Installation per sudo? Nur der Cache, die
// Messung laeuft beim Start und danach hoechstens alle 60 s im Hintergrund -
// dieser Endpunkt blockiert nie.
installRouter.get('/system/rights', requirePerm('settings.read'), (req, res) => {
  res.json(getRightsStatus());
});

// Erzwungene Neumessung - der Knopf im Panel. Gemessen wird sonst nur beim
// Start: Rechte aendern sich nur durch Handarbeit an der sudoers-Datei.
installRouter.post('/system/rights/recheck', requirePerm('settings.read'), async (req, res) => {
  res.json(await recheckRights());
});

// Rechte an den Schreibzugriff auf Einstellungen:
// 2026-10-22 verschaerft - Schluessel aus SECRET_KEYS (curseforge_api_key,
// steam_password, smtp_pass, smtp_user) duerfen NUR vom superuser gesetzt werden.
// Vorher genuegte settings.write (admin), womit ein Admin z.B. den Steam-Login
// oder den CurseForge-Key der Installation ueberschreiben konnte.
installRouter.put('/settings', requirePerm('settings.write'), async (req, res) => {
  const body = req.body ?? {};
  const keys = Object.keys(body).filter((k) => SETTING_KEYS.includes(k));
  if (keys.length === 0) {
    return res.status(400).json({ error: `Keine bekannten Settings uebergeben (erlaubt: ${SETTING_KEYS.join(', ')})` });
  }

  // Secrets sind superuser-Sache. Normale Einstellungen bleiben bei settings.write.
  const secretKeys = keys.filter((k) => SECRET_KEYS.has(k));
  if (secretKeys.length > 0 && req.user?.role !== 'superuser') {
    return res.status(403).json({
      error: 'Nur der Superuser darf Geheimnisse aendern.',
      code: 'SECRET_REQUIRES_SUPERUSER',
      keys: secretKeys,
    });
  }
  // CurseForge-Key NICHT blind speichern: erst live gegen die Core-API pruefen.
  // Ein ungueltiger Key (z.B. versehentlich ein Passwort-Hash) faellt so sofort
  // auf, statt spaeter als kryptischer 403 bei der Modpack-Suche.
  if (Object.prototype.hasOwnProperty.call(body, 'curseforge_api_key') && String(body.curseforge_api_key ?? '').trim() !== '') {
    const candidate = String(body.curseforge_api_key).trim();
    try {
      const check = await verifyApiKey(candidate);
      if (!check.ok) {
        return res.status(400).json({
          error: check.error ?? 'CurseForge-Key wurde von der API abgelehnt',
          hint: 'Bitte den Application-API-Key beantragen: https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key',
          code: 'CURSEFORGE_KEY_INVALID',
        });
      }
    } catch (err) {
      return res.status(502).json({
        error: `Key konnte nicht geprueft werden: ${err.message}`,
        code: 'CURSEFORGE_KEY_UNVERIFIED',
      });
    }
  }

  // SMTP-Passwort SONDERFALL: wenn nur die Maske (z.B. "••••1234") oder leer
  // zurueckkommt, das gespeicherte Passwort NICHT ueberschreiben/loeschen.
  // Sonst wuerde ein reines "Einstellungen speichern" das Passwort zerstoeren.
  if (Object.prototype.hasOwnProperty.call(body, 'smtp_pass')) {
    const v = String(body.smtp_pass ?? '');
    const isMask = v === '' || v.includes('\u2022');
    if (isMask && getSetting('smtp_pass')) {
      delete body.smtp_pass;
      keys.splice(keys.indexOf('smtp_pass'), 1);
    }
  }

  for (const key of keys) {
    setSetting(key, body[key]);
  }
  res.json(getSettingsStatus());
});

// --- SMTP-Testmail (Superuser) ---------------------------------------------
// Baut den Transport, prueft Login+HANDSHAKE und sendet eine kurze Mail.
// Fehler werden sanitisiert (kein Passwort in der Meldung).
installRouter.post('/settings/test-mail', requirePerm('settings.test_mail'), async (req, res) => {
  const to = String(req.body?.to ?? '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return res.status(400).json({ error: 'Bitte eine gueltige Empfaengeradresse angeben.' });
  }
  try {
    await verifyMail();
    const info = await sendTestMail(to);
    res.json({ ok: true, messageId: info.messageId, to });
  } catch (err) {
    res.status(400).json({ error: err.message ?? 'Testmail fehlgeschlagen', code: err.code ?? null });
  }
});

// --- CurseForge --------------------------------------------------------------

installRouter.get('/curseforge/search', requirePerm('rack.read'), async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.status(400).json({ error: 'Query-Parameter q fehlt' });
  try {
    res.json(await searchModpacks(q));
  } catch (err) {
    sendError(res, err);
  }
});

installRouter.get('/curseforge/mod/:modId/files', requirePerm('rack.read'), async (req, res) => {
  const modId = Number(req.params.modId);
  if (!Number.isInteger(modId) || modId <= 0) return res.status(400).json({ error: 'Ungueltige modId' });
  try {
    res.json(await getFiles(modId, { pageSize: 50 }));
  } catch (err) {
    sendError(res, err);
  }
});

// --- Uploads ----------------------------------------------------------------
// Multipart-Upload eines Serverpack-ZIPs. Die Datei wird geprueft und in
// data/uploads/ abgelegt; die zurueckgegebene uploadId ist EINMALIG verwendbar
// (verbraucht sich nach Install/Update) und laeuft sonst nach 7 Tagen aus.

installRouter.post('/uploads', requirePerm('sword.upload'), (req, res) => {
  uploadMiddleware(req, res, async (err) => {
    if (err) {
      const status = err instanceof UploadError ? err.status : (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `Datei zu gross (max. ${Math.round(2 * 1024 * 1024 * 1024 / 1024 / 1024)} GB)`
        : err.message;
      return res.status(status).json({ error: msg });
    }
    try {
      // Rack-Kontext (2026-10-18): Die Inhaltspruefung ist spielabhaengig.
      // Die rackId kommt aus dem Formularfeld, damit ein TS6-Archiv gegen
      // tsserver geprueft wird und nicht gegen mods/. Unbekannt = Standard.
      const rackId = String(req.body?.rackId ?? '').trim();
      const rack = rackId ? getRack(rackId) : null;
      const meta = await registerUpload(req.file, req.user, rack);
      res.status(201).json(meta);
    } catch (e) {
      const status = e instanceof UploadError ? e.status : 400;
      res.status(status).json({ error: e.message });
    }
  });
});

// Liste aller offenen Uploads (nur Metadaten, keine Pfade nach aussen noetig).
installRouter.get('/uploads', requirePerm('sword.upload'), async (req, res) => {
  const list = await listUploads();
  res.json(list.map((u) => ({
    id: u.id, originalName: u.originalName, bytes: u.bytes,
    uploadedAt: u.uploadedAt, uploadedBy: u.uploadedBy,
  })));
});

installRouter.delete('/uploads/:id', requirePerm('sword.upload'), async (req, res) => {
  const ok = await deleteUpload(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Upload nicht gefunden' });
  res.json({ ok: true });
});

// --- Sword-Cache neu laden ----------------------------------------------------
// Synchronisiert den In-Memory-Cache (swordCache in swords.js) mit swords/
// und den Schablonen-Cache (rackCache in racks.js) mit racks/.
// Route-Reihenfolge: '/swords/reload' hat nur EIN Segment nach '/swords/', die
// Update-Route '/swords/:id/update' braucht zwei (:id + 'update'). Eine Kollision
// ist damit ausgeschlossen; wir definieren die Route dennoch vor den
// ':id/...'-Routen, damit die Absicht klar bleibt.
installRouter.post('/swords/reload', requirePerm('rack.reload'), async (req, res) => {
  try {
    // Racks VOR Swords: die Sword-Anreicherung (game/eula) liest aus dem
    // Rack-Cache. Sonst faellt eula faelschlich auf 'none' zurueck.
    const { racks, errors: rackErrors } = await loadRacks();
    const { swords, errors } = await loadSwords();
    res.json({
      ok: true,
      reloaded: swords.length,
      ids: swords.map((s) => s.id),
      errors,
      rackTemplates: racks.length,
      rackErrors,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Sword-Updates -----------------------------------------------------------

installRouter.post('/swords/:id/update', requirePerm('sword.update'), async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  if (sword.locked) return res.status(403).json({ error: 'Lizenz erforderlich', locked: true });

  const body = req.body ?? {};
  const onLog = (line) => console.log(`[update:${sword.id}] ${line}`);

  // Laufender Job? Nicht parallel starten.
  const st = getUpdateState(sword.id);
  if (st.phase && !['idle', 'done', 'error'].includes(st.phase)) {
    return res.status(409).json({ error: 'Update laeuft bereits', state: st });
  }

  // Quelle bestimmen: Upload-ID, ZIP-Pfad ODER CurseForge modId/fileId.
  let start;
  let uploadedId = null;
  if (body.uploadId) {
    let up;
    try {
      up = await readUpload(body.uploadId);
    } catch (e) {
      return res.status(e.status ?? 400).json({ error: e.message });
    }
    uploadedId = up.id;
    start = async () => {
      try {
        return await updateFromZip(sword, up.path, { onLog, keepConfigs: body.keepConfigs });
      } finally {
        await deleteUpload(uploadedId); // Direkt-Upload ist einmalig
      }
    };
  } else if (body.zipPath) {
    if (!(await fileExists(body.zipPath))) {
      return res.status(400).json({ error: `zipPath nicht gefunden (muss auf dem Server liegen): ${body.zipPath}` });
    }
    start = () => updateFromZip(sword, body.zipPath, { onLog, keepConfigs: body.keepConfigs });
  } else if (body.modId || sword.update?.projectId) {
    start = () => updateFromCurseForge(sword, { modId: body.modId, fileId: body.fileId, onLog, keepConfigs: body.keepConfigs });
  } else {
    return res.status(400).json({ error: 'Quelle fehlt: {uploadId}, {zipPath} oder {modId, fileId}' });
  }

  // 202 sofort, Job im Hintergrund.
  res.status(202).json({ accepted: true, sword: sword.id, statusUrl: `/api/swords/${sword.id}/update-status` });
  start().catch((err) => console.error(`[update:${sword.id}] Fehler: ${err.message}`));
});

installRouter.get('/swords/:id/update-status', requireAuth, (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  res.json(getUpdateState(sword.id));
});

// --- Neu-Installs ------------------------------------------------------------

// Ein Rack erlaubt genau die Install-Methoden, die zu seinem Spiel passen.
// Diese Tabelle ist die EINZIGE Quelle der Wahrheit fuer die Zuordnung
// rack.installMethod -> erlaubter source.type. Frontend und Server nutzen sie.
const INSTALL_TYPE_FOR_METHOD = {
  curseforge: 'curseforge',
  steamcmd: 'steam',
  zip: 'zip',
  upload: 'upload',
  url: 'zip',
};

installRouter.post('/installs', requirePerm('sword.create'), async (req, res) => {
  const body = req.body ?? {};
  const { id, name, port, source, rackId, root } = body;
  if (!id || !name || !port) return res.status(400).json({ error: 'id, name, port erforderlich' });
  if (!source || !source.type) return res.status(400).json({ error: 'source.type erforderlich (zip|upload|curseforge)' });
  if (!rackId) return res.status(400).json({ error: 'rackId erforderlich - ohne Rack ist der Server nicht eindeutig zuordenbar' });

  // --- Idiotensicherung: Rack bestimmt das Spiel und die Install-Methode. ---
  if (getRacks().length === 0) await loadRacks();
  const rack = getRack(rackId);
  if (!rack) return res.status(400).json({ error: `Unbekanntes Rack: ${rackId}` });

  const expectedType = INSTALL_TYPE_FOR_METHOD[rack.installMethod];
  if (!expectedType) {
    return res.status(400).json({ error: `Rack ${rackId} hat eine unbekannte Install-Methode: ${rack.installMethod}` });
  }
  if (source.type !== expectedType) {
    return res.status(400).json({
      error: `Rack "${rack.name}" (${rack.game}) wird per "${rack.installMethod}" installiert - `
        + `"${source.type}" ist dafür nicht erlaubt. Erlaubt: ${expectedType}.`,
    });
  }

  // EULA: nur mit ausdruecklicher Betreiber-Zustimmung wird eula=true gesetzt.
  const acceptEula = body.acceptEula === true;
  const acceptedBy = req.user?.username ?? null;

  // --- Einmal-Racks (singleton: true) -------------------------------------
  // Manche Dienste skalieren INTERN statt ueber mehrere Instanzen
  // (z.B. TeamSpeak 6: ein Prozess, beliebig viele virtuelle Server).
  // Ein zweiter Prozess waere hier schaedlich (eigene Ports/DB/Lizenz).
  // Deshalb: existiert schon ein Sword dieses Racks -> ablehnen.
  if (rack.singleton === true) {
    const already = getSwords().filter((sw) => sw.rack === rack.id);
    if (already.length > 0) {
      return res.status(409).json({
        error: `Rack "${rack.name}" ist ein Einmal-Rack und kann nur einmal installiert werden. `
          + `Bereits vorhanden: ${already.map((sw) => sw.id).join(', ')}. `
          + `Weitere Server dieses Typs werden intern angelegt (z.B. virtueller Server), nicht als neue Instanz.`,
      });
    }
  }

  // Nur laufende Jobs sperren die ID. Ein Job in phase 'done'/'error' ist
  // beendet - sein Artefakt (Sword) entscheidet, nicht der Job-Rest.
  const existingJob = installJobs.get(id);
  const jobActive = existingJob && existingJob.phase !== 'done' && existingJob.phase !== 'error';
  if (getSword(id) || jobActive) {
    return res.status(409).json({ error: `ID bereits vergeben: ${id}` });
  }

  const jobId = id;
  setJob(jobId, { phase: 'starting', progress: 0, message: 'Installation gestartet', startedAt: Date.now(), finishedAt: null, error: null });

  const log = (line) => {
    console.log(`[install:${jobId}] ${line}`);
    setJob(jobId, { message: line });
  };

  const runInstall = async () => {
    setJob(jobId, { phase: 'running', progress: 20, message: 'Installation laeuft' });
    let result;
    let uploadedId = null;
    if (source.type === 'zip') {
      if (!source.path) throw new InstallerError('source.path (ZIP auf dem Server) erforderlich');
      result = await installFromZip({ id, name, port, zipPath: source.path, acceptEula, acceptedBy, packVersion: source.packVersion ?? null, packVersionSource: source.packVersion ? 'upload-filename' : null }, { log });
    } else if (source.type === 'upload') {
      if (!source.uploadId) throw new InstallerError('source.uploadId erforderlich');
      const up = await readUpload(source.uploadId);
      uploadedId = up.id;
      try {
        result = await installFromZip({ id, name, port, zipPath: up.path, acceptEula, acceptedBy, packVersion: up.packVersion ?? null, packVersionSource: up.packVersion ? 'upload-filename' : null }, { log });
      } finally {
        await deleteUpload(uploadedId);
      }
    } else if (source.type === 'curseforge') {
      result = await installFromCurseForge({ id, name, port, modId: source.modId, fileId: source.fileId, acceptEula, acceptedBy }, { log });
    } else if (source.type === 'steam') {
      // SteamCMD-Rack (z.B. 7 Days to Die). Optionaler Steam-Login aus den Einstellungen;
      // ist keiner gesetzt, nutzt der Helfer 'login anonymous'.
      const appId = source.appId ?? rack?.source?.appId ?? null;
      const branch = source.branch ?? rack?.source?.branch ?? 'public';
      // Ziel-Pfad: explizit uebergeben > Rack-Default. Der Helfer erlaubt nur /opt/*.
      const rackRoot = (typeof root === 'string' && root.trim() !== '') ? root.trim() : (rack?.defaultRoot ?? null);
      const steamUser = getSetting('steam_username');
      const steamPass = getSetting('steam_password');
      const credentials = steamUser ? { username: steamUser, password: steamPass ?? '' } : null;
      result = await installFromSteam(
        { id, name, port, appId, branch, rootDir: rackRoot, credentials, acceptEula, acceptedBy, rackId: rackId ?? null },
        {
          log,
          // Live-Fortschritt: phase/progress/message direkt aus SteamCMD.
          // setJob merged nur die uebergebenen Felder - undefined bleibt aussen vor.
          onProgress: (patch) => {
            const clean = { ...patch };
            if (clean.progress === undefined) delete clean.progress;
            setJob(jobId, clean);
          },
        },
      );
    } else if (source.type === 'url') {
      // URL-Rack (z.B. TeamSpeak 6): laedt das Asset aus dem GitHub-Release
      // des Racks nach /tmp und installiert daraus. Die Aufloesung 'latest'
      // stellt sicher, dass ein Kunde die aktuelle Version bekommt.
      const repo = source.url ?? rack?.source?.url ?? null;
      const assetPattern = source.assetPattern ?? rack?.source?.assetPattern ?? null;
      if (!repo) throw new InstallerError('source.url (GitHub-Repo) erforderlich');
      const dl = await downloadGithubAsset({ repo, assetPattern, log });
      const rackRoot = (typeof root === 'string' && root.trim() !== '')
        ? root.trim()
        : (rack?.defaultRoot ?? null);
      if (!rackRoot) throw new InstallerError('Zielpfad (defaultRoot) fehlt');
      const workDir = `${rackRoot.replace(/\/+$/, '')}/${id}`;
      try {
        result = await installFromTarball(
          { id, name, port, tarballPath: dl.path, workDir, configFile: rack?.configFile ?? 'tsserver.yaml', installedVersion: dl.tag ?? null, installedVersionSource: dl.tag ? 'github-release' : null },
          { log },
        );
      } finally {
        await rm(dl.path, { force: true });
      }
    } else {
      throw new InstallerError(`Unbekannter source.type: ${source.type}`);
    }
    setJob(jobId, { phase: 'done', progress: 100, message: 'Installation abgeschlossen', finishedAt: Date.now(), result });
  };

  res.status(202).json({ accepted: true, id: jobId, statusUrl: `/api/installs/${jobId}/status` });
  runInstall().catch((err) => {
    console.error(`[install:${jobId}] Fehler: ${err.message}`);
    setJob(jobId, { phase: 'error', progress: 100, message: `Installation fehlgeschlagen: ${err.message}`, finishedAt: Date.now(), error: err.message });
  });
});

// --- Sword entfernen ----------------------------------------------------------
// Destruktiv: stoppt den Server, entfernt Unit/Sword/RCON/Logs/User. Der Ordner
// wird standardmaessig ebenfalls geloescht; {deleteFiles:false} behaelt ihn.
installRouter.delete('/swords/:id', requirePerm('sword.delete'), async (req, res) => {
  const id = String(req.params.id);
  if (!getSword(id)) return res.status(404).json({ error: `Sword nicht gefunden: ${id}` });
  const deleteFiles = req.body?.deleteFiles !== false;
  const log = (line) => console.log(`[delete:${id}] ${line}`);
  try {
    const result = await removeSword(id, { deleteFiles, log });
    res.json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof SwordDeleteError ? 409 : 500;
    res.status(status).json({ error: err.message });
  }
});

// --- EULA nachtragen ----------------------------------------------------------
// Setzt eula=true fuer einen bestehenden Server. Nur auf ausdrueckliche
// Betreiber-Zustimmung; wird vom UI-Haekchen ausgeloest.
installRouter.post('/swords/:id/eula', requirePerm('sword.eula'), async (req, res) => {
  const id = String(req.params.id);
  const sword = getSword(id);
  if (!sword) return res.status(404).json({ error: `Sword nicht gefunden: ${id}` });
  // EULA gilt nur fuer Racks, die sie verlangen (rack.eula === 'required').
  // Z.B. Minecraft ja, TeamSpeak/7d2d nein - kein Spiel-Hardcode.
  const rack = sword.rack ? getRack(sword.rack) : null;
  if ((rack?.eula ?? 'none') !== 'required') {
    return res.status(400).json({
      error: `Dieser Server braucht keine EULA${rack ? ` (Rack: ${rack.id})` : ''}`,
    });
  }
  if (req.body?.acceptEula !== true) {
    return res.status(400).json({ error: 'Zustimmung fehlt: { acceptEula: true } erforderlich' });
  }
  const acceptedBy = req.user?.username ?? null;
  const log = (line) => console.log(`[eula:${id}] ${line}`);
  try {
    const result = await acceptEulaForRack(sword, { acceptedBy, log });
    res.json({ ok: true, id, ...result });
  } catch (err) {
    const status = err instanceof InstallerError ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

installRouter.get('/installs/:id/status', requirePerm('sword.create'), (req, res) => {
  const job = installJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Kein Install-Job mit dieser ID' });
  res.json(job);
});

// --- Selbst-Update der Armory -----------------------------------------------
// Nur der Superuser (requireRole('superuser')): ein fehlgeschlagenes Update
// legt das ganze Panel lahm - inklusive der Moeglichkeit, es zu reparieren.
// Der Tausch selbst laeuft im privilegierten Helfer, nicht in diesem Prozess.

// Version fuer den Header (2026-10-19): JEDER Angemeldete soll sehen, ob das
// Panel aktuell ist - das ist kein Admin-Wissen, sondern Betriebszustand.
// Deshalb requireAuth statt requireRole('superuser'). Nur der Zustand, keine
// Helfer-Details (kein Commit, kein Pfad).
installRouter.get('/self-update/state', requireAuth, async (req, res) => {
  res.json(getSelfUpdateState());
});

// Manuelle Neumessung: nur wer auch das Update ausloesen darf.
installRouter.post('/self-update/check', requireRole('superuser'), async (req, res) => {
  try {
    const r = await runSelfUpdateCheck({ log: () => {} });
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

installRouter.get('/system/self-update/status', requireRole('superuser'), async (req, res) => {
  const st = await getSelfUpdateStatus();
  res.json(st);
});

installRouter.get('/system/self-update/tags', requireRole('superuser'), async (req, res) => {
  try {
    res.json({ tags: await listSelfUpdateTags() });
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// Trockenlauf: prueft Tag, Sauberkeit und Sicherung, tauscht aber nichts.
installRouter.post('/system/self-update/dry-run', requireRole('superuser'), async (req, res) => {
  try {
    res.json(await dryRunSelfUpdate(req.body?.tag));
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// Echt anwenden. Antwortet ERST nach dem Neustart-Versuch: bei Erfolg mit
// result=ok, bei Rollback mit result=rolled-back (kein Server-Fehler - der
// alte Stand laeuft ja wieder).
installRouter.post('/system/self-update/apply', requireRole('superuser'), async (req, res) => {
  try {
    const out = await applySelfUpdate(req.body?.tag);
    res.json(out);
  } catch (err) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});

// Hilfs-Export fuer spaetere Job-ID-Generierung / Tests.
export { installJobs, randomUUID };
