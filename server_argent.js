
let BRIDGE_STATE = {};
let LAST_IPHONE_PING = 0;
let PC_QUEUE = [];

﻿const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { sanitizePaymentState } = require('./payment_state');
const { sanitizePaymentEvents } = require('./finance_reporting');
const { validateGeneratedSite } = require('./site_validation');
const { buildDeepEnrichmentPlan } = require('./deep_enrichment');
const { snapshotCrmState } = require('./crm_backup');
const { parseCsvTable, mergeImportedProspects } = require('./lead_csv');
const CrmPolicy = require('./crm_policy');

const DOMAINE = 'maquettes-france-36881.surge.sh';
const PORT = 3001;
const ROOT_DIR = __dirname;
const CLIENTS_DIR = path.join(ROOT_DIR, 'dossiers_clients');
const SITES_DIR = path.join(ROOT_DIR, 'sites');
const BACKUPS_DIR = path.join(ROOT_DIR, 'backups');
const STATE_FILE = path.join(CLIENTS_DIR, 'crm_state.json');
const DATA_FILE = path.join(ROOT_DIR, 'data.js');
const API_TOKEN = crypto.randomBytes(32).toString('hex');
let PAIR_CODE = '';
let PAIR_CODE_EXPIRES = 0;
const PAIR_ATTEMPTS = new Map();
let CRM_STATE = Object.create(null);

function renewPairCode() {
  PAIR_CODE = String(crypto.randomInt(100000, 1000000));
  PAIR_CODE_EXPIRES = Date.now() + 10 * 60 * 1000;
  return PAIR_CODE;
}
renewPairCode();

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, ch => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026',
    '\u2028': '\\u2028', '\u2029': '\\u2029'
  })[ch]);
}

function isLoopbackAddress(address) {
  return address === '::1' || address === '127.0.0.1' ||
    address.startsWith('127.') || address.startsWith('::ffff:127.');
}

function ipv4Number(address) {
  const octets = String(address || '').split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return (((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0);
}

function isPrivateIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function localIpv4Addresses() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && isPrivateIpv4(item.address)) {
        found.push(item.address);
      }
    }
  }
  return [...new Set(found)];
}

function isAllowedHost(host) {
  const normalized = String(host || '').toLowerCase();
  return normalized === 'localhost:' + PORT || normalized === '127.0.0.1:' + PORT ||
    normalized === '[::1]:' + PORT ||
    localIpv4Addresses().some(ip => normalized === ip + ':' + PORT);
}

function requestOriginAllowed(req) {
  const origin = req.headers.origin;
  return !origin || origin === 'http://' + req.headers.host;
}

function isLocalClient(req) {
  return isLoopbackAddress(req.socket.remoteAddress || '');
}

function isTrustedLanClient(req) {
  const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const hostAddress = String(req.headers.host || '').replace(/:\d+$/, '');
  const remote = ipv4Number(remoteAddress);
  if (remote === null || !isPrivateIpv4(remoteAddress) || !isPrivateIpv4(hostAddress)) return false;

  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if ((item.family !== 'IPv4' && item.family !== 4) || item.address !== hostAddress) continue;
      const local = ipv4Number(item.address);
      const mask = ipv4Number(item.netmask);
      if (local !== null && mask !== null && (local & mask) === (remote & mask)) return true;
    }
  }
  return false;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        req.resume();
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Payload trop volumineux'), { statusCode: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('JSON invalide'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function writeAtomic(filePath, contents) {
  const tempPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  fs.writeFileSync(tempPath, contents, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 120;
}

function normalizedText(value, max = 300) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function normalizeFrenchPhone(value) {
  const digits = String(value == null ? '' : value).replace(/\D/g, '');
  let national = digits;
  if (/^0033[1-9]\d{8}$/.test(digits)) national = '0' + digits.slice(4);
  else if (/^33[1-9]\d{8}$/.test(digits)) national = '0' + digits.slice(2);
  if (!/^0[1-9]\d{8}$/.test(national)) return '';
  return national.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

function isSecurePhoneSource(value) {
  return CrmPolicy.isSecurePublicEvidenceUrl(value);
}

function verifiedPhoneFields(input) {
  const tel = normalizeFrenchPhone(input && input.tel);
  const telSource = normalizedText(input && input.telSource, 500);
  if (!tel || !input || input.telVerified !== true || !isSecurePhoneSource(telSource)) {
    return { tel: '', telVerified: false, telSource: '' };
  }
  return { tel, telVerified: true, telSource };
}

function normalizeProspect(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fiche invalide');
  const phone = verifiedPhoneFields(input);
  const p = {
    siren: String(input.siren == null ? '' : input.siren),
    slug: String(input.slug == null ? '' : input.slug).toLowerCase(),
    nom: normalizedText(input.nom, 160),
    dirigeant: normalizedText(input.dirigeant, 120),
    metier: normalizedText(input.metier, 120),
    ville: normalizedText(input.ville, 120),
    dept: normalizedText(input.dept, 16),
    tel: phone.tel,
    telVerified: phone.telVerified,
    telSource: phone.telSource,
    email: normalizedText(input.email, 180),
    adresse: normalizedText(input.adresse, 240),
    urlPublique: normalizedText(input.urlPublique, 500),
    note: normalizedText(input.note, 500),
    sms: normalizedText(input.sms, 1000),
    score: Number.isFinite(Number(input.score)) ? Number(input.score) : 0,
    checkedTel: Boolean(input.checkedTel),
    isMobile: Boolean(phone.tel && /^0[67]/.test(phone.tel.replace(/\D/g, '')))
  };
  if (!/^\d{9,14}$/.test(p.siren)) throw new Error('SIREN/SIRET invalide');
  if (!validSlug(p.slug)) throw new Error('Identifiant de page invalide');
  if (!p.nom || !p.ville || !p.metier) throw new Error('Nom, ville et métier sont requis');
  return p;
}

function sanitizeCrmState(input) {
  const result = Object.create(null);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  for (const [siren, value] of Object.entries(input).slice(0, 3000)) {
    if (!/^\d{9,14}$/.test(siren) || !value || typeof value !== 'object') continue;
    const status = ['todo', 'sent', 'hot', 'sold', 'refused'].includes(value.status) ? value.status : 'todo';
    const phone = verifiedPhoneFields(value);
    result[siren] = {
      status,
      notes: normalizedText(value.notes, 5000),
      tel: phone.tel,
      telVerified: phone.telVerified,
      telSource: phone.telSource,
      phoneLookupAttempts: Number.isInteger(Number(value.phoneLookupAttempts)) ? Math.min(9999, Math.max(0, Number(value.phoneLookupAttempts))) : 0,
      phoneLookupCheckedAt: Number.isFinite(Number(value.phoneLookupCheckedAt)) && Number(value.phoneLookupCheckedAt) > 0 ? Number(value.phoneLookupCheckedAt) : 0,
      phoneLookupOutcome: ['pending', 'no_match', 'verified'].includes(value.phoneLookupOutcome) ? value.phoneLookupOutcome : '',
      phoneLookupLastSource: /^[a-z0-9_]{1,48}$/.test(String(value.phoneLookupLastSource || '')) ? String(value.phoneLookupLastSource) : '',
      phoneVerifiedAt: Number.isFinite(Number(value.phoneVerifiedAt)) && Number(value.phoneVerifiedAt) > 0 ? Number(value.phoneVerifiedAt) : 0,
      email: normalizedText(value.email, 180),
      lastSentAt: Number.isFinite(Number(value.lastSentAt)) ? Number(value.lastSentAt) : 0,
      lastInteractionAt: Number.isFinite(Number(value.lastInteractionAt)) ? Number(value.lastInteractionAt) : 0,
      firstContactAt: Number.isFinite(Number(value.firstContactAt)) && Number(value.firstContactAt) > 0 ? Number(value.firstContactAt) : 0,
      paidAt: Number.isFinite(Number(value.paidAt)) && Number(value.paidAt) > 0 ? Number(value.paidAt) : 0,
      doNotContact: value.doNotContact === true,
      doNotContactAt: Number.isFinite(Number(value.doNotContactAt)) && Number(value.doNotContactAt) > 0 ? Number(value.doNotContactAt) : 0,
      doNotContactReleasedAt: Number.isFinite(Number(value.doNotContactReleasedAt)) && Number(value.doNotContactReleasedAt) > 0 ? Number(value.doNotContactReleasedAt) : 0,
      doNotContactReason: normalizedText(value.doNotContactReason, 300),
      publishedAt: Number.isFinite(Number(value.publishedAt)) && Number(value.publishedAt) > 0 ? Number(value.publishedAt) : 0,
      publishedUrl: (() => { try { const url = new URL(String(value.publishedUrl || '')); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } })(),
      paymentLinkUrl: CrmPolicy.isPayPalMeLink(value.paymentLinkUrl) ? String(value.paymentLinkUrl) : '',
      paymentLinkAmount: Number.isInteger(Number(value.paymentLinkAmount)) ? Math.min(1000000, Math.max(0, Number(value.paymentLinkAmount))) : 0,
      paymentLinkPurpose: ['deposit', 'installment', 'total'].includes(value.paymentLinkPurpose) ? value.paymentLinkPurpose : '',
      paymentLinkCreatedAt: Number.isFinite(Number(value.paymentLinkCreatedAt)) && Number(value.paymentLinkCreatedAt) > 0 ? Number(value.paymentLinkCreatedAt) : 0,
      paymentEvents: sanitizePaymentEvents(value.paymentEvents),
      ...sanitizePaymentState(value),
      publishApproved: value.publishApproved === true
    };
  }
  return result;
}

function saveProspects(prospects = DATA) {
  writeAtomic(DATA_FILE, 'window.PROSPECTS_DATA = ' + JSON.stringify(prospects) + ';');
}

function saveCrmState(state) {
  const nextState = Object.assign(Object.create(null), CRM_STATE, sanitizeCrmState(state));
  snapshotCrmState(nextState, BACKUPS_DIR);
  writeAtomic(STATE_FILE, JSON.stringify(nextState, null, 2));
  CRM_STATE = nextState;
}

function createImportedSlug(name, siren, usedSlugs) {
  const base = String(name || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'entreprise';
  const suffix = String(siren).slice(-6);
  let slug = (base + '-' + suffix).slice(0, 120);
  let sequence = 2;
  while (usedSlugs.has(slug)) {
    const tail = '-' + suffix + '-' + sequence++;
    slug = base.slice(0, 120 - tail.length) + tail;
  }
  usedSlugs.add(slug);
  return slug;
}

function saveClientFiles(prospect, state) {
  const safe = normalizeProspect(prospect);
  const sitePath = path.resolve(SITES_DIR, safe.slug + '.html');
  if (!sitePath.startsWith(SITES_DIR + path.sep)) throw new Error('Chemin de page invalide');

  const index = DATA.findIndex(item => item && String(item.siren) === safe.siren);
  if (index === -1) DATA.unshift(safe);
  else DATA[index] = Object.assign({}, DATA[index], safe);
  saveProspects();
  saveCrmState(state);

  const crm = CRM_STATE[safe.siren] || {};
  const fiche = {
    siren: safe.siren, entreprise: safe.nom, dirigeant: safe.dirigeant, metier: safe.metier,
    ville: safe.ville, departement: safe.dept, telephone: safe.tel,
    telephone_verifie: safe.telVerified, source_telephone: safe.telSource,
    email: crm.email || safe.email, statut: crm.status || 'todo',
    notes: crm.notes || '', maquette_url: safe.urlPublique, derniere_maj: new Date().toISOString()
  };
  writeAtomic(path.join(CLIENTS_DIR, safe.siren + '_' + safe.slug + '.json'), JSON.stringify(fiche, null, 2));
  writeAtomic(sitePath, buildLuxurySite(safe));
  return safe;
}

let DATA = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8').replace(/^window\.PROSPECTS_DATA\s*=\s*/, '').replace(/;\s*$/, '');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('le contenu doit être une liste de fiches');
    DATA = parsed;
  } catch (e) {
    console.error('data.js invalide; le serveur démarre sans importer de fiches:', e.message);
  }
}

fs.mkdirSync(CLIENTS_DIR, { recursive: true });
fs.mkdirSync(SITES_DIR, { recursive: true });
if (fs.existsSync(STATE_FILE)) {
  try {
    CRM_STATE = sanitizeCrmState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (e) {
    const recoveredCopy = path.join(BACKUPS_DIR, 'crm-state-recovery-' + Date.now() + '.json');
    try {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      fs.copyFileSync(STATE_FILE, recoveredCopy);
      console.error('État CRM illisible; copie préservée dans ' + recoveredCopy + '. Le serveur démarre avec un état vide:', e.message);
    } catch (backupError) {
      console.error('État CRM illisible et copie de récupération impossible; le serveur démarre avec un état vide:', backupError.message);
    }
  }
}

// Configuration Design Prestige par métier pour les sites vitrines
const METIERS_LUXE = {
  'Plombier Chauffagiste': {
    accent: '#38bdf8',
    btnGrad: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
    bgHero: 'radial-gradient(circle at 80% 20%, #0c2d48 0%, #071321 55%, #03070e 100%)',
    badge: 'Prestations sur demande',
    heroImg: 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=1000&q=85',
    gal1: 'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=700&q=80',
    gal2: 'https://images.unsplash.com/photo-1620626011761-996317b8d101?auto=format&fit=crop&w=700&q=80',
    gal3: 'https://images.unsplash.com/photo-1504328345606-18bbc8c9d7d1?auto=format&fit=crop&w=700&q=80',
    unit: 'Surface / Logement',
    base: 120,
    s1: 'Dépannage plomberie et sanitaires',
    d1: 'Recherche de fuite, réparation et remise en service selon disponibilité.',
    s2: 'Installation Pompe à Chaleur & Chauffage',
    d2: 'Étude et installation de systèmes de chauffage selon les besoins du logement.',
    s3: 'Conception de Salle de Bain Clé en Main',
    d3: 'Création complète de salles d\'eau contemporaines : douche à l\'italienne, robinetterie encastrée et carrelage.'
  },
  'Électricien Général': {
    accent: '#fbbf24',
    btnGrad: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    bgHero: 'radial-gradient(circle at 80% 20%, #2e1f08 0%, #120d06 55%, #070503 100%)',
    badge: 'Prestations sur demande',
    heroImg: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?auto=format&fit=crop&w=1000&q=85',
    gal1: 'https://images.unsplash.com/photo-1558402529-d2638a7023e9?auto=format&fit=crop&w=700&q=80',
    gal2: 'https://images.unsplash.com/photo-1544724569-5f546fd6f2b5?auto=format&fit=crop&w=700&q=80',
    gal3: 'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?auto=format&fit=crop&w=700&q=80',
    unit: 'Pièces / Points électriques',
    base: 110,
    s1: 'Tableaux électriques et rénovation',
    d1: 'Diagnostic, rénovation et amélioration des installations électriques.',
    s2: 'Dépannage Électrique & Recherche de Panne',
    d2: 'Recherche de panne sur coupure, court-circuit ou tableau disjoncté.',
    s3: 'Éclairage, domotique et recharge électrique',
    d3: 'Installation de bornes pour véhicules électriques, éclairage architectural et maison connectée.'
  },
  'Peintre & Décorateur': {
    accent: '#34d399',
    btnGrad: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
    bgHero: 'radial-gradient(circle at 80% 20%, #063324 0%, #041710 55%, #020a07 100%)',
    badge: 'Prestations sur demande',
    heroImg: 'https://images.unsplash.com/photo-1562259949-e8e7689d7828?auto=format&fit=crop&w=1000&q=85',
    gal1: 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?auto=format&fit=crop&w=700&q=80',
    gal2: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=700&q=80',
    gal3: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=700&q=80',
    unit: 'Surface en m²',
    base: 35,
    s1: 'Peinture Intérieure, Plafonds & Enduits Lisses',
    d1: 'Préparation minutieuse des murs, ratissage complet et peintures professionnelles velours ou mates.',
    s2: 'Ravalement de Façade & Boiseries Extérieures',
    d2: 'Nettoyage, traitement hydrofuge et protection longue durée de vos façades et volets.',
    s3: 'Pose de Parquet, Revêtements & Décoration',
    d3: 'Habillage de vos sols et murs avec protection intégrale de votre mobilier.'
  },
  'Menuisier Agenceur': {
    accent: '#fb923c',
    btnGrad: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)',
    bgHero: 'radial-gradient(circle at 80% 20%, #381808 0%, #170a04 55%, #080402 100%)',
    badge: 'Prestations sur demande',
    heroImg: 'https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=1000&q=85',
    gal1: 'https://images.unsplash.com/photo-1600585152220-90363fe7e115?auto=format&fit=crop&w=700&q=80',
    gal2: 'https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=700&q=80',
    gal3: 'https://images.unsplash.com/photo-1600566753376-12c8ab7fb75b?auto=format&fit=crop&w=700&q=80',
    unit: 'Ouvrages / Mètres linéaires',
    base: 240,
    s1: 'Fenêtres Alu/PVC, Portes d\'Entrée & Volets',
    d1: 'Menuiseries isolantes haute performance thermique et acoustique posées sur-mesure.',
    s2: 'Agencement Intérieur, Dressing & Escalier Bois',
    d2: 'Création de rangements architecturaux, bibliothèques et cuisines personnalisées au millimètre.',
    s3: 'Terrasse Bois, Pergola & Aménagement Extérieur',
    d3: 'Conception d\'espaces extérieurs chaleureux et durables en bois noble ou composite.'
  },
  default: {
    accent: '#94a3b8',
    btnGrad: 'linear-gradient(135deg, #64748b 0%, #475569 100%)',
    bgHero: 'radial-gradient(circle at 80% 20%, #263241 0%, #111820 55%, #07090d 100%)',
    badge: 'Prestations à confirmer',
    heroImg: 'https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=1000&q=85',
    gal1: '', gal2: '', gal3: '',
    unit: 'Prestations', base: 0,
    s1: 'Prestations à confirmer',
    d1: 'Le détail des prestations est à préciser avec l’entreprise.',
    s2: 'Projet sur mesure',
    d2: 'Le périmètre et les modalités sont à définir selon votre demande.',
    s3: 'Devis personnalisé',
    d3: 'Contactez l’entreprise pour confirmer les services proposés.'
  }
};

function getTradeConfig(metier) {
  const value = String(metier || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/plomb|chauff|clim|therm|pac/.test(value)) return METIERS_LUXE['Plombier Chauffagiste'];
  if (/electric|electr|borne/.test(value)) return METIERS_LUXE['Électricien Général'];
  if (/peint|decor|revet|platr/.test(value)) return METIERS_LUXE['Peintre & Décorateur'];
  if (/menuis|agence|charpent|serrur/.test(value)) return METIERS_LUXE['Menuisier Agenceur'];
  if (/macon|maconner|gros oeuvre/.test(value)) return Object.assign({}, METIERS_LUXE.default, { accent: '#94a3b8' });
  if (/eco|renov|isolation|energie/.test(value)) return Object.assign({}, METIERS_LUXE.default, { accent: '#34d399' });
  return METIERS_LUXE.default;
}

