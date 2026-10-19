// Game-Armory - Backend Server
// Express + WebSocket. Swords (laufende Server) werden geladen und per systemd gesteuert.
// Alle Server-Aktionen sind login-pflichtig; Rollen: admin / moderator / friend.

import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSwords, getSwords, getSword, setVersionCheck } from './swords.js';
import { checkSwordVersion } from './versionCheck.js';
import { getNumericSetting } from './settings.js';
import { loadPendingRestarts, getPendingRestart, clearPendingRestart } from './pendingRestart.js';
import { loadRacks } from './racks.js';
import { serviceAction, serviceStatus, streamLogs } from './control.js';
import { authRouter } from './authRoutes.js';
import { installRouter } from './installRoutes.js';
import { getSessionUser, requireAuth, cleanupExpiredSessions,  cleanupLoginAttempts,
} from './auth.js';
import { roleHasPerm } from './permissions.js';
import { cleanupOldUploads } from './uploads.js';
import { detectRights } from './systemRights.js';
import { runSelfUpdateCheck, selfUpdateCheckMinutes } from './selfUpdateCheck.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const COOKIE_NAME = 'armory_session';


const app = express();

// Hinter einem Reverse-Proxy: nur der erste Hop ist vertrauenswuerdig.
// Ohne das sieht die App fuer ALLE Clients '127.0.0.1' - der Brute-Force-Schutz
// wuerde dann alle gemeinsam sperren statt den Angreifer. req.ip wird dadurch
// zur echten Client-IP aus X-Forwarded-For.
app.set('trust proxy', 1);
app.use(express.json());
app.use(cookieParser());

// --- Auth ----------------------------------------------------------------

app.use('/api/auth', authRouter);

// --- API: Settings, CurseForge, Install & Update ---------------------------
app.use('/api', installRouter);

// --- API: Swords (lesen: jeder Eingeloggte) ------------------------------

app.get('/api/swords', requireAuth, (req, res) => {
  res.json(getSwords());
});

app.get('/api/swords/:id', requireAuth, (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  res.json(sword);
});

// --- API: Sword-Status & Aktionen ----------------------------------------

app.get('/api/swords/:id/status', requireAuth, async (req, res) => {
  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  if (sword.locked) return res.status(403).json({ error: 'Lizenz erforderlich', locked: true });

  const service = sword.control?.service;
  if (!service) return res.status(400).json({ error: 'Kein Service im Sword definiert' });

  const status = await serviceStatus(service);

  // Merker "Neustart ausstehend": Wenn der Server gestoppt ist, ist der
  // ausstehende Neustart erledigt/gegenstandslos (der naechste Start nimmt die
  // neuen Werte ohnehin mit) - auch wenn er extern, ohne Panel-Klick, gestoppt
  // wurde. So klebt der Hinweis nie. Laeuft er noch, wird das Flag mitgeliefert.
  let pendingRestart = getPendingRestart(sword.id);
  if (pendingRestart && status.running !== true) {
    await clearPendingRestart(sword.id);
    pendingRestart = null;
  }

  res.json({ sword: sword.id, ...status, pendingRestart: pendingRestart ?? null });
});

// Start/Stop/Restart: ueber die Rechte-Matrix (pro Aktion steuerbar).
//   start    -> sword.control.start
//   stop     -> sword.control.stop
//   restart  -> sword.control.restart
// Startbelegung: friend hat nur start, moderator/admins haben alle drei
// -> Verhalten identisch zu vorher (start ab Level 1, stop/restart ab Level 2).
const ACTION_PERM = {
  start: 'sword.control.start',
  stop: 'sword.control.stop',
  restart: 'sword.control.restart',
};
app.post('/api/swords/:id/:action(start|stop|restart)', requireAuth, async (req, res) => {
  if (!roleHasPerm(req.user.role, ACTION_PERM[req.params.action])) {
    return res.status(403).json({ error: 'Keine Berechtigung' });
  }

  const sword = getSword(req.params.id);
  if (!sword) return res.status(404).json({ error: 'Sword nicht gefunden' });
  if (sword.locked) return res.status(403).json({ error: 'Lizenz erforderlich', locked: true });

  const service = sword.control?.service;
  if (!service) return res.status(400).json({ error: 'Kein Service im Sword definiert' });

  const result = await serviceAction(service, req.params.action);

  // Jeder Start/Stop/Restart erledigt einen ausstehenden Neustart:
  //   start/restart -> die neuen Werte sind jetzt aktiv.
  //   stop          -> der naechste Start nimmt sie ohnehin mit.
  if (result.ok) await clearPendingRestart(sword.id);

  res.status(result.ok ? 200 : 500).json(result);
});

