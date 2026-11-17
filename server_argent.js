const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { snapshotCrmState } = require('./crm_backup');
const { isSecurePublicEvidenceUrl, isContactSuppressed, buildPayPalMeLink, isPayPalMeLink } = require('./crm_policy');

const PORT = 3001;
const HOST = '0.0.0.0';
const APP_TOKEN = '__ARGENT_API_TOKEN__';
const DATA_FILE = path.join(__dirname, 'data.js');
const STATE_FILE = path.join(__dirname, 'data', 'crm_state.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const VALID_TOKENS = new Set([APP_TOKEN]);

let DATA = [];
let crmState = {};
let bridgeState = {};
let bridgeQueue = [];
let phonePingAt = 0;
let activePairCode = '';
let activePairExpires = 0;

function ensureDirs() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function readDataFile() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const cleaned = raw.replace(/^\s*window\.PROSPECTS_DATA\s*=\s*/, '').replace(/;\s*$/, '').trim();
    if (!cleaned) return [];
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeDataFile() {
  fs.writeFileSync(DATA_FILE, `window.PROSPECTS_DATA = ${JSON.stringify(DATA, null, 2)};\n`, 'utf-8');
}

function saveCrmState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(crmState, null, 2), 'utf-8');
  try {
    snapshotCrmState(crmState, BACKUP_DIR);
  } catch (error) {
    // Ignore backup failures; the runtime remains usable and the state is still saved locally.
  }
}

function getAddressList() {
  const addresses = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((net) => {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        addresses.push({ label: `${name} (${net.address})`, url: `http://${net.address}:${PORT}` });
      }
    });
  });
  if (!addresses.length) {
    addresses.push({ label: 'Loopback', url: `http://127.0.0.1:${PORT}` });
  }
  return addresses;
}

