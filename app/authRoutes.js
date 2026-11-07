// Game-Armory - Auth-Routen
// Login, Logout, Session-Check und (Admin-)User-Verwaltung.

import { Router } from 'express';
import { wrapRouter } from './routeWrap.js';
import { isMailReady, sendPasswordResetMail } from './mailer.js';
import {
  verifyLogin, createSession, destroySession, getSessionUser,
  requireAuth, requirePerm, hasUsers, createUser, getUserPrefs, setUserPrefs,
  listUsers, deleteUser, setRole, countSuperusers, getRole, changeOwnPassword, setUserPassword, ROLE_LEVEL,
  createAuthToken, consumeAuthToken, setUserEmail, getUserByEmail, getUserById, pruneAuthTokens,
  loginBanRemainingMs, recordLoginFailure, clearLoginFailures,
  validatePassword,
} from './auth.js';
import { getLoginGuardConfig } from './settings.js';
import { getPermissionsForRole, getMatrix, setPermission, roleHasPerm, ROLES, PERMISSIONS } from './permissions.js';

const COOKIE_NAME = 'armory_session';

// Cookie-Optionen. `secure` wird pro Antwort gesetzt (siehe cookieOptions):
// ueber HTTPS (Reverse-Proxy, X-Forwarded-Proto=https) secure=true, bei direktem
// HTTP-Zugriff lokal (http://127.0.0.1:3000) secure=false - sonst koennte man
// sich lokal gar nicht mehr einloggen.
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 1000 * 60 * 60 * 24 * 7,
  path: '/',
};

function cookieOptions(req) {
  return { ...COOKIE_OPTS, secure: Boolean(req.secure) };
}

export const authRouter = Router();

// Basis-URL fuer Links in Mails (Reset/Einladung). Nutzt den Host-Header,
// damit es hinter Reverse-Proxy genauso funktioniert wie lokal.
//
// Audit-Fix 2026-10-31 (M8): Host und Protokoll kamen ungeprueft aus dem
// Request. Der daraus gebaute Link geht per E-Mail an einen ANDEREN Menschen
// (das Opfer eines Reset-Wunsches). Waere der Header frei setzbar, koennte ein
// Angreifer einen Link auf seine eigene Domain schicken lassen, der mit einem
// echten Token des Opfers aufschlaegt - ein klassischer Token-Diebstahl.
//
// Deshalb: nur Hosts aus dieser Liste werden uebernommen. Steht der Host nicht
// darin, faellt es auf ARMORY_BASE_URL zurueck (feste Adresse aus der
// Umgebung bzw. der lokale Standard). Bewusst eine Erlaubnisliste: eine
// Verbotsliste muesste jede Schreibweise von "127.0.0.1", "localhost" und
// jeden Port kennen - und vergisst beim naechsten Mal eine.
const ALLOWED_MAIL_HOSTS = new Set([
  'armory.felsis.de',
  'felsis.de',
  '127.0.0.1:3000',
  'localhost:3000',
]);
const ARMORY_BASE_URL = process.env.ARMORY_BASE_URL || 'http://127.0.0.1:3000';

