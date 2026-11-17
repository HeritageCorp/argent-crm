const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreLead, getSegment } = require('./sales_insights');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

test('scores CRM stages and rewards recent recorded engagement', () => {
  assert.equal(scoreLead({ status: 'todo' }, NOW), 20);
  assert.equal(scoreLead({ status: 'hot', lastInteractionAt: NOW - DAY_MS }, NOW), 90);
  assert.equal(scoreLead({ status: 'sent', lastInteractionAt: NOW - 31 * DAY_MS }, NOW), 30);
});

test('segments only explicitly recorded, overdue sent leads for follow-up', () => {
  assert.equal(getSegment({ status: 'sent' }, NOW), 'active');
  assert.equal(getSegment({ status: 'sent', lastInteractionAt: NOW - 3 * DAY_MS }, NOW), 'followup');
  assert.equal(getSegment({ status: 'hot' }, NOW), 'hot');
  assert.equal(getSegment({ status: 'refused' }, NOW), 'closed');
});

test('unknown CRM status safely falls back to the uncontacted stage', () => {
  assert.equal(scoreLead({ status: 'unknown' }, NOW), 20);
  assert.equal(getSegment({ status: 'unknown' }, NOW), 'todo');
});