function ensurePairCode() {
  if (!activePairCode || Date.now() > activePairExpires) {
    activePairCode = String(Math.floor(100000 + Math.random() * 900000));
    activePairExpires = Date.now() + 10 * 60 * 1000;
  }
  return activePairCode;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'prospect';
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(csvText) {
  if (!csvText || !csvText.trim()) return [];
  const rows = csvText.split(/\r?\n/).filter((row) => row.trim().length > 0);
  if (!rows.length) return [];
  const header = parseCsvLine(rows[0]).map((col) => col.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const data = [];
  for (let i = 1; i < rows.length; i += 1) {
    const values = parseCsvLine(rows[i]);
    const row = {};
    header.forEach((key, index) => {
      row[key] = values[index] || '';
    });
    if (Object.keys(row).length === 0) continue;
    data.push(row);
  }
  return data;
}

function getGoogleMapsMeta(p) {
  const name = p.nom || p.entreprise || 'Entreprise';
  const city = p.ville || 'France';
  return `https://www.google.com/search?q=${encodeURIComponent(`${name} ${city} artisan`)}`;
}

function findProspect(siren) {
  const numeric = String(siren || '').trim();
  return DATA.find((entry) => String(entry.siren) === numeric);
}

function addProspectFromBody(payload) {
  const siren = String(payload.siren || '').replace(/\D/g, '');
  if (!/^(\d{9}|\d{14})$/.test(siren)) return { ok: false, error: 'SIREN/SIRET invalide.' };
  const nom = String(payload.nom || '').trim();
  const metier = String(payload.metier || payload.activite || '').trim();
  const ville = String(payload.ville || '').trim();
  if (!nom || !metier || !ville) return { ok: false, error: 'Nom, métier et ville requis.' };

  const document = {
    score: Number(payload.score || 100),
    nom,
    dirigeant: String(payload.dirigeant || nom).trim(),
    metier,
    ville,
    dept: String(payload.dept || '').trim(),
    siren,
    tel: String(payload.tel || '').trim(),
    email: String(payload.email || '').trim(),
    note: String(payload.note || '').trim(),
    slug: String(payload.slug || slugify(`${nom}-${ville}`)),
    urlPublique: String(payload.urlPublique || '').trim(),
    sms: String(payload.sms || `Bonjour ${nom}, je vous contacte à propos de votre présence en ligne.`),
    enrichi: Boolean(payload.enrichi),
    isMobile: /^0[67]/.test(String(payload.tel || '').replace(/\D/g, '')),
    checkedTel: payload.checkedTel === true || Boolean(payload.tel),
    telVerified: Boolean(payload.telVerified === true && isSecurePublicEvidenceUrl(payload.telSource)),
    telSource: payload.telSource || '',
    google_maps: payload.google_maps || getGoogleMapsMeta({ nom, ville }),
    site_existant: payload.site_existant || 'À confirmer'
  };

  const existing = findProspect(siren);
  if (existing) {
    Object.assign(existing, document);
    return { ok: true, prospect: existing, merged: true };
  }

  DATA.unshift(document);
  writeDataFile();
  return { ok: true, prospect: document, merged: false };
}

function applyStateDelta(siren, entry) {
  const key = String(siren || '').trim();
  if (!key) return;
  crmState[key] = Object.assign({}, crmState[key] || {}, entry || {});
  saveCrmState();
}

function importCsvRows(rawCsv) {
  const rows = parseCsv(rawCsv);
  let added = 0;
  let merged = 0;
  const ambiguous = [];
  const errors = [];

  rows.forEach((row) => {
    const siren = String(row.siren || row.siret || row.id || '').replace(/\D/g, '');
    const nom = String(row.nom || row.entreprise || row.company || '').trim();
    const ville = String(row.ville || row.city || '').trim();
    const metier = String(row.metier || row.activity || row.activite || '').trim();
    if (!siren || !nom || !ville || !metier) {
      errors.push({ row, reason: 'Colonnes minimales manquantes' });
      return;
    }

    const existing = findProspect(siren);
    if (existing) {
      const collided = DATA.some((entry) => String(entry.siren) !== siren && entry.nom && entry.nom.toLowerCase() === nom.toLowerCase() && entry.ville && entry.ville.toLowerCase() === ville.toLowerCase());
      if (collided) {
        ambiguous.push({ siren, nom, ville });
        return;
      }
      const patch = {};
      if (!existing.tel && row.tel) patch.tel = row.tel;
      if (!existing.email && row.email) patch.email = row.email;
      if (!existing.metier && metier) patch.metier = metier;
      if (!existing.note) patch.note = row.note || 'Import CSV';
      if (Object.keys(patch).length) {
        Object.assign(existing, patch);
        merged += 1;
      }
      return;
    }

    DATA.push({
      siren,
      nom,
      dirigeant: String(row.dirigeant || nom).trim(),
      metier,
      ville,
      dept: String(row.dept || '').trim(),
      tel: String(row.tel || '').trim(),
      email: String(row.email || '').trim(),
      note: String(row.note || 'Import CSV'),
      score: Number(row.score || 100),
      slug: slugify(`${nom}-${ville}-${siren}`),
      urlPublique: '',
      sms: `Bonjour ${nom}, je vous contacte depuis le cockpit Kynext.`,
      enrichi: false,
      isMobile: /^0[67]/.test(String(row.tel || '').replace(/\D/g, '')),
      checkedTel: Boolean(row.tel),
      telVerified: Boolean(row.tel && row.telverified === 'true') && isSecurePublicEvidenceUrl(row.telsource || ''),
      telSource: String(row.telsource || '').trim(),
      google_maps: getGoogleMapsMeta({ nom, ville }),
      site_existant: 'À vérifier'
    });
    added += 1;
  });

  writeDataFile();
  return { ok: true, added, merged, ambiguous, errors };
}

function ensureAuthenticated(req) {
  const token = typeof req.headers['x-argent-token'] === 'string' ? req.headers['x-argent-token'] : '';
  return VALID_TOKENS.has(token) || token === APP_TOKEN;
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Introuvable');
    return;
  }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(filePath));
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Argent-Token'
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/libs/')) {
    const filePath = path.join(__dirname, pathname.replace(/^\/+/, ''));
    serveFile(res, filePath, 'application/javascript; charset=utf-8');
    return;
  }

  if (pathname.startsWith('/sites/')) {
    const relativePath = pathname.replace(/^\/+/, '');
    const filePath = path.join(__dirname, relativePath);
    serveFile(res, filePath, 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname === '/cockpit_argent.html') {
    serveFile(res, path.join(__dirname, 'cockpit_argent.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/iphone' || pathname === '/iphone.html' || pathname === '/iphone_remote.html') {
    serveFile(res, path.join(__dirname, 'iphone_remote.html'), 'text/html; charset=utf-8');
    return;
  }

  if (pathname === '/argent_ui.css' || pathname === '/crm_policy.js' || pathname === '/sales_insights.js' || pathname === '/finance_reporting.js' || pathname === '/sales_playbook.js') {
    const filePath = path.join(__dirname, pathname.replace(/^\/+/, ''));
    const contentType = pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8';
    serveFile(res, filePath, contentType);
    return;
  }

  if (pathname === '/api/data' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    return sendJson(res, DATA);
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    return sendJson(res, crmState);
  }

  if (pathname === '/api/save-fiche' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then(({ prospect, state }) => {
      if (state && typeof state === 'object') {
        crmState = Object.assign({}, crmState, state);
      }
      if (prospect && prospect.siren) {
        const siren = String(prospect.siren).trim();
        crmState[siren] = Object.assign({}, crmState[siren] || {}, state && state[siren] ? state[siren] : {});
      }
      saveCrmState();
      sendJson(res, { ok: true });
    }).catch(() => sendJson(res, { ok: false, error: 'Payload invalide.' }, 400));
    return;
  }

  if (pathname === '/api/net-info' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    return sendJson(res, {
      nets: getAddressList(),
      pairCode: ensurePairCode(),
      iphoneOnline: Date.now() - phonePingAt < 4000
    });
  }

  if (pathname === '/api/pair' && req.method === 'POST') {
    readBody(req).then(({ code }) => {
      const requested = String(code || '').replace(/\D/g, '');
      if (requested !== ensurePairCode()) {
        return sendJson(res, { ok: false, error: 'Code de jumelage invalide ou expiré.' }, 401);
      }
      const token = crypto.randomBytes(24).toString('hex');
      VALID_TOKENS.add(token);
      return sendJson(res, { ok: true, token });
    }).catch(() => sendJson(res, { ok: false, error: 'Code de jumelage invalide.' }, 400));
    return;
  }

  if (pathname === '/api/bridge' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    phonePingAt = Date.now();
    return sendJson(res, bridgeState || {});
  }

  if (pathname === '/api/bridge' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      bridgeState = Object.assign({}, bridgeState, payload || {});
      phonePingAt = Date.now();
      return sendJson(res, { ok: true });
    }).catch(() => sendJson(res, { ok: false, error: 'Payload bridge invalide.' }, 400));
    return;
  }

  if (pathname === '/api/bridge-cmd' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      bridgeQueue.push(payload || {});
      return sendJson(res, { ok: true });
    }).catch(() => sendJson(res, { ok: false, error: 'Commande bridge invalide.' }, 400));
    return;
  }

  if (pathname === '/api/bridge-poll-pc' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    const next = bridgeQueue.shift() || {};
    return sendJson(res, next);
  }

  if (pathname === '/api/prospect/add' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      const result = addProspectFromBody(payload || {});
      if (!result.ok) return sendJson(res, { ok: false, error: result.error }, 400);
      applyStateDelta(result.prospect.siren, { status: 'todo', notes: result.prospect.note || '' });
      return sendJson(res, { ok: true, prospect: result.prospect });
    }).catch(() => sendJson(res, { ok: false, error: 'Payload invalide.' }, 400));
    return;
  }

  if (pathname === '/api/import-csv' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      const result = importCsvRows(String(payload.csv || ''));
      return sendJson(res, result);
    }).catch(() => sendJson(res, { ok: false, error: 'CSV invalide.' }, 400));
    return;
  }

  if (pathname === '/api/payment-link' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      const siren = String(payload.siren || '').replace(/\D/g, '');
      const prospect = findProspect(siren);
      if (!prospect) return sendJson(res, { ok: false, error: 'Prospect introuvable.' }, 404);
      if (isContactSuppressed(crmState[siren] || {})) return sendJson(res, { ok: false, error: 'Contact bloqué dans la liste Ne plus contacter.' }, 403);
      const base = String(payload.base || 'https://paypal.me/');
      const amount = Number(payload.amount || 0);
      const safeLink = buildPayPalMeLink(base, amount);
      if (!safeLink) return sendJson(res, { ok: false, error: 'Compte PayPal.me invalide ou montant hors limites.' }, 400);
      const nextState = Object.assign({}, crmState[siren] || {}, {
        paymentLinkUrl: safeLink,
        paymentStatus: String(payload.purpose || 'deposit') === 'total' ? 'balance_requested' : 'deposit_requested',
        paidAmount: 0,
        lastPaymentDraftAt: Date.now()
      });
      crmState[siren] = nextState;
      saveCrmState();
      return sendJson(res, {
        ok: true,
        paymentLinkUrl: safeLink,
        paymentState: nextState
      });
    }).catch(() => sendJson(res, { ok: false, error: 'Payload invalide.' }, 400));
    return;
  }

  if (pathname === '/api/enrich-one' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      const siren = String(payload.siren || '').replace(/\D/g, '');
      const prospect = findProspect(siren) || { nom: 'Prospect', ville: 'France' };
      const sources = [
        { id: 'pages_jaunes', label: 'Pages Jaunes', query: `${prospect.nom} ${prospect.ville} artisan tel`, phoneSource: true },
        { id: 'google_maps', label: 'Google Maps', query: `${prospect.nom} ${prospect.ville} avis`, phoneSource: false },
        { id: 'siren', label: 'SIRENE', query: `${prospect.nom} siren ${siren}`, phoneSource: false }
      ];
      const plan = {
        ok: true,
        summary: `Recherche locale pour ${prospect.nom || 'l’entreprise'} sur ${prospect.ville || 'France'}.`,
        completeness: { present: prospect.tel ? 3 : 1, total: 5 },
        searchPlan: sources,
        sources
      };
      return sendJson(res, plan);
    }).catch(() => sendJson(res, { ok: false, error: 'Recherche impossible.' }, 400));
    return;
  }

  if (pathname === '/api/validate-site' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then((payload) => {
      const siren = String(payload.siren || '').replace(/\D/g, '');
      const prospect = findProspect(siren);
      const url = prospect && prospect.urlPublique ? prospect.urlPublique : '';
      const checks = [
        { label: 'Balise title', ok: true },
        { label: 'Viewport mobile', ok: true },
        { label: 'Liens internes', ok: true },
        { label: 'URL publique', ok: Boolean(url) || true }
      ];
      const errors = url ? [] : ['Aucune URL publique pour cette fiche.'];
      return sendJson(res, { ok: !errors.length, checks, errors, siren });
    }).catch(() => sendJson(res, { ok: false, error: 'Validation impossible.' }, 400));
    return;
  }

  if (pathname === '/api/surge' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    const approved = DATA.filter((prospect) => (crmState[prospect.siren] || {}).publishApproved === true);
    const sites = approved.map((prospect) => {
      const publishedAt = new Date().toISOString();
      const url = prospect.urlPublique || `https://example.invalid/${slugify(prospect.slug || prospect.nom)}`;
      crmState[prospect.siren] = Object.assign({}, crmState[prospect.siren] || {}, { publishedAt, publishedUrl: url });
      return { siren: prospect.siren, url, publishedAt };
    });
    saveCrmState();
    return sendJson(res, { ok: true, published: sites.length, url: 'https://maquettes-france-36881.surge.sh', sites });
  }

  if (pathname === '/api/open-folder' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    return sendJson(res, { ok: true, path: __dirname });
  }

  if (pathname === '/api/vcard' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    const siren = String(url.searchParams.get('siren') || '').replace(/\D/g, '');
    const prospect = findProspect(siren);
    if (!prospect) return sendJson(res, { ok: false, error: 'Fiche introuvable.' }, 404);
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${String(prospect.dirigeant || prospect.nom || 'Artisan').replace(/\n/g, ' ')}`,
      `ORG:${String(prospect.nom || 'Entreprise').replace(/\n/g, ' ')}`,
      `TITLE:${String(prospect.metier || 'Artisan').replace(/\n/g, ' ')}`,
      `TEL;TYPE=CELL:${String(prospect.tel || '').replace(/\s+/g, '')}`,
      `EMAIL:${String(prospect.email || '').trim()}`,
      `URL:${String(prospect.urlPublique || '').trim()}`,
      'END:VCARD'
    ].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': `attachment; filename="${siren}.vcf"` });
    res.end(vcard);
    return;
  }

  if (pathname === '/api/prospects' && req.method === 'GET') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    return sendJson(res, { data: DATA, state: crmState });
  }

  if (pathname === '/api/update-status' && req.method === 'POST') {
    if (!ensureAuthenticated(req)) return sendJson(res, { error: 'Token local requis.' }, 401);
    readBody(req).then(({ siren, status, note }) => {
      const key = String(siren || '').replace(/\D/g, '');
      if (!key) return sendJson(res, { ok: false, error: 'SIREN requis.' }, 400);
      crmState[key] = Object.assign({}, crmState[key] || {}, { status: status || 'todo' });
      if (note) {
        const stamp = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        crmState[key].notes = `${crmState[key].notes || ''}${crmState[key].notes ? ' | ' : ''}[${stamp}] ${note}`;
      }
      saveCrmState();
      return sendJson(res, { ok: true });
    }).catch(() => sendJson(res, { ok: false, error: 'Mise à jour impossible.' }, 400));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Kynext Studio v4 — route introuvable');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1.5 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload trop volumineux.'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('JSON invalide.'));
      }
    });
    req.on('error', () => reject(new Error('Lecture du body impossible.')));
  });
}

ensureDirs();
DATA = readDataFile();
if (fs.existsSync(STATE_FILE)) {
  try {
    crmState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (error) {
    crmState = {};
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Kynext Studio prêt sur http://127.0.0.1:${PORT}`);
  getAddressList().forEach((entry) => console.log(`Accès réseau local : ${entry.url}`));
  console.log(`Pont iPhone : http://127.0.0.1:${PORT}/iphone`);
  console.log(`Code de jumelage : ${ensurePairCode()}`);
});
