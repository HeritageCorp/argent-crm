const fs = require('fs');

// Liste d'identités (User-Agents) pour berner les anti-bots
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchHTML(query) {
    const url = 'https://html.duckduckgo.com/html/?q=' + query.replace(/\s+/g, '+');
    try {
        const res = await fetch(url, { headers: { 'User-Agent': getRandomUA(), 'Accept-Language': 'fr-FR,fr;q=0.9' } });
        if (!res.ok) return '';
        return await res.text();
    } catch(e) { return ''; }
}

async function godModeEnrich() {
    console.log("\n☢️ KYNEXT GOD MODE : Double-Frappe SIREN, GMB & Anti-Ban");
    
    let dataFile = 'data.js';
    if (!fs.existsSync(dataFile)) return console.log("❌ data.js introuvable.");

    let raw = fs.readFileSync(dataFile, 'utf-8');
    let jsonStr = raw.replace(/^window\.PROSPECTS_DATA\s*=\s*/, '').replace(/;\s*$/, '');
    let prospects = [];
    try { prospects = JSON.parse(jsonStr); } catch (e) { return console.log("Erreur parsing."); }

    let missing = prospects.filter(p => !p.tel || !p.email || !p.site_existant || !p.google_maps);
    console.log(`🎯 ${missing.length} fiches à passer au Rayon X.`);

    if (missing.length === 0) return console.log("✅ Base 100% absolue.");

    let updatedCount = 0;

    for (let i = 0; i < missing.length; i++) {
        let p = missing[i];
        let searchName = p.nom.replace(/\b(MONSIEUR|MADAME|SARL|SASU|SAS|EURL|EI|SOCIETE|ENTREPRISE|MME|M\.)\b/gi, '').trim() || p.nom;
        
        process.stdout.write(`[${i+1}/${missing.length}] 🔍 ${searchName.substring(0, 15)} `);
        
        let html = '';
        let foundSomething = false;

        // PASSE 1 : Nom + Ville (Recherche Classique)
        html = await fetchHTML(`${searchName} ${p.ville} ${p.code_postal || ''} telephone contact`);
        
        // PASSE 2 (Double-Frappe) : Si la passe 1 est vide, on attaque avec le numéro SIREN (Redoutable)
        if (!html.includes('href="') || html.length < 1000) {
            process.stdout.write(`⚡ (Frappe SIREN) `);
            await new Promise(r => setTimeout(r, 1000)); // Pause tactique
            html = await fetchHTML(`${p.siren} ${searchName} telephone`);
        }

        // 1. TÉLÉPHONE (Regex ultime couvrant les espaces, points, tirets, +33, (0)6)
        if (!p.tel) {
            const phoneRegex = /(?:(?:\+|00)33|0)\s*(?:[\s.-]*\(0\))?\s*[1-9](?:[\s.-]*\d){8,9}/g;
            const matches = html.match(phoneRegex);
            if (matches) {
                let cleanNumbers = matches.map(n => n.replace(/[^\d+]/g, '').replace(/^(?:\+|00)330?/, '0'));
                let valid = cleanNumbers.filter(n => n.length === 10 || n.length === 9);
                if (valid.length > 0) {
                    let bestNum = valid.find(n => n.startsWith('06') || n.startsWith('07')) || valid[0];
                    if (bestNum.length === 9 && !bestNum.startsWith('0')) bestNum = '0' + bestNum;
                    p.tel = bestNum.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
                    process.stdout.write(`📞 ${p.tel} `);
                    foundSomething = true;
                }
            }
        }

        // 2. E-MAIL (Regex robuste + protection anti-fichiers)
        if (!p.email) {
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
            const matches = html.match(emailRegex);
            if (matches) {
                let cleanEmails = matches.filter(e => !/\.(png|jpg|jpeg|gif|svg|pdf|css|js)$/i.test(e) && !e.includes('sentry') && !e.includes('example'));
                if (cleanEmails.length > 0) {
                    p.email = cleanEmails[0].toLowerCase();
                    process.stdout.write(`📧 ${p.email.split('@')[0]}@... `);
                    foundSomething = true;
                }
            }
        }

        // 3. SITES, RÉSEAUX ET GOOGLE MAPS
        const urlRegex = /href="https?:\/\/(?:www\.)?([^"]+)/gi;
        let urls = [];
        let match;
        while ((match = urlRegex.exec(html)) !== null) { urls.push(match[1].toLowerCase()); }
        
        const blacklist = ['duckduckgo', 'w3.org', 'pagesjaunes', 'societe.com', 'pappers', 'infogreffe', 'mappy', '118000'];
        
        // Google Maps Détection
        if (!p.google_maps) {
            let hasMaps = urls.some(u => u.includes('maps.google') || u.includes('google.com/maps') || u.includes('g.page'));
            if (hasMaps) {
                p.google_maps = "Présent sur Google Maps";
                process.stdout.write(`📍 GMB `);
                foundSomething = true;
            } else {
                p.google_maps = "Absent de Google Maps";
            }
        }

        // Site Web
        if (!p.site_existant) {
            let realSites = urls.filter(domain => !blacklist.some(b => domain.includes(b)));
            if (realSites.length > 0) {
                if (realSites[0].includes('facebook.com')) { p.site_existant = "Page Facebook"; process.stdout.write(`🌐 FB `); }
                else if (realSites[0].includes('instagram.com')) { p.site_existant = "Page Instagram"; process.stdout.write(`🌐 IG `); }
                else { p.site_existant = realSites[0].split('/')[0]; process.stdout.write(`🌐 Site `); }
                foundSomething = true;
            }
        }

        if (!foundSomething) process.stdout.write(`❌ Vide`);
        console.log("");
        
        updatedCount++;
        
        // Sauvegarde agressive (tous les 2 prospects)
        if (updatedCount % 2 === 0) {
            fs.writeFileSync(dataFile, `window.PROSPECTS_DATA = ${JSON.stringify(prospects, null, 2)};\n`, 'utf-8');
        }
        
        // Délai aléatoire (1.5s à 3s) pour simuler un comportement humain parfait
        const delay = Math.floor(Math.random() * (3000 - 1500 + 1)) + 1500;
        await new Promise(r => setTimeout(r, delay));
    }

    fs.writeFileSync(dataFile, `window.PROSPECTS_DATA = ${JSON.stringify(prospects, null, 2)};\n`, 'utf-8');
    console.log(`\n☢️ GOD MODE TERMINÉ ! Data sauvegardée en lieu sûr.`);
}

godModeEnrich();