function publicBaseUrl(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim().toLowerCase();
  // Host ohne Port mit einem Eintrag MIT Port vergleichen: beide Formen zulassen.
  const host = ALLOWED_MAIL_HOSTS.has(rawHost) || ALLOWED_MAIL_HOSTS.has(rawHost.split(':')[0])
    ? rawHost
    : null;
  if (!host) {
    if (rawHost) console.warn(`[auth] Unbekannter Host für Mail-Link verworfen: ${rawHost.slice(0, 100)}`);
    return ARMORY_BASE_URL.replace(/\/+$/, '');
  }
  // Protokoll ebenso: nur http/https, und hinter dem Proxy nur, wenn der Host
  // aus der Liste kommt (sonst waere der Host schon verworfen).
  const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').trim().toLowerCase();
  const proto = rawProto === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

// --- Login-Ratenbegrenzung (H3, Audit 2026-10-22) --------------------------
// Warum das noetig ist (gemessen 2026-10-31): ein Login-Versuch kostet ~250 ms
// bcrypt. Der bestehende Brute-Force-Schutz (login_attempts) greift erst NACH
// 5 Fehlversuchen im Fenster - bis dahin sind 5 x 250 ms Prozessblockade
// moeglich. Mit dem async- Vergleich blockiert der Prozess zwar nicht mehr,
// aber ohne Deckel kann ein Angreifer beliebig viele Versuche parallel
// abfeuern. Deshalb ein festes Fenster VOR der Passwortpruefung.
//
// Bewusst im Prozess statt in der DB oder als neues Paket:
//  - ein Node-Prozess (kein Cluster, ExecStart = node app/server.js)
//  - der DB-Bann (login_ban_minutes) bleibt unabhaengig davon bestehen
//  - Neustart setzt die Zaehler zurueck, das ist bei einem Panel ok
// Schluessel: IP und IP+Username getrennt, damit ein einzelnes Konto nicht
// ueber viele IPs (verteiltes Raten) unbegrenzt angegriffen werden kann.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 10;        // Versuche pro Minute und IP
const RATE_MAX_PER_ACCOUNT = 5;    // Versuche pro Minute und IP+Username
const rateBuckets = new Map();     // key -> { count, resetAt }

// Nur pruefen, ohne zu zaehlen (Aufruf VOR der Passwortpruefung).
function checkRate(key, max) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) return { ok: true, remaining: max };
  if (b.count >= max) return { ok: false, remaining: 0, retryMs: b.resetAt - now };
  return { ok: true, remaining: max - b.count };
}

// Zaehlen (Aufruf NACH einem Fehlversuch).
function bumpRate(key, max) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now >= b.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, remaining: max - 1 };
  }
  b.count += 1;
  if (b.count > max) return { ok: false, remaining: 0, retryMs: b.resetAt - now };
  return { ok: true, remaining: max - b.count };
}

// Aufraeumen, damit die Map bei langer Laufzeit nicht waechst.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now >= v.resetAt) rateBuckets.delete(k);
}, 5 * 60_000).unref();

// Nur fuer Tests: Zaehler zuruecksetzen (nicht ueber HTTP erreichbar).
export function __resetRateBuckets() {
  rateBuckets.clear();
}

// Ist überhaupt schon ein Admin angelegt? (für Setup-Hinweis im Frontend)
authRouter.get('/setup-status', (req, res) => {
  res.json({ needsSetup: !hasUsers() });
});

