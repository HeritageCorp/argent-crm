const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePaymentState } = require('./payment_state');

test('keeps a valid manual payment state and rounds amounts to cents', () => {
  assert.deepEqual(
    sanitizePaymentState({ paymentStatus: 'deposit_received', paidAmount: 237.456, paymentUpdatedAt: 1234 }),
    { paymentStatus: 'deposit_received', paidAmount: 237.46, paymentUpdatedAt: 1234 }
  );
});

test('rejects unknown status and bounds invalid payment amounts', () => {
  assert.deepEqual(
    sanitizePaymentState({ paymentStatus: 'crypto_wallet', paidAmount: Infinity, paymentUpdatedAt: -1 }),
    { paymentStatus: 'not_invoiced', paidAmount: 0, paymentUpdatedAt: 0 }
  );
  assert.equal(sanitizePaymentState({ paidAmount: 2000000 }).paidAmount, 1000000);
  assert.equal(sanitizePaymentState({ paidAmount: -5 }).paidAmount, 0);
});
