// Game-Armory - Tests
//
// Aufruf:
//   node --test tests/
//   npm test
//
// Warum node:test und kein Framework: das Projekt hat null devDependencies,
// und Tests, die beim Kunden laufen sollen, duerfen keine Netzinstallation
// brauchen. node:test ist seit Node 18 eingebaut; das Projekt verlangt ohnehin
// Node >= 20.
//
// Grundsatz (aus dem Audit vom 2026-10-31): jeder Test muss ERST scheitern
// koennen. Ein Test, der immer gruen ist, prueft nichts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

export const GUELTIGES_RACK = {
  $schema: './rack.schema.json',
  id: 'testrack',
  name: 'Test-Rack',
  description: 'Ein Rack, das nur fuer Tests existiert.',
  icon: 'testrack',
  game: '7d2d',
  loader: 'native',
  tier: 'free',
  licenseRequired: false,
  installMethod: 'steamcmd',
  defaultRoot: '/opt/testrack',
  source: { type: 'steam', projectId: null, appId: 123456 },
  javaRequired: null,
};

// Deep-Copy, damit ein Test das Fixture nicht fuer den naechsten veraendert.
export function rack(overrides = {}) {
  return { ...structuredClone(GUELTIGES_RACK), ...overrides };
}

export { test, assert };
