const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SNAPSHOTS = 50;

function pruneCrmSnapshots(backupDir, maxSnapshots = MAX_SNAPSHOTS) {
  const snapshots = fs.readdirSync(backupDir)
    .filter(name => /^crm-state-[a-f0-9]{64}\.json$/.test(name))
    .map(name => {
      const filePath = path.join(backupDir, name);
      return { filePath, modifiedAt: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.filePath.localeCompare(b.filePath));

  for (const snapshot of snapshots.slice(maxSnapshots)) fs.unlinkSync(snapshot.filePath);
  return Math.min(snapshots.length, maxSnapshots);
}

function restoreCrmSnapshot(snapshotPath, statePath, backupDir, restoredAt = Date.now()) {
  const resolvedBackupDir = fs.realpathSync(backupDir);
  const resolvedSnapshotPath = fs.realpathSync(snapshotPath);
  const relativeSnapshotPath = path.relative(resolvedBackupDir, resolvedSnapshotPath);
  if (!relativeSnapshotPath || relativeSnapshotPath.startsWith('..') || path.isAbsolute(relativeSnapshotPath) ||
      relativeSnapshotPath.includes(path.sep) ||
      !/^crm-state-[a-f0-9]{64}\.json$/.test(path.basename(resolvedSnapshotPath))) {
    throw new Error('Choisis un snapshot CRM valide situé directement dans le dossier backups.');
  }

  const snapshot = JSON.parse(fs.readFileSync(resolvedSnapshotPath, 'utf8'));
  if (!snapshot || !snapshot.state || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state) ||
      Object.keys(snapshot.state).length > 3000 ||
      Object.entries(snapshot.state).some(([siren, value]) => !/^\d{9,14}$/.test(siren) || !value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('Le snapshot ne contient pas un état CRM valide.');
  }

  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(statePath)) {
    const recoveryPath = path.join(backupDir, 'crm-state-pre-restore-' + restoredAt + '.json');
    fs.writeFileSync(recoveryPath, fs.readFileSync(statePath), { flag: 'wx' });
  }

  const temporaryPath = statePath + '.' + process.pid + '.restore.tmp';
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(snapshot.state, null, 2), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, statePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch {}
    throw error;
  }
  return { statePath, savedAt: String(snapshot.savedAt || '') };
}

function snapshotCrmState(state, backupDir, savedAt = new Date().toISOString(), maxSnapshots = MAX_SNAPSHOTS) {
  const contents = JSON.stringify(state, null, 2);
  const digest = crypto.createHash('sha256').update(contents).digest('hex');
  const filePath = path.join(backupDir, 'crm-state-' + digest + '.json');
  fs.mkdirSync(backupDir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    const snapshot = JSON.stringify({ savedAt, state: JSON.parse(contents) }, null, 2);
    const tempPath = filePath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tempPath, snapshot, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      if (!fs.existsSync(filePath)) throw error;
    }
  }

  pruneCrmSnapshots(backupDir, maxSnapshots);
  return filePath;
}

module.exports = { snapshotCrmState, pruneCrmSnapshots, restoreCrmSnapshot, MAX_SNAPSHOTS };
