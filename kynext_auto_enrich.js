const fs = require('fs');

async function autoEnrich() {
    console.log("\n🤖 KYNEXT AUTO-ENRICHER : Liaison Automatique des Numéros Publics");
    
    let dataFile = 'data.js';
    if (!fs.existsSync(dataFile)) {
        console.log("❌ Fichier data.js introuvable.");
        return;
    }

    // Chargement de la base de prospects actuelle
    let raw = fs.readFileSync(dataFile, 'utf-8');
    let jsonStr = raw.replace(/^window\.PROSPEcripts_DATA\s*=\s*/, '').replace(/^window\.PROSPECTS_DATA\s*=\s*/, '').replace(/;\s*$/, '');
    let prospects = [];
    try { prospects = JSON.parse(jsonStr); } catch (e) { console.log("Erreur parsing data.js"); return; }

    // Cibler uniquement les prospects SANS numéro
    let missing = prospects.filter(p => !p.tel || p.tel.trim() === '');
    console.log(`🎯 ${missing.length} fiches en attente de numéro sur ${prospects.length} au total.`);

    if (missing.length === 0) {
        console.log("✅ Tous tes prospects ont déjà un numéro !");
        return;
    }

    let updatedCount = 0;

    for (let p of missing) {
        process.stdout.write(`🔍 Recherche pour : ${p.nom.substring(0, 25).padEnd(25)} (${p.ville})... `);
        
        try {
            // Requête publique ciblée (Nom + Ville + Téléphone)
            const query = `${p.nom} ${p.ville} téléphone`.replace(/\s+/g, '+');
            const response = await fetch('https://html.duckduckgo.com/html/?q=' + query, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' }
            });
            
            const html = await response.text();
            
            // Regex stricte pour extraire les numéros français (01 à 09)
            const phoneRegex = /(?:(?:\+|00)33|0)\s*[1-9](?:[\s.-]*\d{2}){4}/g;
            const matches = html.match(phoneRegex);
            
            if (matches) {
                // Nettoyage et uniformisation (format 0X XX XX XX XX)
                let cleanNumbers = matches.map(n => n.replace(/[\s.-]/g, '').replace(/^(?:\+|00)33/, '0'));
                cleanNumbers = cleanNumbers.filter(n => n.length === 10 && n.startsWith('0')); // 10 chiffres obligatoires
                
                if (cleanNumbers.length > 0) {
                    // Stratégie Kynext : Priorité absolue aux mobiles (06 / 07)
                    let mobile = cleanNumbers.find(n => n.startsWith('06') || n.startsWith('07'));
                    let finalNumber = mobile || cleanNumbers[0];
                    
                    // Formatage propre : 06 12 34 56 78
                    finalNumber = finalNumber.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
                    
                    p.tel = finalNumber;
                    updatedCount++;
                    console.log(`✅ Trouvé : ${finalNumber} ${mobile ? '📱' : '☎️'}`);
                } else {
                    console.log(`❌ Introuvable`);
                }
            } else {
                console.log(`❌ Introuvable`);
            }
        } catch (e) {
            console.log(`⚠️ Erreur réseau`);
        }
        
        // Pause de 2 secondes pour imiter un humain et ne pas se faire bannir l'IP par le moteur de recherche
        await new Promise(r => setTimeout(r, 2000));
    }

    // Sauvegarde en temps réel si on a trouvé des numéros
    if (updatedCount > 0) {
        console.log(`\n💾 SAUVEGARDE : ${updatedCount} nouveaux numéros ajoutés à ta base Kynext !`);
        const newDataContent = `window.PROSPECTS_DATA = ${JSON.stringify(prospects, null, 2)};\n`;
        fs.writeFileSync(dataFile, newDataContent, 'utf-8');
        console.log(`👉 Actualise ton Cockpit (F5), tes fiches sont prêtes pour le pont iPhone.`);
    } else {
        console.log("\n🤷‍♂️ Aucun numéro trouvé sur cette passe. (Les fiches restent 'À vérifier')");
    }
}

autoEnrich();
