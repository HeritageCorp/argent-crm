const PAYMENT_STATUSES = new Set([
  'not_invoiced',
  'deposit_requested',
  'deposit_received',
  'balance_requested',
  'paid',
  'refunded'
]);

function sanitizePaymentState(value) {
  const paidAmount = Number(value && value.paidAmount);
  const paymentUpdatedAt = Number(value && value.paymentUpdatedAt);

  return {
    paymentStatus: value && PAYMENT_STATUSES.has(value.paymentStatus) ? value.paymentStatus : 'not_invoiced',
    paidAmount: Number.isFinite(paidAmount) ? Math.round(Math.max(0, Math.min(1000000, paidAmount)) * 100) / 100 : 0,
    paymentUpdatedAt: Number.isFinite(paymentUpdatedAt) && paymentUpdatedAt > 0 ? paymentUpdatedAt : 0
  };
}

module.exports = { sanitizePaymentState };
