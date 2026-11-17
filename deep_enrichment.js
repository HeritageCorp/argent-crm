function normalizeFrenchPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  let national = digits;
  if (/^0033[1-9]\d{8}$/.test(digits)) national = '0' + digits.slice(4);
  else if (/^33[1-9]\d{8}$/.test(digits)) national = '0' + digits.slice(2);
  return /^0[1-9]\d{8}$/.test(national) ? national : '';
}

function getPhoneQuality(raw) {
  const phone = normalizeFrenchPhone(raw);
  if (!phone) return { kind: 'missing', label: 'Aucun numéro vérifié' };
  if (/^0[67]\d{8}$/.test(phone)) return { kind: 'mobile', label: 'Mobile professionnel vérifié' };
  if (/^0[1-5]\d{8}$/.test(phone)) return { kind: 'landline', label: 'Ligne fixe professionnelle vérifiée' };
  if (/^0[89]\d{8}$/.test(phone)) return { kind: 'special', label: 'Ligne spéciale — pas de WhatsApp' };
  return { kind: 'ambiguous', label: 'Format à vérifier' };
}

function buildSourceCatalog(prospect = {}) {
  const name = String(prospect.nom || '').trim();
  const city = String(prospect.ville || '').trim();
  const dept = String(prospect.dept || '').trim();
  const metier = String(prospect.metier || '').trim();
  const address = String(prospect.adresse || '').trim();
  const place = [address, city, dept].filter(Boolean).join(' ');

  return [
    {
      id: 'official_business_site',
      label: 'Site officiel · contact / mentions légales',
      priority: 1,
      authority: 'official_business_source',
      phoneSource: true,
      note: 'Vérifie que le numéro apparaît sur le site de cette entreprise et correspond au bon établissement.',
      query: [name, place, metier, 'site officiel contact téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'google_business_profile',
      label: 'Google Business Profile · fiche d’entreprise',
      priority: 2,
      authority: 'public_business_profile',
      phoneSource: true,
      note: 'Confirme le nom commercial, la ville et le téléphone public de la fiche professionnelle.',
      query: [name, place, metier, 'Google Maps téléphone entreprise'].filter(Boolean).join(' ')
    },
    {
      id: 'pages_jaunes',
      label: 'Pages Jaunes · fiche professionnelle',
      priority: 3,
      authority: 'public_business_directory',
      phoneSource: true,
      note: 'Utilise la fiche entreprise et vérifie l’adresse avant de retenir le téléphone.',
      query: ['site:pagesjaunes.fr/pros', name, place, metier, 'téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'municipal_directory',
      label: 'Annuaire municipal ou consulaire',
      priority: 4,
      authority: 'public_directory',
      phoneSource: true,
      note: 'Cherche une fiche publiée par la mairie ou la chambre des métiers de la commune.',
      query: [name, place, metier, 'annuaire mairie chambre des métiers téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'artisan_certification',
      label: 'Qualibat · CAPEB · FFB',
      priority: 5,
      authority: 'professional_directory',
      phoneSource: true,
      note: 'Vérifie l’identité professionnelle et les coordonnées publiées par l’organisme.',
      query: [name, place, 'Qualibat OR CAPEB OR FFB téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'mappy_business',
      label: 'Mappy · fiche d’entreprise',
      priority: 6,
      authority: 'public_business_directory',
      phoneSource: true,
      note: 'Croise la fiche d’établissement et son adresse avec les autres sources publiques.',
      query: ['site:mappy.com', name, place, metier, 'téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'building_trade_directory',
      label: 'Annuaire professionnel du bâtiment',
      priority: 7,
      authority: 'public_business_directory',
      phoneSource: true,
      note: 'Utilise une page entreprise publiée par un annuaire professionnel du bâtiment.',
      query: [name, place, metier, 'Habitatpresto OR Travaux.com téléphone entreprise'].filter(Boolean).join(' ')
    },
    {
      id: 'directory_118000',
      label: '118000 · fiche entreprise',
      priority: 8,
      authority: 'public_business_directory',
      phoneSource: true,
      note: 'Vérifie le téléphone de la fiche entreprise et l’adresse correspondante.',
      query: ['site:118000.fr', name, place, metier, 'téléphone'].filter(Boolean).join(' ')
    },
    {
      id: 'sirene_identity',
      label: 'Annuaire des entreprises · identité et adresse',
      priority: 9,
      authority: 'identity_only',
      phoneSource: false,
      note: 'Sert à confirmer la raison sociale, le SIREN et l’établissement; ne prouve pas un numéro de téléphone.',
      query: [name, place, 'site:annuaire-entreprises.data.gouv.fr'].filter(Boolean).join(' ')
    }
  ];
}

function buildPhoneCandidates(prospect = {}) {
  const source = String(prospect.telSource || prospect.phoneSource || '');
  const sourceIsSecure = /^https:\/\/[^\s]+$/i.test(source);
  const current = prospect.telVerified === true && sourceIsSecure
    ? normalizeFrenchPhone(prospect.tel || prospect.telephone || prospect.phone)
    : '';
  const candidateTypes = [
    { type: 'mobile', label: 'Mobile professionnel', reason: 'Numéro mobile confirmé sur la source enregistrée.', pattern: /^0[67]/ },
    { type: 'fixed_line', label: 'Ligne fixe professionnelle', reason: 'Numéro fixe confirmé sur la source enregistrée.', pattern: /^0[1-5]/ },
    { type: 'special', label: 'Ligne spéciale', reason: 'Ne pas utiliser pour WhatsApp ou comme téléphone direct.', pattern: /^0[89]/ }
  ];

  return candidateTypes.map((candidate) => {
    const available = Boolean(current) && candidate.pattern.test(current);
    return {
    ...candidate,
    available,
    verified: available,
    value: available ? current : ''
    };
  });
}

function buildDeepEnrichmentPlan(prospect = {}) {
  const name = String(prospect.nom || '').trim();
  const city = String(prospect.ville || '').trim();
  const dept = String(prospect.dept || '').trim();
  const metier = String(prospect.metier || '').trim();
  const dirigeant = String(prospect.dirigeant || '').trim();
  const source = String(prospect.telSource || prospect.phoneSource || '');
  const verifiedPhone = prospect.telVerified === true && /^https:\/\/[^\s]+$/i.test(source);
  const currentPhone = verifiedPhone ? normalizeFrenchPhone(prospect.tel || prospect.telephone || prospect.phone) : '';
  const currentMail = String(prospect.email || '').trim();
  const currentWebsite = String(prospect.urlPublique || prospect.site || '').trim();
  const phoneQuality = getPhoneQuality(currentPhone);
  const sources = buildSourceCatalog(prospect);
  const phoneCandidates = buildPhoneCandidates(prospect);

  const completeness = {
    present: [Boolean(currentPhone), Boolean(currentMail), Boolean(currentWebsite), Boolean(city), Boolean(metier)].filter(Boolean).length,
    total: 5,
    missing: [
      !currentPhone ? 'Téléphone professionnel vérifié' : '',
      !currentMail ? 'E-mail professionnel public' : '',
      !currentWebsite ? 'Site officiel' : '',
      !city ? 'Ville' : '',
      !metier ? 'Métier' : ''
    ].filter(Boolean)
  };

  const plan = {
    ok: true,
    dryRun: true,
    completeness,
    requiresManualReview: !currentPhone,
    summary: currentPhone
      ? `Un numéro professionnel vérifié est enregistré pour ${name || 'cette entreprise'}.`
      : `Aucun numéro professionnel n’est confirmé pour ${name || 'cette entreprise'}; vérification manuelle requise.`,
    phoneState: phoneQuality,
    phoneCandidates,
    contactReadiness: {
      phone: Boolean(currentPhone),
      email: Boolean(currentMail),
      website: Boolean(currentWebsite),
      hasDirector: Boolean(dirigeant)
    },
    sourceOrder: sources.map(source => source.id),
    sources,
    searchPlan: sources.map((source) => ({
      id: source.id,
      label: source.label,
      priority: source.priority,
      authority: source.authority,
      phoneSource: source.phoneSource,
      query: source.query,
      note: source.note
    })),
    evidenceChecklist: [
      'Le nom, l’adresse et l’activité doivent correspondre à la même entreprise.',
      'La page source doit afficher ce numéro comme coordonnées professionnelles publiques.',
      'Enregistrer l’URL exacte de la source consultée.',
      'Ne jamais déduire, compléter ou deviner les chiffres manquants.'
    ],
    actions: [
      'Ouvrir une source professionnelle publique et vérifier l’identité de l’établissement.',
      'Saisir le numéro exactement comme publié, puis confirmer sa vérification.',
      'Garder le dossier dans la file manuelle si aucune source fiable ne le publie.'
    ]
  };

  if (!name) {
    plan.summary = 'Aucune fiche de prospect n’a été fournie. Le moteur de recherche local ne peut pas produire de plan exploitable.';
    plan.requiresManualReview = true;
  }

  return plan;
}

module.exports = {
  normalizeFrenchPhone,
  getPhoneQuality,
  buildDeepEnrichmentPlan,
  buildSourceCatalog,
  buildPhoneCandidates
};
