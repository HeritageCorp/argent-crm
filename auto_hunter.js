const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'generated');
const DEPTS_CIBLES = process.argv[2] || '';
const METIERS = [
  { label: 'Plombier Chauffagiste', naf: '43.22A' },
  { label: 'Électricien Général', naf: '43.21A' },
  { label: 'Peintre & Décorateur', naf: '43.34Z' },
  { label: 'Menuisier Agenceur', naf: '43.32A' }
];
const BLACKLIST = ['CHUBB', 'EIFFAGE', 'CONSTRUCTEL', 'SNEF', 'ENGIE', 'VINCI', 'BOUYGUES', 'SPIE', 'REXEL', 'SONEPAR', 'VEOLIA', 'SUEZ', 'GROUPE', 'HOLDING', 'FRANCE', 'SYSTEMES'];

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(sarl|eurl|sas|sasu|sa|entreprise|ets|etablissements)\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function csvCell(value) {
  return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

function buildCandidateCsv(prospects) {
  const headers = ['siren', 'nom', 'dirigeant', 'metier', 'ville', 'dept', 'adresse', 'telephone', 'telephone_verifie', 'source_telephone', 'site', 'notes'];
  const lines = [headers.map(csvCell).join(';')];
  for (const prospect of prospects) {
    lines.push([
      prospect.siren, prospect.nom, prospect.dirigeant, prospect.metier, prospect.ville,
      prospect.dept, prospect.adresse, '', 'false', '', '',
      prospect.note
    ].map(csvCell).join(';'));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function loadExistingSirens() {
  const dataPath = path.join(ROOT, 'data.js');
  if (!fs.existsSync(dataPath)) return new Set();
  const raw = fs.readFileSync(dataPath, 'utf8')
    .replace(/^\uFEFF?window\.PROSPECTS_DATA\s*=\s*/, '')
    .replace(/;\s*$/, '');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('data.js ne contient pas une liste de fiches valide.');
  return new Set(parsed.map(prospect => String(prospect.siren || '')).filter(Boolean));
}

async function hasLikelyWebsite(name, city) {
  const base = slugify(name).replace(/-/g, '');
  const dashed = slugify(name);
  const citySlug = slugify(city);
  if (base.length < 3) return false;
  const domains = [base + '.fr', dashed + '.fr', base + '.com', base + '-' + citySlug + '.fr'];
  for (const domain of domains) {
    try {
      await dns.lookup(domain);
      return true;
    } catch (error) {
      if (error.code !== 'ENOTFOUND' && error.code !== 'ENODATA') throw error;
    }
  }
  return false;
}

async function runHunter() {
  const existingSirens = loadExistingSirens();
  const candidates = [];
  const page = Math.floor(Math.random() * 8) + 1;
  console.log('Recherche de candidats depuis l’API officielle Recherche Entreprises (page ' + page + ').');

  for (const trade of METIERS) {
    const deptParam = DEPTS_CIBLES ? '&departement=' + encodeURIComponent(DEPTS_CIBLES) : '';
    const apiUrl = 'https://recherche-entreprises.api.gouv.fr/search?activite_principale=' +
      encodeURIComponent(trade.naf) + '&etat_administratif=A&per_page=25&page=' + page + deptParam;
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        console.error('Recherche échouée pour ' + trade.label + ' : HTTP ' + response.status);
        continue;
      }
      const result = await response.json();
      for (const company of result.results || []) {
        const siren = String(company.siren || '');
        const name = String(company.nom_complet || company.nom_raison_sociale || '').trim();
        if (!/^\d{9}$/.test(siren) || !name || existingSirens.has(siren)) continue;
        if (BLACKLIST.some(entry => name.toUpperCase().includes(entry))) continue;

        const headquarters = company.siege || {};
        const city = String(headquarters.libelle_commune || '').trim();
        if (!city) continue;
        if (await hasLikelyWebsite(name, city)) continue;

        const director = (company.dirigeants || [])[0];
        candidates.push({
          siren,
          nom: name,
          dirigeant: director ? ((director.prenoms || '') + ' ' + (director.nom || '')).trim() : '',
          metier: trade.label,
          ville: city,
          dept: String(headquarters.departement || (headquarters.code_postal || '').slice(0, 2)),
          adresse: String(headquarters.adresse || ''),
          note: 'Candidat issu de l’API Recherche Entreprises; détection DNS indicative seulement. Vérifier manuellement l’entreprise et son site avant import.'
        });
        existingSirens.add(siren);
      }
    } catch (error) {
      console.error('Recherche impossible pour ' + trade.label + ' : ' + error.message);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(OUTPUT_DIR, 'hunter-candidates-' + stamp + '.csv');
  const temporaryPath = outputPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporaryPath, buildCandidateCsv(candidates), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporaryPath, outputPath);
  console.log(candidates.length + ' candidat(s) exporté(s) vers ' + path.relative(ROOT, outputPath) + '. data.js et les maquettes n’ont pas été modifiés.');
  return outputPath;
}

if (require.main === module) {
  runHunter().catch(error => {
    console.error('Auto Hunter interrompu : ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildCandidateCsv, loadExistingSirens, runHunter };