// --- WebSocket: Live-Logs (login-pflichtig) -------------------------------

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/logs' });

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

wss.on('connection', (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const user = getSessionUser(cookies[COOKIE_NAME]);
  if (!user) {
    ws.send('[armory] Nicht eingeloggt.\n');
    ws.close();
    return;
  }
  // Live-Konsole: ueber die Rechte-Matrix steuerbar (nicht mehr hart ab Level 1).
  // Startbelegung vergibt sword.console.read an friend+ -> Verhalten wie bisher.
  if (!roleHasPerm(user.role, 'sword.console.read')) {
    ws.send('[armory] Keine Berechtigung\n');
    ws.close();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const swordId = url.searchParams.get('sword');
  const sword = swordId ? getSword(swordId) : null;

  if (!sword) { ws.send('[armory] Sword nicht gefunden\n'); ws.close(); return; }
  if (sword.locked) { ws.send('[armory] Lizenz erforderlich\n'); ws.close(); return; }

  const service = sword.control?.service;
  if (!service) { ws.send('[armory] Kein Service definiert\n'); ws.close(); return; }

  let logProcess;
  try {
    logProcess = streamLogs(sword, (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
  } catch (err) {
    ws.send(`[armory] Log-Stream Fehler: ${err.message}\n`);
    return;
  }

  ws.on('close', () => { if (logProcess) logProcess.kill('SIGTERM'); });
});

// --- Seiten ----------------------------------------------------------------
// Login-Seite öffentlich (enthält ggf. Setup), App nur mit gültiger Session.
app.get('/login', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(join(__dirname, '..', 'public', 'login.html'));
});
// Reset-/Einladungs-Seite: oeffentlich, weil der Nutzer per Link aus der Mail
// kommt und dort sein neues Passwort setzt.
app.get('/reset', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(join(__dirname, '..', 'public', 'reset.html'));
});
app.get(['/', '/app'], (req, res) => {
  if (!getSessionUser(req.cookies?.[COOKIE_NAME])) return res.redirect('/login');
  // Wie /app.html: HTML nie hart cachen, sonst sieht man nach einem Deploy
  // noch die alte UI (sendFile durchlaeuft NICHT express.static/setHeaders).
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(join(__dirname, '..', 'public', 'app.html'));
});

// Statische Assets (CSS/JS/...); HTML-Dateien werden nur über die Routen oben ausgeliefert.
// Cache: Der Kern (app.html, app.js, CSS) darf NICHT im Browser haengen bleiben,
// sonst sieht man nach einem Deploy noch das alte HTML. Statische Assets ohne
// Cache-Validierung ausliefern; der ETag von express.static reicht fuer 304er.
app.use(express.static(join(__dirname, '..', 'public'), {
  index: false,
  extensions: [],
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (/\.html$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// --- Start -----------------------------------------------------------------

(async () => {
  // Racks ZUERST laden: die Sword-Anreicherung (game, eula) liest aus dem
  // Rack-Cache (getRack). Waeren die Racks noch leer, fiele eula auf 'none'
  // zurueck und der EULA-Button verschwaende selbst bei Minecraft.
  const { racks, errors: rackErrors } = await loadRacks();
  console.log(`[armory] ${racks.length} Rack(s) geladen.`);
  if (rackErrors.length) console.warn(`[armory] ${rackErrors.length} Rack-Fehler:`, rackErrors);

  // Swords danach laden - sie brauchen die Racks fuer game/eula.
  const { swords, errors } = await loadSwords();
  console.log(`[armory] ${swords.length} Sword(s) geladen.`);
  if (errors.length) console.warn(`[armory] ${errors.length} Sword-Fehler:`, errors);

  // Systemrechte einmal messen - NICHT awaiten, der Start darf nicht warten.
  detectRights().catch(() => {});

  // Merker "Neustart ausstehend" (laufender Zustand, nicht in der Sword-Datei).
  await loadPendingRestarts();

  cleanupExpiredSessions();
  cleanupLoginAttempts();
  setInterval(() => {
    cleanupExpiredSessions();
    cleanupLoginAttempts();
  }, 1000 * 60 * 60);

  // Hochgeladene ZIPs, die aelter als 7 Tage sind, entfernen (Sicherheitsnetz).
  cleanupOldUploads().then((n) => { if (n) console.log(`[armory] ${n} alte(r) Upload(s) aufgeraeumt.`); }).catch(() => {});
  setInterval(() => { cleanupOldUploads().catch(() => {}); }, 1000 * 60 * 60 * 6);

  // Versions-Gegenprobe (2026-10-18): optionaler Hintergrund-Timer.
  // Intervall 0 = aus (nur der Knopf im Panel prueft). Das Intervall wird
  // bei jedem Tick neu gelesen, damit eine Aenderung ohne Neustart greift.
  let versionTimer = null;
  let versionTimerMinutes = -1;
  async function runVersionChecks() {
    for (const sword of getSwords()) {
      try {
        const installDir = sword.control?.workingDir ?? null;
        const r = await checkSwordVersion(sword, { installDir });
        await setVersionCheck(sword.id, {
          state: r.state,
          available: r.available ?? null,
          reason: r.reason ?? null,
        });
      } catch (err) {
        console.warn(`[armory] Versions-Check ${sword.id}: ${err.message}`);
      }
    }
  }
  function scheduleVersionChecks() {
    const minutes = getNumericSetting('version_check_minutes');
    if (minutes === versionTimerMinutes) return;
    versionTimerMinutes = minutes;
    if (versionTimer) { clearInterval(versionTimer); versionTimer = null; }
    if (minutes > 0) {
      console.log(`[armory] Versions-Pruefung alle ${minutes} min.`);
      versionTimer = setInterval(() => { runVersionChecks().catch(() => {}); }, 1000 * 60 * minutes);
    } else {
      console.log('[armory] Versions-Pruefung: nur manuell (Intervall 0).');
    }
  }
  scheduleVersionChecks();
  setInterval(scheduleVersionChecks, 1000 * 60 * 5);   // Intervall-Aenderung nachziehen

  // Selbst-Update-Gegenprobe (2026-10-19): rollierend, Default einmal am Tag.
  // Rollierend statt fester Uhrzeit: bei mehreren Installationen verteilt das
  // die Last, statt alle um 04:00 gleichzeitig zu GitHub zu schicken.
  // 0 = aus (dann prueft nur der Knopf im Panel).
  // Wie bei den Swords: eine gescheiterte Pruefung wird "unknown", nicht "rot".
  let suTimer = null;
  let suMinutes = -1;
  function scheduleSelfUpdateCheck() {
    const minutes = selfUpdateCheckMinutes();
    if (minutes === suMinutes) return;
    suMinutes = minutes;
    if (suTimer) { clearInterval(suTimer); suTimer = null; }
    if (minutes > 0) {
      console.log(`[armory] Selbst-Update-Pruefung alle ${minutes} min (rollierend).`);
      suTimer = setInterval(() => {
        runSelfUpdateCheck({ log: (m) => console.log(m) }).catch((err) => {
          console.warn(`[armory] Selbst-Update-Pruefung fehlgeschlagen: ${err.message}`);
        });
      }, 1000 * 60 * minutes);
      // Erste Pruefung kurz nach dem Start, damit der Header nicht lange
      // "unbekannt" zeigt. Verzoegert, damit listen() zuerst laeuft.
      setTimeout(() => {
        runSelfUpdateCheck({ log: (m) => console.log(m) }).catch(() => {});
      }, 1000 * 20);
    } else {
      console.log('[armory] Selbst-Update-Pruefung: nur manuell (Intervall 0).');
    }
  }
  scheduleSelfUpdateCheck();
  setInterval(scheduleSelfUpdateCheck, 1000 * 60 * 5);  // Intervall-Aenderung nachziehen

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[armory] Game-Armory läuft auf http://127.0.0.1:${PORT}`);
  });
})();
