const net = require('net');
const path = require('path');
const { restoreCrmSnapshot } = require('./crm_backup');

const ROOT = __dirname;
const BACKUPS_DIR = path.join(ROOT, 'backups');
const STATE_FILE = path.join(ROOT, 'dossiers_clients', 'crm_state.json');
const PORT = 3001;

function assertServerStopped() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: PORT });
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('Arrête le serveur Kynext avant de restaurer un snapshot.'));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Impossible de confirmer que le serveur est arrêté.'));
    });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
  });
}

async function main() {
  const requestedPath = process.argv[2];
  if (!requestedPath) throw new Error('Usage : node restore_crm_snapshot.js backups\\crm-state-<hash>.json');
  const snapshotPath = path.resolve(ROOT, requestedPath);
  await assertServerStopped();
  const restored = restoreCrmSnapshot(snapshotPath, STATE_FILE, BACKUPS_DIR);
  console.log('État CRM restauré depuis le snapshot ' + (restored.savedAt || 'sans date') + '.');
  console.log('L’ancien état a été conservé dans backups/crm-state-pre-restore-*.json.');
}

if (require.main === module) {
  main().catch(error => {
    console.error('Restauration impossible : ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { assertServerStopped };