function buildLuxurySite(input) {
  const p = normalizeProspect(input);
  const cfg = getTradeConfig(p.metier);
  const name = escapeHtml(p.nom);
  const job = escapeHtml(p.metier);
  const city = escapeHtml(p.ville);
  const dept = escapeHtml(p.dept);
  const telDisplay = escapeHtml(p.tel);
  const telHref = p.tel.replace(/[^\d+]/g, '');
  const telDigits = p.tel.replace(/\D/g, '');
  const waNumber = telDigits.startsWith('00') ? telDigits.slice(2) : (telDigits.startsWith('33') ? telDigits : '33' + telDigits.replace(/^0/, ''));
  const whatsappHref = /^\d{8,15}$/.test(waNumber) ? 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent('Bonjour, je souhaite obtenir des renseignements.') : '';
  const emailCandidate = String(p.email || '').trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCandidate) ? emailCandidate : '';
  const emailJson = safeScriptJson(email);
  const businessJson = safeScriptJson(p.nom);
  const themeStorageKey = safeScriptJson('kynext-site-theme-' + p.slug);
  const cityQuery = encodeURIComponent(p.ville + ' France');
  const reviewQuery = encodeURIComponent(p.nom + ' ' + p.ville + ' avis');
  const ini = (p.nom || 'AR').split(/[\s-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const logoSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 48 48"><rect x="2" y="2" width="44" height="44" rx="13" fill="' + cfg.accent + '"/><text x="24" y="26" text-anchor="middle" dominant-baseline="central" fill="#111827" font-family="Arial,sans-serif" font-size="17" font-weight="800">' + escapeHtml(ini) + '</text></svg>';
  const faviconHref = 'data:image/svg+xml,' + encodeURIComponent(logoSvg);
  let publicUrl = '';
  try { const parsed = new URL(String(p.urlPublique || '')); if (parsed.protocol === 'https:') publicUrl = parsed.href; } catch {}
  const contactBlock = email
    ? '<p class="text-sm text-slate-300">Le bouton ouvrira votre application de messagerie afin que vous confirmiez l’envoi.</p>'
    : (telHref
      ? '<p class="text-sm text-slate-300">Aucune adresse e-mail publique n’est renseignée. Utilisez le bouton d’appel pour demander un devis.</p>'
      : '<p class="text-sm text-slate-300">Aucune adresse e-mail ou téléphone n’est renseigné pour cette maquette. Les coordonnées doivent être confirmées avec l’entreprise.</p>');
  const calculator = cfg.base
    ? '      <label class="block text-xs font-bold text-slate-500 mb-1.5" for="calcType">Prestation souhaitée</label><select id="calcType" onchange="calc()" class="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs font-bold mb-4"><option value="1">' + escapeHtml(cfg.s1) + '</option><option value="2.4">' + escapeHtml(cfg.s2) + '</option><option value="3.8">' + escapeHtml(cfg.s3) + '</option></select><div class="flex justify-between text-xs font-bold text-slate-500 mb-1.5"><span>Volume (' + escapeHtml(cfg.unit) + ')</span><span id="qtyVal" class="text-slate-950 font-extrabold">1</span></div><input id="calcQty" type="range" min="1" max="10" value="1" oninput="calc()" class="w-full mb-4"><div class="rounded-2xl p-5 text-white bg-slate-950"><div class="text-[11px] text-slate-400">Ordre de grandeur indicatif, à confirmer par devis</div><div id="calcRes" class="text-2xl font-extrabold mt-1" style="color:' + cfg.accent + '">À partir de ' + cfg.base + ' €</div></div>'
    : '<div class="rounded-2xl p-5 text-white bg-slate-950"><div class="text-[11px] text-slate-300">Un tarif fiable ne peut pas être estimé sans connaître le périmètre des travaux.</div><a href="#devis" class="inline-block mt-3 text-sm font-bold" style="color:' + cfg.accent + '">Demander un devis</a></div>';
  const contactForm = email
    ? `<form id="quoteForm" class="space-y-4 mt-6">
      <p id="quoteProgress" class="text-xs text-slate-400" aria-live="polite">Étape 1 sur 3</p>
      <fieldset data-quote-step="0" class="space-y-4">
        <label class="block text-xs font-bold" for="clientProject">Quel est votre projet ?</label>
        <select id="clientProject" required class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-sm"><option value="">Choisir une prestation</option><option>Dépannage</option><option>Installation</option><option>Rénovation</option><option>Autre demande</option></select>
        <button type="button" onclick="setQuoteStep(1)" class="w-full text-slate-950 font-extrabold py-3 rounded-xl text-sm" style="background:${cfg.accent}">Continuer</button>
      </fieldset>
      <fieldset data-quote-step="1" class="space-y-4" disabled>
        <label class="block text-xs font-bold" for="clientCity">Dans quelle ville se situe le projet ?</label>
        <input id="clientCity" required maxlength="120" class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-sm" placeholder="Votre ville">
        <div class="grid grid-cols-2 gap-3"><button type="button" onclick="setQuoteStep(0)" class="bg-white/10 text-white font-bold py-3 rounded-xl text-sm">Retour</button><button type="button" onclick="setQuoteStep(2)" class="text-slate-950 font-extrabold py-3 rounded-xl text-sm" style="background:${cfg.accent}">Continuer</button></div>
      </fieldset>
      <fieldset data-quote-step="2" class="space-y-4" disabled>
        <label class="block text-xs font-bold" for="clientName">Votre nom</label><input id="clientName" required maxlength="120" class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-sm" placeholder="Votre nom">
        <label class="block text-xs font-bold" for="clientPhone">Votre téléphone</label><input id="clientPhone" required maxlength="40" type="tel" class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-sm" placeholder="Votre téléphone">
        <label class="block text-xs font-bold" for="clientMessage">Votre demande</label><textarea id="clientMessage" required maxlength="3000" rows="3" class="w-full bg-white/10 border border-white/15 rounded-xl px-4 py-3 text-sm" placeholder="Décrivez votre projet"></textarea>
        <div class="grid grid-cols-2 gap-3"><button type="button" onclick="setQuoteStep(1)" class="bg-white/10 text-white font-bold py-3 rounded-xl text-sm">Retour</button><button type="submit" class="text-slate-950 font-extrabold py-3 rounded-xl text-sm" style="background:${cfg.accent}">Préparer ma demande</button></div>
      </fieldset>
      <p id="formNotice" class="text-xs text-emerald-200" role="status"></p>
    </form>`
    : '';

  return [
    '<!DOCTYPE html>',
    '<html lang="fr" class="scroll-smooth">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width,initial-scale=1">',
    '  <meta name="description" content="' + name + ' — ' + job + ' à ' + city + '. Informations à confirmer auprès de l’entreprise.">',
    '  <meta property="og:type" content="website">',
    '  <meta property="og:title" content="' + name + ' — ' + job + ' à ' + city + '">',
    '  <meta property="og:description" content="Découvrez les prestations proposées par ' + name + ' à ' + city + '. Contactez l’entreprise pour confirmer les informations.">',
    '  <meta property="og:image" content="' + cfg.heroImg + '">',
    (publicUrl ? '  <meta property="og:url" content="' + escapeHtml(publicUrl) + '">' : ''),
    '  <title>' + name + ' — ' + job + ' à ' + city + '</title>',
    '  <link rel="icon" type="image/svg+xml" href="' + faviconHref + '">',
    '  <link href="/argent_ui.css" rel="stylesheet">',
    '  <style>body{font-family:Inter,"Segoe UI",Arial,sans-serif}.hero-bg{background:' + cfg.bgHero + '}.btn-lux{background:' + cfg.btnGrad + ';box-shadow:0 10px 25px -5px rgba(0,0,0,.35)}.site-card{position:relative;overflow:hidden;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease;background-image:radial-gradient(240px circle at var(--spot-x,50%) var(--spot-y,50%),rgba(255,255,255,.16),transparent 72%)}.site-card:hover{transform:translateY(-3px);box-shadow:0 18px 36px rgba(15,23,42,.12)}html.reveal-ready .reveal{opacity:0;transform:translateY(12px);transition:opacity .45s ease,transform .45s ease}html.reveal-ready .reveal.is-visible{opacity:1;transform:translateY(0)}.theme-toggle{border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.08);color:#fff}.prototype-banner{position:fixed;top:76px;left:50%;z-index:60;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);padding:8px 12px;border:1px solid rgba(255,255,255,.18);border-radius:12px;background:rgba(15,23,42,.94);color:#fff;font-size:11px;box-shadow:0 8px 24px rgba(0,0,0,.22)}.site-contact-float{position:fixed;right:18px;bottom:18px;z-index:40;animation:contact-pulse 2.6s ease-out infinite}@keyframes contact-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,255,255,.16)}50%{box-shadow:0 0 0 8px rgba(255,255,255,0)}}.faq-item{border-bottom:1px solid rgba(148,163,184,.22)}body[data-theme="dark"]{background:#09090b!important;color:#f4f4f5!important;color-scheme:dark}body[data-theme="dark"] .bg-white{background-color:#18181b!important;color:#f4f4f5!important}body[data-theme="dark"] .bg-slate-50{background-color:#27272a!important}body[data-theme="dark"] .text-slate-900{color:#f4f4f5!important}body[data-theme="dark"] .text-slate-600,body[data-theme="dark"] .text-slate-500{color:#d4d4d8!important}body[data-theme="dark"] .border-slate-200,body[data-theme="dark"] .border-slate-100{border-color:#3f3f46!important}body[data-theme="dark"] input,body[data-theme="dark"] select,body[data-theme="dark"] textarea{background:#27272a;color:#f4f4f5}.site-contact-float:hover{filter:brightness(1.08)}@media(max-width:640px){.prototype-banner{top:72px;font-size:10px}.site-contact-float{right:12px;bottom:12px}}@media(prefers-reduced-motion:reduce){.site-card,.reveal,.site-contact-float{animation:none!important;transition:none!important}html.reveal-ready .reveal{opacity:1;transform:none}}</style>',
    '  <style>@media(max-width:640px){.prototype-banner{top:128px}}</style>',
    '</head>',
    '<body class="bg-[#fafafa] text-slate-900 antialiased" data-theme="light">',
    '  <div id="prototypeBanner" class="prototype-banner">Maquette de présentation — textes, photos et informations à valider <button type="button" onclick="dismissPrototypeBanner()" aria-label="Masquer ce bandeau" style="margin-left:8px;color:#fcd34d">Masquer</button></div>',
    '  <div class="fixed top-4 inset-x-0 z-50 px-4 sm:px-6"><nav class="max-w-6xl mx-auto bg-slate-950/90 border border-white/10 rounded-2xl px-5 py-3.5 flex flex-wrap gap-3 justify-between items-center shadow-2xl">',
    '    <div class="flex items-center gap-3"><div class="h-10 w-10 rounded-xl flex items-center justify-center" aria-hidden="true">' + logoSvg + '</div><div><span class="font-extrabold text-sm text-white block">' + name + '</span><span class="text-[11px] text-slate-400">' + job + ' • ' + city + ' (' + dept + ')</span></div></div>',
    '    <div class="flex flex-wrap items-center justify-end gap-2"><button id="themeToggle" type="button" class="theme-toggle text-xs font-bold px-3 py-2 rounded-xl" aria-label="Activer le thème sombre" aria-pressed="false" onclick="toggleSiteTheme()">☾</button>' + (telHref ? '<a href="tel:' + escapeHtml(telHref) + '" class="text-xs font-bold text-white bg-white/10 px-4 py-2.5 rounded-xl">📞 ' + telDisplay + '</a>' : '') + '<a href="#devis" class="btn-lux text-white font-extrabold px-4 py-2.5 rounded-xl text-xs">Demander un devis</a></div>',
    '  </nav></div>',
    '  <header class="hero-bg text-white pt-48 sm:pt-40 lg:pt-36 pb-20 lg:pb-28 px-6 relative overflow-hidden"><div class="max-w-6xl mx-auto grid lg:grid-cols-12 gap-12 items-center">',
    '    <div class="lg:col-span-7 space-y-6"><div class="inline-flex items-center gap-2 bg-white/[0.07] border border-white/15 px-3.5 py-1.5 rounded-full text-xs font-semibold text-slate-200"><span class="h-2 w-2 rounded-full bg-emerald-400"></span><span>Présentation de l’entreprise</span></div>',
    '      <h1 class="text-3xl sm:text-5xl font-extrabold leading-tight">Votre <span style="color:' + cfg.accent + '">' + job.toLowerCase() + '</span> à ' + city + '.</h1>',
    '      <p class="text-slate-300 text-base sm:text-lg leading-relaxed max-w-xl">Découvrez les prestations proposées par <strong class="text-white">' + name + '</strong>. Les informations et disponibilités sont à confirmer directement auprès de l’entreprise.</p>',
    '      <div class="flex flex-wrap gap-3.5 pt-2">' + (telHref ? '<a href="tel:' + escapeHtml(telHref) + '" class="px-6 py-4 rounded-2xl font-bold bg-white/[0.08] border border-white/15 text-white text-sm">📞 Appeler l’entreprise</a>' : '') + '<a href="#services" class="px-6 py-4 rounded-2xl font-bold bg-white text-slate-950 text-sm">Voir les prestations</a></div>',
    '      <div class="grid grid-cols-3 gap-6 pt-6 border-t border-white/10"><div><div class="text-lg font-extrabold text-white">Contact</div><div class="text-xs text-slate-400">direct</div></div><div><div class="text-lg font-extrabold text-white">Secteur</div><div class="text-xs text-slate-400">' + city + '</div></div><div><div class="text-lg font-extrabold text-white">Devis</div><div class="text-xs text-slate-400">sur demande</div></div></div>',
    '    </div>',
    '    <div class="lg:col-span-5 bg-white text-slate-900 rounded-[28px] p-6 sm:p-8 shadow-2xl border border-slate-100"><div class="relative h-40 rounded-2xl overflow-hidden mb-6"><img src="' + cfg.heroImg + '" alt="Photo d’illustration d’une prestation de ' + job + ', non représentative des réalisations de l’entreprise" loading="lazy" decoding="async" class="w-full h-full object-cover"><div class="absolute inset-0 bg-gradient-to-t from-slate-950/85 to-transparent flex items-end p-4"><span class="text-white text-xs font-extrabold uppercase">Illustration · estimation indicative</span></div></div>',
    calculator,
    '    </div>',
    '  </div></header>',
    '  <main>',
    '  <section id="services" class="max-w-6xl mx-auto px-6 py-20"><div class="max-w-2xl mb-10"><span class="text-xs font-extrabold uppercase tracking-widest text-slate-400">Prestations</span><h2 class="text-3xl sm:text-4xl font-extrabold mt-2">Services à ' + city + '</h2></div><div class="grid md:grid-cols-3 gap-7">',
    '    <article class="site-card reveal bg-white p-7 rounded-3xl border border-slate-200 shadow-sm"><h3 class="font-extrabold text-lg mb-3">' + escapeHtml(cfg.s1) + '</h3><p class="text-sm text-slate-600 leading-relaxed">' + escapeHtml(cfg.d1) + '</p></article>',
    '    <article class="site-card reveal bg-white p-7 rounded-3xl border border-slate-200 shadow-sm"><h3 class="font-extrabold text-lg mb-3">' + escapeHtml(cfg.s2) + '</h3><p class="text-sm text-slate-600 leading-relaxed">' + escapeHtml(cfg.d2) + '</p></article>',
    '    <article class="site-card reveal bg-white p-7 rounded-3xl border border-slate-200 shadow-sm"><h3 class="font-extrabold text-lg mb-3">' + escapeHtml(cfg.s3) + '</h3><p class="text-sm text-slate-600 leading-relaxed">' + escapeHtml(cfg.d3) + '</p></article>',
    '  </div></section>',
    '  <section id="faq" class="max-w-4xl mx-auto px-6 pb-16"><div class="mb-6"><span class="text-xs font-extrabold uppercase tracking-widest text-slate-400">Questions fréquentes</span><h2 class="text-2xl sm:text-3xl font-extrabold mt-2">À savoir avant votre demande</h2></div><div class="bg-white border border-slate-200 rounded-3xl px-6">',
    '    <details class="faq-item py-4"><summary class="font-bold text-sm cursor-pointer">Comment obtenir un devis ?</summary><p class="text-sm text-slate-600 mt-3">Décrivez votre besoin via le formulaire ou contactez directement l’entreprise. Toute estimation affichée ici est indicative et doit être confirmée par un devis.</p></details>',
    '    <details class="faq-item py-4"><summary class="font-bold text-sm cursor-pointer">Quels sont les délais d’intervention ?</summary><p class="text-sm text-slate-600 mt-3">Les délais et disponibilités dépendent de la demande et sont à confirmer directement auprès de l’entreprise.</p></details>',
    '    <details class="faq-item py-4"><summary class="font-bold text-sm cursor-pointer">Dans quelles communes intervenez-vous ?</summary><p class="text-sm text-slate-600 mt-3">La ville indiquée présente l’entreprise; son secteur exact d’intervention est à confirmer avec elle.</p></details>',
    '    <details class="faq-item py-4"><summary class="font-bold text-sm cursor-pointer">Les photos montrent-elles ses chantiers ?</summary><p class="text-sm text-slate-600 mt-3">Non. Les photos de cette maquette sont des illustrations génériques et doivent être remplacées par des visuels autorisés de l’entreprise avant publication.</p></details>',
    '    <details class="faq-item py-4"><summary class="font-bold text-sm cursor-pointer">Quelles garanties et certifications s’appliquent ?</summary><p class="text-sm text-slate-600 mt-3">Les garanties, assurances et certifications applicables doivent être vérifiées et communiquées par l’entreprise avant toute publication.</p></details>',
    '  </div></section>',
    '  <section id="avis" class="bg-slate-950 text-white py-20 px-6"><div class="max-w-6xl mx-auto grid lg:grid-cols-2 gap-10 items-center"><div><span class="text-xs font-extrabold uppercase tracking-widest text-slate-400">Avis</span><h2 class="text-3xl font-extrabold mt-2">Consultez les avis publics</h2><p class="text-sm text-slate-300 mt-3">Aucun témoignage n’est publié ici sans validation de l’entreprise.</p><a class="inline-block mt-5 px-5 py-3 rounded-xl bg-white text-slate-950 text-xs font-bold" target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?q=' + reviewQuery + '">Rechercher les avis</a></div><iframe title="Carte de ' + city + '" loading="lazy" width="100%" height="300" style="border:0" src="https://maps.google.com/maps?q=' + cityQuery + '&t=&z=12&ie=UTF8&iwloc=&output=embed"></iframe></div></section>',
    '  <section id="devis" class="max-w-4xl mx-auto px-6 py-20"><div class="hero-bg rounded-[32px] p-8 sm:p-12 text-white shadow-2xl"><h2 class="text-2xl sm:text-3xl font-extrabold">Contacter ' + name + '</h2><p class="text-sm text-slate-300 mt-2 mb-6">Les informations envoyées par e-mail restent sous votre contrôle : votre messagerie demandera confirmation.</p>' + contactBlock,
    contactForm,
    '  </div></section>',
    '  </main>',
    '  <footer class="bg-slate-950 text-slate-400 text-xs py-10 px-6 text-center border-t border-white/10"><p class="font-bold text-white mb-1">' + name + ' — ' + job + '</p><p>' + city + ' (' + dept + ')</p><p>Référence dossier : ' + escapeHtml(p.siren) + '</p><p class="mt-3">Maquette de présentation. Tarifs, prestations, mentions légales, assurances et certifications sont à confirmer par l’entreprise avant publication.</p><p class="mt-2 text-slate-500">Conçu par Kynext · visuels d’illustration non contractuels</p></footer>',
    (whatsappHref ? '  <a class="site-contact-float btn-lux inline-flex items-center gap-2 text-white font-extrabold px-5 py-4 rounded-full text-sm" href="' + escapeHtml(whatsappHref) + '" target="_blank" rel="noopener noreferrer" aria-label="Ouvrir WhatsApp pour contacter ' + name + '">💬 Contacter</a>' : ''),
    '  <script>',
    '    var BASE = ' + Number(cfg.base) + ';',
    '    var CONTACT_EMAIL = ' + emailJson + ';',
    '    var BUSINESS_NAME = ' + businessJson + ';',
    '    var THEME_KEY = ' + themeStorageKey + ';',
    '    function calc(){var type=document.getElementById("calcType"),quantity=document.getElementById("calcQty");if(!type||!quantity)return;var m=parseFloat(type.value),q=parseInt(quantity.value,10);document.getElementById("qtyVal").innerText=q;document.getElementById("calcRes").innerText="À partir de "+new Intl.NumberFormat("fr-FR").format(Math.round(BASE*m*(1+(q-1)*.35)))+" €";}',
    '    function toggleSiteTheme(){var dark=document.body.dataset.theme!=="dark";document.body.dataset.theme=dark?"dark":"light";document.getElementById("themeToggle").textContent=dark?"☀":"☾";document.getElementById("themeToggle").setAttribute("aria-label",dark?"Activer le thème clair":"Activer le thème sombre");document.getElementById("themeToggle").setAttribute("aria-pressed",String(dark));try{localStorage.setItem(THEME_KEY,dark?"dark":"light");}catch(e){}}',
    '    function dismissPrototypeBanner(){var banner=document.getElementById("prototypeBanner");banner.hidden=true;try{sessionStorage.setItem(THEME_KEY+"-banner","hidden");}catch(e){}}',
    '    function setQuoteStep(step){var form=document.getElementById("quoteForm");if(!form)return;var current=Number(form.dataset.step||0);if(step>current){var active=form.querySelector("[data-quote-step=\\""+current+"\\"]");var fields=active.querySelectorAll("input,select,textarea");for(var i=0;i<fields.length;i++){if(!fields[i].checkValidity()){fields[i].reportValidity();return;}}}Array.prototype.forEach.call(form.querySelectorAll("[data-quote-step]"),function(fieldset){var activeStep=Number(fieldset.dataset.quoteStep)===step;fieldset.disabled=!activeStep;fieldset.classList.toggle("hidden",!activeStep);});form.dataset.step=String(step);document.getElementById("quoteProgress").textContent="Étape "+(step+1)+" sur 3";}',
    '    try{if(localStorage.getItem(THEME_KEY)==="dark"){document.body.dataset.theme="dark";document.getElementById("themeToggle").textContent="☀";document.getElementById("themeToggle").setAttribute("aria-label","Activer le thème clair");document.getElementById("themeToggle").setAttribute("aria-pressed","true");}}catch(e){}try{if(sessionStorage.getItem(THEME_KEY+"-banner")==="hidden")document.getElementById("prototypeBanner").hidden=true;}catch(e){}',
    '    var quoteForm=document.getElementById("quoteForm");if(quoteForm)quoteForm.addEventListener("submit",function(event){event.preventDefault();var notice=document.getElementById("formNotice");var subject=encodeURIComponent("Demande de devis — "+BUSINESS_NAME);var body=encodeURIComponent("Projet : "+document.getElementById("clientProject").value+"\\nVille : "+document.getElementById("clientCity").value+"\\nNom : "+document.getElementById("clientName").value+"\\nTéléphone : "+document.getElementById("clientPhone").value+"\\n\\nDemande :\\n"+document.getElementById("clientMessage").value);notice.textContent="Votre messagerie va s’ouvrir. Vérifiez puis confirmez l’envoi.";window.location.href="mailto:"+encodeURIComponent(CONTACT_EMAIL)+"?subject="+subject+"&body="+body;});',
    '    var revealItems=document.querySelectorAll(".reveal");if("IntersectionObserver" in window){document.documentElement.classList.add("reveal-ready");var revealObserver=new IntersectionObserver(function(entries){entries.forEach(function(entry){if(entry.isIntersecting){entry.target.classList.add("is-visible");revealObserver.unobserve(entry.target);}});},{threshold:.12});revealItems.forEach(function(item){revealObserver.observe(item);});}',
    '    document.querySelectorAll(".site-card").forEach(function(card){card.addEventListener("pointermove",function(event){var box=card.getBoundingClientRect();card.style.setProperty("--spot-x",(event.clientX-box.left)+"px");card.style.setProperty("--spot-y",(event.clientY-box.top)+"px");});});',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');
}
for (const rawProspect of DATA) {
  try {
    const p = normalizeProspect(rawProspect);
    writeAtomic(path.join(SITES_DIR, p.slug + '.html'), buildLuxurySite(p));
  } catch (error) {
    console.warn('Fiche ignorée lors de la génération:', error.message);
  }
}

async function enrichirProspect(prospect = {}) {
  return buildDeepEnrichmentPlan(prospect);
}

async function enrichirBatch(limit = 15) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(25, Number(limit))) : 15;
  const records = Array.isArray(DATA) ? DATA.slice(0, safeLimit) : [];
  const report = records.map((prospect) => {
    const plan = buildDeepEnrichmentPlan(prospect);
    return {
      siren: String(prospect && prospect.siren || ''),
      nom: prospect && prospect.nom ? String(prospect.nom) : '',
      requiresManualReview: plan.requiresManualReview,
      topSource: plan.searchPlan[0] ? plan.searchPlan[0].label : 'À déterminer'
    };
  });

  return {
    ok: true,
    dryRun: true,
    enriched: 0,
    queued: report.length,
    summary: 'Le moteur de recherche locale prépare un plan d’enrichissement sans injecter de données non vérifiées.',
    report
  };
}
// INTERFACE "APPLE / LINEAR DARK LUXURY"
const linearHtml = [
'<!DOCTYPE html>',
'<html lang="fr">',
'<head>',
'  <meta charset="UTF-8">',
'  <meta name="viewport" content="width=device-width,initial-scale=1">',
'  <title>Kynext — Studio Executive</title>',
'  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 36 36%27%3E%3Cdefs%3E%3ClinearGradient id=%27g%27 x1=%270%27 y1=%270%27 x2=%2736%27 y2=%2736%27 gradientUnits=%27userSpaceOnUse%27%3E%3Cstop stop-color=%27%23fbbf24%27/%3E%3Cstop offset=%271%27 stop-color=%27%2334d399%27/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=%2736%27 height=%2736%27 rx=%2710%27 fill=%27url(%23g)%27/%3E%3Cpath d=%27M11 10v16m12-16-7 8 7 8m-7-8h9%27 stroke=%27%2309090b%27 stroke-width=%273%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E">',
'  <link href="/argent_ui.css" rel="stylesheet">',
 '  <script src="/qrious.js"></script>',
 '  <script src="/sales_insights.js"></script>',
  '  <script src="/finance_reporting.js"></script>',
 '  <script src="/sales_playbook.js"></script>',
 '  <script src="/crm_policy.js"></script>',
'  <style>',
'    body {',
'      font-family: Inter, "Segoe UI", Arial, sans-serif;',
'      background-color: #050507;',
'      background-image: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(245, 158, 11, 0.10), transparent);',
'    }',
'',
'    ::-webkit-scrollbar { width: 5px; height: 5px; }',
'    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 99px; }',
'    .lux-panel { background: rgba(15, 15, 19, 0.76); backdrop-filter: blur(20px); border: 1px solid rgba(255, 255, 255, 0.075); box-shadow: inset 0 1px rgba(255,255,255,.035); }',
'    .lux-card { background: linear-gradient(180deg, rgba(24, 24, 29, 0.76) 0%, rgba(14, 14, 18, 0.9) 100%) padding-box, linear-gradient(180deg, rgba(255,255,255,.14), rgba(255,255,255,.015)) border-box; border: 1px solid transparent; box-shadow: inset 0 1px rgba(255,255,255,.045), 0 20px 40px -15px rgba(0,0,0,.42); }',
'    .lux-input { background: rgba(7, 7, 10, 0.62); border: 1px solid transparent; transition: border-color 150ms ease, background-color 150ms ease, box-shadow 150ms ease; }',
'    .lux-input:focus { border-color: rgba(251, 191, 36, 0.55); box-shadow: 0 0 0 3px rgba(251, 191, 36, 0.12); outline: none; }',
'    .lux-input:hover { border-color: rgba(255,255,255,.09); background-color: rgba(7,7,10,.82); }',
'    .gold-btn { background: linear-gradient(135deg, #fcd34d 0%, #fbbf24 100%); color: #18130a; box-shadow: 0 8px 25px -8px rgba(245, 158, 11, 0.38); }',
'    .emerald-btn { background: linear-gradient(135deg, #6ee7b7 0%, #34d399 100%); color: #052e16; box-shadow: 0 8px 25px -8px rgba(16, 185, 129, 0.3); }',
'    .reporting-overlay { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 1rem; background: rgba(0,0,0,.78); }',
'    .reporting-overlay.hidden { display: none; }',
'    .reporting-dialog { width: min(100%, 900px); max-height: 90vh; overflow: auto; padding:1.5rem; display:flex; flex-direction:column; gap:1.25rem; }',
'    .reporting-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; }',
'    .reporting-kpi { border: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.025); border-radius: 1rem; padding: .9rem; }',
'    .reporting-kpi span { display:block; color:#a1a1aa; font-size:10px; }',
'    .reporting-kpi strong { display:block; color:#f4f4f5; font-size:16px; margin-top:.3rem; }',
'    .reporting-ledger { max-height: 240px; overflow:auto; border: 1px solid rgba(255,255,255,.08); border-radius: 1rem; }',
'    .reporting-ledger table { width:100%; border-collapse:collapse; font-size:11px; }',
'    .reporting-ledger th,.reporting-ledger td { padding:.65rem .75rem; text-align:left; border-bottom:1px solid rgba(255,255,255,.06); }',
'    .reporting-settings { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.75rem; }',
'    .reporting-controls { display:flex; flex-wrap:wrap; align-items:flex-end; gap:.75rem; }',
'    .payment-movement { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto; gap:.5rem; }',
'    .payment-movement input { min-width:0; }',
'    .payment-balance { opacity:.72; }',
'    @media (max-width: 640px) { .reporting-settings { grid-template-columns:1fr; } }',
'  </style>',
'</head>',
'<body class="app-root text-zinc-100 antialiased h-screen flex flex-col overflow-hidden select-none">',
'',
'  <!-- NOTIFICATION ÉLÉGANTE -->',
'  <div id="toastBox" class="toast-stack fixed bottom-5 right-5 z-50" aria-live="polite" aria-atomic="false">',
'  </div>',
'',
'  <!-- TOPBAR ULTRA-FINE -->',
'  <header class="app-topbar lux-panel border-b border-white/[0.06] px-6 py-3 flex items-center justify-between shrink-0 z-20">',
'    <div class="flex items-center gap-4">',
'      <div class="flex items-center gap-2.5">',
'        <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg" class="shrink-0" aria-hidden="true" focusable="false">',
'          <rect width="36" height="36" rx="10" fill="url(#gradK)" />',
'          <path d="M11 10V26M23 10L16 18L23 26M16 18H25" stroke="#09090b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />',
'          <defs><linearGradient id="gradK" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse"><stop stop-color="#fbbf24" /><stop offset="1" stop-color="#34d399" /></linearGradient></defs>',
'        </svg>',
'        <span id="brandTitle" class="font-extrabold text-sm tracking-tight gradient-text">Kynext</span>',
'        <span class="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md bg-white/[0.06] text-amber-300 border border-white/[0.08]">Studio</span>',
'      </div>',
'      <div class="h-4 w-[1px] bg-white/10"></div>',
'      <div id="kpiSummary" class="text-xs text-zinc-400 flex items-center gap-4"></div>',
'    </div>',
'',
    '    <div class="flex items-center gap-2">',
    '      <button onclick="openPipeline()" class="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 text-xs font-semibold px-3 py-2 rounded-xl transition">▦ Pipeline</button>',
    '      <button onclick="openQuickNotes()" class="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 text-xs font-semibold px-3 py-2 rounded-xl transition">✎ Note rapide</button>',
    '      <button onclick="openReporting()" class="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 text-xs font-semibold px-3 py-2 rounded-xl transition">📊 Pilotage</button>',
    '      <button onclick="toggleIphonePanel()" class="bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-400/20 text-indigo-200 text-xs font-semibold px-3 py-2 rounded-xl transition">📱 iPhone</button>',
    '      <button onclick="lancerRafale()" class="emerald-btn hover:opacity-95 text-xs font-extrabold px-4 py-2 rounded-xl transition">⚡ Séquence WhatsApp</button>',
'      <button onclick="publierSurgeDirect()" id="btnSurge" class="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-200 text-xs font-semibold px-3.5 py-2 rounded-xl transition">☁️ Publier Surge</button>',
'      <button onclick="toggleHelpPanel()" aria-label="Raccourcis clavier" title="Raccourcis clavier (?)" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-zinc-400 text-xs font-semibold w-9 h-9 rounded-xl transition">?</button>',
'      <button onclick="ouvrirDossierWindows()" class="bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] text-zinc-300 text-xs font-semibold px-3 py-2 rounded-xl transition" title="Dossier Kynext">📁</button>',
'    </div>',
    '  </header>',
    '',
    '  <section id="iphonePanel" class="hidden fixed top-16 right-5 z-40 lux-panel rounded-3xl p-5 w-80 shadow-2xl space-y-3">',
    '    <div class="flex justify-between items-center"><strong class="text-sm text-white">Jumeler l’iPhone</strong><button onclick="toggleIphonePanel()" class="text-zinc-400">✕</button></div>',
    '    <p class="text-xs text-zinc-300">Scanne le code ou ouvre l’adresse sur le même Wi-Fi, puis saisis ce code sur l’iPhone.</p>',
    '    <img id="iphoneQr" alt="QR code de connexion au pont iPhone" class="w-40 h-40 mx-auto bg-white rounded-xl p-1">',
    '    <div class="text-center"><div class="text-[10px] uppercase tracking-widest text-zinc-400">Code valable 10 minutes</div><strong id="iphonePairCode" class="text-3xl tracking-[0.25em] text-amber-300">••••••</strong></div>',
    '    <select id="iphoneNetwork" onchange="refreshIphonePair()" class="w-full lux-input rounded-xl px-3 py-2 text-xs text-white"></select>',
    '    <div class="flex gap-2"><button onclick="copyIphoneUrl()" class="flex-1 bg-white/[0.06] border border-white/[0.08] text-xs font-semibold py-2 rounded-xl">Copier le lien</button><button onclick="refreshIphonePair()" class="flex-1 bg-white/[0.06] border border-white/[0.08] text-xs font-semibold py-2 rounded-xl">Actualiser</button></div>',
    '    <div id="iphoneUrlText" class="text-[10px] text-zinc-400 break-all text-center"></div>',
    '    <div id="iphoneStatus" class="text-[10px] text-zinc-500 text-center">Pont prêt • même réseau Wi-Fi requis</div>',
    '  </section>',
    '  <div id="helpPanel" class="reporting-overlay hidden" onclick="if(event.target===this) toggleHelpPanel()">',
    '    <section class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="helpTitle">',
    '      <div class="flex items-center justify-between mb-5"><h2 id="helpTitle" class="text-sm font-extrabold text-white">Raccourcis</h2><button onclick="toggleHelpPanel()" class="text-zinc-400 hover:text-white" aria-label="Fermer">×</button></div>',
    '      <div class="grid grid-cols-[1fr_auto] gap-y-3 items-center text-xs text-zinc-300">',
    '        <span>Rechercher une fiche</span><span class="kbd-badge">/</span>',
    '        <span>Recherche rapide</span><span><span class="kbd-badge">Ctrl</span> + <span class="kbd-badge">K</span></span>',
    '        <span>Naviguer dans la liste</span><span><span class="kbd-badge">↑</span> <span class="kbd-badge">↓</span></span>',
    '        <span>Ouvrir un onglet</span><span><span class="kbd-badge">1</span> <span class="kbd-badge">2</span> <span class="kbd-badge">3</span></span>',
    '        <span>Fermer ce panneau</span><span class="kbd-badge">Échap</span>',
    '      </div>',
    '    </section>',
    '  </div>',
    '  <div id="pipelinePanel" class="reporting-overlay hidden" onclick="if(event.target===this) closePipeline()">',
    '    <section class="pipeline-dialog lux-card" role="dialog" aria-modal="true" aria-labelledby="pipelineTitle">',
    '      <header class="flex items-start justify-between gap-4"><div><h2 id="pipelineTitle" class="text-lg font-extrabold text-white">Pipeline commercial</h2><p class="text-xs text-zinc-400 mt-1">Glissez une fiche vers une colonne pour modifier son statut CRM.</p></div><button onclick="closePipeline()" class="bg-white/[0.06] border border-white/[0.08] rounded-xl px-3 py-2 text-sm" aria-label="Fermer le pipeline">×</button></header>',
    '      <div id="pipelineBoard" class="pipeline-board" aria-live="polite"></div>',
    '    </section>',
    '  </div>',
    '  <aside id="quickNotesPanel" class="quick-notes-panel" aria-label="Note rapide" aria-hidden="true">',
    '    <div class="flex items-center justify-between gap-3"><div><strong class="text-sm text-white">Note rapide</strong><p id="quickNotesCompany" class="text-[10px] text-zinc-400 mt-1">Aucune fiche sélectionnée</p></div><button onclick="closeQuickNotes()" class="text-zinc-400 hover:text-white" aria-label="Fermer les notes">×</button></div>',
    '    <label class="sr-only" for="quickNoteInput">Ajouter une note à la fiche active</label><textarea id="quickNoteInput" rows="7" maxlength="2000" class="w-full lux-input rounded-2xl p-3.5 text-xs text-white leading-relaxed mt-4" placeholder="Une information à retenir…"></textarea>',
    '    <button onclick="saveQuickNote()" class="gold-btn w-full rounded-xl px-4 py-2.5 text-xs font-bold mt-3">Ajouter à la fiche</button>',
    '  </aside>',
    '',
    '  <section class="workflow-guide" aria-label="Guide de démarrage">',
    '    <div class="workflow-guide__intro">Commencer en 3 étapes</div>',
    '    <div class="workflow-guide__step"><span class="workflow-guide__number">1</span><span>Choisissez une fiche et vérifiez ses coordonnées.</span></div>',
    '    <div class="workflow-guide__step"><span class="workflow-guide__number">2</span><span>Préparez un message ou notez le résultat de l’échange.</span></div>',
    '    <div class="workflow-guide__step"><span class="workflow-guide__number">3</span><span>Consultez la maquette, puis préparez une proposition.</span></div>',
    '  </section>',
    '  <div id="reportingPanel" class="reporting-overlay hidden" onclick="if(event.target===this) closeReporting()">',
    '      <section class="reporting-dialog lux-card rounded-3xl space-y-5" role="dialog" aria-modal="true" aria-labelledby="reportingTitle">',
    '      <header class="flex items-start justify-between gap-4">',
    '        <div><h2 id="reportingTitle" class="text-lg font-extrabold text-white">Pilotage financier</h2><p class="text-xs text-zinc-400 mt-1">Journal manuel des mouvements enregistrés dans Kynext.</p></div>',
    '        <button onclick="closeReporting()" class="bg-white/[0.06] border border-white/[0.08] rounded-xl px-3 py-2 text-sm" aria-label="Fermer le rapport">×</button>',
    '      </header>',
    '      <div class="reporting-controls">',
    '        <label class="text-[11px] text-zinc-400">Mois du rapport<input id="reportMonth" type="month" onchange="renderFinanceReport()" class="block lux-input rounded-xl px-3 py-2 text-xs text-white mt-1"></label>',
    '        <button onclick="exportMonthlyAccountingCsv()" class="gold-btn rounded-xl px-4 py-2 text-xs font-bold">Exporter le journal CSV</button>',
    '      </div>',
    '      <div id="reportingKpis" class="reporting-kpis"></div>',
    '      <div class="reporting-settings">',
    '        <label class="text-[11px] text-zinc-400">Réserve fiscale estimée (%)<input id="reportTaxRate" type="number" min="0" max="100" step="0.1" onchange="saveFinanceSettings()" class="block lux-input rounded-xl px-3 py-2 text-xs text-white mt-1 w-full"></label>',
    '        <label class="text-[11px] text-zinc-400">Frais de paiement estimés (%)<input id="reportPaymentFee" type="number" min="0" max="100" step="0.1" onchange="saveFinanceSettings()" class="block lux-input rounded-xl px-3 py-2 text-xs text-white mt-1 w-full"></label>',
    '        <label class="text-[11px] text-zinc-400">Infrastructure mensuelle (€)<input id="reportInfrastructure" type="number" min="0" max="1000000" step="0.01" onchange="saveFinanceSettings()" class="block lux-input rounded-xl px-3 py-2 text-xs text-white mt-1 w-full"></label>',
    '      </div>',
    '      <p class="text-[10px] leading-relaxed text-zinc-500">Estimations uniquement : les taux sont à configurer selon votre situation, ce calcul ne remplace pas un conseil comptable ou fiscal. Les mouvements antérieurs à l’activation du journal ne peuvent pas être reconstitués. Le rapport reste local à ce navigateur.</p>',
    '      <div id="reportingLedger" class="reporting-ledger"></div>',
    '    </section>',
    '  </div>',
    '  <!-- WORKSPACE : SIDEBAR + FICHE CENTRALE -->',
'  <div id="appWorkspace" class="app-workspace flex-1 grid grid-cols-12 overflow-hidden">',
'',
'    <!-- SIDEBAR GAUCHE (3 COL) -->',
'    <aside class="col-span-3 border-r border-white/[0.06] bg-[#07070a]/80 flex flex-col h-full overflow-hidden">',
'      <div class="p-3.5 border-b border-white/[0.06] space-y-2.5">',
'        <!-- Segmented Control Filtres -->',
    '        <div class="grid grid-cols-5 gap-1 bg-white/[0.04] p-1 rounded-xl border border-white/[0.05]">',
'          <button onclick="setFilter(\'prio\')" id="btn-prio" class="filter-btn is-active text-[10px] font-extrabold py-1.5 rounded-lg transition" title="Prospects sans site"><span>Sans site</span><span id="filterCountPrio" class="filter-count">0</span></button>',
    '          <button onclick="setFilter(\'review\')" id="btn-review" class="filter-btn text-zinc-400 hover:text-white text-[9px] font-semibold py-1.5 rounded-lg transition" title="Fiches sans téléphone professionnel vérifié"><span>À vérifier</span><span id="filterCountReview" class="filter-count">0</span></button>',
'          <button onclick="setFilter(\'mobile\')" id="btn-mobile" class="filter-btn text-zinc-400 hover:text-white text-[10px] font-semibold py-1.5 rounded-lg transition" title="Prospects avec mobile"><span>06 / 07</span><span id="filterCountMobile" class="filter-count">0</span></button>',
'          <button onclick="setFilter(\'vues\')" id="btn-vues" class="filter-btn text-zinc-400 hover:text-white text-[10px] font-semibold py-1.5 rounded-lg transition" title="Prospects chauds"><span>Chauds</span><span id="filterCountHot" class="filter-count">0</span></button>',
'          <button onclick="setFilter(\'all\')" id="btn-all" class="filter-btn text-zinc-400 hover:text-white text-[10px] font-semibold py-1.5 rounded-lg transition" title="Toutes les fiches"><span>Tous</span><span id="filterCountAll" class="filter-count">0</span></button>',
'        </div>',
'        <select id="crmSegment" onchange="renderList()" aria-label="Segment CRM" class="w-full lux-input rounded-xl px-3 py-2 text-[11px] text-zinc-200">',
'          <option value="all">Tous les segments</option>',
'          <option value="todo">À contacter</option>',
'          <option value="followup">À relancer (J+3)</option>',
'          <option value="hot">Priorité élevée</option>',
'          <option value="closed">Clôturés</option>',
'        </select>',
'        <p class="text-[10px] leading-relaxed text-zinc-500">Indice CRM indicatif, basé sur le statut et les interactions consignées — ce n’est pas une probabilité de conversion.</p>',
'        <div class="flex gap-1.5">',
'          <input id="search" oninput="renderList()" type="search" aria-label="Rechercher un prospect" placeholder="Nom, ville, métier…  /" title="Rechercher (/ ou Ctrl+K)" class="flex-1 lux-input rounded-xl px-3.5 py-2 text-xs text-white placeholder-zinc-500">',
'          <input id="csvImportFile" type="file" accept=".csv,text/csv" class="hidden">',
'          <button onclick="openCsvImport()" aria-label="Importer des prospects CSV" title="Importer un CSV ou déposer le fichier dans la liste" class="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-zinc-200 text-[10px] font-bold px-2.5 rounded-xl transition">CSV ↓</button>',
'          <button onclick="ajouterProspectRapide()" aria-label="Ajouter une fiche" title="Ajouter une fiche" class="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white text-xs font-bold px-3 rounded-xl transition">＋</button>',
'        </div>',
'      </div>',
'      <div id="prospectList" class="flex-1 overflow-y-auto p-2.5 space-y-1.5" aria-live="polite">',
'        <div class="skeleton-card" aria-hidden="true"><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-line"></span></div>',
'        <div class="skeleton-card" aria-hidden="true"><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-line"></span></div>',
'        <div class="skeleton-card" aria-hidden="true"><span class="skeleton skeleton-title"></span><span class="skeleton skeleton-line"></span></div>',
'      </div>',
'    </aside>',
'',
'    <!-- FICHE UNIQUE ENTREPRISE (9 COL) -->',
'    <main class="col-span-9 flex flex-col h-full overflow-hidden">',
'',
'      <!-- HEADER DE LA FICHE -->',
'      <div class="company-header px-8 py-6 border-b border-white/[0.06] flex flex-wrap justify-between items-center gap-4 shrink-0">',
'        <div class="flex items-center gap-4">',
'          <div id="avatarBox" class="h-14 w-14 rounded-2xl bg-gradient-to-br from-amber-400/20 to-amber-500/5 border border-amber-400/30 flex items-center justify-center text-base font-extrabold text-amber-300 shadow-inner">AR</div>',
'          <div>',
'            <div class="flex items-center gap-2.5">',
'              <h2 id="cpNom" class="text-2xl font-extrabold tracking-tight gradient-text">—</h2>',
'              <span id="cpMetierBadge" class="text-[11px] font-semibold px-3 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-zinc-300">Métier</span>',
'            </div>',
'            <p id="cpSub" class="text-xs text-zinc-400 mt-1">—</p>',
'          </div>',
'        </div>',
'',
'        <div class="flex items-center gap-2.5">',
'          <span id="saveStatus" class="save-status text-[10px] text-zinc-500" aria-live="polite"></span>',
'          <div id="cpQuickLinks" class="flex items-center gap-2"></div>',
'          <select id="cpStatus" onchange="updateStatus()" class="lux-input text-xs font-bold rounded-xl px-3.5 py-2.5 text-white cursor-pointer">',
'            <option value="todo">⚪ À contacter</option>',
'            <option value="sent">🟡 Contacté WA / SMS</option>',
'            <option value="hot">🔵 Prospect Chaud 🔥</option>',
    '            <option value="sold">● Client vendu (790 € indicatifs)</option>',
    '            <option value="refused">● Refus / Archivé</option>',
'          </select>',
'        </div>',
'      </div>',
'',
'      <!-- BARRE DE NAVIGATION SEGMENTÉE (STYLE MACOS) -->',
'      <div class="px-8 py-3 border-b border-white/[0.06] flex items-center justify-between bg-white/[0.01] shrink-0">',
'        <div class="inline-flex bg-white/[0.04] p-1 rounded-xl border border-white/[0.06]">',
'          <button onclick="setTab(\'vente\')" id="tab-vente" class="bg-white/10 text-white text-xs font-bold px-4 py-1.5 rounded-lg shadow transition">1. Contact & WhatsApp</button>',
'          <button onclick="setTab(\'maquette\')" id="tab-maquette" class="text-zinc-400 hover:text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition">2. Studio Maquette Live</button>',
    '          <button onclick="setTab(\'closing\')" id="tab-closing" class="text-zinc-400 hover:text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition">3. Proposition & Paiement</button>',
'        </div>',
'        <div class="flex items-center gap-2">',
'          <button onclick="navProspect(-1)" title="Prospect précédent (↑)" data-hover-label="Précédent · ↑" class="bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-zinc-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition">◀ Précédent</button>',
'          <button onclick="navProspect(1)" title="Prospect suivant (↓)" data-hover-label="Suivant · ↓" class="bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-zinc-300 text-xs font-semibold px-3 py-1.5 rounded-lg transition">Suivant ▶</button>',
'        </div>',
'      </div>',
'',
'      <!-- CORPS DE LA FICHE -->',
'      <div class="record-scroll flex-1 overflow-y-auto p-8">',
'',
'        <!-- ONGLET 1 : CONTACT & WHATSAPP -->',
'        <div id="view-vente" class="prospect-view max-w-5xl mx-auto grid lg:grid-cols-12 gap-7">',
'',
'          <div class="lg:col-span-5 space-y-5">',
'            <div class="lux-card rounded-3xl p-6 space-y-4">',
'              <div class="flex justify-between items-center">',
'                <span class="text-xs font-bold uppercase tracking-wider text-zinc-400">Coordonnées Directes</span>',
'                <button onclick="autoEnrichPhones()" id="btnSinglePhone" class="text-xs font-bold text-amber-400 hover:text-amber-300 transition">🧭 Sources publiques</button>',
'              </div>',
'              <div class="space-y-3.5">',
'                <div>',
'                  <label class="text-[11px] font-medium text-zinc-400">Numéro de téléphone</label>',
'                  <input id="editTel" type="tel" placeholder="Saisir un numéro vérifié" onchange="saveContactInfo()" class="w-full lux-input rounded-2xl px-4 py-3 text-sm font-extrabold text-emerald-400 mt-1">',
'                  <label for="editTelSource" class="block text-[11px] font-medium text-zinc-400 mt-3">Source publique de vérification</label>',
'                  <input id="editTelSource" type="url" placeholder="Lien HTTPS vers la source" onchange="saveContactInfo()" class="w-full lux-input rounded-xl px-3 py-2 text-xs text-white mt-1">',
'                  <label class="flex items-center gap-2 text-[11px] text-zinc-400 mt-2"><input id="editTelVerified" type="checkbox" onchange="saveContactInfo()"> Numéro confirmé sur cette source</label>',
'                  <a id="phoneEvidenceLink" class="hidden text-[10px] text-emerald-300 underline mt-1" target="_blank" rel="noopener noreferrer">Consulter la preuve HTTPS</a>',
'                  <p id="phoneLookupStatus" class="text-[10px] text-zinc-500 mt-2" aria-live="polite">Aucune recherche manuelle</p>',
'                  <button type="button" onclick="markNoPhoneFound()" class="text-[10px] font-semibold text-zinc-400 hover:text-white mt-1">Aucun numéro professionnel public trouvé</button>',
'                  <div id="deepSearchSummary" class="hidden mt-3 p-3 rounded-xl border border-white/[0.08] bg-white/[0.025]">',
'                    <div class="flex justify-between items-center gap-2"><span class="text-[10px] font-bold text-zinc-300">Recherches manuelles par source</span><span id="deepSearchCompleteness" class="text-[9px] text-zinc-500"></span></div>',
'                    <div id="deepSearchSources" class="mt-2 flex flex-wrap gap-1.5"></div>',
'                    <p class="text-[9px] text-zinc-500 mt-2">Les liens ouvrent des recherches publiques. Vérifie l’entreprise et sa source; aucun résultat n’est ajouté automatiquement.</p>',
'                  </div>',
'                </div>',
'                <div>',
'                  <label class="text-[11px] font-medium text-zinc-400">Adresse email</label>',
'                  <input id="editEmail" type="email" placeholder="contact@artisan.fr" onchange="saveContactInfo()" class="w-full lux-input rounded-2xl px-4 py-2.5 text-xs text-white mt-1">',
'                </div>',
'                <div class="rounded-xl border border-rose-400/20 bg-rose-400/[0.04] p-3">',
'                  <label class="flex items-center gap-2 text-xs font-bold text-rose-200"><input id="doNotContact" type="checkbox" onchange="toggleDoNotContact()"> Ne plus contacter — suppression permanente</label>',
'                  <p id="doNotContactStatus" class="text-[10px] text-zinc-500 mt-1" aria-live="polite">Désactivé</p>',
'                </div>',
'              </div>',
'            </div>',
'',
'            <div class="lux-card rounded-3xl p-6 space-y-3.5">',
'              <span class="text-xs font-bold uppercase tracking-wider text-zinc-400">Notes & Qualification</span>',
'              <textarea id="callNotes" rows="4" onkeyup="saveNotes()" placeholder="Notes prises durant l\'appel, besoins du client..." class="w-full lux-input rounded-2xl p-3.5 text-xs text-white leading-relaxed"></textarea>',
'              <div class="grid grid-cols-3 gap-2 pt-1">',
'                <button onclick="qualifierAppel(\'Répondeur\', \'sent\')" class="bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] text-[11px] font-semibold py-2.5 rounded-xl transition">📼 Répondeur</button>',
'                <button onclick="qualifierAppel(\'À rappeler\', \'sent\')" class="bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.07] text-[11px] font-semibold py-2.5 rounded-xl transition">⏰ Rappeler</button>',
'                <button onclick="qualifierAppel(\'Très intéressé\', \'hot\')" class="bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 border border-sky-400/30 text-[11px] font-bold py-2.5 rounded-xl transition">🔥 Chaud</button>',
'              </div>',
'            </div>',
'          </div>',
'',
'          <div class="lg:col-span-7 space-y-5">',
'            <div class="lux-card rounded-3xl p-6 border-l-2 border-l-amber-400 space-y-2">',
'              <div class="flex justify-between items-center">',
'                <span class="text-[11px] font-extrabold uppercase tracking-wider text-amber-400">🎙️ Pitch Téléphone (30s)</span>',
'                <span class="text-[11px] text-emerald-400 font-semibold">790  sans abonnement</span>',
'              </div>',
'              <p id="cpPitch" class="text-sm text-zinc-200 leading-relaxed"></p>',
'            </div>',
'',
'            <div class="lux-card rounded-3xl p-6 space-y-4">',
'              <div class="flex flex-wrap justify-between items-center gap-2">',
'                <span class="text-xs font-bold uppercase tracking-wider text-zinc-400">Message WhatsApp / SMS</span>',
'                <select id="scenarioSelect" onchange="choisirScenario(this.value)" class="lux-input rounded-xl px-3.5 py-2 text-xs text-amber-300 font-semibold cursor-pointer">',
'                  <option value="v1">✨ 1er Contact — Accroche Directe</option>',
'                  <option value="v2">✨ 1er Contact — Visibilité Google</option>',
'                  <option value="v3">✨ 1er Contact — Démo Simulateur</option>',
'                  <option value="j3">🔁 Relance douce (J+3)</option>',
'                  <option value="j7">⏳ Dernière relance (J+7)</option>',
'                  <option value="tarif">💶 Réponse : Tarif 790  clé en main</option>',
'                  <option value="2x">💳 Réponse : Facilité 2 × 395 </option>',
'                  <option value="fb">📱 Réponse : J\'ai déjà Facebook</option>',
'                  <option value="pj">📉 Réponse : Comparaison PagesJaunes</option>',
'                  <option value="obj_prix">💶 Objection : budget</option>',
'                  <option value="obj_temps">⏱️ Objection : manque de temps</option>',
'                  <option value="obj_utilite">🎯 Objection : utilité</option>',
'                  <option value="obj_site">🌐 Objection : site déjà existant</option>',
'                  <option value="stop">⛔ Clôturer les relances</option>',
'                </select>',
'              </div>',
'',
'              <textarea id="cpMessage" rows="5" class="w-full lux-input rounded-2xl p-4 text-xs text-zinc-100 leading-relaxed"></textarea>',
'',
'              <div class="flex gap-3">',
    '                <button onclick="sendCurrentWa()" data-hover-label="Préparer un brouillon" class="quick-action flex-1 emerald-btn hover:opacity-95 text-xs font-extrabold py-4 rounded-2xl transition">💬 Préparer WhatsApp</button>',
'                <button onclick="copyMsg()" class="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white text-xs font-bold px-6 py-4 rounded-2xl transition">📋 Copier</button>',
'              </div>',
'            </div>',
'          </div>',
'        </div>',
'',
'        <!-- ONGLET 2 : APERÇU MAQUETTE PRESTIGE -->',
'        <div id="view-maquette" class="prospect-view hidden h-[72vh] flex flex-col space-y-3.5">',
'          <div class="lux-card rounded-2xl px-5 py-3 flex flex-wrap justify-between items-center gap-2">',
    '            <div class="studio-site-info"><a id="iframeUrlLink" href="#" target="_blank" rel="noopener noreferrer" class="text-xs text-amber-300 hover:underline font-mono truncate"></a><span id="studioPublishStatus" class="studio-status">Maquette locale</span></div>',
'            <div class="flex items-center gap-2">',
'              <button onclick="setPreviewMode(\'desktop\')" id="btnPrevDesk" class="gold-btn text-xs font-extrabold px-3.5 py-1.5 rounded-xl">💻 PC</button>',
'              <button onclick="setPreviewMode(\'mobile\')" id="btnPrevMob" class="bg-white/[0.06] text-zinc-300 text-xs font-semibold px-3.5 py-1.5 rounded-xl">📱 Mobile</button>',
'              <button onclick="validateCurrentSite()" id="btnValidateSite" class="bg-white/[0.06] text-zinc-200 text-xs font-semibold px-3.5 py-1.5 rounded-xl">✓ Valider le site</button>',
    '              <a id="btnOpenExt" href="#" target="_blank" rel="noopener noreferrer" class="bg-white text-zinc-950 text-xs font-extrabold px-3.5 py-1.5 rounded-xl" aria-label="Ouvrir la maquette dans un nouvel onglet">↗ Ouvrir</a>',
'            </div>',
'          </div>',
'          <div id="previewStage" class="preview-stage flex-1 flex justify-center rounded-3xl p-3 border border-white/[0.06] overflow-hidden">',
'            <div id="previewLoading" class="preview-loading" aria-hidden="true"><span class="loading-spinner"></span></div>',
'            <iframe id="maquetteIframe" src="about:blank" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox" title="Aperçu de la maquette de l’entreprise" class="preview-frame h-full"></iframe>',
'          </div>',
'        </div>',
'',
'        <!-- ONGLET 3 : DEVIS PDF & PAIEMENT -->',
'        <div id="view-closing" class="prospect-view hidden max-w-4xl mx-auto grid md:grid-cols-2 gap-7">',
'          <div class="lux-card rounded-3xl p-7 space-y-5">',
'            <h3 class="text-sm font-extrabold uppercase tracking-wider text-amber-400">1. Proposition & Devis PDF</h3>',
'            <div class="space-y-3 bg-black/40 p-4 rounded-2xl border border-white/[0.06]">',
    '              <p class="text-[11px] text-amber-200">Montants indicatifs à confirmer avec le client avant tout accord.</p>',
    '              <label class="flex items-center gap-3 text-xs text-zinc-200 font-semibold cursor-pointer">',
    '                <input id="chkUpsell" type="checkbox" onchange="toggleUpsell()" class="accent-amber-400 h-4 w-4"> Option domaine et présence locale (+190 €)',
'              </label>',
'              <label class="flex items-center gap-3 text-xs text-zinc-400 cursor-pointer">',
    '                <input id="chkMaint" type="checkbox" class="accent-amber-400 h-4 w-4"> Maintenance & hébergement (+29 € / mois)',
'              </label>',
'            </div>',
    '            <button id="btnDevis" onclick="genererDevisPDF()" class="w-full gold-btn hover:opacity-95 text-xs font-extrabold py-4 rounded-2xl transition">📄 Imprimer la proposition indicative (790 €)</button>',
'            <div class="grid grid-cols-3 gap-2.5">',
'              <button id="btnAcompte" onclick="envoyerLienAcompte()" class="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white text-xs font-bold py-3 rounded-xl transition">Acompte 30%</button>',
    '              <button id="btnHalfPayment" onclick="envoyerLien2x()" class="bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-white text-xs font-bold py-3 rounded-xl transition">2 × 395 €</button>',
    '              <button id="btnTotal" onclick="envoyerLienTotal()" class="emerald-btn text-xs font-extrabold py-3 rounded-xl transition">Total indicatif 790 €</button>',
'            </div>',
    '            <div class="rounded-2xl bg-black/30 border border-white/[0.06] p-4 space-y-3">',
    '              <div class="flex justify-between items-center gap-3"><strong class="text-xs text-zinc-200">Suivi manuel du règlement</strong><span class="text-[10px] text-zinc-500">EUR</span></div>',
    '              <select id="paymentStatus" onchange="savePaymentInfo()" aria-label="Statut du paiement" class="w-full lux-input rounded-xl px-3 py-2 text-xs text-white">',
    '                <option value="not_invoiced">Non facturé</option>',
    '                <option value="deposit_requested">Acompte demandé</option>',
    '                <option value="deposit_received">Acompte reçu</option>',
    '                <option value="balance_requested">Solde demandé</option>',
    '                <option value="paid">Réglé</option>',
    '                <option value="refunded">Remboursé</option>',
    '              </select>',
    '              <label class="block text-[11px] text-zinc-400">Solde net encaissé (€)<input id="paidAmount" type="number" readonly class="payment-balance w-full lux-input rounded-xl px-3 py-2 text-xs text-white mt-1"></label>',
    '              <div class="payment-movement">',
    '                <select id="paymentMovementType" aria-label="Type de mouvement" class="lux-input rounded-xl px-2 py-2 text-xs text-white"><option value="receipt">Encaissement</option><option value="refund">Remboursement</option></select>',
    '                <input id="paymentMovementAmount" type="number" min="0.01" max="1000000" step="0.01" aria-label="Montant du mouvement" placeholder="Montant €" class="lux-input rounded-xl px-2 py-2 text-xs text-white">',
    '                <button onclick="recordPaymentMovement()" class="gold-btn rounded-xl px-3 py-2 text-xs font-bold" aria-label="Journaliser le mouvement">+</button>',
    '              </div>',
    '              <p class="text-[10px] leading-relaxed text-zinc-500">Journalise uniquement les mouvements confirmés auprès du prestataire. Le statut reste manuel ; aucun paiement n’est vérifié automatiquement.</p>',
    '              <a id="paymentLinkDraftLink" class="hidden text-[10px] text-emerald-300 underline break-all" target="_blank" rel="noopener noreferrer"></a>',
    '            </div>',
'          </div>',
'',
'          <div class="lux-card rounded-3xl p-7 space-y-5">',
'            <h3 class="text-sm font-extrabold uppercase tracking-wider text-zinc-400">2. Livrables & Paramètres</h3>',
'            <label class="publish-approval">',
'              <input id="publishApproval" type="checkbox" onchange="togglePublishApproval()">',
'              <span class="publish-approval__copy"><strong>Autoriser la publication de cette fiche</strong><span>À cocher uniquement après validation de l’entreprise. Sans accord, sa maquette reste locale et ne sera pas incluse dans une publication.</span></span>',
'            </label>',
'            <div class="grid grid-cols-2 gap-3">',
'              <button onclick="envoyerBienvenue()" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-semibold py-3.5 rounded-2xl transition">📦 Checklist Client</button>',
'              <button onclick="genererCarteVisitePDF()" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-semibold py-3.5 rounded-2xl transition">🪪 Carte Visite PDF</button>',
'              <button onclick="genererAfficheAvisPDF()" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-semibold py-3.5 rounded-2xl transition">⭐ Affiche Avis QR</button>',
'              <button onclick="exporterCSV()" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-semibold py-3.5 rounded-2xl transition">📥 Export CSV</button>',
'              <button onclick="exporterMobilesVerifies()" class="bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.07] text-xs font-semibold py-3.5 rounded-2xl transition">📱 Exporter mobiles vérifiés</button>',
'            </div>',
'            <div class="space-y-2.5 pt-2">',
    '              <input id="payLinkBase" type="url" placeholder="Compte PayPal.me, ex. https://paypal.me/votrecompte" onchange="saveConfig()" class="w-full lux-input rounded-xl px-3.5 py-2.5 text-xs text-white">',
'            </div>',
'          </div>',
'        </div>',
'',
'      </div>',
'    </main>',
'  </div>',
'',
'  <script>',
    '    var API_TOKEN = "__ARGENT_API_TOKEN__";',
    '    async function apiFetch(url, options) { options = options || {}; options.headers = Object.assign({}, options.headers || {}, { "X-Argent-Token": API_TOKEN }); return fetch(url, options); }',
    '    function readStoredJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch (e) { return fallback; } }',
    '    function escapeHTML(value) { return String(value == null ? "" : value).replace(/[&<>"\\x27]/g, function(ch) { if(ch==="&")return "&amp;";if(ch==="<")return "&lt;";if(ch===">")return "&gt;";if(ch==="\\x22")return "&quot;";return "&#39;"; }); }',
    '    function safePublicUrl(value) { try { var u = new URL(String(value || "")); return u.protocol === "https:" ? u.href : ""; } catch (e) { return ""; } }',
    '    function qrDataUrl(value, size) { if (typeof QRious !== "function") throw new Error("Générateur QR local indisponible"); return new QRious({ value: String(value || ""), size: size, level: "H", background: "#ffffff", foreground: "#111827" }).toDataURL(); }',
    '    var DATA = [];',
    '    var state = readStoredJson("crm_luxury_v3", {});',
    '    var stateReady = false;',
    '    var cfg = readStoredJson("cockpit_cfg_456", { "pay": "" });',
'    var currentFilter = "prio";',
'    var filteredList = [];',
'    var selected = DATA[0] || {};',
'',
'    var STATUS_LABELS = { todo: "À contacter", sent: "Contacté", hot: "Chaud 🔥", sold: "Vendu ✅", refused: "Refus" };',
'',
'    document.getElementById("payLinkBase").value = cfg.pay || "";',
'',
'    function notify(msg) {',
'      var box = document.getElementById("toastBox");',
'      var text = String(msg || "Mise à jour");',
'      var kind = /gemini|\\bia\\b/i.test(text) ? "ai" : (/échec|impossible|invalide|refus|bloquée|indisponible/i.test(text) ? "error" : (/enregistr|copié|mis à jour|terminée|réussi|journalisé/i.test(text) ? "success" : "info"));',
'      var toast = document.createElement("div"); toast.className = "toast-item"; toast.dataset.kind = kind; toast.setAttribute("role", "status");',
'      var icon = document.createElement("span"); icon.className = "toast-icon"; icon.textContent = kind === "success" ? "✓" : (kind === "error" ? "!" : "•");',
'      var label = document.createElement("span"); label.className = "text-xs font-semibold text-zinc-100"; label.textContent = text;',
'      var close = document.createElement("button"); close.className = "toast-close"; close.type = "button"; close.setAttribute("aria-label", "Fermer la notification"); close.textContent = "×"; close.onclick = function(){ dismissToast(toast); };',
'      toast.appendChild(icon); toast.appendChild(label); toast.appendChild(close); box.appendChild(toast);',
'      while (box.children.length > 4) dismissToast(box.firstElementChild, true);',
'      var duration = Math.min(7000, Math.max(2600, 1800 + text.length * 38));',
'      toast._dismissTimer = setTimeout(function(){ dismissToast(toast); }, duration);',
'    }',
'',
'    function dismissToast(toast, immediate) {',
'      if (!toast || !toast.parentNode) return;',
'      clearTimeout(toast._dismissTimer);',
'      if (immediate) { toast.parentNode.removeChild(toast); return; }',
'      toast.classList.add("is-leaving"); setTimeout(function(){ if(toast.parentNode) toast.parentNode.removeChild(toast); }, 180);',
'    }',
'',
'    function toggleHelpPanel() { document.getElementById("helpPanel").classList.toggle("hidden"); }',
'    function animatePanel(panel) { panel.classList.remove("view-enter"); void panel.offsetWidth; panel.classList.add("view-enter"); }',
'    function openPipeline() { if (!stateReady) return notify("Chargement des données en cours."); renderList(); renderPipeline(); document.getElementById("pipelinePanel").classList.remove("hidden"); }',
'    function closePipeline() { document.getElementById("pipelinePanel").classList.add("hidden"); }',
'    function renderPipeline() {',
'      var statuses = ["todo", "sent", "hot", "sold", "refused"];',
'      var labels = { todo: "À contacter", sent: "Contacté", hot: "Chaud", sold: "Vendu", refused: "Refus" };',
'      var columns = statuses.map(function(status) {',
'        var cards = filteredList.filter(function(p) { return getStatus(p.siren) === status; });',
'        var content = cards.map(function(p) { return "<button type=\\"button\\" draggable=\\"true\\" data-prospect-id=\\"" + escapeHTML(p.siren) + "\\" class=\\"pipeline-card\\" onclick=\\"selectProspect(" + escapeHTML(JSON.stringify(String(p.siren))) + ");closePipeline()\\"><strong>" + escapeHTML(p.nom) + "</strong><span>" + escapeHTML(p.ville || "") + " · " + escapeHTML((p.metier || "").split(" ")[0]) + "</span><small>" + (p.tel ? "Téléphone disponible" : "Sans téléphone") + "</small></button>"; }).join("");',
'        return "<section class=\\"pipeline-column\\" data-drop-status=\\"" + status + "\\"><header><strong>" + labels[status] + "</strong><span>" + cards.length + "</span></header><div class=\\"pipeline-cards\\">" + (content || "<p class=\\"pipeline-empty\\">Déposez une fiche ici</p>") + "</div></section>";',
'      });',
'      document.getElementById("pipelineBoard").innerHTML = columns.join("");',
'    }',
'    function openQuickNotes() {',
'      if (!selected || !selected.siren) return notify("Sélectionne d’abord une fiche.");',
'      document.getElementById("quickNotesCompany").textContent = selected.nom + " · " + selected.ville;',
'      document.getElementById("quickNotesPanel").dataset.prospectId = String(selected.siren);',
'      document.getElementById("quickNotesPanel").classList.add("is-open"); document.getElementById("quickNotesPanel").setAttribute("aria-hidden", "false");',
'      document.getElementById("quickNoteInput").focus();',
'    }',
'    function closeQuickNotes() { document.getElementById("quickNotesPanel").classList.remove("is-open"); document.getElementById("quickNotesPanel").setAttribute("aria-hidden", "true"); }',
'    function saveQuickNote() {',
'      var note = document.getElementById("quickNoteInput").value.trim();',
'      var siren = document.getElementById("quickNotesPanel").dataset.prospectId;',
'      var prospect = DATA.find(function(p) { return String(p.siren) === String(siren); });',
'      if (!prospect) return notify("La fiche associée à cette note n’existe plus.");',
'      if (!note) return notify("Écris une note avant de l’ajouter.");',
'      var current = state[siren] || {}; var stamp = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });',
'      state[siren] = Object.assign({}, current, { notes: (current.notes ? current.notes + " | " : "") + "[" + stamp + "] " + note });',
'      if (selected && String(selected.siren) === String(siren)) document.getElementById("callNotes").value = state[siren].notes;',
'      document.getElementById("quickNoteInput").value = "";',
'      saveState(); closeQuickNotes(); notify("Note ajoutée à " + prospect.nom + " ✓");',
'    }',
'',
'    function getStatus(siren) {',
'      var st = (state[siren] && state[siren].status) ? state[siren].status : "todo";',
'      return STATUS_LABELS[st] ? st : "todo";',
'    }',
'',
'    function setPreviewMode(mode) {',
'      var ifr = document.getElementById("maquetteIframe");',
'      if (mode === "mobile") {',
'        ifr.style.width = "390px"; ifr.style.maxWidth = "100%";',
'        document.getElementById("btnPrevMob").className = "gold-btn text-xs font-extrabold px-3.5 py-1.5 rounded-xl";',
'        document.getElementById("btnPrevDesk").className = "bg-white/[0.06] text-zinc-300 text-xs font-semibold px-3.5 py-1.5 rounded-xl";',
'      } else {',
'        ifr.style.width = "100%"; ifr.style.maxWidth = "100%";',
'        document.getElementById("btnPrevDesk").className = "gold-btn text-xs font-extrabold px-3.5 py-1.5 rounded-xl";',
'        document.getElementById("btnPrevMob").className = "bg-white/[0.06] text-zinc-300 text-xs font-semibold px-3.5 py-1.5 rounded-xl";',
'      }',
'      document.getElementById("btnPrevDesk").setAttribute("aria-pressed", mode !== "mobile");',
'      document.getElementById("btnPrevMob").setAttribute("aria-pressed", mode === "mobile");',
'    }',
'',
'    function setTab(tabName) {',
'      var tabs = ["vente", "maquette", "closing"];',
'      for (var i = 0; i < tabs.length; i++) {',
'        var t = tabs[i];',
'        document.getElementById("view-" + t).classList.toggle("hidden", t !== tabName);',
'        document.getElementById("tab-" + t).className = (t === tabName)',
'          ? "bg-white/10 text-white text-xs font-bold px-4 py-1.5 rounded-lg shadow transition"',
'          : "text-zinc-400 hover:text-white text-xs font-semibold px-4 py-1.5 rounded-lg transition";',
'      }',
'      animatePanel(document.getElementById("view-" + tabName));',
    '      if (tabName === "maquette" && selected) {',
    '        loadSelectedPreview();',
    '        var publicUrl = safePublicUrl((state[selected.siren] || {}).publishedUrl);',
    '        var previewUrl = "/sites/" + selected.slug + ".html";',
    '        document.getElementById("iframeUrlLink").innerText = publicUrl || ("Aperçu local · " + previewUrl);',
    '        document.getElementById("iframeUrlLink").href = publicUrl || previewUrl;',
    '        document.getElementById("btnOpenExt").href = publicUrl || previewUrl;',
'      }',
'    }',
'',
'    function loadSelectedPreview() {',
'      if (!selected || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(selected.slug || "")) return;',
'      var frame = document.getElementById("maquetteIframe");',
'      var source = "/sites/" + selected.slug + ".html";',
'      if (frame.getAttribute("src") === source) { document.getElementById("previewStage").classList.remove("is-loading"); return; }',
'      document.getElementById("previewStage").classList.add("is-loading");',
'      frame.src = source;',
'    }',
'',
'    function saveConfig() {',
'      cfg.pay = document.getElementById("payLinkBase").value.trim();',
'      localStorage.setItem("cockpit_cfg_456", JSON.stringify(cfg));',
'      notify("Paramètres sauvegardés ✓");',
'    }',
'',
'    function openReporting() {',
'      if (!stateReady) return notify("Chargement des données en cours.");',
'      var month = document.getElementById("reportMonth");',
'      month.value = KynextFinance.monthKey(Date.now());',
'      var settings = KynextFinance.sanitizeFinanceSettings(cfg.finance);',
'      document.getElementById("reportTaxRate").value = settings.taxRate;',
'      document.getElementById("reportPaymentFee").value = settings.paymentFeeRate;',
'      document.getElementById("reportInfrastructure").value = settings.infrastructureMonthly;',
'      document.getElementById("reportingPanel").classList.remove("hidden");',
'      renderFinanceReport();',
'    }',
'',
'    function closeReporting() { document.getElementById("reportingPanel").classList.add("hidden"); }',
'',
'    function saveFinanceSettings() {',
'      cfg.finance = KynextFinance.sanitizeFinanceSettings({',
'        taxRate: document.getElementById("reportTaxRate").value,',
'        paymentFeeRate: document.getElementById("reportPaymentFee").value,',
'        infrastructureMonthly: document.getElementById("reportInfrastructure").value',
'      });',
'      localStorage.setItem("cockpit_cfg_456", JSON.stringify(cfg));',
'      document.getElementById("reportTaxRate").value = cfg.finance.taxRate;',
'      document.getElementById("reportPaymentFee").value = cfg.finance.paymentFeeRate;',
'      document.getElementById("reportInfrastructure").value = cfg.finance.infrastructureMonthly;',
'      renderFinanceReport();',
'    }',
'',
'    function renderFinanceReport() {',
'      var month = document.getElementById("reportMonth").value;',
'      if (!month) return;',
'      var report = KynextFinance.calculateMonthlyReport(DATA, state, month, cfg.finance);',
'      var money = function(value) { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(value); };',
'      var cards = [["Encaissements",report.receipts],["Remboursements",-report.refunds],["Net avant estimations",report.netReceipts],["Réserve fiscale",-report.taxReserve],["Frais de paiement",-report.paymentFees],["Infrastructure",-report.infrastructureMonthly],["Net estimé",report.estimatedNet]];',
'      document.getElementById("reportingKpis").innerHTML = cards.map(function(item){ return "<div class=\\"reporting-kpi\\"><span>" + escapeHTML(item[0]) + "</span><strong>" + money(item[1]) + "</strong></div>"; }).join("") +',
'        "<div class=\\"reporting-kpi\\"><span>Délai contact → 1er encaissement</span><strong>" + (report.closingDaysAverage === null ? "—" : report.closingDaysAverage + " jours") + "</strong><span>" + report.closingCount + " dossier(s) mesuré(s)</span></div>";',
'      var rows = report.events.map(function(event){',
'        var label = event.kind === "receipt" ? "Encaissement" : "Remboursement";',
'        return "<tr><td>" + new Date(event.recordedAt).toLocaleDateString("fr-FR") + "</td><td>" + escapeHTML(event.name) + "</td><td>" + label + "</td><td>" + money(event.kind === "refund" ? -event.amount : event.amount) + "</td></tr>";',
'      });',
'      document.getElementById("reportingLedger").innerHTML = rows.length ? "<table><thead><tr><th>Date</th><th>Entreprise</th><th>Mouvement</th><th>Montant</th></tr></thead><tbody>" + rows.join("") + "</tbody></table>" : "<p class=\\"p-4 text-xs text-zinc-500\\">Aucun mouvement journalisé pour ce mois.</p>";',
'    }',
'',
'    function exportMonthlyAccountingCsv() {',
'      var month = document.getElementById("reportMonth").value;',
'      if (!month) return notify("Choisis un mois pour le rapport.");',
'      var report = KynextFinance.calculateMonthlyReport(DATA, state, month, cfg.finance);',
'      var cell = function(value) { var text = String(value == null ? "" : value); if (/^[ \\t\\r]*[=+@-]/.test(text)) text = String.fromCharCode(39) + text; return "\\"" + text.replace(/"/g, "\\"\\"") + "\\""; };',
'      var rows = [["Date","Entreprise","ID fiche","Type","Montant EUR","Statut CRM"].map(cell).join(";")];',
'      report.events.forEach(function(event){ rows.push([cell(new Date(event.recordedAt).toLocaleDateString("fr-FR")),cell(event.name),cell(event.siren),cell(event.kind === "receipt" ? "Encaissement" : "Remboursement"),String(event.kind === "refund" ? -event.amount : event.amount),cell(event.status)].join(";")); });',
'      var link = document.createElement("a");',
'      var csvUrl = URL.createObjectURL(new Blob(["\\uFEFF" + rows.join("\\r\\n")], { type: "text/csv;charset=utf-8" }));',
'      link.href = csvUrl; link.download = "kynext-journal-" + month + ".csv"; link.click(); setTimeout(function(){ URL.revokeObjectURL(csvUrl); }, 1000);',
'    }',
'',
'    function saveState() {',
'      localStorage.setItem("crm_luxury_v3", JSON.stringify(state));',
'      var saveStatus = document.getElementById("saveStatus"); saveStatus.textContent = "Enregistré localement"; saveStatus.classList.add("is-saved");',
'      clearTimeout(window.saveStatusTimer); window.saveStatusTimer = setTimeout(function(){ saveStatus.textContent = ""; saveStatus.classList.remove("is-saved"); }, 2200);',
'      updateKpis();',
    '      if (!stateReady) return;',
'      if (selected && selected.siren) {',
    '        apiFetch("/api/save-fiche", {',
'          method: "POST", headers: { "Content-Type": "application/json" },',
'          body: JSON.stringify({ prospect: selected, state: state })',
    '        }).then(function(r){ if(!r.ok) throw new Error("Échec de sauvegarde"); saveStatus.title = "Synchronisé avec le serveur local"; }).catch(function(){ notify("Serveur indisponible"); });',
'      }',
    '      syncBridgeState();',
'    }',
'',
    '    function paymentBase() { try { var u = new URL(String(cfg.pay || "")); if (u.protocol !== "https:" || !(u.hostname === "paypal.me" || u.hostname.endsWith(".paypal.me")) || u.pathname === "/") return ""; var base = u.href; while (base.endsWith("/")) base = base.slice(0, -1); return base; } catch (e) { return ""; } }',
    '    function toggleIphonePanel() { var panel = document.getElementById("iphonePanel"); panel.classList.toggle("hidden"); if (!panel.classList.contains("hidden")) refreshIphonePair(); }',
    '    async function refreshIphonePair() { try { var r = await apiFetch("/api/net-info"); if (!r.ok) throw new Error(); var info = await r.json(); var select = document.getElementById("iphoneNetwork"); var previous = select.value; select.innerHTML = (info.nets || []).map(function(n){ return "<option value=\\"" + escapeHTML(n.url) + "\\">" + escapeHTML(n.label) + "</option>"; }).join(""); if (previous) select.value = previous; var url = select.value || ""; document.getElementById("iphoneUrlText").innerText = url; document.getElementById("iphonePairCode").innerText = info.pairCode || "••••••"; document.getElementById("iphoneStatus").innerText = info.iphoneOnline ? "iPhone connecté" : "En attente de connexion"; document.getElementById("iphoneQr").src = url ? qrDataUrl(url, 180) : ""; } catch (e) { document.getElementById("iphoneStatus").innerText = "Connexion locale indisponible"; } }',
    '    function copyIphoneUrl() { var text = document.getElementById("iphoneNetwork").value; if (navigator.clipboard) navigator.clipboard.writeText(text).then(function(){ notify("Lien iPhone copié"); }); }',
    '    function syncBridgeState() { if (!stateReady || !selected || !selected.siren) return; var st = state[selected.siren] || {}; var blocked = isSuppressed(selected); var payload = { siren: String(selected.siren), nom: String(selected.nom || ""), dirigeant: String(selected.dirigeant || ""), metier: String(selected.metier || ""), ville: String(selected.ville || ""), tel: !blocked && selected.telVerified ? String(selected.tel || "") : "", telVerified: !blocked && selected.telVerified === true, telSource: !blocked && selected.telVerified ? String(selected.telSource || "") : "", isMobile: !blocked && selected.isMobile === true, doNotContact: blocked, email: String(selected.email || ""), slug: String(selected.slug || ""), urlPublique: safePublicUrl(st.publishedUrl), statusLabel: STATUS_LABELS[getStatus(selected.siren)] || "À contacter", message: blocked ? "" : (document.getElementById("cpMessage").value || ""), payBase: blocked ? "" : (cfg.pay || ""), price: getTarifActuel(), paymentLinkUrl: blocked ? "" : (st.paymentLinkUrl || ""), actionId: blocked ? 0 : (window.bridgeActionId || 0), actionType: blocked ? "" : (window.bridgeActionType || ""), lastSentAt: Number(st.lastSentAt || 0) }; apiFetch("/api/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(function(){}); }',
    '    async function pollBridgeCommands() { if (!stateReady) return; try { var r = await apiFetch("/api/bridge-poll-pc"); if (!r.ok) return; var cmd = await r.json(); if (!cmd || !cmd.type) return; if (cmd.type === "nav") navProspect(cmd.dir); if (cmd.type === "qualify") { qualifierAppel(cmd.note, cmd.status); if (cmd.autoNext) setTimeout(function(){ navProspect(1); }, 500); } if (cmd.type === "note") { document.getElementById("callNotes").value = cmd.note; saveNotes(); } if (cmd.type === "scenario") { document.getElementById("scenarioSelect").value = cmd.value; choisirScenario(cmd.value); } if (cmd.type === "next_phone") { var at = DATA.findIndex(function(p){ return p.siren === selected.siren; }); for (var i = at + 1; i < DATA.length; i++) if (DATA[i].tel) { selectProspect(DATA[i].siren); break; } } } catch (e) {} }',
    '',
'    function updateKpis() {',
'      var sent = 0, hot = 0, sold = 0;',
'      for (var i = 0; i < DATA.length; i++) {',
'        var st = getStatus(DATA[i].siren);',
'        if (st === "sent") sent++;',
'        if (st === "hot") hot++;',
'        if (st === "sold") sold++;',
'      }',
'      var ca = sold * 790;',
'      var followups = DATA.filter(function(p) { return KynextInsights.getSegment(state[p.siren] || {}, Date.now()) === "followup"; }).length;',
'      var noSite = DATA.filter(function(p){ return (p.note || "").indexOf("Site existant") === -1; }).length;',
'      var mobile = DATA.filter(function(p){ return Boolean(p.telVerified && p.tel && p.isMobile); }).length;',
'      var phoneReview = DATA.filter(function(p){ return !(p.telVerified && p.tel); }).length;',
'      document.getElementById("filterCountPrio").textContent = noSite;',
'      document.getElementById("filterCountReview").textContent = phoneReview;',
'      document.getElementById("filterCountMobile").textContent = mobile;',
'      document.getElementById("filterCountHot").textContent = hot;',
'      document.getElementById("filterCountAll").textContent = DATA.length;',

'      document.getElementById("kpiSummary").innerHTML =',
'        "<span><strong class=\\"text-white\\">" + DATA.length + "</strong> dossiers</span>" +',
'        "<span><strong class=\\"text-amber-300\\">" + sent + "</strong> contactés</span>" +',
'        "<span><strong class=\\"text-sky-300\\">" + hot + "</strong> chauds</span>" +',
'        "<span><strong class=\\"text-amber-300\\">" + followups + "</strong> à relancer</span>" +',
'        "<span>CA estimé* : <strong class=\\"text-emerald-400\\">" + ca + " €</strong> <span class=\\"text-zinc-500\\">(*790 € par vente)</span></span>";',
'      var segment = document.getElementById("crmSegment");',
'      if (segment) {',
'        var counts = { all: DATA.length, todo: 0, followup: 0, hot: 0, closed: 0 };',
'        DATA.forEach(function(p) { counts[KynextInsights.getSegment(state[p.siren] || {}, Date.now())]++; });',
'        Array.prototype.forEach.call(segment.options, function(option) {',
'          var labels = { all: "Tous les segments", todo: "À contacter", followup: "À relancer (J+3)", hot: "Priorité élevée", closed: "Clôturés" };',
'          option.textContent = labels[option.value] + " (" + counts[option.value] + ")";',
'        });',
'      }',
'    }',
'',
'    function setFilter(f) {',
'      currentFilter = f;',
'      var ids = ["prio", "review", "mobile", "vues", "all"];',
'      for (var i = 0; i < ids.length; i++) {',
'        var el = document.getElementById("btn-" + ids[i]);',
'        if (el) { el.classList.toggle("is-active", ids[i] === f); el.setAttribute("aria-pressed", ids[i] === f); }',
'      }',
'      renderList();',
'    }',
'',
'    function renderList() {',
'      var q = document.getElementById("search").value.toLowerCase();',
'      var segment = document.getElementById("crmSegment").value;',
'      filteredList = DATA.filter(function(p) {',
'        if (currentFilter === "prio" && (p.note || "").indexOf("Site existant") !== -1) return false;',
'        if (currentFilter === "review" && p.telVerified && p.tel) return false;',
'        if (currentFilter === "mobile" && !(p.telVerified && p.tel && p.isMobile)) return false;',
'        if (currentFilter === "vues" && getStatus(p.siren) !== "hot") return false;',
'        var crmState = state[p.siren] || {};',
'        if (segment !== "all" && KynextInsights.getSegment(crmState, Date.now()) !== segment) return false;',
'        return (p.nom + " " + p.ville + " " + p.dept + " " + p.metier).toLowerCase().indexOf(q) !== -1;',
'      });',
'      if (currentFilter === "review") filteredList.sort(function(a,b){ var aa=Number((state[a.siren]||{}).phoneLookupAttempts||0), bb=Number((state[b.siren]||{}).phoneLookupAttempts||0); return aa-bb || String(a.nom||"").localeCompare(String(b.nom||""), "fr"); });',
'      var items = [];',
'      var max = Math.min(filteredList.length, 150);',
'      for (var i = 0; i < max; i++) {',
'        var p = filteredList[i];',
'        var st = getStatus(p.siren);',
'        var score = KynextInsights.scoreLead(state[p.siren] || {}, Date.now());',
'        var isSel = selected && selected.siren === p.siren;',
'        var dot = "status-" + st;',
    '        items.push("<div role=\\"button\\" tabindex=\\"0\\" onclick=\\"selectProspect(" + escapeHTML(JSON.stringify(String(p.siren))) + ")\\" onkeydown=\\"if(event.key===\\\'Enter\\\'||event.key===\\\' \\\' ){event.preventDefault();selectProspect(" + escapeHTML(JSON.stringify(String(p.siren))) + ")}\\" class=\\"prospect-row cursor-pointer px-3.5 py-3 rounded-2xl border transition-all duration-150 " + (isSel ? "is-selected bg-white/[0.07] border-amber-400/50 shadow-lg" : "bg-white/[0.015] border-white/[0.04] hover:bg-white/[0.04]") + "\\">" +',
    '          "<div class=\\"flex justify-between items-center gap-2\\"><div class=\\"flex items-center gap-2.5 truncate\\"><span class=\\"status-dot " + dot + " h-2 w-2 rounded-full shrink-0\\"></span><span class=\\"font-bold text-xs text-zinc-100 truncate\\">" + escapeHTML(p.nom) + "</span></div>" +',
    '          "<span class=\\"text-[10px] font-bold " + (p.tel ? "text-emerald-400" : "text-zinc-500") + " shrink-0\\">" + escapeHTML(p.tel || "Sans N°") + "</span></div>" +',
    '          "<div class=\\"flex justify-between items-center text-[10px] text-zinc-500 mt-1\\"><span class=\\"truncate\\">" + escapeHTML(p.ville) + (p.dept ? " (" + escapeHTML(p.dept) + ")" : "") + " • " + escapeHTML((p.metier || "").split(" ")[0]) + "</span><span class=\\"flex items-center gap-2\\"><span>" + escapeHTML(STATUS_LABELS[st]) + "</span><strong class=\\"text-amber-300\\" title=\\"Indice CRM indicatif, pas une probabilité\\">" + score + "/100</strong></span></div></div>");',
'      }',
'      if (!items.length) items.push("<div class=\\"empty-state\\"><svg width=\\"42\\" height=\\"42\\" viewBox=\\"0 0 42 42\\" fill=\\"none\\" aria-hidden=\\"true\\"><circle cx=\\"18\\" cy=\\"18\\" r=\\"10\\" stroke=\\"currentColor\\" stroke-width=\\"1.5\\"/><path d=\\"m25 25 8 8M14 18h8m-4-4v8\\" stroke=\\"currentColor\\" stroke-width=\\"1.5\\" stroke-linecap=\\"round\\"/></svg><strong>Aucune fiche ici</strong><span>Essayez un autre filtre ou créez une nouvelle fiche pour reprendre la prospection.</span></div>");',
'      document.getElementById("prospectList").innerHTML = items.join("");',
'      if (!document.getElementById("pipelinePanel").classList.contains("hidden")) renderPipeline();',
'    }',
'',
'    function navProspect(dir) {',
'      var list = filteredList.length ? filteredList : DATA;',
'      var idx = list.findIndex(function(p) { return p.siren === selected.siren; });',
'      var nextIdx = idx + dir;',
'      if (nextIdx >= 0 && nextIdx < list.length) selectProspect(list[nextIdx].siren);',
'    }',
'',
'    function selectProspect(siren) {',
'      selected = DATA.find(function(p) { return p.siren === siren; }) || DATA[0];',
'      if (!selected) return;',
'      renderList();',
'      animatePanel(document.getElementById("view-" + (document.getElementById("view-vente").classList.contains("hidden") ? (document.getElementById("view-maquette").classList.contains("hidden") ? "closing" : "maquette") : "vente")));',
'      var ini = (selected.nom || "AR").split(/[\\s-]+/).filter(Boolean).slice(0, 2).map(function(w){ return w[0]; }).join("").toUpperCase();',
'      document.getElementById("avatarBox").innerText = ini;',
'      var nameHash = 0; for (var n = 0; n < selected.nom.length; n++) nameHash = (nameHash * 31 + selected.nom.charCodeAt(n)) | 0;',
'      var hue = Math.abs(nameHash) % 360;',
'      document.getElementById("avatarBox").style.backgroundImage = "linear-gradient(145deg, hsla(" + hue + ", 60%, 50%, .22), rgba(52,211,153,.08))";',
'      document.getElementById("cpNom").innerText = selected.nom;',
    '      document.getElementById("cpSub").innerText = (selected.dirigeant ? "Dirigeant : " + selected.dirigeant + "   •   " : "") + selected.ville + (selected.dept ? " (" + selected.dept + ")" : "") + "   •   SIREN " + selected.siren;',
'      document.getElementById("cpMetierBadge").innerText = selected.metier;',
'      var trade = (selected.metier || "").toLowerCase();',
'      var tradeClass = /plomb/.test(trade) ? "trade-plumber" : (/électric|electric/.test(trade) ? "trade-electric" : (/peint/.test(trade) ? "trade-paint" : (/menuis/.test(trade) ? "trade-carpenter" : "trade-default")));',
'      document.getElementById("cpMetierBadge").className = "trade-badge " + tradeClass + " text-[11px] font-semibold px-3 py-1 rounded-full";',
'      document.getElementById("cpStatus").value = getStatus(selected.siren);',
'      document.getElementById("publishApproval").checked = Boolean(state[selected.siren] && state[selected.siren].publishApproved);',
'      document.getElementById("editTel").value = selected.tel || "";',
'      document.getElementById("editTelSource").value = selected.telSource || "";',
'      document.getElementById("editTelVerified").checked = Boolean(selected.telVerified);',
'      updatePhoneEvidence(selected);',
'      updatePhoneLookupStatus(selected);',
'      var currentContactState = state[selected.siren] || {};',
'      document.getElementById("doNotContact").checked = currentContactState.doNotContact === true;',
'      document.getElementById("doNotContactStatus").textContent = currentContactState.doNotContact === true ? "Bloqué · " + (currentContactState.doNotContactReason || "aucun motif indiqué") : (currentContactState.doNotContactReleasedAt ? "Retiré de la liste le " + new Date(currentContactState.doNotContactReleasedAt).toLocaleDateString("fr-FR") : "Désactivé");',
'      document.getElementById("editEmail").value = selected.email || "";',
'      document.getElementById("callNotes").value = (state[selected.siren] && state[selected.siren].notes) ? state[selected.siren].notes : "";',
'      var paymentState = state[selected.siren] || {};',
'      document.getElementById("paymentStatus").value = paymentState.paymentStatus || "not_invoiced";',
'      document.getElementById("paidAmount").value = Number(paymentState.paidAmount || 0);',
'',
'      var prenom = (selected.dirigeant && selected.dirigeant !== "Dirigeant") ? selected.dirigeant.split(" ")[0] : "";',
    '      document.getElementById("cpPitch").innerText = KynextPlaybook.buildCallPitch(selected);',
'',
    '      var telClean = isSuppressed(selected) ? "" : (selected.tel || "").replace(/[^0-9+]/g, "");',
    '      var publicUrl = ""; try { var parsedPublicUrl = new URL(selected.urlPublique || ""); if (parsedPublicUrl.protocol === "https:" || parsedPublicUrl.protocol === "http:") publicUrl = parsedPublicUrl.href; } catch (e) {}',
    '      document.getElementById("cpQuickLinks").innerHTML =',
    '        (publicUrl ? "<a href=\\"" + escapeHTML(publicUrl) + "\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" class=\\"bg-white/[0.06] hover:bg-white/[0.12] border border-white/[0.08] text-zinc-200 text-xs font-semibold px-3.5 py-2.5 rounded-xl transition\\">🌐 Voir son site</a>" : "") +',
    '        (telClean ? "<a href=\\"tel:" + escapeHTML(telClean) + "\\" title=\\"Appeler cette entreprise\\" class=\\"quick-action bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-extrabold px-4 py-2.5 rounded-xl shadow transition\\">📞 Appeler</a>" : "");',
'      var publishStatus = document.getElementById("studioPublishStatus");',
'      var isApproved = Boolean(state[selected.siren] && state[selected.siren].publishApproved);',
'      var publishedAt = Number(state[selected.siren] && state[selected.siren].publishedAt || 0);',
'      var publishedUrl = safePublicUrl(state[selected.siren] && state[selected.siren].publishedUrl);',
'      publishStatus.textContent = publishedUrl && publishedAt ? "Publié le " + new Date(publishedAt).toLocaleDateString("fr-FR") : (isApproved ? "Autorisation accordée · publication à confirmer" : "Maquette locale · autorisation requise");',
'      publishStatus.classList.toggle("is-approved", isApproved);',
'      var publishedLink = document.getElementById("iframeUrlLink");',
'      publishedLink.href = publishedUrl || ("/sites/" + selected.slug + ".html");',
'      publishedLink.textContent = publishedUrl || ("Aperçu local · /sites/" + selected.slug + ".html");',
'      document.getElementById("btnOpenExt").href = publishedUrl || ("/sites/" + selected.slug + ".html");',
'      var paymentDraft = state[selected.siren] || {};',
'      var paymentLinkEl = document.getElementById("paymentLinkDraftLink");',
'      paymentLinkEl.hidden = !KynextCrmPolicy.isPayPalMeLink(paymentDraft.paymentLinkUrl);',
'      if (!paymentLinkEl.hidden) { paymentLinkEl.href = paymentDraft.paymentLinkUrl; paymentLinkEl.textContent = "Brouillon de paiement · " + paymentDraft.paymentLinkAmount + " € · " + new Date(paymentDraft.paymentLinkCreatedAt).toLocaleString("fr-FR"); }',
'',
'      if (!document.getElementById("view-maquette").classList.contains("hidden")) {',
    '        loadSelectedPreview();',
'      }',
'      choisirScenario(document.getElementById("scenarioSelect").value);',
'    }',
'',
'    function choisirScenario(val) {',
'      var p = selected;',
    '      var prenom = (p.dirigeant && p.dirigeant !== "Dirigeant") ? " " + p.dirigeant.split(" ")[0] : "";',
'      var publishedUrl = safePublicUrl((state[p.siren] || {}).publishedUrl);',
'      var siteRef = publishedUrl ? " : " + publishedUrl : "";',
'      var askToSee = publishedUrl ? "Souhaitez-vous le consulter ?" : "Souhaitez-vous que je vous présente l’aperçu local ?";',
'      var map = {',
    '        v1: "Bonjour" + prenom + ", je vous contacte car j’ai préparé un aperçu de site pour " + p.nom + siteRef + " — " + askToSee,',
    '        v2: "Bonjour" + prenom + ", voici un aperçu de site préparé pour " + p.nom + " à " + p.ville + siteRef + " — " + askToSee,',
    '        v3: "Bonjour" + prenom + ", je vous partage la maquette préparée pour " + p.nom + siteRef + " — Les textes et prestations sont à valider avec vous.",',
'        j3: publishedUrl ? "Bonjour" + prenom + ", avez-vous pu jeter un œil à la maquette préparée pour " + p.nom + " (" + publishedUrl + ") ? Je peux adapter les photos et textes selon vos chantiers." : "Bonjour" + prenom + ", je reviens au sujet de l’aperçu préparé pour " + p.nom + ". Souhaitez-vous que je vous le présente ?",',
'        j7: "Bonjour" + prenom + ", je reviens vers vous au sujet de la maquette préparée pour " + p.nom + ". Souhaitez-vous la consulter ou préférez-vous que je ne vous relance plus ?",',
'        tarif: "Bonjour" + prenom + ", le montant de départ indicatif pour la création du site est de " + getTarifActuel() + " € HT. Le périmètre, les options et le devis final sont à confirmer ensemble.",',
    '        "2x": "Bonjour" + prenom + ", des modalités de paiement en plusieurs fois peuvent être discutées et précisées dans le devis.",',
    '        fb: "Bonjour" + prenom + ", cette maquette peut compléter votre présence actuelle sur Facebook ou d’autres canaux, si cela vous est utile.",',
    '        pj: "Bonjour" + prenom + ", voici un aperçu de site que vous pouvez comparer à vos outils actuels. Les frais et modalités seront précisés dans le devis.",',
    '        obj_prix: KynextPlaybook.buildObjectionMessage("budget", p),',
    '        obj_temps: KynextPlaybook.buildObjectionMessage("time", p),',
    '        obj_utilite: KynextPlaybook.buildObjectionMessage("usefulness", p),',
    '        obj_site: KynextPlaybook.buildObjectionMessage("existing_site", p),',
    '        stop: KynextPlaybook.buildObjectionMessage("no_followup", p)',
'      };',
    '      document.getElementById("cpMessage").value = map[val] || map.v1;',
'    }',
'',
'    function normalizePhoneInput(value) { var digits = String(value || "").replace(/\\D/g, ""); if (/^0033[1-9]\\d{8}$/.test(digits)) digits = "0" + digits.slice(4); else if (/^33[1-9]\\d{8}$/.test(digits)) digits = "0" + digits.slice(2); return /^0[1-9]\\d{8}$/.test(digits) ? digits.replace(/(\\d{2})(?=\\d)/g, "$1 ").trim() : ""; }',
'    function securePhoneSource(value) { return KynextCrmPolicy.isSecurePublicEvidenceUrl(value); }',
'    function isSuppressed(prospect) { return KynextCrmPolicy.isContactSuppressed(prospect && state[prospect.siren]); }',
'    function updatePhoneEvidence(prospect) { var link = document.getElementById("phoneEvidenceLink"); if (!link || !prospect) return; var source = prospect.telSource || ""; var available = prospect.telVerified && KynextCrmPolicy.isSecurePublicEvidenceUrl(source); link.hidden = !available; if (available) { link.href = source; link.title = source; } else { link.removeAttribute("href"); } }',
'    function updatePhoneLookupStatus(prospect) { var el = document.getElementById("phoneLookupStatus"); if (!el || !prospect) return; var current = state[prospect.siren] || {}; var attempts = Number(current.phoneLookupAttempts || 0); var checked = Number(current.phoneLookupCheckedAt || 0); var when = checked ? new Date(checked).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : ""; if (prospect.telVerified && prospect.tel) { var verifiedAt = Number(current.phoneVerifiedAt || 0); el.textContent = "Vérifié · source HTTPS consultable" + (verifiedAt ? " · " + new Date(verifiedAt).toLocaleDateString("fr-FR") : ""); } else if (current.phoneLookupOutcome === "no_match") el.textContent = "Aucun numéro public trouvé · " + attempts + " recherche(s) · " + when; else if (attempts) el.textContent = attempts + " recherche(s) ouverte(s) · dernière le " + when + " · à vérifier"; else el.textContent = "À vérifier · aucune recherche manuelle"; }',
'    function recordPhoneLookupAttempt(sourceId) { if (!selected || !selected.siren) return; var current = state[selected.siren] || {}; state[selected.siren] = Object.assign({}, current, { phoneLookupAttempts: Math.min(9999, Number(current.phoneLookupAttempts || 0) + 1), phoneLookupCheckedAt: Date.now(), phoneLookupOutcome: selected.telVerified ? "verified" : "pending", phoneLookupLastSource: String(sourceId || "public_source").replace(/[^a-z0-9_]/g, "").slice(0, 48) }); saveState(); updatePhoneLookupStatus(selected); renderList(); }',
'    function markNoPhoneFound() { if (!selected || !selected.siren) return; var current = state[selected.siren] || {}; if (selected.telVerified && selected.tel) return notify("Cette fiche possède déjà un téléphone vérifié."); if (!Number(current.phoneLookupAttempts || 0)) return notify("Ouvre d’abord au moins une source de recherche."); state[selected.siren] = Object.assign({}, current, { phoneLookupOutcome: "no_match", phoneLookupCheckedAt: Number(current.phoneLookupCheckedAt || Date.now()) }); saveState(); updatePhoneLookupStatus(selected); notify("Résultat enregistré : aucun numéro public trouvé."); }',
'    function saveContactInfo() {',
'      var telInput = document.getElementById("editTel").value.trim();',
'      var tel = normalizePhoneInput(telInput);',
'      var telSource = document.getElementById("editTelSource").value.trim();',
'      var telVerified = document.getElementById("editTelVerified").checked;',
'      if (telInput && (!tel || !telVerified || !securePhoneSource(telSource))) return notify("Saisis un numéro français valide, son lien HTTPS public et confirme sa vérification.");',
'      var duplicatePhone = tel && DATA.find(function(p){ return String(p.siren) !== String(selected.siren) && p.telVerified && p.tel && p.tel.replace(/\\D/g, "") === tel.replace(/\\D/g, ""); });',
'      if (duplicatePhone && !confirm("Ce numéro est déjà vérifié pour « " + duplicatePhone.nom + " ». Confirme qu’il est aussi publié comme contact professionnel pour cette fiche.")) return;',
'      selected.tel = tel;',
'      selected.telVerified = Boolean(tel);',
'      selected.telSource = tel ? telSource : "";',
'      selected.email = document.getElementById("editEmail").value.trim();',
'      var currentContactState = state[selected.siren] || {};',
'      state[selected.siren] = Object.assign({}, currentContactState, { tel: selected.tel, telVerified: selected.telVerified, telSource: selected.telSource, email: selected.email, phoneLookupOutcome: selected.telVerified ? "verified" : (currentContactState.phoneLookupOutcome === "verified" ? "pending" : currentContactState.phoneLookupOutcome), phoneVerifiedAt: selected.telVerified ? Date.now() : 0 });',
'      saveState(); selectProspect(selected.siren);',
'      notify("Coordonnées mises à jour ✓");',
'    }',
'',
'    function savePaymentInfo() {',
'      if (!selected || !selected.siren) return notify("Sélectionne d’abord une fiche.");',
'      state[selected.siren] = Object.assign({}, state[selected.siren] || {}, {',
'        paymentStatus: document.getElementById("paymentStatus").value,',
'        paymentUpdatedAt: Date.now()',
'      });',
'      saveState();',
'      notify("Suivi du règlement enregistré");',
'    }',
'',
'    function toggleDoNotContact() {',
'      if (!selected || !selected.siren) return;',
'      var current = state[selected.siren] || {};',
'      var enabled = document.getElementById("doNotContact").checked;',
'      var next = Object.assign({}, current);',
'      if (enabled) { next.doNotContact = true; next.doNotContactAt = Date.now(); next.doNotContactReason = (prompt("Motif du retrait de contact (facultatif) :", current.doNotContactReason || "") || "").trim().slice(0, 300); next.doNotContactReleasedAt = 0; }',
'      else { if (!confirm("Retirer cette entreprise de la liste « Ne plus contacter » ?")) { document.getElementById("doNotContact").checked = true; return; } next.doNotContact = false; next.doNotContactReleasedAt = Date.now(); }',
'      state[selected.siren] = next; saveState(); selectProspect(selected.siren);',
'      notify(enabled ? "Contact bloqué dans la liste de suppression" : "Contact réactivé après confirmation");',
'    }',
'',
'    async function createPaymentDraft(amount, purpose) {',
'      if (!selected || !selected.siren || isSuppressed(selected)) throw new Error("Cette fiche est dans la liste « Ne plus contacter ».");',
'      var result = await apiFetch("/api/payment-link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siren: String(selected.siren), amount: amount, purpose: purpose, base: cfg.pay || "" }) });',
'      var payload = await result.json(); if (!result.ok || !payload.ok) throw new Error(payload.error || "Création du lien impossible.");',
'      state[selected.siren] = Object.assign({}, state[selected.siren] || {}, payload.paymentState); saveState(); selectProspect(selected.siren);',
'      return payload.paymentLinkUrl;',
'    }',
'',
'    function recordPaymentMovement() {',
'      if (!selected || !selected.siren) return notify("Sélectionne d’abord une fiche.");',
'      var amount = Number(document.getElementById("paymentMovementAmount").value);',
'      var kind = document.getElementById("paymentMovementType").value;',
'      var current = state[selected.siren] || {};',
'      var result = KynextFinance.addPaymentMovement(current, kind, amount, Date.now());',
'      if (!result.ok) {',
'        var errors = { invalid_amount: "Montant invalide.", refund_exceeds_balance: "Le remboursement dépasse le solde encaissé.", balance_limit: "Le solde maximal de 1 000 000 € serait dépassé.", journal_full: "Le journal de cette fiche est plein.", invalid_kind: "Type de mouvement invalide." };',
'        return notify(errors[result.error] || "Mouvement impossible.");',
'      }',
'      state[selected.siren] = Object.assign({}, current, result.state);',
'      document.getElementById("paidAmount").value = result.state.paidAmount;',
'      document.getElementById("paymentMovementAmount").value = "";',
'      saveState(); renderFinanceReport();',
'      notify(kind === "receipt" ? "Encaissement journalisé" : "Remboursement journalisé");',
'    }',
'',
'    function togglePublishApproval() {',
'      if (!selected || !selected.siren) return;',
'      var approved = document.getElementById("publishApproval").checked;',
'      state[selected.siren] = Object.assign({}, state[selected.siren] || {}, { publishApproved: approved });',
'      saveState();',
'      notify(approved ? "Publication autorisée pour cette fiche" : "Fiche exclue des publications");',
'    }',
'',
    '    function saveNotes() {',
    '      var siren = selected.siren; var notes = document.getElementById("callNotes").value;',
    '      clearTimeout(window.noteSaveTimer); window.noteSaveTimer = setTimeout(function(){ state[siren] = Object.assign({}, state[siren] || {}, { notes: notes }); saveState(); }, 400);',
'    }',
'',
'    function updateStatus() {',
'      if (!selected || !selected.siren) return;',
'      setProspectStatus(selected.siren, document.getElementById("cpStatus").value, true);',
'    }',
'    function setProspectStatus(siren, nextStatus, announce) {',
'      if (!["todo", "sent", "hot", "sold", "refused"].includes(nextStatus)) return;',
'      var current = state[siren] || {}; var now = Date.now();',
'      state[siren] = Object.assign({}, current, { status: nextStatus, lastInteractionAt: now, firstContactAt: current.firstContactAt || (current.status !== "sent" && current.status !== "hot" && current.status !== "sold" && nextStatus !== "todo" ? now : 0) });',
'      if (selected && String(selected.siren) === String(siren)) document.getElementById("cpStatus").value = nextStatus;',
'      saveState(); renderList();',
'      if (announce) notify("Statut mis à jour ✓");',
'    }',
'',
'    function qualifierAppel(noteAjout, nouveauStatut) {',
'      var current = state[selected.siren] || {}; var prev = current.notes || ""; var now = Date.now();',
'      var h = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });',
'      state[selected.siren] = Object.assign({}, current, { notes: (prev ? prev + " | " : "") + "[" + h + "] " + noteAjout, status: nouveauStatut, lastSentAt: now, lastInteractionAt: now, firstContactAt: current.firstContactAt || (current.status !== "sent" && current.status !== "hot" && current.status !== "sold" && nouveauStatut !== "todo" ? now : 0) });',
'      saveState(); selectProspect(selected.siren);',
'      notify("Qualifié : " + noteAjout);',
'    }',
'',
'    function verifiedMobileIntl() { if (!selected || isSuppressed(selected) || !selected.telVerified || !selected.tel) return ""; var digits = selected.tel.replace(/\\D/g, ""); return /^0[67]\\d{8}$/.test(digits) ? "33" + digits.slice(1) : ""; }',
'    function sendCurrentWa() {',
    '      if (isSuppressed(selected)) return notify("Contact bloqué : aucun brouillon ne peut être préparé.");',
    '      var intl = verifiedMobileIntl(); if (!intl) return notify("⚠️ WhatsApp exige un mobile professionnel 06/07 vérifié.");',
'      var txt = document.getElementById("cpMessage").value;',
'      window.open("https://wa.me/" + intl + "?text=" + encodeURIComponent(txt), "_blank");',
    '      window.bridgeActionId = Number(window.bridgeActionId || 0) + 1; window.bridgeActionType = "wa"; syncBridgeState();',
    '      notify("Brouillon WhatsApp ouvert. Marque le contacté après l’envoi.");',
'    }',
'',
'    function copyMsg() {',
    '      if (isSuppressed(selected)) return notify("Contact bloqué : copie du message désactivée.");',
'      navigator.clipboard.writeText(document.getElementById("cpMessage").value);',
'      notify("Message copié ✓");',
'    }',
'',
    '    function chercherNumeroAuto() { autoEnrichPhones(); }',
'',
'    function renderDeepSearchSummary(plan) {',
'      var completeEl = document.getElementById("deepSearchCompleteness");',
'      var sourceEl = document.getElementById("deepSearchSources");',
'      var panel = document.getElementById("deepSearchSummary");',
'      if (!panel || !completeEl || !sourceEl) return;',
'      var sources = (plan && (plan.searchPlan || plan.sources || []) || []).slice(0, 8);',
'      var completeness = plan && plan.completeness ? plan.completeness : {};',
'      completeEl.textContent = Number(completeness.present || 0) + "/" + Number(completeness.total || 0) + " champs";',
'      sourceEl.innerHTML = sources.length ? sources.map(function(item) {',
'        var href = "https://www.google.com/search?q=" + encodeURIComponent(String(item.query || ""));',
'        var kind = item.phoneSource === false ? " · identité" : " · téléphone pro";',
'        return \'<a href="\' + escapeHTML(href) + \'" target="_blank" rel="noopener noreferrer" onclick="recordPhoneLookupAttempt(\' + escapeHTML(JSON.stringify(String(item.id || "public_source"))) + \')" class="inline-flex items-center rounded-lg border border-amber-400/20 bg-amber-500/[0.07] px-2.5 py-1.5 text-[10px] font-semibold text-amber-200 hover:bg-amber-500/15">\' + escapeHTML(item.label || item.id || "Source") + escapeHTML(kind) + " ↗</a>";',
'      }).join("") : "Aucune source priorisée pour le moment.";',
'      panel.classList.remove("hidden");',
'    }',
'    async function autoEnrichPhones() {',
'      if (!selected) return notify("Sélectionne d’abord une fiche.");',
'      try {',
'        var r = await apiFetch("/api/enrich-one", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siren: selected.siren }) });',
'        var result = await r.json();',
'        if (!r.ok || !result.ok) throw new Error(result.error || "Plan d’enrichissement indisponible");',
'        var plan = result.plan || result || {};',
'        var sourceList = (plan.searchPlan || plan.sources || []);',
'        var topSources = sourceList.slice(0, 5).map(function(item) { return item.label || item.id || "Source"; }).join(" • ");',
'        renderDeepSearchSummary(plan);',
'        notify((plan.summary || "Plan de recherche prêt.") + (topSources ? " Sources : " + topSources + "." : ""));',
'      } catch (e) {',
'        notify("Recherche enrichie indisponible : " + (e.message || "erreur réseau"));',
'      }',
'    }',
'',
'    async function validateCurrentSite() {',
'      if (!selected || !selected.siren) return notify("Sélectionne d’abord une fiche.");',
'      var btn = document.getElementById("btnValidateSite");',
'      btn.disabled = true; btn.innerText = "⏳ Vérification...";',
'      try {',
'        var r = await apiFetch("/api/validate-site", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siren: selected.siren }) });',
'        var result = await r.json();',
'        if (!r.ok || !result.ok) return notify("Corrections requises : " + ((result.errors || []).join(", ") || result.error || "validation échouée"));',
'        notify("Prévalidation réussie : " + result.checks.length + " contrôles.");',
'      } catch (e) { notify("Validation indisponible : " + (e.message || "erreur réseau")); }',
'      finally { btn.disabled = false; btn.innerText = "✓ Valider le site"; }',
'    }',
'',
'    async function publierSurgeDirect() {',
'      var btn = document.getElementById("btnSurge");',
    '      var approvedCount = DATA.filter(function(p) { return state[p.siren] && state[p.siren].publishApproved === true; }).length;',
    '      if (!approvedCount) return notify("Aucune fiche n’a été autorisée pour la publication.");',
    '      if (!confirm("Publier " + approvedCount + " fiche(s) autorisée(s) sur le site public ? Les autres fiches resteront privées.")) return;',
    '      btn.innerText = "⏳ Publication..."; btn.disabled = true;',
    '      try { var r = await apiFetch("/api/surge", { method: "POST" }); var j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.error || ("HTTP " + r.status)); (j.sites || []).forEach(function(site){ state[site.siren] = Object.assign({}, state[site.siren] || {}, { publishedAt: site.publishedAt, publishedUrl: site.url }); }); saveState(); if (selected && selected.siren) selectProspect(selected.siren); btn.innerText = "✓ Publication terminée"; notify(j.published + " maquettes publiées sur " + j.url); } catch (e) { btn.innerText = "Échec de publication"; notify("Publication impossible : " + (e.message || "erreur réseau")); } finally { btn.disabled = false; }',
'    }',
'',
    '    async function ouvrirDossierWindows() { try { var r = await apiFetch("/api/open-folder", { method: "POST" }); if (!r.ok) throw new Error(); } catch (e) { notify("Impossible d’ouvrir le dossier du projet."); } }',
'',
'    function lancerRafale() {',
'      var cibles = DATA.filter(function(p) { return p.tel && !isSuppressed(p) && (p.note || "").indexOf("Site existant") === -1 && getStatus(p.siren) === "todo"; });',
    '      if (!cibles.length) return notify("⚠️ Aucune cible avec numéro en attente");',
    '      if (!confirm("Préparer " + cibles.length + " brouillons WhatsApp ? Aucun message ne sera envoyé automatiquement.")) return;',
'      var idx = 0;',
'      function next() {',
'        if (idx >= cibles.length) return;',
'        selectProspect(cibles[idx].siren);',
'        sendCurrentWa();',
'        idx++;',
'        setTimeout(next, 9000);',
'      }',
'      next();',
'    }',
'',
'    function getTarifActuel() { return document.getElementById("chkUpsell").checked ? 980 : 790; }',
'',
'    function toggleUpsell() {',
'      var total = getTarifActuel();',
    '      document.getElementById("btnTotal").innerText = "Total indicatif " + total + " €";',
    '    document.getElementById("btnHalfPayment").innerText = "2 × " + Math.round(total / 2) + " €";',
    '      document.getElementById("btnDevis").innerText = "📄 Imprimer la proposition indicative (" + total + " €)";',
'    }',
'',
    '    async function envoyerLienPaiement(amount, purpose, label) {',
    '      var intl = verifiedMobileIntl(); if (!intl) return notify(isSuppressed(selected) ? "Contact bloqué : aucun lien ne sera préparé." : "WhatsApp exige un mobile professionnel 06/07 vérifié.");',
    '      if (!paymentBase()) return notify("Configure un compte PayPal.me valide dans les paramètres.");',
    '      var popup = window.open("about:blank", "_blank"); if (!popup) return notify("Autorise les fenêtres contextuelles pour préparer le brouillon.");',
    '      try { var link = await createPaymentDraft(amount, purpose); var msg = "Bonjour, voici le brouillon de lien pour " + label + " (" + amount + " € indicatifs, à confirmer dans le devis) pour " + selected.nom + " : " + link; popup.location.href = "https://wa.me/" + intl + "?text=" + encodeURIComponent(msg); notify("Lien rattaché à la fiche; brouillon WhatsApp prêt."); }',
    '      catch (error) { popup.close(); notify("Lien non préparé : " + (error.message || "erreur réseau")); }',
'    }',
'',
    '    function envoyerLienAcompte() {',
    '      var amount = Math.round(getTarifActuel() * 0.3); envoyerLienPaiement(amount, "deposit", "l’acompte de 30%");',
'    }',
'',
    '    function envoyerLien2x() {',
    '      var half = Math.round(getTarifActuel() / 2); envoyerLienPaiement(half, "installment", "la première échéance");',
    '    }',
    '',
    '    function envoyerLienTotal() {',
    '      var total = getTarifActuel(); envoyerLienPaiement(total, "total", "le montant total indicatif");',
'    }',
'',
'    function envoyerBienvenue() {',
    '      var intl = verifiedMobileIntl(); if (!intl) return notify("WhatsApp exige un mobile professionnel 06/07 vérifié.");',
    '      var msg = "Bonjour, pour préparer la suite du projet pour " + selected.nom + ", vous pouvez envoyer les photos, le logo et les horaires souhaités.";',
'      window.open("https://wa.me/" + intl + "?text=" + encodeURIComponent(msg), "_blank");',
'    }',
'',
'    function genererDevisPDF() {',
'      var total = getTarifActuel();',
'      var hasMaint = document.getElementById("chkMaint").checked;',
'      var w = window.open("", "_blank");',
    '      w.document.write("<!DOCTYPE html><html><head><title>Proposition - " + escapeHTML(selected.nom) + "</title><style>body{font-family:Arial;padding:40px;max-width:800px;margin:auto}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:10px;text-align:left}.total{font-size:20px;font-weight:bold;text-align:right;margin-top:20px}</style></head><body>" +',
    '        "<h1>PROPOSITION COMMERCIALE</h1><p><strong>Date :</strong> " + new Date().toLocaleDateString("fr-FR") + "</p><p><strong>Client :</strong> " + escapeHTML(selected.nom) + " — " + escapeHTML(selected.ville) + "</p>" +',
'        "<table><tr><th>Prestation</th><th>Montant HT</th></tr><tr><td>Création Site Vitrine Sur-Mesure Prestige + Simulateur + SEO Local</td><td>790,00 </td></tr>" +',
'        (total === 980 ? "<tr><td>Pack Google Maps + Nom de domaine .fr (1 an)</td><td>190,00 </td></tr>" : "") +',
    '        (hasMaint ? "<tr><td>Maintenance & Hébergement (optionnel)</td><td>29,00 € / mois</td></tr>" : "") +',
    '        "</table><p class=\\"total\\">Total indicatif : " + total + ",00 €</p><p>Document de proposition à compléter et à valider avant signature.</p>" +',
'        "<scr" + "ipt>window.print();</scr" + "ipt></body></html>");',
'      w.document.close();',
'    }',
'',
'    function genererCarteVisitePDF() {',
    '      var qr = qrDataUrl(safePublicUrl(selected.urlPublique), 160);',
'      var w = window.open("", "_blank");',
    '      w.document.write("<!DOCTYPE html><html><body style=\\"font-family:Arial;display:flex;justify-content:center;align-items:center;height:100vh\\"><div style=\\"width:85mm;height:55mm;background:#09090b;color:#fff;border-radius:12px;padding:18px;display:flex;justify-content:space-between;align-items:center\\"><div><h3 style=\\"color:#f59e0b;margin:0\\">" + escapeHTML(selected.nom) + "</h3><p style=\\"font-size:12px\\">" + escapeHTML(selected.metier) + "<br>" + escapeHTML(selected.ville) + "<br>" + escapeHTML(selected.tel || "") + "</p></div><img src=\\"" + escapeHTML(qr) + "\\" style=\\"background:#fff;padding:4px;border-radius:8px;width:65px\\"></div><scr" + "ipt>window.print();</scr" + "ipt></body></html>");',
'      w.document.close();',
'    }',
'',
'    function genererAfficheAvisPDF() {',
'      var qr = qrDataUrl("https://www.google.com/search?q=" + encodeURIComponent(selected.nom + " " + selected.ville + " avis"), 220);',
'      var w = window.open("", "_blank");',
    '      w.document.write("<!DOCTYPE html><html><body style=\\"font-family:Arial;text-align:center;padding:50px\\"><h1>" + escapeHTML(selected.nom) + "</h1><h2 style=\\"color:#f59e0b\\">Votre avis compte</h2><p>Scannez pour consulter la fiche et laisser un avis authentique :</p><img src=\\"" + escapeHTML(qr) + "\\"><scr" + "ipt>window.print();</scr" + "ipt></body></html>");',
'      w.document.close();',
'    }',
'',
'    function exporterCSV() {',
'      var csvCell = function(v) { var cell = String(v == null ? "" : v); if (/^[ \\t\\r]*[=+@-]/.test(cell)) cell = String.fromCharCode(39) + cell; return String.fromCharCode(34) + cell.replace(/"/g, String.fromCharCode(34) + String.fromCharCode(34)) + String.fromCharCode(34); }; var rows = [["Score /100", "Nom", "Dirigeant", "Métier", "Ville", "SIREN ou ID fiche", "Téléphone", "E-mail", "Statut CRM", "Statut paiement", "Montant reçu EUR", "Prix indicatif", "URL maquette", "Message", "Notes"].map(csvCell).join(",")].concat(DATA.map(function(p) {',
'        var paymentState = state[p.siren] || {};',
'        var paymentLabels = { not_invoiced: "Non facturé", deposit_requested: "Acompte demandé", deposit_received: "Acompte reçu", balance_requested: "Solde demandé", paid: "Réglé", refunded: "Remboursé" };',
'        return [p.score + "/100", p.nom, p.dirigeant, p.metier, p.ville, p.siren, p.tel, p.email, STATUS_LABELS[getStatus(p.siren)], paymentLabels[paymentState.paymentStatus] || "Non facturé", paymentState.paidAmount || 0, "790 € indicatif", p.urlPublique, p.sms, p.note].map(csvCell).join(",");',
'      }));',
'      var a = document.createElement("a");',
'      a.href = URL.createObjectURL(new Blob(["\\uFEFF" + rows.join("\\n")], { type: "text/csv" }));',
'      a.download = "export_google_sheet.csv";',
'      a.click();',
'    }',
'',
'    function openCsvImport() { document.getElementById("csvImportFile").click(); }',
'',
'    async function importerCSVFile(file) {',
'      if (!file) return;',
'      if (!String(file.name || "").toLowerCase().endsWith(".csv")) return notify("Sélectionne un fichier .csv.");',
'      if (file.size > 2 * 1024 * 1024) return notify("Le fichier dépasse la limite de 2 Mo.");',
'      try {',
'        var response = await apiFetch("/api/import-csv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ csv: await file.text() }) });',
'        var result = await response.json();',
'        if (!response.ok || !result.ok) throw new Error(result.error || "Import refusé");',
'        var dataResponse = await apiFetch("/api/data");',
'        if (!dataResponse.ok) throw new Error("Impossible de recharger les fiches importées");',
'        DATA = await dataResponse.json(); updateKpis(); renderList();',
'        notify("Import CSV : " + result.added + " ajoutée(s), " + result.merged + " fusionnée(s), " + result.ambiguous.length + " doublon(s) à vérifier, " + result.errors.length + " ligne(s) ignorée(s).");',
'      } catch (error) { notify("Import CSV impossible : " + (error.message || "erreur réseau")); }',
'    }',
'',
'    function exporterMobilesVerifies() {',
'      var verified = DATA.filter(function(p) { return p.telVerified === true && /^0[67]/.test(String(p.tel || "").replace(/\\D/g, "")); });',
'      if (!verified.length) return notify("Aucun mobile professionnel vérifié à exporter.");',
'      var cell = function(value) { var text = String(value == null ? "" : value); if (/^[ \\t\\r]*[=+@-]/.test(text)) text = String.fromCharCode(39) + text; return String.fromCharCode(34) + text.replace(/"/g, String.fromCharCode(34) + String.fromCharCode(34)) + String.fromCharCode(34); };',
'      var rows = [["Nom", "SIREN/SIRET", "Mobile vérifié", "Source HTTPS", "Maquette"].map(cell).join(";")];',
'      verified.forEach(function(p) { rows.push([cell(p.nom), cell(p.siren), cell(p.tel), cell(p.telSource), cell(safePublicUrl(p.urlPublique))].join(";")); });',
'      var link = document.createElement("a"); var url = URL.createObjectURL(new Blob(["\\uFEFF" + rows.join("\\r\\n")], { type: "text/csv;charset=utf-8" }));',
'      link.href = url; link.download = "kynext-mobiles-verifies.csv"; link.click(); setTimeout(function() { URL.revokeObjectURL(url); }, 1000);',
'    }',
'',
'    async function ajouterProspectRapide() {',
'      var nom = prompt("Nom de l\'entreprise :");',
'      if (!nom) return;',
'      var telInput = prompt("Téléphone vérifié sur une source publique (laisser vide si inconnu) :", "") || "";',
'      var tel = normalizePhoneInput(telInput);',
'      var telSource = tel ? prompt("Lien HTTPS de la source publique :", "") || "" : "";',
'      if (telInput && (!tel || !securePhoneSource(telSource))) return alert("Numéro refusé : saisis un numéro français valide avec son lien HTTPS de vérification.");',
'      if (tel && !confirm("Après avoir ouvert cette source, confirmes-tu que ce numéro exact est publié comme téléphone professionnel de cette entreprise ?")) return alert("Fiche non créée. Relance l’ajout et laisse le téléphone vide si tu ne peux pas confirmer ce numéro.");',
'      var ville = prompt("Ville :", "Lille");',
'      var metier = prompt("Métier :", "Plombier Chauffagiste");',
'      var dept = prompt("Département (code réel, optionnel) :", "") || "";',
'      var siren = String(prompt("SIREN ou SIRET réel de l’entreprise (9 ou 14 chiffres) :", "") || "").replace(/\\D/g, "");',
'      if (!/^\\d{9}(?:\\d{5})?$/.test(siren)) return alert("Saisis le SIREN ou SIRET réel de l’entreprise.");',
'      if (DATA.some(function(existing){ return String(existing.siren) === siren; })) return alert("Cette entreprise existe déjà dans le CRM.");',
'      if (!ville || !metier) return alert("La ville et le métier sont requis.");',
'      try {',
'        var response = await apiFetch("/api/prospect/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ siren: siren, nom: nom.trim(), ville: ville.trim(), dept: dept.trim(), metier: metier.trim(), tel: tel, telVerified: Boolean(tel), telSource: tel ? telSource : "", email: "", urlPublique: "", note: "Ajout manuel — maquette locale à valider" }) });',
'        var result = await response.json();',
'        if (!response.ok || !result.ok) throw new Error(result.error || "Enregistrement impossible");',
'        DATA.unshift(result.prospect);',
'        selectProspect(result.prospect.siren); saveState(); updateKpis(); renderList();',
'        notify("Fiche ajoutée et enregistrée. La maquette reste locale jusqu’à sa publication autorisée.");',
'      } catch (error) { notify("Ajout impossible : " + (error.message || "erreur réseau")); }',
'    }',
'',
'    document.addEventListener("keydown", function(e) {',
'      if (e.key === "Escape") {',
'        if (!document.getElementById("reportingPanel").classList.contains("hidden")) closeReporting();',
'        if (!document.getElementById("helpPanel").classList.contains("hidden")) toggleHelpPanel();',
'        if (!document.getElementById("pipelinePanel").classList.contains("hidden")) closePipeline();',
'        closeQuickNotes();',
'        return;',
'      }',
'      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); document.getElementById("search").focus(); return; }',
'      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) { e.preventDefault(); document.getElementById("search").focus(); return; }',
'      if (e.key === "?") { toggleHelpPanel(); return; }',
'      if (["INPUT", "TEXTAREA", "SELECT"].indexOf(document.activeElement.tagName) !== -1) return;',
'      if (e.key === "ArrowDown") { e.preventDefault(); navProspect(1); }',
'      if (e.key === "ArrowUp") { e.preventDefault(); navProspect(-1); }',
'      if (e.key === "1") setTab("vente");',
'      if (e.key === "2") setTab("maquette");',
'      if (e.key === "3") setTab("closing");',
'    });',
'',
    '    async function initializeApp() {',
    '      document.getElementById("payLinkBase").value = cfg.pay || "";',
    '      document.getElementById("maquetteIframe").addEventListener("load", function(){ document.getElementById("previewStage").classList.remove("is-loading"); });',
    '      document.getElementById("prospectList").addEventListener("pointermove", function(event){ var row=event.target.closest(".prospect-row"); if(!row)return; var rect=row.getBoundingClientRect(); row.style.setProperty("--spotlight-x",(event.clientX-rect.left)+"px"); row.style.setProperty("--spotlight-y",(event.clientY-rect.top)+"px"); });',
    '      var csvImportFile = document.getElementById("csvImportFile");',
    '      csvImportFile.addEventListener("change", function() { importerCSVFile(csvImportFile.files && csvImportFile.files[0]); csvImportFile.value = ""; });',
    '      var prospectList = document.getElementById("prospectList");',
    '      prospectList.addEventListener("dragover", function(event) { if (event.dataTransfer && Array.prototype.some.call(event.dataTransfer.types || [], function(type) { return type === "Files"; })) event.preventDefault(); });',
    '      prospectList.addEventListener("drop", function(event) { if (!event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return; event.preventDefault(); importerCSVFile(event.dataTransfer.files[0]); });',
    '      var pipelineBoard = document.getElementById("pipelineBoard");',
    '      pipelineBoard.addEventListener("dragstart", function(event) { var card = event.target.closest("[data-prospect-id]"); if (!card) return; event.dataTransfer.setData("text/plain", card.dataset.prospectId); event.dataTransfer.effectAllowed = "move"; });',
    '      pipelineBoard.addEventListener("dragover", function(event) { var column = event.target.closest("[data-drop-status]"); if (!column) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; });',
    '      pipelineBoard.addEventListener("drop", function(event) { var column = event.target.closest("[data-drop-status]"); if (!column) return; event.preventDefault(); var siren = event.dataTransfer.getData("text/plain"); var status = column.dataset.dropStatus; if (siren && getStatus(siren) !== status) { setProspectStatus(siren, status, false); notify("Statut déplacé vers « " + STATUS_LABELS[status] + " »."); } });',
    '      try { var dataResponse = await apiFetch("/api/data"); if (!dataResponse.ok) throw new Error("Chargement des dossiers refusé"); DATA = await dataResponse.json(); var stateResponse = await apiFetch("/api/state"); if (stateResponse.ok) { var serverState = await stateResponse.json(); state = Object.assign({}, serverState, state); Object.keys(serverState).forEach(function(key){ if (serverState[key] && serverState[key].doNotContact === true) state[key] = Object.assign({}, state[key] || {}, serverState[key]); }); } }',
    '      catch (e) { notify("Chargement impossible : " + e.message); return; }',
    '      Object.keys(state).forEach(function(key){ var entry = state[key] && typeof state[key] === "object" ? state[key] : {}; var savedTel = normalizePhoneInput(entry.tel); var verified = Boolean(savedTel && entry.telVerified === true && securePhoneSource(entry.telSource)); state[key] = Object.assign({}, entry, { tel: verified ? savedTel : "", telVerified: verified, telSource: verified ? entry.telSource : "" }); });',
    '      DATA.forEach(function(p){ var saved = state[p.siren] || {}; if (saved.telVerified) { p.tel = saved.tel; p.telVerified = true; p.telSource = saved.telSource; } if (saved.email) p.email = saved.email; });',
    '      localStorage.setItem("crm_luxury_v3", JSON.stringify(state));',
    '      stateReady = true; updateKpis(); renderList(); if (DATA.length) selectProspect(DATA[0].siren);',
    '      setPreviewMode("desktop");',
    '      setInterval(pollBridgeCommands, 700); setInterval(syncBridgeState, 1200);',
    '      setInterval(function(){ updateKpis(); renderList(); }, 60000);',
    '    }',
    '    initializeApp();',
'  </script>',
'</body>',
'</html>'
].join('\n');

