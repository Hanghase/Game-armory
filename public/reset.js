// Game-Armory - Passwort-Reset-Seite
// Ausgelagert aus reset.html (2026-10-23), damit die CSP
// script-src 'self' ohne 'unsafe-inline' auskommt. Inhalt 1:1 uebernommen.

    const msgEl = document.getElementById('msg');
    const noteEl = document.getElementById('note');
    const subtitleEl = document.getElementById('subtitle');
    const submitBtn = document.getElementById('submitBtn');
    const formEl = document.getElementById('form');

    function setMsg(text, cls = '') { msgEl.textContent = text; msgEl.className = 'msg ' + cls; }

    async function api(path, opts) {
      const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
      let data = {};
      try { data = await r.json(); } catch {}
      return { status: r.status, data };
    }

    // Token aus dem Link lesen: /reset?token=XXX  (invite=1 kennzeichnet Einladungen)
    const params = new URLSearchParams(location.search);
    const token = params.get('token') || '';
    const isInvite = params.get('invite') === '1';

    if (!token) {
      formEl.classList.add('hidden');
      subtitleEl.textContent = 'Kein gueltiger Link';
      setMsg('Diesem Link fehlt der Token. Bitte fordere eine neue E-Mail an.', 'err');
      noteEl.innerHTML = '<a href="/login">Zurueck zum Login</a>';
    } else if (isInvite) {
      subtitleEl.textContent = 'Willkommen — Passwort setzen';
      noteEl.textContent = 'Setze jetzt dein Passwort, um die Einladung abzuschliessen.';
    } else {
      noteEl.textContent = 'Der Link ist 60 Minuten gueltig und nur einmal verwendbar.';
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!token) return;
      const p1 = document.getElementById('password').value;
      const p2 = document.getElementById('password2').value;
      if (p1.length < 8) return setMsg('Das Passwort braucht mindestens 8 Zeichen.', 'err');
      if (p1 !== p2) return setMsg('Die Passwoerter stimmen nicht ueberein.', 'err');

      submitBtn.disabled = true;
      setMsg('…');
      const endpoint = isInvite ? '/api/auth/accept-invite' : '/api/auth/reset-password';
      const { status, data } = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ token, newPassword: p1 }),
      });
      submitBtn.disabled = false;

      if (status === 200) {
        setMsg('Passwort gespeichert! Du kannst dich jetzt einloggen.', 'ok');
        formEl.querySelectorAll('input').forEach((i) => { i.disabled = true; });
        submitBtn.disabled = true;
        noteEl.innerHTML = '<a href="/login">Jetzt einloggen</a>';
      } else {
        setMsg(data?.error ?? 'Der Link ist ungueltig oder abgelaufen.', 'err');
      }
    });

// --- Darstellung hell/dunkel --------------------------------------------------
// Login und Reset kennen kein Konto, deshalb liegt die Wahl nur im Browser.
// Nach dem Login ueberschreibt der gespeicherte Wert aus users.prefs diese Wahl.
(() => {
  const KEY = 'armory-theme';
  const btn = document.getElementById('themeSwitch');
  if (!btn) return;

  const read = () => {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; }
    catch { return 'dark'; }
  };

  const paint = (theme) => {
    const light = theme === 'light';
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    btn.setAttribute('aria-checked', light ? 'true' : 'false');
  };

  paint(read());

  btn.addEventListener('click', () => {
    const next = read() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch { /* privat -> egal */ }
    paint(next);
  });
})();
