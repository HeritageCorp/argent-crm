(function (root, factory) {
  const insights = factory();
  if (typeof module === 'object' && module.exports) module.exports = insights;
  else root.KynextInsights = insights;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BASE_SCORE = { todo: 20, sent: 45, hot: 80, sold: 100, refused: 0 };

  function getStatus(crmState) {
    const status = crmState && crmState.status;
    return Object.prototype.hasOwnProperty.call(BASE_SCORE, status) ? status : 'todo';
  }

  function getInteractionAge(crmState, now) {
    const timestamp = Number(crmState && crmState.lastInteractionAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return Math.max(0, now - timestamp);
  }

  function scoreLead(crmState, now) {
    const status = getStatus(crmState);
    const age = getInteractionAge(crmState, Number.isFinite(now) ? now : Date.now());
    let score = BASE_SCORE[status];

    if (age !== null && (status === 'sent' || status === 'hot')) {
      if (age <= 7 * DAY_MS) score += 10;
      else if (age >= 30 * DAY_MS) score -= 15;
    }

    return Math.max(0, Math.min(100, score));
  }

  function getSegment(crmState, now) {
    const status = getStatus(crmState);
    if (status === 'sold' || status === 'refused') return 'closed';
    if (status === 'hot') return 'hot';
    if (status === 'todo') return 'todo';

    const age = getInteractionAge(crmState, Number.isFinite(now) ? now : Date.now());
    return status === 'sent' && age !== null && age >= 3 * DAY_MS ? 'followup' : 'active';
  }

  return { scoreLead, getSegment };
}));
