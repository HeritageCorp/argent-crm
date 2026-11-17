const fs = require('fs');
const path = require('path');

const keyword = process.argv[2] || 'plombier';
const dept = process.argv[3] || '59';

async function huntMassiveLeads() {
    console.log(`\n🎯 KYNEXT MASS HUNTER - Ciblage : "${keyword}" | Département : ${dept}`);
    console.log(`⏳ Aspiration intensive (pagination par 25, filtre département exact)...`);
    
    let allResults = [];
    
    try {
        // Boucle pour récupérer jusqu'à 20 pages (500 leads d'un coup)
        for (let page = 1; page <= 20; page++) {
            // Utilisation du paramètre officiel 'departement'
            const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(keyword)}&departement=${dept}&per_page=25&page=${page}&etat_administratif=A`;
            
            const response = await fetch(url);
            if (!response.ok) {
                if (response.status === 400) break; 
                throw new Error(`Erreur HTTP: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.results && data.results.length > 0) {
                allResults = allResults.concat(data.results);
                process.stdout.write(`✓ Page ${page} extraite... `);
            }
            
            // Si la page renvoie moins de 25 résultats, c'est la fin
            if (!data.results || data.results.length < 25) break;
            
            // Courte pause pour respecter l'API
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (allResults.length === 0) {
            console.log("\n❌ Aucun prospect trouvé pour ces critères dans ce département.");
            return;
        }

        console.log(`\n✅ ${allResults.length} entreprises actives trouvées au total ! Formatage CSV...`);
        
        let csvContent = "nom;siren;metier;ville;code_postal;adresse\n";
        
        allResults.forEach(p => {
            const nom = (p.nom_complet || p.nom_raison_sociale || 'Inconnu').replace(/;/g, ',').replace(/\n/g, ' ');
            const siren = p.siren;
            const siege = p.siege || {};
            const ville = (siege.libelle_commune || '').replace(/;/g, ',');
            const cp = siege.code_postal || '';
            const adresse = (siege.adresse || '').replace(/;/g, ',').replace(/\n/g, ' ');
            const activite = (p.libelle_activite_principale || keyword).replace(/;/g, ',');
            
            csvContent += `${nom};${siren};${activite};${ville};${cp};${adresse}\n`;
        });

        if (!fs.existsSync('generated')) fs.mkdirSync('generated');
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 15);
        const filename = `kynext_LEADS_${keyword}_${dept}_${dateStr}.csv`;
        const filePath = path.join('generated', filename);
        
        fs.writeFileSync(filePath, csvContent, 'utf-8');
        
        console.log(`\n🚀 SUCCÈS TOTAL !`);
        console.log(`📁 Fichier sauvegardé : ${filePath}`);
        
    } catch (e) {
        console.error("\n❌ Échec de la recherche :", e.message);
    }
}

huntMassiveLeads();
