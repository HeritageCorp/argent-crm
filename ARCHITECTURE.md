# Kynext — architecture cible

État observé le 16 novembre 2026. Ce document fixe la structure de destination et le chemin pour l’atteindre sans casser le lanceur Windows existant.

## État actuel

- `ARGENT_Cockpit.exe` démarre le serveur Node local sur le port `3001`.
- `server_argent.js` regroupe le serveur HTTP, ses routes, le rendu de l’interface, le générateur de sites et plusieurs règles métier.
- `data.js` contient 164 fiches. Onze téléphones ont une source HTTPS enregistrée; les 153 autres restent sans numéro.
- `dossiers_clients/crm_state.json` contient les statuts et événements CRM locaux.
- `sites/` contient les maquettes générées; `cockpit_argent.html` est le cockpit rendu; `iphone_remote.html` est le client iPhone.
- `deep_enrichment.js`, `finance_reporting.js`, `payment_state.js`, `sales_insights.js` et `site_validation.js` sont déjà des modules séparés.
- `auto_hunter.js` est un outil autonome, absent de `npm start`. Il ne doit pas devenir une seconde source de rendu ou de vérité.
- Le dossier n’a pas de dépôt Git. Les données CRM et les maquettes contenant des données d’entreprises ne doivent pas être envoyées dans un dépôt public.

## Structure exacte visée

```text
ARGENT/
├── ARGENT_Cockpit.exe                 # Lanceur Windows conservé
├── server_argent.js                   # Entrée de compatibilité : appelle src/server/index.js
├── package.json
├── package-lock.json
├── .gitignore
├── .env.example                       # Noms de variables seulement, jamais de secrets
├── src/
│   ├── server/
│   │   ├── index.js                   # Création HTTP et démarrage
│   │   ├── routes/
│   │   │   ├── cockpit.js
│   │   │   ├── crm.js
│   │   │   ├── enrichment.js
│   │   │   ├── bridge.js
│   │   │   ├── sites.js
│   │   │   └── payments.js
│   │   └── security/
│   │       ├── origin.js
│   │       ├── local-network.js
│   │       └── api-token.js
│   ├── domain/                        # Règles pures, sans HTTP ni accès disque
│   │   ├── prospect.js
│   │   ├── phone.js
│   │   ├── crm-state.js
│   │   ├── enrichment-plan.js
│   │   ├── payment-state.js
│   │   └── sales-funnel.js
│   ├── services/                      # Cas d’usage orchestrant domaine et adaptateurs
│   │   ├── prospect-service.js
│   │   ├── enrichment-service.js
│   │   ├── site-service.js
│   │   ├── bridge-service.js
│   │   ├── payment-service.js
│   │   └── reporting-service.js
│   ├── adapters/
│   │   ├── storage/
│   │   │   ├── prospect-store.js
│   │   │   └── crm-store.js
│   │   └── providers/
│   │       ├── entreprises-api.js
│   │       ├── paypal-checkout.js
│   │       └── email-delivery.js
│   ├── ui/
│   │   ├── cockpit/                   # Source HTML/JS du cockpit
│   │   ├── iphone/                    # Client du pont iPhone
│   │   └── sites/                     # Gabarits de maquettes
│   └── jobs/
│       └── follow-up-reminders.js     # Rappels internes; aucun envoi implicite
├── data/                              # Données locales, exclues de Git
│   ├── prospects.json
│   ├── crm_state.json
│   └── backups/
├── public/
│   ├── argent_ui.css
│   └── assets/
├── generated/                         # Sorties recalculables, exclues de Git
│   ├── cockpit/index.html
│   └── sites/
├── scripts/
│   ├── build-css.ps1
│   ├── migrate-data.js
│   └── import-enterprises.js           # Import contrôlé, sans collecte de téléphone
├── packaging/
│   └── windows/ArgentLauncher.cs
├── tests/                             # Tests existants, rangés par module
│   ├── domain/
│   ├── services/
│   └── integration/
└── docs/
    ├── RUNBOOK.md
    ├── DATA_POLICY.md
    └── DEPLOYMENT.md
```

