const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsvTable, mergeImportedProspects } = require('./lead_csv');

test('parses semicolon CSV, BOM, escaped quotes, and embedded newlines', () => {
  const csv = "\uFEFFSIREN/SIRET;Entreprise;Ville;Métier;Notes\r\n123456789;\"L'Atelier \"\"Nord\"\"\";Lille;Menuisier;\"Appel fait\nà rappeler\"";
  const result = parseCsvTable(csv);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].nom, 'L\'Atelier "Nord"');
  assert.equal(result.records[0].note, 'Appel fait\nà rappeler');
  assert.deepEqual(result.errors, []);
});

test('rejects missing required columns and reports invalid rows', () => {
  assert.throws(() => parseCsvTable('Entreprise;Ville\nTest;Lille'), /Colonnes obligatoires manquantes/);
  const result = parseCsvTable('SIREN;Nom;Ville;Métier\n123;Test;Lille;Peintre');
  assert.equal(result.records.length, 0);
  assert.equal(result.errors[0].row, 2);
});

test('does not mark imported phones verified by default', () => {
  const result = parseCsvTable('SIREN;Nom;Ville;Métier;Téléphone;Téléphone vérifié;Source téléphone\n123456789;Test;Lille;Peintre;0612345678;;');
  assert.equal(result.records[0].telVerified, false);
  assert.equal(result.records[0].tel, '0612345678');
});

test('merges same-SIREN notes without overwriting existing details and flags name collisions', () => {
  const result = mergeImportedProspects([
    { siren: '123456789', nom: 'Atelier Nord', ville: 'Lille', metier: 'Menuisier', note: 'Note existante', email: 'pro@example.fr' },
    { siren: '987654321', nom: 'Artisan Sud', ville: 'Lyon', metier: 'Peintre' }
  ], [
    { siren: '123456789', nom: 'Autre nom', ville: 'Paris', metier: 'Autre métier', note: 'Note importée', email: 'nouveau@example.fr' },
    { siren: '987654320', nom: 'Artisan Sud', ville: 'Lyon', metier: 'Peintre', note: 'À vérifier' },
    { siren: '555555555', nom: 'Nouveau Bâtiment', ville: 'Bordeaux', metier: 'Électricien' }
  ]);
  assert.equal(result.added, 1);
  assert.equal(result.merged, 1);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.prospects[0].nom, 'Atelier Nord');
  assert.equal(result.prospects[0].email, 'pro@example.fr');
  assert.equal(result.prospects[0].note, 'Note existante | Note importée');
});
