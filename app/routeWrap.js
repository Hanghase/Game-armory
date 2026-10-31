// Game-Armory - async-Routen absichern (PRE-RELEASE-AUDIT 2026-10-31)
//
// Warum es das braucht (belegt, nicht vermutet):
//   express 4.22.3
//   Eine async-Route, die ein Promise ablehnt, landet NICHT im Error-Handler.
//   Der Prozess beendet sich mit "unhandledRejection". Isoliert getestet:
//   eine werfende async-Route hat die Testinstanz sofort beendet.
//   Betroffen waren fuenf Routen ohne eigenes try/catch - ein einziger
//   unerwarteter Reject haette das GANZE Panel fuer alle Nutzer beendet.
//
// Was der Wrapper macht:
//   Er nimmt eine Route (req,res[,next]) und gibt eine Route zurueck, die
//   einen zurueckgewiesenen Promise an next(err) gibt. Damit greift der
//   zentrale Error-Handler in server.js: Kennung ins Log und in die
//   Fehlertabelle, generischer Text an den Client, Prozess lebt weiter.
//
// Bewusst OHNE Express 5 zu verlangen: das waere ein groesseres Vorhaben
// (eigene Fehlerbehandlung anders, Router-Verhalten anders). Der Wrapper
// funktioniert unter Express 4 und bleibt unter Express 5 gueltig.

// Wickelt eine einzelne Route.
export function wrap(fn) {
  return function wrapped(req, res, next) {
    try {
      // Route ohne Rueckgabe (synchron) -> fertig.
      const out = fn(req, res, next);
      // Route mit Rueckgabe: nur Promises brauchen ein catch.
      if (out && typeof out.then === 'function') {
        out.catch((err) => next(err));
      }
    } catch (err) {
      // Synchroner Wurf: auch der muss zum Error-Handler, nicht zum Absturz.
      next(err);
    }
  };
}

// Wickelt jeden Handler eines Routers.
// Wird einmal nach dem Aufbau des Routers aufgerufen. Bewusst am Router und
// nicht an jeder Route: so kann keine neue Route beim Hinzufuegen vergessen
// werden - sie ist automatisch geschuetzt.
//
// WICHTIG (Fehler beim ersten Versuch, 2026-10-31, belegt):
// Bei `router.get('/pfad', handler)` ist `layer.handle` NICHT der Handler,
// sondern eine interne Dispatch-Funktion von Express ("bound dispatch").
// Die echten Handler liegen in `layer.route.stack[i].handle`. Die erste
// Fassung wickelte nur `layer.handle` - der Marker zeigte "2 von 2 gewickelt",
// aber der echte Handler blieb ungeschuetzt und der Reject kam weiterhin als
// unhandledRejection durch. Nur der Absturztest hat das aufgedeckt, nicht der
// Marker. Deshalb jetzt beide Ebenen:
//   1. layer.route.stack[].handle  -> die eigentlichen Routen-Handler
//   2. layer.handle                -> Middleware, die direkt am Router haengt
function wrapOne(layer) {
  const fn = layer?.handle;
  if (typeof fn !== 'function') return false;
  if (fn.__armoryWrapped) return false;
  const wrapped = wrap(fn);
  wrapped.__armoryWrapped = true;
  layer.handle = wrapped;
  return true;
}

export function wrapRouter(router) {
  const stack = router?.stack;
  if (!Array.isArray(stack)) return router;
  for (const layer of stack) {
    // 1) Routen: jeder Handler in der Route einzeln.
    const routeStack = layer?.route?.stack;
    if (Array.isArray(routeStack)) {
      for (const routeLayer of routeStack) wrapOne(routeLayer);
    }
    // 2) Middleware direkt am Router (kein layer.route).
    if (!layer?.route) wrapOne(layer);
  }
  return router;
}