## Dépendances entre couches

```text
Routes HTTP → Services → Domain
                    ↘ Adapters de stockage / fournisseurs
UI → API locale → Services
Jobs → Services
```

Le domaine ne dépend ni du navigateur, ni de Node HTTP, ni d’un fournisseur. Les routes valident l’entrée et l’authentification; les services exécutent les cas d’usage; les adaptateurs sont les seuls modules qui parlent au disque, à l’API Entreprises, à PayPal ou au fournisseur e-mail.

## Correspondance entre fichiers actuels et cible

| Aujourd’hui | Destination |
|---|---|
| Règles de téléphone dans `server_argent.js` et `deep_enrichment.js` | `src/domain/phone.js` et `src/domain/enrichment-plan.js` |
| Normalisation des fiches et du CRM dans `server_argent.js` | `src/domain/prospect.js`, `src/domain/crm-state.js`, `src/adapters/storage/` |
| `payment_state.js`, `finance_reporting.js` | `src/domain/payment-state.js`, `src/services/reporting-service.js` |
| `site_validation.js` et génération dans `server_argent.js` | `src/services/site-service.js`, `src/ui/sites/` |
| Routes et pont dans `server_argent.js` | `src/server/routes/` et `src/services/bridge-service.js` |
| `iphone_remote.html` | `src/ui/iphone/index.html` |
| `data.js`, `dossiers_clients/crm_state.json` | `data/prospects.json`, `data/crm_state.json` |
| `cockpit_argent.html`, `sites/` | `generated/cockpit/`, `generated/sites/` |
| `ArgentLauncher.cs` | `packaging/windows/ArgentLauncher.cs` |
| Scripts `setup_*`, `upgrade_*`, `fix_*` | `scripts/migrations/legacy/` après archivage et vérification de leur utilité |

## Règles de données et d’envoi

1. Un téléphone utilisable doit être français, accompagné d’une URL publique HTTPS et confirmé par une personne. Une recherche ne remplit jamais le numéro.
2. Un mobile non vérifié ne peut pas alimenter WhatsApp, les liens de paiement ni le pont iPhone.
3. Une opposition ou un refus doit bloquer les prochaines relances sur tous les canaux.
4. `data/`, `generated/`, sauvegardes, `.env` et secrets sont exclus du dépôt Git. Seuls le code, les gabarits génériques, les migrations et les exemples anonymisés sont versionnés.
5. Un statut « payé » n’est automatique qu’après vérification d’un événement signé du prestataire. Les données de carte ne sont jamais stockées par Kynext.
6. Toute publication publique reste bloquée tant que la fiche concernée n’a pas son autorisation explicite.

## Ordre de migration

1. Créer le dépôt privé, `.gitignore` et les sauvegardes locales; ne pas y importer les prospects.
2. Extraire les modules métier purs sans changer les routes ni les fichiers de données.
3. Déplacer les routes, services et gabarits; conserver `server_argent.js` comme lanceur compatible avec l’EXE.
4. Migrer `data.js` vers `data/prospects.json` par script idempotent avec sauvegarde avant écriture.
5. Déplacer les sorties vers `generated/` et les sources de styles vers `public/`; mettre à jour le lanceur et le build CSS.
6. Déployer une version HTTPS avec sauvegardes, journal d’événements et procédure de retour arrière.
7. Ajouter seulement ensuite le paiement avec notifications vérifiées et l’envoi e-mail avec opposition/suppression intégrée.

## Seuils de mise en production

- Le démarrage local, les routes CRM et le jumelage iPhone fonctionnent après chaque étape.
- Aucun téléphone sans source n’apparaît dans l’interface, le pont, une maquette ou un export.
- Un refus bloque réellement les relances.
- Un paiement n’est rapproché qu’avec un événement vérifié ou une saisie manuelle documentée.
- Une maquette publique n’est publiée que pour une fiche autorisée.
- Une sauvegarde peut être restaurée avant la première publication publique.
