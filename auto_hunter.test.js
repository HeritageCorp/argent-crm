const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCandidateCsv } = require('./auto_hunter');
const { parseCsvTable } = require('./lead_csv');

test('exports hunter candidates as importable leads without treating numbers as verified', () => {
  const csv = buildCandidateCsv([{
    siren: '123456789',
    nom: 'Atelier "Nord"',
    dirigeant: 'Camille Martin',
    metier: 'Électricien Général',
    ville: 'Lille',
    dept: '59',
    adresse: '10 rue du Nord',
    note: 'Vérifier manuellement.'
  }]);

  const parsed = parseCsvTable(csv);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].siren, '123456789');
  assert.equal(parsed.records[0].nom, 'Atelier "Nord"');
  assert.equal(parsed.records[0].telVerified, false);
  assert.equal(parsed.records[0].tel, '');
  assert.match(parsed.records[0].note, /Vérifier manuellement/);
});