// async, seit verifyLogin() auf bcrypt.compare (async) umgestellt wurde:
// der synchrone Vergleich blockierte den einzigen Node-Prozess 247 ms pro
// Login-Versuch (gemessen 2026-10-31) - das ganze Panel stand so lange still.
// ACHTUNG: ohne `await` kaeme hier ein Promise zurueck, `!user` waere immer
// false und JEDER Login wuerde durchgehen. Deshalb await + try/catch.
authRouter.post('/login', async (req, res) => {
  const ip = req.ip;
  // 1. Gesperrte IP? -> 429, ohne Hinweis auf die Restzeit.
  if (loginBanRemainingMs(ip) > 0) {
    return res.status(429).json({ error: 'Zu viele Versuche, versuche es später wieder' });
  }
  const { username, password } = req.body ?? {};
  // 2. Ratenbegrenzung VOR der teuren bcrypt-Pruefung (~250 ms). Sonst kann
  //    ein Angreifer den Prozess mit parallelen Versuchen belasten, bevor der
  //    IP-Bann (oben) greift. IP und IP+Account getrennt zaehlen.
  //
  // WICHTIG (Bugfix direkt nach dem Einbau, 2026-10-31): Erst PRUEFEN, dann
  // zaehlen - und nur Fehlversuche zaehlen. Die erste Fassung rief bumpRate()
  // vor der Passwortpruefung auf, also zaehlte JEDER Versuch mit, auch der
  // erfolgreiche. Wer sich funfmal hintereinander anmeldet, haette sich damit
  // selbst ausgesperrt.
  const acctKey = `acct:${ip}:${String(username ?? '').toLowerCase().slice(0, 64)}`;
  const ipGate = checkRate(`ip:${ip}`, RATE_MAX_PER_IP);
  if (!ipGate.ok) {
    res.set('Retry-After', String(Math.ceil((ipGate.retryMs ?? RATE_WINDOW_MS) / 1000)));
    return res.status(429).json({ error: 'Zu viele Versuche, versuche es später wieder' });
  }
  const acctGate = checkRate(acctKey, RATE_MAX_PER_ACCOUNT);
  if (!acctGate.ok) {
    res.set('Retry-After', String(Math.ceil((acctGate.retryMs ?? RATE_WINDOW_MS) / 1000)));
    return res.status(429).json({ error: 'Zu viele Versuche, versuche es später wieder' });
  }
  let user;
  try {
    user = await verifyLogin(username, password);
  } catch (err) {
    // bcrypt-Fehler (z. B. beschaedigter Hash) nicht als 500 nach aussen
    // zeigen - wie ein Fehlversuch behandeln, aber protokollieren.
    console.error(`[auth] Login-Prüfung fehlgeschlagen: ${err.message}`);
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  if (!user) {
    // Jetzt erst zaehlen: dieser Versuch war ein Fehlversuch.
    bumpRate(`ip:${ip}`, RATE_MAX_PER_IP);
    bumpRate(acctKey, RATE_MAX_PER_ACCOUNT);
    // Fehlversuch zaehlen (Schwellen aus den Admin-Einstellungen).
    const guard = getLoginGuardConfig();
    const { banned } = recordLoginFailure(ip, guard);
    // Maschinenlesbare Zeile fuer den Fail2ban-Filter (festes, einfaches Format).
    // Zusaetzlich die menschenlesbare Warnung fuer das normale Log.
    console.warn(`ARMORY_LOGIN_FAIL ip=${ip} user=${String(username ?? '').slice(0, 32)}`);
    console.warn(`[auth] Login fehlgeschlagen: user=${String(username ?? '').slice(0, 32)} ip=${ip}${banned ? ' -> IP gesperrt' : ''}`);
    // Bei erreichter Sperre dieselbe 429-Meldung wie oben liefern.
    if (banned) {
      return res.status(429).json({ error: 'Zu viele Versuche, versuche es später wieder' });
    }
    return res.status(401).json({ error: 'Falscher Benutzername oder Passwort' });
  }
  clearLoginFailures(ip);
  const token = createSession(user.id);
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  res.json({ ok: true, user });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  const user = getSessionUser(req.cookies?.[COOKIE_NAME]);
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' });
  // Aufgeloeste Rechte mitliefern, damit das Frontend Knoepfe/Modals ueber die
  // Rechte-Matrix steuern kann (statt ueber die alte Rang-Leiter).
  const perms = getPermissionsForRole(user.role);
  res.json({ user: { ...user, perms } });
});

// --- Darstellung je Nutzer --------------------------------------------------
// Jeder darf NUR seine eigenen Einstellungen lesen und schreiben. Die Nutzer-ID
// kommt aus der Session, nie aus dem Request-Body - sonst koennte man die
// Darstellung fremder Konten umstellen.
authRouter.get('/prefs', requireAuth, (req, res) => {
  res.json(getUserPrefs(req.user.id));
});

authRouter.put('/prefs', requireAuth, (req, res) => {
  const body = req.body ?? {};
  if (Object.prototype.hasOwnProperty.call(body, 'theme') && !['dark', 'light'].includes(body.theme)) {
    return res.status(400).json({ error: 'Unbekannte Darstellung' });
  }
  res.json(setUserPrefs(req.user.id, { theme: body.theme }));
});

// --- User-Verwaltung (nur Admin) ------------------------------------------

authRouter.get('/users', requirePerm('user.read'), (req, res) => {
  res.json(listUsers());
});

authRouter.post('/users', requirePerm('user.create'), async (req, res) => {
  const { username, password, role, email } = req.body ?? {};
  try {
    // E-Mail nur uebernehmen, wenn der Anlegende auch user.email darf.
    const mail = roleHasPerm(req.user?.role, 'user.email') ? email : null;
    const user = await createUser(username, password, role ?? 'friend', mail);
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// E-Mail eines Nutzers setzen (Admin). Eigener Pfad, kollidiert nicht mit
// PATCH /users/:id (Rolle). Fuer den eigenen Account gibt es /password
// analog das eigene /email unten - Admin darf jede Adresse, auch die eigene.
authRouter.post('/users/:id/email', requirePerm('user.email'), (req, res) => {
  const raw = req.body?.email;
  const email = raw ? String(raw).trim() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  if (!listUsers().some((u) => u.id === id)) {
    return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  }
  // Adress-Eindeutigkeit: getUserByEmail darf bei einer ANDEREN id nicht treffen.
  if (email) {
    const other = getUserByEmail(email);
    if (other && other.id !== id) {
      return res.status(409).json({ error: 'Diese E-Mail ist bereits einem anderen Nutzer zugeordnet' });
    }
  }
  try {
    setUserEmail(id, email);
    res.json({ ok: true, email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.patch('/users/:id', requirePerm('user.role'), (req, res) => {
  const { role } = req.body ?? {};
  const id = Number(req.params.id);

  // Lockout-Schutz 1: niemand darf die EIGENE Rolle aendern. Sonst kann sich
  // der einzige Superuser selbst degradieren und ist ausgesperrt.
  if (id === req.user.id) {
    return res.status(400).json({
      error: 'Die eigene Rolle kann nicht geändert werden. Bitte einen anderen Superuser darum bitten.',
    });
  }

  // Lockout-Schutz 2: der LETZTE Superuser darf nicht degradiert werden.
  try {
    const current = getRole(id);
    if (current === 'superuser' && role !== 'superuser' && countSuperusers() <= 1) {
      return res.status(400).json({
        error: 'Der letzte Superuser kann nicht herabgestuft werden - sonst wäre die Armory nicht mehr administrierbar.',
      });
    }
    setRole(id, role);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.delete('/users/:id', requirePerm('user.delete'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });

  // Lockout-Schutz 3: den LETZTEN Superuser nicht loeschen.
  try {
    const current = getRole(id);
    if (current === 'superuser' && countSuperusers() <= 1) {
      return res.status(400).json({
        error: 'Der letzte Superuser kann nicht gelöscht werden - sonst wäre die Armory nicht mehr administrierbar.',
      });
    }
    deleteUser(id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- E-Mail des eigenen Kontos pflegen (jeder eingeloggte Nutzer) --------
// Bewusst requireAuth (nicht requirePerm): die eigene Adresse darf jeder
// aendern, sonst kann niemand den Reset fuer sich selbst einrichten.
authRouter.post('/email', requireAuth, (req, res) => {
  const raw = req.body?.email;
  const email = raw ? String(raw).trim() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Ungültige E-Mail-Adresse' });
  }
  if (email) {
    const other = getUserByEmail(email);
    if (other && other.id !== req.user.id) {
      return res.status(409).json({ error: 'Diese E-Mail ist bereits einem anderen Nutzer zugeordnet' });
    }
  }
  try {
    setUserEmail(req.user.id, email);
    res.json({ ok: true, email });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Passwort aendern (eigenes) + Admin-Reset -----------------------------

// Eigenes Passwort aendern (jeder eingeloggte Nutzer).
authRouter.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  try {
    // Eigene Sitzung behalten, alle anderen des Nutzers verwerfen: eine
    // gestohlene Sitzung soll durch den Passwortwechsel hinausfliegen.
    await changeOwnPassword(req.user.id, currentPassword, newPassword, req.cookies?.armory_session);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-Reset: Passwort eines anderen Nutzers setzen (nur Admin).
// Eigene Methode (POST) + eigener Pfad, kollidiert nicht mit PATCH /users/:id.
authRouter.post('/users/:id/password', requirePerm('user.password'), async (req, res) => {
  const { newPassword } = req.body ?? {};
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const exists = listUsers().some((u) => u.id === id);
  if (!exists) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  try {
    await setUserPassword(id, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Setup: ersten Admin anlegen (nur solange kein User existiert!) -------

authRouter.post('/setup', async (req, res) => {
  if (hasUsers()) return res.status(403).json({ error: 'Setup bereits abgeschlossen' });
  const { username, password } = req.body ?? {};
  try {
    const user = await createUser(username, password, 'admin');
    const token = createSession(user.id);
    res.cookie(COOKIE_NAME, token, cookieOptions(req));
    res.status(201).json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Passwort vergessen (public) -------------------------------------------
// Sicherheit: Die Antwort ist IMMER gleich, egal ob die Adresse existiert.
// Sonst koennte jeder per Reset-Formular existierende Accounts ausspaehen.
authRouter.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  const GENERIC = { ok: true, message: 'Wenn die Adresse existiert, wurde eine E-Mail verschickt.' };

  if (!email) return res.json(GENERIC);
  try {
    // Nur wenn Versand eingerichtet ist, ueberhaupt versuchen.
    if (!isMailReady()) return res.json(GENERIC);

    const user = getUserByEmail(email);
    if (user) {
      const { token, expiresMinutes } = createAuthToken(user.id, 'reset');
      const base = publicBaseUrl(req);
      const link = `${base}/reset?token=${encodeURIComponent(token)}`;
      await sendPasswordResetMail(email, link, user.username, expiresMinutes);
    }
  } catch (err) {
    // Fehler NICHT nach aussen geben (wuerde Existenz verraten) - nur loggen.
    console.error('[armory] Reset-Mail fehlgeschlagen:', err.message);
  }
  res.json(GENERIC);
});

// --- Passwort-Reset einloesen (public) -------------------------------------
authRouter.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  try {
    await validatePassword(String(newPassword ?? ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const hit = consumeAuthToken(String(token ?? ''), 'reset');
  if (!hit) return res.status(400).json({ error: 'Der Link ist ungültig oder abgelaufen.' });
  try {
    await setUserPassword(hit.userId, newPassword);
    pruneAuthTokens();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Einladung einloesen (public) ------------------------------------------
authRouter.post('/accept-invite', async (req, res) => {
  const { token, newPassword } = req.body ?? {};
  try {
    await validatePassword(String(newPassword ?? ''));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const hit = consumeAuthToken(String(token ?? ''), 'invite');
  if (!hit) return res.status(400).json({ error: 'Die Einladung ist ungültig oder abgelaufen.' });
  try {
    await setUserPassword(hit.userId, newPassword);
    pruneAuthTokens();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Rechte-Matrix (nur user.role = Superuser-Sache) ----------------------
// Die Matrix steuert ALLE Berechtigungen des Panels. Wer sie aendern darf,
// darf sich damit selbst alles geben - daher nur ueber das Recht user.role
// (Startbelegung: superuser).
authRouter.get('/permissions', requirePerm('user.role'), (req, res) => {
  res.json(getMatrix());
});

authRouter.put('/permissions', requirePerm('user.role'), (req, res) => {
  const body = req.body ?? {};
  const changes = body.changes;
  if (!Array.isArray(changes)) {
    return res.status(400).json({ error: 'changes[] erwartet' });
  }
  const applied = [];
  const errors = [];
  for (const ch of changes) {
    const role = ch?.role;
    const perm = ch?.perm;
    // Audit-Fix 2026-10-30 (D129): vorher `!!ch?.allowed`. Damit wurden auch
    // "false" und "0" (Strings) zu true - wer per API {"allowed":"false"}
    // schickte, um ein Recht zu ENTZIEHEN, vergab es stattdessen.
    // Jetzt: nur echte Booleans. Alles andere ist ein Fehler, kein stiller Wert.
    const allowed = ch?.allowed;
    if (typeof allowed !== 'boolean') {
      errors.push({
        role, perm,
        error: `allowed muss ein Boolean sein (ist: ${JSON.stringify(allowed)})`,
      });
      continue;
    }
    try {
      setPermission(role, perm, allowed);
      applied.push({ role, perm, allowed });
    } catch (err) {
      errors.push({ role, perm, error: err.message });
    }
  }
  // Teilweise Erfolge werden gemeldet, damit die UI genau weiss, was durchkam
  // (z.B. superuser-Zeile wird IMMER abgelehnt).
  res.json({ ok: errors.length === 0, applied, errors, matrix: getMatrix() });
});

// Rollenliste inkl. Level fuer die UI-Anzeige (Namen/Reihenfolge).
authRouter.get('/roles', requirePerm('user.role'), (req, res) => {
  res.json({ roles: ROLES.slice(), permissions: PERMISSIONS.map((p) => p.perm) });
});

// --- Mail-Status (fuer Login-Seite: "Passwort vergessen" nur zeigen, wenn moeglich) ---
authRouter.get('/mail-status', (req, res) => {
  res.json({ ready: isMailReady() });
});

// PRE-RELEASE-AUDIT 2026-10-31: siehe installRoutes.js - Express 4 faengt
// abgelehnte Promises nicht ab. Ohne diesen Aufruf beendet eine werfende
// async-Route den gesamten Prozess.
wrapRouter(authRouter);

export { ROLE_LEVEL };
