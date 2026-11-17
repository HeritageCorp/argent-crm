const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotCrmState, restoreCrmSnapshot, MAX_SNAPSHOTS } = require('./crm_backup');

test('stores one recoverable snapshot per distinct CRM state', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kynext-backup-'));
  try {
    const first = snapshotCrmState({ '123456789': { status: 'todo' } }, backupDir, '2026-11-16T20:00:00.000Z');
    const repeated = snapshotCrmState({ '123456789': { status: 'todo' } }, backupDir, '2026-11-16T21:00:00.000Z');
    const changed = snapshotCrmState({ '123456789': { status: 'hot' } }, backupDir, '2026-11-16T22:00:00.000Z');

    assert.equal(first, repeated);
    assert.notEqual(first, changed);
    assert.deepEqual(fs.readdirSync(backupDir).sort(), [path.basename(first), path.basename(changed)].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(changed, 'utf8')).state, { '123456789': { status: 'hot' } });
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

test('restores a CRM snapshot while preserving the previous live state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kynext-backup-restore-'));
  const backupDir = path.join(root, 'backups');
  const statePath = path.join(root, 'crm_state.json');
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ '123456789': { status: 'hot' } }), 'utf8');
    const snapshotPath = snapshotCrmState({ '123456789': { status: 'todo' } }, backupDir);
    const restored = restoreCrmSnapshot(snapshotPath, statePath, backupDir, 1234);

    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), { '123456789': { status: 'todo' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupDir, 'crm-state-pre-restore-1234.json'), 'utf8')), { '123456789': { status: 'hot' } });
    assert.equal(restored.statePath, statePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains only the configured number of distinct CRM snapshots', () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kynext-backup-retention-'));
  try {
    const oldest = snapshotCrmState({ id: 1 }, backupDir, '2026-11-16T20:00:00.000Z', 2);
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(oldest, oldTime, oldTime);
    snapshotCrmState({ id: 2 }, backupDir, '2026-11-16T21:00:00.000Z', 2);
    snapshotCrmState({ id: 3 }, backupDir, '2026-11-16T22:00:00.000Z', 2);

    const snapshots = fs.readdirSync(backupDir).filter(name => /^crm-state-[a-f0-9]{64}\.json$/.test(name));
    assert.equal(snapshots.length, 2);
    assert.equal(fs.existsSync(oldest), false);
    assert.equal(MAX_SNAPSHOTS, 50);
  } finally {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});
