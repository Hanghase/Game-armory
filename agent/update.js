// Fernupdate fuer ein Arsenal - die ENTSCHEIDUNGEN.
//
// Hier steht kein git, kein tar, kein systemctl. Das ist Absicht: was hier
// passiert, muss ohne Netz und ohne Prozesse testbar sein. Die Ausfuehrung
// liegt in agent/updateRun.js.
//
// Die eine Regel, an der alles haengt (Konzept 2026-11-09):
//
//   DAS ROLLBACK DARF NICHT VON DER ARMORY ABHAENGEN.
//
// Ein Arsenal, das nach einem missglueckten Update auf ein Lebenszeichen aus
// dem Panel wartet, ist bei einem Netzproblem tot. Es sichert sich selbst,
// prueft sich selbst, rollt sich selbst zurueck - und MELDET danach nur.
// Darum kennt entscheideNachNeustart() die Armory gar nicht als Eingabe.

// Zerlegt "1.4.10" in [1, 4, 10]. Gibt null zurueck, wenn etwas nicht passt -
// dann wird NICHT upgedatet (im Zweifel nichts tun).
export function parseVersion(wert) {
  if (typeof wert !== 'string') return null;
  const roh = wert.trim().replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(roh)) return null;
  const teile = roh.split('.').map((n) => Number(n));
  if (teile.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return teile;
}

// -1 = a ist aelter, 0 = gleich, 1 = a ist neuer, null = nicht vergleichbar.
// Numerisch je Stelle, NICHT als Zeichenkette: "1.10.0" ist neuer als "1.9.0",
// als String waere es aelter.
export function vergleicheVersionen(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

// Was ist zu tun? Gibt einen Plan zurueck, nie eine Aktion.
//   noetig:     darf ueberhaupt upgedatet werden
//   grund:      warum nicht (fuer Log und Panel)
//   sicherung:  wo vorher gesichert wird
//   rollback:   wie zurueckgegangen wird
export function planeUpdate({ aktuell, verfuegbar, ziel = '1.5.0' } = {}) {
  const v = vergleicheVersionen(aktuell, verfuegbar);
  if (v === null) {
    return {
      noetig: false,
      grund: 'versionsangabe-unbrauchbar',
      sicherung: null,
      rollback: null,
    };
  }
  if (v === 0) {
    return { noetig: false, grund: 'schon-aktuell', sicherung: null, rollback: null };
  }
  if (v > 0) {
    // Zurueck ist kein Update. Wer das verwechselt, macht aus einem falschen
    // Tag einen Rueckbau der Maschine.
    return { noetig: false, grund: 'verfuegbar-ist-aelter', sicherung: null, rollback: null };
  }
  return {
    noetig: true,
    grund: 'neuere-version',
    von: aktuell,
    auf: verfuegbar,
    // Vor dem Wechsel den laufenden Stand als tar wegschreiben. Ohne Sicherung
    // gibt es kein Zurueck, und ohne Zurueck ist ein Fernupdate ein Risiko
    // ohne Deckung.
    sicherung: `backup/vor-${verfuegbar.replace(/[^0-9A-Za-z._-]/g, '')}.tar`,
    rollback: 'git checkout <alter-tag> && systemctl restart armory-arsenal',
  };
}

// Nach dem Neustart: bleiben oder zurueck?
//
// NUR lokale Messungen entscheiden. Die Armory ist bewusst KEIN Parameter -
// wer sie hier hineinreicht, baut einen Rollback, der bei Netzproblemen
// ausfaellt, und merkt es erst, wenn er gebraucht wird.
//
//   dienstAktiv     laeuft der Dienst nach dem Neustart?
//   versionGemeldet welche Version meldet er von sich aus?
//   erwartet        welche sollte es sein?
//
// Antwort: { zurueck: boolean, grund: '...' }
export function entscheideNachNeustart({ dienstAktiv, versionGemeldet, erwartet } = {}) {
  if (!dienstAktiv) {
    return { zurueck: true, grund: 'dienst-nicht-aktiv' };
  }
  if (erwartet && versionGemeldet) {
    const v = vergleicheVersionen(versionGemeldet, erwartet);
    // Meldet er weniger als erwartet, laeuft der alte Stand noch. Ein Dienst,
    // der "aktiv" ist und die alte Version faehrt, ist kein erfolgreiches
    // Update - nur ein Neustart.
    if (v === -1) {
      return { zurueck: true, grund: 'alte-version-laeuft-noch' };
    }
  }
  return { zurueck: false, grund: 'dienst-gesund' };
}
