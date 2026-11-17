const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addPaymentMovement,
  calculateMonthlyReport,
  sanitizeFinanceSettings,
  sanitizePaymentEvents
} = require('./finance_reporting');

test('records receipts and refunds against the current balance', () => {
  const receiptAt = new Date(2026, 10, 4, 12).getTime();
  const receipt = addPaymentMovement({ paidAmount: 0 }, 'receipt', 300.125, receiptAt);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.state, {
    paymentEvents: [{ kind: 'receipt', amount: 300.13, recordedAt: receiptAt }],
    paidAmount: 300.13,
    paymentUpdatedAt: receiptAt,
    paidAt: receiptAt
  });

  const refund = addPaymentMovement(receipt.state, 'refund', 100, receiptAt + 1000);
  assert.equal(refund.ok, true);
  assert.equal(refund.state.paidAmount, 200.13);
  assert.equal(refund.state.paymentEvents.length, 2);
  assert.equal(addPaymentMovement(refund.state, 'refund', 201, receiptAt + 2000).error, 'refund_exceeds_balance');
});

test('calculates monthly receipts, estimated costs, and contact-to-first-payment time', () => {
  const contactAt = new Date(2026, 10, 1, 12).getTime();
  const receiptAt = new Date(2026, 10, 4, 12).getTime();
  const refundAt = new Date(2026, 10, 6, 12).getTime();
  const report = calculateMonthlyReport(
    [{ siren: '123456789', nom: 'Atelier Test' }],
    {
      '123456789': {
        firstContactAt: contactAt,
        paymentEvents: [
          { kind: 'receipt', amount: 500, recordedAt: receiptAt },
          { kind: 'refund', amount: 50, recordedAt: refundAt }
        ]
      }
    },
    '2026-11',
    { taxRate: 10, paymentFeeRate: 2, infrastructureMonthly: 20 }
  );
  assert.equal(report.receipts, 500);
  assert.equal(report.refunds, 50);
  assert.equal(report.netReceipts, 450);
  assert.equal(report.taxReserve, 45);
  assert.equal(report.paymentFees, 10);
  assert.equal(report.estimatedNet, 375);
  assert.equal(report.closingDaysAverage, 3);
  assert.equal(report.closingCount, 1);
  assert.equal(report.events[0].name, 'Atelier Test');
});

test('sanitizes event history and estimated cost settings', () => {
  assert.deepEqual(sanitizePaymentEvents([
    { kind: 'receipt', amount: 25.555, recordedAt: 123 },
    { kind: 'wire', amount: 100, recordedAt: 123 },
    { kind: 'refund', amount: Infinity, recordedAt: 123 }
  ]), [{ kind: 'receipt', amount: 25.56, recordedAt: 123 }]);
  assert.deepEqual(sanitizeFinanceSettings({ taxRate: 120, paymentFeeRate: -2, infrastructureMonthly: -1 }), {
    taxRate: 100,
    paymentFeeRate: 0,
    infrastructureMonthly: 0
  });
});

test('does not treat an undated legacy balance as a monthly receipt', () => {
  const report = calculateMonthlyReport(
    [{ siren: '123456789', nom: 'Atelier Test' }],
    { '123456789': { paidAmount: 790, paymentStatus: 'paid' } },
    '2026-11',
    {}
  );
  assert.equal(report.receipts, 0);
  assert.equal(report.events.length, 0);
  assert.equal(report.closingDaysAverage, null);
});
