function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function chooseDelimiter(line) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && Object.prototype.hasOwnProperty.call(counts, line[i])) {
      counts[line[i]]++;
    }
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
}

function parseCsvTable(input, { maxRows = 3000 } = {}) {
  const text = String(input || '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Le fichier CSV est vide.');

  const firstLine = text.split(/\r\n|\n|\r/, 1)[0];
  const delimiter = chooseDelimiter(firstLine);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows + 1) throw new Error('Le fichier dépasse la limite de ' + maxRows + ' lignes.');
    } else {
      cell += char;
    }
  }

  if (quoted) throw new Error('Le fichier CSV contient une cellule entre guillemets incomplète.');
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('Le fichier CSV ne contient aucune fiche.');

  const aliases = {
    siren: ['siren', 'siret', 'siren_siret', 'id', 'identifiant'],
    nom: ['nom', 'entreprise', 'raison_sociale', 'company', 'name'],
    dirigeant: ['dirigeant', 'contact', 'responsable', 'manager'],
    metier: ['metier', 'activite', 'activite_principale', 'profession', 'trade'],
    ville: ['ville', 'commune', 'city'],
    dept: ['dept', 'departement', 'department'],
    tel: ['telephone', 'tel', 'phone', 'mobile'],
    telVerified: ['telephone_verifie', 'tel_verified', 'phone_verified'],
    telSource: ['source_telephone', 'tel_source', 'phone_source', 'source'],
    email: ['email', 'e_mail', 'courriel', 'mail'],
    adresse: ['adresse', 'address'],
    urlPublique: ['site', 'url', 'site_web', 'website'],
    note: ['note', 'notes', 'commentaire', 'comments']
  };
  const headers = rows[0].map(normalizeHeader);
  const indexes = {};
  for (const [field, candidates] of Object.entries(aliases)) {
    indexes[field] = headers.findIndex(header => candidates.includes(header));
  }
  if (indexes.siren === -1 || indexes.nom === -1 || indexes.ville === -1 || indexes.metier === -1) {
    throw new Error('Colonnes obligatoires manquantes : SIREN/SIRET, nom, ville et métier.');
  }

  const records = [];
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const get = field => indexes[field] < 0 ? '' : String(values[indexes[field]] || '').trim();
    const companyId = get('siren').replace(/\D/g, '');
    const siren = companyId.length === 14 ? companyId.slice(0, 9) : companyId;
    const nom = get('nom');
    const ville = get('ville');
    const metier = get('metier');
    if (!/^\d{9}(?:\d{5})?$/.test(companyId) || !nom || !ville || !metier) {
      errors.push({ row: i + 1, reason: 'Identifiant, nom, ville ou métier invalide.' });
      continue;
    }
    const verifiedValue = get('telVerified').toLowerCase();
    records.push({
      rowNumber: i + 1,
      siren,
      nom,
      dirigeant: get('dirigeant'),
      metier,
      ville,
      dept: get('dept'),
      tel: get('tel'),
      telVerified: ['1', 'true', 'oui', 'yes'].includes(verifiedValue),
      telSource: get('telSource'),
      email: get('email'),
      adresse: get('adresse'),
      urlPublique: get('urlPublique'),
      note: get('note')
    });
  }
  return { records, errors };
}

function normalizeIdentity(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function mergeImportedProspects(existing, imported) {
  const prospects = existing.map(item => Object.assign({}, item));
  const mergedIds = new Set();
  const addedIds = new Set();
  const ambiguous = [];

  for (const incoming of imported) {
    const duplicate = prospects.find(item => String(item.siren) === String(incoming.siren));
    if (duplicate) {
      const fillFields = ['dirigeant', 'metier', 'ville', 'dept', 'email', 'adresse', 'urlPublique'];
      for (const field of fillFields) {
        if (!duplicate[field] && incoming[field]) duplicate[field] = incoming[field];
      }
      if (!duplicate.telVerified && incoming.telVerified && incoming.tel && incoming.telSource) {
        duplicate.tel = incoming.tel;
        duplicate.telVerified = true;
        duplicate.telSource = incoming.telSource;
        duplicate.isMobile = Boolean(incoming.isMobile);
      }
      if (incoming.note && !String(duplicate.note || '').includes(incoming.note)) {
        duplicate.note = [duplicate.note, incoming.note].filter(Boolean).join(' | ').slice(0, 500);
      }
      mergedIds.add(String(incoming.siren));
      continue;
    }

    const sameNameAndCity = prospects.find(item =>
      normalizeIdentity(item.nom) === normalizeIdentity(incoming.nom) &&
      normalizeIdentity(item.ville) === normalizeIdentity(incoming.ville)
    );
    if (sameNameAndCity) {
      ambiguous.push({
        siren: String(incoming.siren),
        existingSiren: String(sameNameAndCity.siren),
        reason: 'Même nom et même ville, mais identifiant différent : vérification manuelle requise.'
      });
      continue;
    }

    prospects.push(incoming);
    addedIds.add(String(incoming.siren));
  }

  return {
    prospects,
    added: addedIds.size,
    merged: mergedIds.size,
    addedSirens: Array.from(addedIds),
    ambiguous
  };
}

module.exports = { parseCsvTable, mergeImportedProspects };