writeAtomic(path.join(ROOT_DIR, 'cockpit_argent.html'), linearHtml);

if (process.argv.includes('--render-only')) {
  console.log('Maquettes et cockpit régénérés sans démarrer le serveur.');
  process.exit(0);
}

function requireApiToken(req, res) {
  const supplied = String(req.headers['x-argent-token'] || '');
  if (supplied.length !== API_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(API_TOKEN))) {
    sendJson(res, 401, { ok: false, error: 'Authentification requise' });
    return false;
  }
  return true;
}

function normalizeBridgeState(input) {
  if (!input || typeof input !== 'object' || !/^\d{9,14}$/.test(String(input.siren || ''))) {
    throw Object.assign(new Error('État du pont invalide'), { statusCode: 400 });
  }
  let publicUrl = '';
  try {
    const parsed = new URL(String(input.urlPublique || ''));
    if (parsed.protocol === 'https:') publicUrl = parsed.href;
  } catch {}
  return {
    siren: String(input.siren),
    nom: normalizedText(input.nom, 160),
    dirigeant: normalizedText(input.dirigeant, 120),
    metier: normalizedText(input.metier, 120),
    ville: normalizedText(input.ville, 120),
    ...verifiedPhoneFields(input.doNotContact === true ? {} : input),
    doNotContact: input.doNotContact === true,
    isMobile: input.doNotContact !== true && /^0[67]/.test(verifiedPhoneFields(input).tel.replace(/\D/g, '')),
    email: normalizedText(input.email, 180),
    slug: validSlug(String(input.slug || '')) ? String(input.slug) : '',
    urlPublique: publicUrl,
    statusLabel: ['À contacter', 'Contacté', 'Chaud 🔥', 'Vendu ✅', 'Refus'].includes(input.statusLabel) ? input.statusLabel : 'À contacter',
    message: input.doNotContact === true ? '' : normalizedText(input.message, 2000),
    payBase: input.doNotContact === true ? '' : (() => { try { const u = new URL(String(input.payBase || "")); return u.protocol === "https:" && (u.hostname === "paypal.me" || u.hostname.endsWith(".paypal.me")) && u.pathname !== "/" ? u.href : ""; } catch { return ""; } })(),
    paymentLinkUrl: input.doNotContact === true || !CrmPolicy.isPayPalMeLink(input.paymentLinkUrl) ? '' : String(input.paymentLinkUrl),
    price: Number(input.price) === 980 ? 980 : 790,
    actionId: input.doNotContact === true ? 0 : (Number.isFinite(Number(input.actionId)) ? Number(input.actionId) : 0),
    actionType: input.doNotContact === true ? '' : (['call', 'wa', 'sms'].includes(input.actionType) ? input.actionType : ''),
    lastSentAt: Number.isFinite(Number(input.lastSentAt)) ? Number(input.lastSentAt) : 0
  };
}

