const fs = require('fs');

async function deepEnrich360() {
    console.log("\n🛰️ KYNEXT DEEP ENRICHER 360° : Téléphones, E-mails & Détection de Sites");
    
    let dataFile = 'data.js';
    if (!fs.existsSync(dataFile)) {
        console.log("❌ Fichier data.js introuvable.");
        return;
    }

    let raw = fs.readFileSync(dataFile, 'utf-8');
    let jsonStr = raw.replace(/^window\.PROSPECTS_DATA\s*=\s*/, '').replace(/;\s*$/, '');
    let prospects = [];
    try { prospects = JSON.parse(jsonStr); } catch (e) { console.log("Erreur parsing data.js"); return; }

    // On cible ceux à qui il manque des infos vitales (Tel OU Email)
    let missing = prospects.filter(p => !p.tel || !p.email || p.tel.trim() === '');
    console.log(`🎯 ${missing.length} fiches à enrichir profondément sur ${prospects.length}.`);

    if (missing.length === 0) {
        console.log("✅ Ta base est déjà parfaite à 100% !");
        return;
    }

    let updatedCount = 0;
    // Liste des annuaires à ignorer pour trouver le "vrai" site de l'artisan
    const blacklistUrls = ['pagesjaunes', 'societe', 'pappers', 'infogreffe', 'facebook', 'instagram', 'linkedin', 'mappy', 'yelp', '118000', 'verif', 'lefigaro', 'kompass'];

    for (let i = 0; i < missing.length; i++) {
        let p = missing[i];
        process.stdout.write(`[${i+1}/${missing.length}] 🔍 Analyse : ${p.nom.substring(0, 20).padEnd(20)} (${p.ville})... `);
        
        try {
            const query = `${p.nom} ${p.ville} ${p.metier || ''} contact`.replace(/\s+/g, '+');
            const response = await fetch('https://html.duckduckgo.com/html/?q=' + query, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            
            const html = await response.text();
            let foundSomething = false;
            
            // 1. EXTRACTION TÉLÉPHONE (Priorité Mobile)
            if (!p.tel) {
                const phoneRegex = /(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/g;
                const pMatches = html.match(phoneRegex);
                if (pMatches) {
                    let cleanNumbers = pMatches.map(n => n.replace(/[\s.-]/g, '').replace(/^(?:\+|00)33/, '0')).filter(n => n.length === 10 && n.startsWith('0'));
                    if (cleanNumbers.length > 0) {
                        let mobile = cleanNumbers.find(n => n.startsWith('06') || n.startsWith('07'));
                        p.tel = (mobile || cleanNumbers[0]).replace(/(\d{2})(?=\d)/g, '$1 ').trim();
                        process.stdout.write(`📞 ${p.tel} `);
                        foundSomething = true;
                    }
                }
            }

            // 2. EXTRACTION E-MAIL
            if (!p.email) {
                const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                const eMatches = html.match(emailRegex);
                if (eMatches) {
                    // Filtrage des faux emails (type sentry, w3.org, ou images)
                    let cleanEmails = eMatches.filter(e => !e.includes('sentry') && !e.includes('example') && !e.endsWith('.png'));
                    if (cleanEmails.length > 0) {
                        p.email = cleanEmails[0].toLowerCase();
                        process.stdout.write(`📧 ${p.email} `);
                        foundSomething = true;
                    }
                }
            }

            // 3. DÉTECTION VRAI SITE WEB (Hors annuaires)
            if (!p.site_existant) {
                const urlRegex = /href="https?:\/\/(?:www\.)?([-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6})\b/g;
                let urls = [];
                let match;
                while ((match = urlRegex.exec(html)) !== null) {
                    urls.push(match[1].toLowerCase());
                }
                
                // On cherche un nom de domaine qui n'est PAS dans la blacklist
                let realSites = urls.filter(domain => !blacklistUrls.some(b => domain.includes(b)) && !domain.includes('duckduckgo') && !domain.includes('w3.org'));
                
                if (realSites.length > 0) {
                    p.site_existant = realSites[0];
                    process.stdout.write(`🌐 A déjà un site `);
                    foundSomething = true;
                } else {
                    p.site_existant = "Aucun site détecté";
                }
            }

            if (!foundSomething) {
                process.stdout.write(`❌ Rien trouvé`);
            }
            console.log(""); // Retour à la ligne
            updatedCount++;

        } catch (e) {
            console.log(`⚠️ Erreur réseau`);
        }
        
        // SAUVEGARDE PROGRESSIVE (Tous les 5 prospects) - Zéro perte de données
        if (updatedCount % 5 === 0) {
            fs.writeFileSync(dataFile, `window.PROSPECTS_DATA = ${JSON.stringify(prospects, null, 2)};\n`, 'utf-8');
        }
        
        // Pause de 2.5 secondes pour être indétectable
        await new Promise(r => setTimeout(r, 2500));
    }

    // Sauvegarde finale
    fs.writeFileSync(dataFile, `window.PROSPECTS_DATA = ${JSON.stringify(prospects, null, 2)};\n`, 'utf-8');
    console.log(`\n✅ ENRICHISSEMENT TERMINÉ !`);
    console.log(`👉 Actualise ton Cockpit. Tu as maintenant des Téléphones, des E-mails, et tu sais qui a déjà un site !`);
}

deepEnrich360();
