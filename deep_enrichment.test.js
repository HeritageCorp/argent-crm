const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFrenchPhone, buildDeepEnrichmentPlan } = require('./deep_enrichment');

test('normalizes French phone numbers to a consistent format', () => {
  assert.equal(normalizeFrenchPhone('+33 3 20 59 52 31'), '0320595231');
  assert.equal(normalizeFrenchPhone('03.20.59.52.31'), '0320595231');
  assert.equal(normalizeFrenchPhone('0333'), '');
});

test('builds a manual source plan without inventing confidence scores', () => {
  const plan = buildDeepEnrichmentPlan({
    nom: 'BUQUET-PASTANT',
    ville: 'Ennevelin',
    dept: '59',
    metier: 'Menuisier',
    dirigeant: 'Florian BUQUET',
    tel: '03 20 59 52 31',
    telVerified: true,
    telSource: 'https://www.buquet-pastant.fr/mentions-legales/',
    email: 'secretariat@buquet-pastant.fr',
    urlPublique: 'https://www.buquet-pastant.fr/'
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.completeness.present, 5);
  assert.equal(plan.completeness.total, 5);
  assert.ok(plan.searchPlan.length >= 8);
  assert.equal(plan.searchPlan[0].label, 'Site officiel · contact / mentions légales');
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.phoneCandidates.length, 3);
  assert.equal(plan.phoneCandidates.filter(candidate => candidate.available).length, 1);
  assert.ok(plan.phoneCandidates.find(candidate => candidate.available).verified);
  assert.ok(plan.evidenceChecklist.length >= 4);
});

test('marks incomplete leads for manual review', () => {
  const plan = buildDeepEnrichmentPlan({ nom: 'Société Test', ville: 'Rouen', metier: 'Menuisier' });
  assert.equal(plan.requiresManualReview, true);
  assert.ok(plan.searchPlan.length >= 8);
  assert.ok(plan.phoneCandidates.some(candidate => candidate.type === 'mobile'));
  assert.ok(plan.phoneCandidates.every(candidate => candidate.value === ''));
});