function enqueueBridgeCommand(command) {
  if (PC_QUEUE.length >= 100) throw Object.assign(new Error('File de commandes saturée'), { statusCode: 429 });
  PC_QUEUE.push(command);
}

function vcardEscape(value) {
  return normalizedText(value, 240).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
}

const server = http.createServer(async (req, resHttp) => {
  resHttp.setHeader('X-Content-Type-Options', 'nosniff');
  resHttp.setHeader('Referrer-Policy', 'same-origin');
  resHttp.setHeader('Cache-Control', 'no-store');

  try {
    const host = String(req.headers.host || '').toLowerCase();
    if (!isAllowedHost(host)) {
      resHttp.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      return resHttp.end('Hôte non autorisé');
    }
    if (!requestOriginAllowed(req)) {
      resHttp.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return resHttp.end('Origine non autorisée');
    }
    if (req.method === 'OPTIONS') {
      resHttp.writeHead(405, { Allow: 'GET, POST' });
      return resHttp.end();
    }

    let url;
    try { url = new URL(req.url, 'http://' + host); }
    catch {
      resHttp.writeHead(400);
      return resHttp.end('URL invalide');
    }
    const route = url.pathname;

    if (!isLocalClient(req) && (route === '/iphone' || route.startsWith('/api/')) && !isTrustedLanClient(req)) {
      return sendJson(resHttp, 403, { ok: false, error: 'Connexion autorisée uniquement depuis le réseau local privé' });
    }

    if (route === '/iphone' && req.method === 'GET') {
      resHttp.setHeader('X-Frame-Options', 'DENY');
      resHttp.setHeader('Content-Type', 'text/html; charset=utf-8');
      resHttp.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me https://gemini.google.com");
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'iphone_remote.html')));
    }

    if (route === '/api/pair' && req.method === 'POST') {
      if (!isLocalClient(req) && !req.headers.origin) return sendJson(resHttp, 403, { ok: false, error: 'Origine requise' });
      const ip = req.socket.remoteAddress || 'unknown';
      const attempt = PAIR_ATTEMPTS.get(ip) || { count: 0, expires: Date.now() + 10 * 60 * 1000 };
      if (attempt.expires < Date.now()) { attempt.count = 0; attempt.expires = Date.now() + 10 * 60 * 1000; }
      if (attempt.count >= 5) return sendJson(resHttp, 429, { ok: false, error: 'Trop de tentatives. Réessaie dans 10 minutes.' });
      const body = await readJsonBody(req, 4096);
      const code = String(body.code || '');
      const valid = /^\d{6}$/.test(code) && Date.now() < PAIR_CODE_EXPIRES &&
        crypto.timingSafeEqual(Buffer.from(code), Buffer.from(PAIR_CODE));
      if (!valid) {
        attempt.count++;
        PAIR_ATTEMPTS.set(ip, attempt);
        return sendJson(resHttp, 401, { ok: false, error: 'Code de jumelage incorrect ou expiré' });
      }
      PAIR_ATTEMPTS.delete(ip);
      renewPairCode();
      return sendJson(resHttp, 200, { ok: true, token: API_TOKEN });
    }

    if (route === '/api/net-info' && req.method === 'GET') {
      if (!isLocalClient(req)) return sendJson(resHttp, 403, { ok: false, error: 'Disponible depuis le cockpit local uniquement' });
      if (!requireApiToken(req, resHttp)) return;
      if (Date.now() >= PAIR_CODE_EXPIRES) renewPairCode();
      const nets = localIpv4Addresses().map(ip => ({
        label: 'Wi-Fi / réseau local (' + ip + ')',
        ip,
        url: 'http://' + ip + ':' + PORT + '/iphone'
      }));
      return sendJson(resHttp, 200, {
        nets,
        pairCode: PAIR_CODE,
        expiresAt: PAIR_CODE_EXPIRES,
        iphoneOnline: Date.now() - LAST_IPHONE_PING < 5000
      });
    }

    if (route.startsWith('/api/')) {
      if (!requireApiToken(req, resHttp)) return;
      const desktopOnlyRoutes = ['/api/data', '/api/state', '/api/import-csv', '/api/prospect/add', '/api/pair-code', '/api/bridge-poll-pc', '/api/save-fiche', '/api/enrich-one', '/api/enrich', '/api/validate-site', '/api/surge', '/api/open-folder'];
      if (desktopOnlyRoutes.includes(route) && !isLocalClient(req)) return sendJson(resHttp, 403, { ok: false, error: 'Disponible depuis le cockpit du PC uniquement' });
      if (route === '/api/data' && req.method === 'GET') {
        const safeData = [];
        for (const item of DATA) {
          try { safeData.push(normalizeProspect(item)); } catch {}
        }
        return sendJson(resHttp, 200, safeData);
      }
      if (route === '/api/prospect/add' && req.method === 'POST') {
        const body = await readJsonBody(req, 16 * 1024);
        const suppliedId = String(body.siren || '').replace(/\D/g, '');
        if (!/^\d{9}(?:\d{5})?$/.test(suppliedId)) return sendJson(resHttp, 400, { ok: false, error: 'SIREN ou SIRET invalide.' });
        const siren = suppliedId.slice(0, 9);
        if (DATA.some(item => String(item.siren) === siren)) return sendJson(resHttp, 409, { ok: false, error: 'Cette entreprise existe déjà dans le CRM.' });
        let prospect;
        try {
          const usedSlugs = new Set(DATA.map(item => String(item.slug || '')));
          const slug = createImportedSlug(body.nom, siren, usedSlugs);
          prospect = normalizeProspect(Object.assign({}, body, { siren, slug, urlPublique: '' }));
        } catch (error) {
          return sendJson(resHttp, 422, { ok: false, error: normalizedText(error.message, 200) || 'Fiche invalide.' });
        }
        try {
          fs.mkdirSync(SITES_DIR, { recursive: true });
          writeAtomic(path.join(SITES_DIR, prospect.slug + '.html'), buildLuxurySite(prospect));
          const nextData = [prospect, ...DATA];
          saveProspects(nextData);
          DATA = nextData;
        } catch {
          return sendJson(resHttp, 500, { ok: false, error: 'La fiche ou sa maquette locale n’a pas pu être enregistrée.' });
        }
        return sendJson(resHttp, 201, { ok: true, prospect, total: DATA.length });
      }
      if (route === '/api/state' && req.method === 'GET') {
        return sendJson(resHttp, 200, CRM_STATE);
      }
      if (route === '/api/payment-link' && req.method === 'POST') {
        const body = await readJsonBody(req, 4096);
        const siren = String(body.siren || '');
        const amount = Number(body.amount);
        const purpose = String(body.purpose || '');
        if (!/^\d{9,14}$/.test(siren)) return sendJson(resHttp, 400, { ok: false, error: 'Identifiant de fiche invalide.' });
        if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) return sendJson(resHttp, 400, { ok: false, error: 'Montant de lien invalide.' });
        if (!['deposit', 'installment', 'total'].includes(purpose)) return sendJson(resHttp, 400, { ok: false, error: 'Type de paiement invalide.' });
        if (!DATA.some(item => String(item.siren) === siren)) return sendJson(resHttp, 404, { ok: false, error: 'Fiche introuvable.' });
        if (!isLocalClient(req) && BRIDGE_STATE.siren !== siren) return sendJson(resHttp, 403, { ok: false, error: 'La fiche ne correspond pas au pont iPhone actif.' });
        const current = CRM_STATE[siren] || {};
        if (CrmPolicy.isContactSuppressed(current)) return sendJson(resHttp, 409, { ok: false, error: 'Contact bloqué par la liste de suppression.' });
        const base = isLocalClient(req) ? body.base : BRIDGE_STATE.payBase;
        const paymentLinkUrl = CrmPolicy.buildPayPalMeLink(base, amount);
        if (!paymentLinkUrl) return sendJson(resHttp, 400, { ok: false, error: 'Compte PayPal.me invalide ou non configuré.' });
        const paymentState = Object.assign({}, current, {
          paymentLinkUrl,
          paymentLinkAmount: amount,
          paymentLinkPurpose: purpose,
          paymentLinkCreatedAt: Date.now()
        });
        saveCrmState(Object.assign(Object.create(null), CRM_STATE, { [siren]: paymentState }));
        return sendJson(resHttp, 200, { ok: true, paymentLinkUrl, paymentState: CRM_STATE[siren] });
      }
      if (route === '/api/import-csv' && req.method === 'POST') {
        const body = await readJsonBody(req, 3 * 1024 * 1024);
        if (typeof body.csv !== 'string') return sendJson(resHttp, 400, { ok: false, error: 'Contenu CSV manquant.' });
        let parsed;
        try { parsed = parseCsvTable(body.csv); }
        catch (error) { return sendJson(resHttp, 400, { ok: false, error: normalizedText(error.message, 240) }); }
        const usedSlugs = new Set(DATA.map(item => String(item.slug || '')));
        const validRecords = [];
        const errors = parsed.errors.slice();
        for (const record of parsed.records) {
          try {
            const slug = createImportedSlug(record.nom, record.siren, usedSlugs);
            let urlPublique = '';
            try {
              const candidate = new URL(String(record.urlPublique || ''));
              if (candidate.protocol === 'https:') urlPublique = candidate.href;
            } catch {}
            validRecords.push(normalizeProspect(Object.assign({}, record, {
              slug,
              dept: record.dept || '',
              urlPublique
            })));
          } catch (error) {
            errors.push({ row: record.rowNumber, reason: normalizedText(error.message, 180) });
          }
        }
        if (!validRecords.length) {
          return sendJson(resHttp, 422, { ok: false, error: 'Aucune ligne importable.', added: 0, merged: 0, ambiguous: [], errors });
        }
        const result = mergeImportedProspects(DATA, validRecords);
        if (result.added || result.merged) {
          const newlyAdded = new Set(result.addedSirens);
          for (const prospect of result.prospects) {
            if (newlyAdded.has(String(prospect.siren))) {
              writeAtomic(path.join(SITES_DIR, prospect.slug + '.html'), buildLuxurySite(prospect));
            }
          }
          saveProspects(result.prospects);
          DATA = result.prospects;
        }
        return sendJson(resHttp, 200, {
          ok: true,
          added: result.added,
          merged: result.merged,
          ambiguous: result.ambiguous,
          errors,
          total: DATA.length
        });
      }
      if (route === '/api/pair-code' && req.method === 'POST') {
        if (!isLocalClient(req)) return sendJson(resHttp, 403, { ok: false, error: 'Disponible depuis le cockpit local uniquement' });
        renewPairCode();
        return sendJson(resHttp, 200, { ok: true, pairCode: PAIR_CODE, expiresAt: PAIR_CODE_EXPIRES });
      }
      if (route === '/api/bridge' && req.method === 'GET') {
        LAST_IPHONE_PING = Date.now();
        return sendJson(resHttp, 200, BRIDGE_STATE);
      }
      if (route === '/api/bridge' && req.method === 'POST') {
        BRIDGE_STATE = normalizeBridgeState(await readJsonBody(req, 16 * 1024));
        return sendJson(resHttp, 200, { ok: true });
      }
      if (route === '/api/bridge-cmd' && req.method === 'POST') {
        const body = await readJsonBody(req, 8 * 1024);
        if (body.cmd === 'nav') {
          const dir = Number(body.dir);
          if (dir !== 1 && dir !== -1) return sendJson(resHttp, 400, { ok: false, error: 'Navigation invalide' });
          enqueueBridgeCommand({ type: 'nav', dir });
        } else if (body.cmd === 'qualify') {
          if (!['todo', 'sent', 'hot', 'sold', 'refused'].includes(body.status)) return sendJson(resHttp, 400, { ok: false, error: 'Statut invalide' });
          enqueueBridgeCommand({ type: 'qualify', note: normalizedText(body.note, 500), status: body.status, autoNext: Boolean(body.autoNext) });
        } else if (body.cmd === 'note') {
          enqueueBridgeCommand({ type: 'note', note: normalizedText(body.note, 1000) });
        } else if (body.cmd === 'scenario') {
          if (!['v1', 'v2', 'v3', 'j3', 'j7', 'tarif', '2x', 'fb', 'pj', 'obj_prix', 'obj_temps', 'obj_utilite', 'obj_site', 'stop'].includes(body.value)) return sendJson(resHttp, 400, { ok: false, error: 'Scénario invalide' });
          enqueueBridgeCommand({ type: 'scenario', value: body.value });
        } else if (body.cmd === 'next_phone') {
          enqueueBridgeCommand({ type: 'next_phone' });
        } else {
          return sendJson(resHttp, 400, { ok: false, error: 'Commande inconnue' });
        }
        return sendJson(resHttp, 202, { ok: true });
      }
      if (route === '/api/bridge-poll-pc' && req.method === 'GET') {
        if (!isLocalClient(req)) return sendJson(resHttp, 403, { ok: false, error: 'Disponible depuis le cockpit local uniquement' });
        return sendJson(resHttp, 200, PC_QUEUE.shift() || {});
      }
      if (route === '/api/save-fiche' && req.method === 'POST') {
        const payload = await readJsonBody(req);
        const saved = saveClientFiles(payload.prospect, payload.state);
        return sendJson(resHttp, 200, { ok: true, siren: saved.siren });
      }
      if (route === '/api/enrich-one' && req.method === 'POST') {
        const body = await readJsonBody(req, 4096);
        const siren = String(body.siren || '');
        if (!/^\d{9,14}$/.test(siren)) return sendJson(resHttp, 400, { ok: false, error: 'Identifiant invalide' });
        const prospect = DATA.find(item => String(item.siren) === siren);
        if (!prospect) return sendJson(resHttp, 404, { ok: false, error: 'Dossier introuvable' });
        const plan = await enrichirProspect(prospect);
        return sendJson(resHttp, 200, { ok: true, ...plan, plan, message: plan.summary });
      }
      if (route === '/api/enrich' && req.method === 'POST') {
        const body = await readJsonBody(req, 4096).catch(() => ({}));
        const limit = Number(body.limit || 15);
        return sendJson(resHttp, 200, await enrichirBatch(limit));
      }
      if (route === '/api/validate-site' && req.method === 'POST') {
        const body = await readJsonBody(req, 4096);
        const siren = String(body.siren || '');
        if (!/^\d{9,14}$/.test(siren)) return sendJson(resHttp, 400, { ok: false, error: 'Identifiant invalide' });
        const item = DATA.find(prospect => String(prospect.siren) === siren);
        if (!item) return sendJson(resHttp, 404, { ok: false, error: 'Dossier introuvable' });
        let result;
        try {
          result = validateGeneratedSite(buildLuxurySite(item), fs.existsSync(path.join(ROOT_DIR, 'argent_ui.css')));
        } catch {
          return sendJson(resHttp, 422, { ok: false, errors: ['invalid_prospect'] });
        }
        return sendJson(resHttp, result.ok ? 200 : 422, result);
      }
      if (route === '/api/surge' && req.method === 'POST') {
        const deployDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argent-deploy-'));
        let generated = 0;
        const publishedProspects = [];
        const failures = [];
        try {
          for (const item of DATA) {
            try {
              const prospect = normalizeProspect(item);
              if (!CRM_STATE[prospect.siren] || CRM_STATE[prospect.siren].publishApproved !== true) continue;
              const html = buildLuxurySite(prospect);
              const validation = validateGeneratedSite(html, fs.existsSync(path.join(ROOT_DIR, 'argent_ui.css')));
              if (!validation.ok) {
                failures.push({ siren: prospect.siren, errors: validation.errors });
                continue;
              }
              writeAtomic(path.join(deployDir, prospect.slug + '.html'), html);
              publishedProspects.push({ siren: prospect.siren, slug: prospect.slug });
              generated++;
            } catch {
              failures.push({ siren: String(item && item.siren || ''), errors: ['invalid_prospect'] });
            }
          }
          if (generated) fs.copyFileSync(path.join(ROOT_DIR, 'argent_ui.css'), path.join(deployDir, 'argent_ui.css'));
        } catch (error) {
          fs.rmSync(deployDir, { recursive: true, force: true });
          return sendJson(resHttp, 500, { ok: false, error: 'Préparation de la publication impossible' });
        }
        if (failures.length) {
          fs.rmSync(deployDir, { recursive: true, force: true });
          return sendJson(resHttp, 422, { ok: false, error: 'Publication bloquée : la prévalidation de ' + failures.length + ' fiche(s) a échoué.', failures });
        }
        if (!generated) {
          fs.rmSync(deployDir, { recursive: true, force: true });
          return sendJson(resHttp, 400, { ok: false, error: 'Aucune fiche autorisée et valide à publier' });
        }
        const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npx';
        const args = process.platform === 'win32'
          ? ['/d', '/s', '/c', 'npx.cmd --yes surge "' + deployDir + '" ' + DOMAINE]
          : ['--yes', 'surge', deployDir, DOMAINE];
        return execFile(command, args, {
          cwd: ROOT_DIR, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024
        }, (error, stdout, stderr) => {
          try { fs.rmSync(deployDir, { recursive: true, force: true }); } catch {}
          if (error) return sendJson(resHttp, 502, { ok: false, error: 'Publication échouée : ' + error.message });
          const publishedAt = Date.now();
          const nextState = Object.assign(Object.create(null), CRM_STATE);
          for (const prospect of publishedProspects) {
            nextState[prospect.siren] = Object.assign({}, nextState[prospect.siren] || {}, {
              publishedAt,
              publishedUrl: 'https://' + DOMAINE + '/' + prospect.slug + '.html'
            });
          }
          try { saveCrmState(nextState); }
          catch (saveError) {
            console.error('Publication Surge réussie mais le journal CRM n’a pas pu être mis à jour:', saveError.message);
            return sendJson(resHttp, 500, { ok: false, deployed: true, error: 'Publication réussie, mais le statut n’a pas pu être enregistré dans le CRM.' });
          }
          return sendJson(resHttp, 200, {
            ok: true,
            published: generated,
            url: 'https://' + DOMAINE,
            sites: publishedProspects.map(prospect => ({ siren: prospect.siren, url: 'https://' + DOMAINE + '/' + prospect.slug + '.html', publishedAt })),
            output: String(stdout || stderr || '').slice(0, 4000)
          });
        });
      }
      if (route === '/api/open-folder' && req.method === 'POST') {
        if (process.platform !== 'win32') return sendJson(resHttp, 501, { ok: false, error: 'Fonction disponible sous Windows uniquement' });
        return execFile('explorer.exe', [ROOT_DIR], { windowsHide: true }, error => {
          if (error) return sendJson(resHttp, 500, { ok: false, error: 'Impossible d’ouvrir le dossier' });
          return sendJson(resHttp, 200, { ok: true });
        });
      }
      if (route === '/api/vcard' && req.method === 'GET') {
        const siren = url.searchParams.get('siren') || '';
        if (!/^\d{9,14}$/.test(siren)) return sendJson(resHttp, 400, { ok: false, error: 'Identifiant invalide' });
        const prospect = DATA.find(item => String(item.siren) === siren);
        if (!isLocalClient(req) && BRIDGE_STATE.siren !== siren) return sendJson(resHttp, 403, { ok: false, error: "Disponible pour la fiche active uniquement" });
        const person = prospect || (BRIDGE_STATE.siren === siren ? BRIDGE_STATE : null);
        if (!person) return sendJson(resHttp, 404, { ok: false, error: 'Contact introuvable' });
        const vcf = [
          'BEGIN:VCARD', 'VERSION:3.0',
          'FN:' + vcardEscape(person.nom || 'Artisan'),
          'ORG:' + vcardEscape(person.nom || ''),
          'TITLE:' + vcardEscape(person.metier || 'Artisan'),
          'TEL;TYPE=CELL,VOICE:' + vcardEscape((person.tel || '').replace(/\s+/g, '')),
          'EMAIL:' + vcardEscape(person.email || ''),
          'URL:' + vcardEscape(person.urlPublique || ''),
          'NOTE:SIREN ' + vcardEscape(person.siren || ''),
          'END:VCARD'
        ].join('\r\n');
        resHttp.writeHead(200, {
          'Content-Type': 'text/vcard; charset=utf-8',
          'Content-Disposition': 'attachment; filename="artisan_' + siren + '.vcf"'
        });
        return resHttp.end(vcf);
      }
      resHttp.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return resHttp.end(JSON.stringify({ ok: false, error: 'Route API inconnue' }));
    }

    if (route === '/data.js') {
      resHttp.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return resHttp.end('La route publique data.js a été désactivée.');
    }

    if (route === '/argent_ui.css' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/css; charset=utf-8');
      resHttp.setHeader('Cache-Control', 'public, max-age=3600');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'argent_ui.css')));
    }

    if (route === '/qrious.js' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      resHttp.setHeader('Cache-Control', 'public, max-age=86400');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'node_modules', 'qrious', 'dist', 'qrious.min.js')));
    }

    if (route === '/sales_insights.js' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'sales_insights.js')));
    }

    if (route === '/finance_reporting.js' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      resHttp.setHeader('Cache-Control', 'no-store');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'finance_reporting.js')));
    }

    if (route === '/sales_playbook.js' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      resHttp.setHeader('Cache-Control', 'no-store');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'sales_playbook.js')));
    }

    if (route === '/crm_policy.js' && req.method === 'GET') {
      resHttp.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      resHttp.setHeader('Cache-Control', 'no-store');
      return resHttp.end(fs.readFileSync(path.join(ROOT_DIR, 'crm_policy.js')));
    }

    if (route.startsWith('/sites/')) {
      if (!isLocalClient(req) || req.headers['sec-fetch-site'] === 'cross-site') {
        resHttp.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return resHttp.end('Accès local uniquement');
      }
      const match = route.match(/^\/sites\/([a-z0-9]+(?:-[a-z0-9]+)*)\.html$/);
      if (!match) {
        resHttp.writeHead(404);
        return resHttp.end('Page introuvable');
      }
      const filePath = path.resolve(SITES_DIR, match[1] + '.html');
      if (!filePath.startsWith(SITES_DIR + path.sep) || !fs.existsSync(filePath) || !DATA.some(item => item && String(item.slug) === match[1])) {
        resHttp.writeHead(404);
        return resHttp.end('Page introuvable');
      }
      resHttp.setHeader('Content-Type', 'text/html; charset=utf-8');
      resHttp.setHeader('X-Frame-Options', 'SAMEORIGIN');
      return resHttp.end(fs.readFileSync(filePath));
    }

    if (route === '/' && req.method === 'GET') {
      if (!isLocalClient(req)) {
        resHttp.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return resHttp.end('Le cockpit est accessible uniquement depuis cet ordinateur.');
      }
      const page = fs.readFileSync(path.join(ROOT_DIR, 'cockpit_argent.html'), 'utf8')
        .replace('__ARGENT_API_TOKEN__', API_TOKEN);
      resHttp.setHeader('Content-Type', 'text/html; charset=utf-8');
      resHttp.setHeader('X-Frame-Options', 'DENY');
      resHttp.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://wa.me https://gemini.google.com");
      return resHttp.end(page);
    }

    resHttp.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return resHttp.end('Page introuvable');
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (!resHttp.headersSent) return sendJson(resHttp, status, { ok: false, error: status === 500 ? 'Erreur interne du serveur' : error.message });
    resHttp.destroy();
  }
});

let shuttingDown = false;
function backupAndShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    snapshotCrmState(CRM_STATE, BACKUPS_DIR);
  } catch (error) {
    console.error('Sauvegarde de fermeture impossible:', error.message);
  }
  if (!server.listening) return process.exit(0);
  const forceExit = setTimeout(() => process.exit(1), 5000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on('SIGINT', backupAndShutdown);
process.on('SIGTERM', backupAndShutdown);
if (process.platform === 'win32') process.on('SIGBREAK', backupAndShutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Kynext prêt en local sur http://127.0.0.1:' + PORT + ' ; jumelage iPhone par code temporaire.');
});
