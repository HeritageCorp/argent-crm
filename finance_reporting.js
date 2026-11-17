(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.KynextFinance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_AMOUNT = 1000000;
  const MAX_EVENTS = 500;
  const PAYMENT_KINDS = new Set(['receipt', 'refund']);

  function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
  }

  function validTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= Date.now() + 86400000
      ? timestamp
      : 0;
  }

  function sanitizePaymentEvents(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(-MAX_EVENTS).reduce((events, item) => {
      if (!item || !PAYMENT_KINDS.has(item.kind)) return events;
      const amount = Number(item.amount);
      const recordedAt = validTimestamp(item.recordedAt);
      const roundedAmount = roundMoney(amount);
      if (!Number.isFinite(amount) || roundedAmount <= 0 || amount > MAX_AMOUNT || !recordedAt) return events;
      events.push({ kind: item.kind, amount: roundedAmount, recordedAt });
      return events;
    }, []);
  }

  function sanitizeFinanceSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    function percentage(raw) {
      const number = Number(raw);
      return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
    }
    const infrastructureMonthly = Number(input.infrastructureMonthly);
    return {
      taxRate: percentage(input.taxRate),
      paymentFeeRate: percentage(input.paymentFeeRate),
      infrastructureMonthly: Number.isFinite(infrastructureMonthly)
        ? roundMoney(Math.max(0, Math.min(MAX_AMOUNT, infrastructureMonthly)))
        : 0
    };
  }

  function addPaymentMovement(currentState, kind, amountValue, recordedAtValue) {
    if (!PAYMENT_KINDS.has(kind)) return { ok: false, error: 'invalid_kind' };
    const amount = roundMoney(Number(amountValue));
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return { ok: false, error: 'invalid_amount' };

    const state = currentState && typeof currentState === 'object' ? currentState : {};
    const currentBalance = Number(state.paidAmount);
    const paidAmount = Number.isFinite(currentBalance) ? Math.max(0, Math.min(MAX_AMOUNT, roundMoney(currentBalance))) : 0;
    const paymentEvents = sanitizePaymentEvents(state.paymentEvents);
    const recordedAt = validTimestamp(recordedAtValue || Date.now());
    if (!recordedAt) return { ok: false, error: 'invalid_date' };
    if (paymentEvents.length >= MAX_EVENTS) return { ok: false, error: 'journal_full' };
    if (kind === 'refund' && amount > paidAmount) return { ok: false, error: 'refund_exceeds_balance' };
    if (kind === 'receipt' && paidAmount + amount > MAX_AMOUNT) return { ok: false, error: 'balance_limit' };

    const nextBalance = roundMoney(paidAmount + (kind === 'receipt' ? amount : -amount));
    const nextState = {
      paymentEvents: paymentEvents.concat({ kind, amount, recordedAt }),
      paidAmount: nextBalance,
      paymentUpdatedAt: recordedAt
    };
    if (kind === 'receipt' && !validTimestamp(state.paidAt)) nextState.paidAt = recordedAt;
    else if (validTimestamp(state.paidAt)) nextState.paidAt = validTimestamp(state.paidAt);
    return { ok: true, state: nextState };
  }

  function monthKey(timestamp) {
    const date = new Date(Number(timestamp));
    if (!Number.isFinite(date.getTime())) return '';
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
  }

  function calculateMonthlyReport(prospects, state, month, settingsValue) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) {
      throw new TypeError('Mois de reporting invalide');
    }
    const records = state && typeof state === 'object' ? state : {};
    const names = new Map((Array.isArray(prospects) ? prospects : []).map(item => [String(item.siren), String(item.nom || 'Entreprise')]));
    const firstReceipts = new Map();
    const events = [];
    for (const [siren, entry] of Object.entries(records)) {
      if (!entry || typeof entry !== 'object') continue;
      const contactAt = validTimestamp(entry.firstContactAt);
      for (const payment of sanitizePaymentEvents(entry.paymentEvents)) {
        if (payment.kind === 'receipt' && (!firstReceipts.has(siren) || payment.recordedAt < firstReceipts.get(siren))) {
          firstReceipts.set(siren, payment.recordedAt);
        }
        if (monthKey(payment.recordedAt) !== month) continue;
        events.push({
          siren,
          name: names.get(siren) || 'Entreprise',
          kind: payment.kind,
          amount: payment.amount,
          recordedAt: payment.recordedAt,
          status: String(entry.status || 'todo'),
          firstContactAt: contactAt
        });
      }
    }
    events.sort((left, right) => left.recordedAt - right.recordedAt);

    let receipts = 0;
    let refunds = 0;
    for (const event of events) {
      if (event.kind === 'receipt') receipts += event.amount;
      else refunds += event.amount;
    }
    receipts = roundMoney(receipts);
    refunds = roundMoney(refunds);
    const netReceipts = roundMoney(receipts - refunds);
    const settings = sanitizeFinanceSettings(settingsValue);
    const taxReserve = roundMoney(Math.max(0, netReceipts) * settings.taxRate / 100);
    const paymentFees = roundMoney(receipts * settings.paymentFeeRate / 100);
    const estimatedNet = roundMoney(netReceipts - taxReserve - paymentFees - settings.infrastructureMonthly);

    let closingDaysTotal = 0;
    let closingCount = 0;
    for (const [siren, firstPaidAt] of firstReceipts) {
      if (monthKey(firstPaidAt) !== month) continue;
      const contactAt = validTimestamp(records[siren] && records[siren].firstContactAt);
      if (!contactAt || contactAt > firstPaidAt) continue;
      closingDaysTotal += (firstPaidAt - contactAt) / 86400000;
      closingCount++;
    }

    return {
      month,
      receipts,
      refunds,
      netReceipts,
      taxReserve,
      paymentFees,
      infrastructureMonthly: settings.infrastructureMonthly,
      estimatedNet,
      netRate: netReceipts > 0 ? roundMoney(estimatedNet / netReceipts * 100) : null,
      closingDaysAverage: closingCount ? roundMoney(closingDaysTotal / closingCount) : null,
      closingCount,
      events
    };
  }

  return {
    addPaymentMovement,
    calculateMonthlyReport,
    monthKey,
    sanitizeFinanceSettings,
    sanitizePaymentEvents
  };
});
