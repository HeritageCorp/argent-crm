const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCallPitch, buildObjectionMessage, buildGentleFollowUp } = require('./sales_playbook');

test('builds a concise call pitch personalized with company, director, trade, and city', () => {
  const pitch = buildCallPitch({
    nom: 'Atelier Nord',
    dirigeant: 'Camille Martin',
    metier: 'Électricien',
    ville: 'Lille'
  });
  assert.match(pitch, /Bonjour Camille/);
  assert.match(pitch, /Atelier Nord/);
  assert.match(pitch, /Électricien/);
  assert.match(pitch, /Lille/);
});

test('provides respectful objection replies and an explicit no-follow-up message', () => {
  const prospect = { nom: 'Atelier Nord', dirigeant: 'Camille Martin' };
  assert.match(buildObjectionMessage('time', prospect), /créneau précis/);
  assert.match(buildObjectionMessage('usefulness', prospect), /Atelier Nord/);
  assert.match(buildObjectionMessage('no_followup', prospect), /ne vous relancerai plus/);
});

test('builds a low-pressure follow-up that explicitly allows ending contact', () => {
  const message = buildGentleFollowUp({ nom: 'Atelier Nord', dirigeant: 'Camille Martin' });
  assert.match(message, /Bonjour Camille/);
  assert.match(message, /Atelier Nord/);
  assert.match(message, /quand vous le souhaitez/);
  assert.match(message, /je ne vous relancerai plus/);
});
