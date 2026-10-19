// Game-Armory - Auth-Routen
// Login, Logout, Session-Check und (Admin-)User-Verwaltung.

import { Router } from 'express';
import { isMailReady, sendPasswordResetMail, sendInviteMail } from './mailer.js';
import {
  verifyLogin, createSession, destroySession, getSessionUser,
  requireAuth, requirePerm, hasUsers, createUser,
  listUsers, deleteUser, setRole, countSuperusers, getRole, changeOwnPassword, setUserPassword, ROLE_LEVEL,
  createAuthToken, consumeAuthToken, setUserEmail, getUserByEmail, getUserById, pruneAuthTokens,
  loginBanRemainingMs, recordLoginFailure, clearLoginFailures,
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
function publicBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:3000';
  return `${proto}://${host}`;
}

// Ist überhaupt schon ein Admin angelegt? (für Setup-Hinweis im Frontend)
authRouter.get('/setup-status', (req, res) => {
  res.json({ needsSetup: !hasUsers() });
});

authRouter.post('/login', (req, res) => {
  const ip = req.ip;
  // 1. Gesperrte IP? -> 429, ohne Hinweis auf die Restzeit.
  if (loginBanRemainingMs(ip) > 0) {
    return res.status(429).json({ error: 'Zu viele Versuche, versuche es später wieder' });
  }
  const { username, password } = req.body ?? {};
  const user = verifyLogin(username, password);
  if (!user) {
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

// --- User-Verwaltung (nur Admin) ------------------------------------------

authRouter.get('/users', requirePerm('user.read'), (req, res) => {
  res.json(listUsers());
});

authRouter.post('/users', requirePerm('user.create'), (req, res) => {
  const { username, password, role, email } = req.body ?? {};
  try {
    // E-Mail nur uebernehmen, wenn der Anlegende auch user.email darf.
    const mail = roleHasPerm(req.user?.role, 'user.email') ? email : null;
    const user = createUser(username, password, role ?? 'friend', mail);
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
    return res.status(400).json({ error: 'Ungueltige E-Mail-Adresse' });
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
      error: 'Die eigene Rolle kann nicht geaendert werden. Bitte einen anderen Superuser darum bitten.',
    });
  }

  // Lockout-Schutz 2: der LETZTE Superuser darf nicht degradiert werden.
  try {
    const current = getRole(id);
    if (current === 'superuser' && role !== 'superuser' && countSuperusers() <= 1) {
      return res.status(400).json({
        error: 'Der letzte Superuser kann nicht herabgestuft werden - sonst waere die Armory nicht mehr administrierbar.',
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
        error: 'Der letzte Superuser kann nicht geloescht werden - sonst waere die Armory nicht mehr administrierbar.',
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
    return res.status(400).json({ error: 'Ungueltige E-Mail-Adresse' });
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
authRouter.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  try {
    changeOwnPassword(req.user.id, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin-Reset: Passwort eines anderen Nutzers setzen (nur Admin).
// Eigene Methode (POST) + eigener Pfad, kollidiert nicht mit PATCH /users/:id.
authRouter.post('/users/:id/password', requirePerm('user.password'), (req, res) => {
  const { newPassword } = req.body ?? {};
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const exists = listUsers().some((u) => u.id === id);
  if (!exists) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  try {
    setUserPassword(id, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Setup: ersten Admin anlegen (nur solange kein User existiert!) -------

authRouter.post('/setup', (req, res) => {
  if (hasUsers()) return res.status(403).json({ error: 'Setup bereits abgeschlossen' });
  const { username, password } = req.body ?? {};
  try {
    const user = createUser(username, password, 'admin');
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
authRouter.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Neues Passwort: mindestens 8 Zeichen.' });
  }
  const hit = consumeAuthToken(String(token ?? ''), 'reset');
  if (!hit) return res.status(400).json({ error: 'Der Link ist ungueltig oder abgelaufen.' });
  try {
    setUserPassword(hit.userId, newPassword);
    pruneAuthTokens();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Einladung einloesen (public) ------------------------------------------
authRouter.post('/accept-invite', (req, res) => {
  const { token, newPassword } = req.body ?? {};
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ error: 'Neues Passwort: mindestens 8 Zeichen.' });
  }
  const hit = consumeAuthToken(String(token ?? ''), 'invite');
  if (!hit) return res.status(400).json({ error: 'Die Einladung ist ungueltig oder abgelaufen.' });
  try {
    setUserPassword(hit.userId, newPassword);
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
    const allowed = !!ch?.allowed;
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

export { ROLE_LEVEL };
