# Kynext — guide de démarrage

## Lancer le cockpit

Prérequis : Node.js 18 ou plus récent, installé sur Windows.

Depuis PowerShell, installe une fois les dépendances du projet avec `npm.cmd install`. Le build CSS et les QR codes locaux utilisent ces dépendances; aucun service QR tiers n’est contacté.

Double-clique sur `ARGENT_Cockpit.exe` (nom de fichier historique). Le lanceur démarre Kynext depuis son propre dossier, attend que le cockpit réponde sur le port 3001, puis ouvre la fenêtre du navigateur. Il signale les erreurs de démarrage au lieu d’ouvrir une page vide.

Alternative depuis PowerShell, dans le dossier du projet :

```powershell
npm.cmd start
```

Ouvre ensuite [http://127.0.0.1:3001](http://127.0.0.1:3001). Garde la fenêtre du serveur ouverte tant que le cockpit est utilisé.

## Jumeler un iPhone

1. Connecte l’iPhone et le PC au même réseau Wi-Fi.
2. Dans le cockpit, ouvre le bouton téléphone et choisis l’adresse du réseau local.
3. Sur l’iPhone, ouvre cette adresse, puis saisis le code temporaire affiché sur le PC.
4. Utilise uniquement un réseau privé et de confiance. La connexion locale utilise HTTP et n’est pas chiffrée ; évite les réseaux publics ou partagés.

Le code de jumelage expire après dix minutes. Le jeton d’accès est renouvelé au redémarrage du serveur.
Les connexions iPhone sont limitées aux adresses IPv4 privées du même sous-réseau que le PC.

## Données et publication

- Les fiches sont lues depuis `data.js`.
- Les statuts, coordonnées corrigées et notes CRM sont conservés dans `dossiers_clients/crm_state.json`.
- Un numéro professionnel n’est conservé que s’il est français, confirmé par l’utilisateur et accompagné d’une source publique HTTPS (`telVerified` et `telSource`). Les recherches web ne remplissent jamais les numéros automatiquement; les numéros non vérifiés restent vides et ne sont pas proposés à l’appel, à WhatsApp ou à la publication.
- La source HTTPS d’un numéro confirmé est consultable depuis la fiche. Cette preuve est une référence à vérifier par l’utilisateur; le serveur ne prétend pas vérifier automatiquement le contenu distant.
- « Ne plus contacter » est une liste de suppression distincte du statut de vente. Elle bloque les actions téléphone, SMS/WhatsApp, la rafale et la création de brouillons de paiement, y compris via le pont iPhone. La désactivation demande une confirmation et laisse la date/motif de retrait dans l’état CRM.
- Le filtre « À vérifier » regroupe les entreprises sans numéro public confirmé. Les recherches ouvrent des requêtes manuelles vers des annuaires professionnels; le cockpit mémorise le nombre, la date et la dernière source consultée. « Aucun numéro public trouvé » ne peut être enregistré qu’après ouverture d’une source. Aucun numéro n’est deviné ou récupéré par contournement anti-bot.
- L’import CSV se fait par le bouton « CSV ↓ » ou en déposant le fichier dans la liste. Colonnes minimales : SIREN/SIRET, nom, ville et métier. Les doublons d’identifiant fusionnent seulement les champs manquants et les notes; les collisions nom+ville avec identifiant différent restent à vérifier. Les téléphones importés ne deviennent pas vérifiés sans indicateur explicite et source HTTPS. « Exporter mobiles vérifiés » ne contient que les 06/07 confirmés.
- Le score affiché est un indice CRM explicable fondé sur le statut et la date d’une interaction consignée ; il ne constitue pas une probabilité statistique. Les relances apparaissent dans le segment « À relancer (J+3) » et restent des rappels internes.
- Les pages locales sont générées dans `sites`.
- Les maquettes générées proposent un thème clair/sombre, une FAQ générique, un formulaire en trois étapes qui prépare un brouillon e-mail (aucun envoi automatique), une identité SVG et des métadonnées Open Graph. Les photos de catalogue sont des illustrations génériques, jamais des références de chantiers; aucune note ou disponibilité n’est inventée. Les métiers sans barème configuré n’affichent pas de prix estimatif.
- Avant publication, vérifie les mentions légales, assurances, certifications, photos, services et tarifs avec l’entreprise. Les contenus génériques de FAQ ne remplacent pas ses réponses validées.
- Le cockpit prend en charge `/` ou `Ctrl+K` pour la recherche, `↑`/`↓` pour parcourir les fiches, `1`/`2`/`3` pour changer d’onglet et `?` pour afficher l’aide.
- Le pitch d’appel est personnalisé avec le dirigeant, le métier et la ville. Le sélecteur de messages propose des réponses sobres aux objections (budget, temps, utilité, site existant) et une clôture explicite des relances ; ces textes restent des brouillons à envoyer manuellement.
- Le sélecteur propose aussi un message de reprise de contact à trois mois, formulé sans pression et avec une option explicite d’arrêt. Il ne planifie ni n’envoie rien automatiquement et reste soumis à la liste « Ne plus contacter ».
- Le bouton « Pipeline » ouvre une vue Kanban des fiches correspondant aux filtres actifs. Les déplacer entre les colonnes met à jour leur statut CRM et l’enregistre localement, comme le sélecteur de statut de la fiche.
- « Note rapide » ajoute une note horodatée à la fiche sélectionnée, sans quitter sa vue. Les notes sont enregistrées avec l’état CRM local.
- Une fiche n’est publiée que si « Autoriser la publication de cette fiche » est cochée dans l’onglet Livrables. Les nouvelles fiches sont privées par défaut ; vérifie les textes, coordonnées et autorisations avant toute publication publique.
- Après publication Surge réussie, chaque fiche reçoit l’URL précise et l’horodatage de sa page publiée. Les brouillons PayPal.me sont rattachés à la fiche et affichés dans son suivi; leur création ne marque pas le paiement comme demandé, envoyé ou reçu. Les statuts et encaissements restent manuels, sans confirmation par webhook.
- Le bouton de publication demande confirmation et envoie seulement les fiches autorisées vers Surge, après prévalidation de la structure HTML, du viewport mobile, des liens internes, des ressources HTTPS, des images et de la feuille CSS. Cette prévalidation ne remplace pas Lighthouse ni des vérifications réseau réelles. Le CLI Surge doit déjà être configuré.
- Les QR codes sont rendus localement dans le navigateur; les données encodées ne sont pas envoyées à un service QR tiers. Les fiches `.vcf` sont générées depuis le cockpit. Les formulaires de contact ouvrent la messagerie du visiteur et ne transmettent pas les données à un serveur.
- `argent_ui.css` est la feuille de style locale utilisée par le cockpit, le pont iPhone et les maquettes publiées. Pour la régénérer après modification de l’interface, exécute `npm.cmd run build:css`.
- Les prix affichés sont indicatifs. Configure un lien de compte PayPal.me valide avant d’utiliser les messages de paiement.
- Le suivi du règlement est manuel et en euros : vérifie chaque encaissement dans le compte du prestataire avant de modifier son statut. Kynext ne stocke ni données de carte, ni clés de portefeuille, et ne déclenche pas de transferts ou de conversions automatiques.
- `npm.cmd run hunter -- 59,62` lance une recherche de candidats via l’API officielle et exporte un CSV dans `generated/` pour import manuel. La vérification DNS est seulement indicative; le script ne modifie plus `data.js` et ne fabrique pas de maquette ni de coordonnées.
- Le tableau « Pilotage » permet de journaliser manuellement les encaissements et remboursements, d’exporter les mouvements d’un mois en CSV et d’estimer un net après taux fiscaux/frais/infrastructure que vous renseignez. Ce n’est ni un journal comptable certifié ni un conseil fiscal ; les montants antérieurs à l’activation du journal ne sont pas reconstitués.
- Le délai contact–premier encaissement est calculé uniquement pour les dossiers dont le premier contact et le premier encaissement sont consignés à partir de cette version ; les historiques incomplets sont exclus.
- Les demandes de devis ouvrent la messagerie de l’utilisateur ; elles ne prétendent pas avoir envoyé le formulaire automatiquement.
- Aucun suivi nominatif des visiteurs anonymes ni SMS post-visite n’est activé. Les fonctions d’envoi e-mail/SMS, de qualification IA et de calendrier nécessitent des fournisseurs, des clés et des règles de consentement qui ne sont pas configurés dans cette édition.
- Les alertes chiffrées, la détection statistique de baisse de conversion, les cartes de ventes, les sauvegardes distantes, le kill switch avec purge et l’analyse marketing par IA ne sont pas activés : le cockpit ne dispose ni des intégrations, ni d’un historique attribué suffisant pour les exécuter de façon fiable.

## Maintenance

### Bibliothèques locales

Les bibliothèques d’interface et d’export utilisées par le cockpit sont figées dans `libs/` et servies par le serveur local : Fuse.js (recherche tolérante), Day.js (dates), Toastify (notifications), Flatpickr (dates), Chart.js (graphiques), PapaParse (CSV), FileSaver/JSZip (exports) et Cleave.js (saisie). Elles sont chargées localement, sans CDN requis au runtime. Les modules qui ne sont pas encore branchés à un écran métier restent volontairement disponibles mais inactifs.

### FreeLLMAPI et GitHub Copilot

Le dépôt FreeLLMAPI est copié dans `freellmapi/` comme composant séparé. Il expose une API OpenAI-compatible sur `/v1`; Kynext reste sur son port 3001 et FreeLLMAPI doit utiliser le port 3002. Le modèle `auto` peut ensuite être ajouté à GitHub Copilot CLI avec `scripts/configure-freellmapi-copilot.ps1`. Le script écrit dans le profil Copilot de l’utilisateur, conserve les autres fournisseurs et ne versionne aucune clé. Il faut fournir la clé unifiée créée dans le tableau de bord FreeLLMAPI.

`server_argent.js` est la source principale du serveur et du générateur de cockpit. Les anciens scripts de migration sont archivés dans `archive/migrations/` ; ne les relance pas sur cette version. Les outils d’enrichissement historiques sont rangés dans `tools/enrichment/`.
`finance_reporting.js` contient la logique locale de journalisation et de reporting ; ses règles sont couvertes par `finance_reporting.test.js`.
`sales_playbook.js` contient les modèles locaux de pitch et de réponses aux objections ; ses textes sont couverts par `sales_playbook.test.js`.
Les états CRM distincts sont archivés dans `backups` avant leur écriture et à l’arrêt gracieux du serveur. Seuls les 50 derniers snapshots distincts sont conservés; ils restent des fichiers JSON non chiffrés. `data.js`, les dossiers CRM, les maquettes, les sauvegardes et les fichiers générés sont exclus de Git pour ne pas versionner les données d’entreprise ou les artefacts locaux.
Pour restaurer le CRM, arrête d’abord le serveur, repère un snapshot avec `Get-ChildItem .\backups\crm-state-*.json`, puis lance `npm.cmd run restore-crm -- .\backups\crm-state-<hash>.json`. Le script refuse de travailler si le port 3001 répond et conserve l’état courant sous `crm-state-pre-restore-*.json` avant remplacement.
Le dépôt Git versionne le code et la documentation. Pour annuler des changements de code, utilise `git diff` puis `git restore -- <fichier>` uniquement après avoir vérifié que les changements à retirer sont bien les tiens; les snapshots CRM ne remplacent pas une sauvegarde externe.
Lancer les tests avec `npm.cmd test`; l’audit de dépendances se lance avec `npm.cmd audit`. L’import CSV n’ajoute pas de nouveau paquet.
