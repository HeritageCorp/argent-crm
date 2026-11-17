const test = require('node:test');
const assert = require('node:assert/strict');
const { isSecurePublicEvidenceUrl, isContactSuppressed, buildPayPalMeLink, isPayPalMeLink } = require('./crm_policy');

test('requires a credential-free HTTPS source for phone evidence', () => {
  assert.equal(isSecurePublicEvidenceUrl('https://annuaire.example/entreprise/123'), true);
  assert.equal(isSecurePublicEvidenceUrl('http://annuaire.example/123'), false);
  assert.equal(isSecurePublicEvidenceUrl('https://user:pass@annuaire.example/123'), false);
});

test('treats do-not-contact as an explicit CRM suppression flag', () => {
  assert.equal(isContactSuppressed({ doNotContact: true }), true);
  assert.equal(isContactSuppressed({ status: 'refused' }), false);
});

test('builds bounded payment links only for configured PayPal.me accounts', () => {
  assert.equal(buildPayPalMeLink('https://paypal.me/kynext', 237), 'https://paypal.me/kynext/237');
  assert.equal(buildPayPalMeLink('https://paypal.me/', 237), '');
  assert.equal(buildPayPalMeLink('https://paypal.me/kynext?ref=campaign', 237), '');
  assert.equal(buildPayPalMeLink('https://paypal.me/kynext/subaccount', 237), '');
  assert.equal(buildPayPalMeLink('https://example.com/kynext', 237), '');
  assert.equal(buildPayPalMeLink('https://paypal.me/kynext', 1.5), '');
  assert.equal(isPayPalMeLink('https://paypal.me/kynext/237'), true);
  assert.equal(isPayPalMeLink('https://example.com/kynext/237'), false);
});
