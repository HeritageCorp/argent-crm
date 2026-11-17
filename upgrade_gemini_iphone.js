const fs = require('fs');

// 1. Ajoute la route /api/vcard dans server_argent.js pour enregistrer n'importe quel artisan dans les Contacts iPhone en 1 tap
let srv = fs.readFileSync('server_argent.js', 'utf-8');

const vcardRoute = `
  if (req.url.startsWith('/api/vcard')) {
    const u = new URL(req.url, 'http://127.0.0.1:3000');
    const s = u.searchParams.get('siren');
    const p = DATA.find(x => x.siren === s) || BRIDGE_STATE;
    if (p) {
      const cleanTel = (p.tel || '').replace(/\\s+/g, '');
      const vcf = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:🛠️ ' + (p.nom || 'Artisan') + ' (' + (p.ville || '') + ')',
        'ORG:' + (p.nom || ''),
        'TITLE:' + (p.metier || 'Artisan'),
        'TEL;TYPE=CELL,VOICE:' + cleanTel,
        'URL:' + (p.urlPublique || ''),
        'NOTE:SIREN ' + (p.siren || '') + ' - Maquette : ' + (p.urlPublique || ''),
        'END:VCARD'
      ].join('\\r\\n');
      resHttp.writeHead(200, {
        'Content-Type': 'text/vcard; charset=utf-8',
        'Content-Disposition': 'attachment; filename="artisan_' + (p.siren || 'contact') + '.vcf"'
      });
      return resHttp.end(vcf);
    }
  }
`;

if (!srv.includes('/api/vcard')) {
  srv = srv.replace("if (req.url === '/iphone') {", vcardRoute + "\n  if (req.url === '/iphone') {");
  fs.writeFileSync('server_argent.js', srv, 'utf-8');
}

// 2. Met à jour iphone_remote.html avec le Pont Gemini IA iPhone + Bouton Fiche Contact .vcf + Sélecteur d'Objections IA
let iph = fs.readFileSync('iphone_remote.html', 'utf-8');

const geminiIphoneBlock = `
    <!-- PONT GEMINI IA SUR IPHONE + FICHE CONTACT VCF -->
    <div class="glass rounded-2xl p-3 space-y-2 border border-purple-500/30">
      <div class="flex justify-between items-center">
        <span class="text-[10px] font-extrabold uppercase tracking-wider text-purple-300">✨ Assistant Gemini iPhone & Contact</span>
        <a id="btnVcard" href="#" class="bg-zinc-800 border border-white/10 text-[10px] font-bold px-2.5 py-1 rounded-lg text-emerald-300">📇 +Contact iOS</a>
      </div>
      <div class="grid grid-cols-2 gap-1.5">
        <button onclick="askGeminiPhone('objection')" class="bg-gradient-to-r from-purple-600 to-indigo-600 active:scale-95 text-white font-extrabold py-2.5 rounded-xl text-[11px] shadow">✨ Gemini : Répondre</button>
        <button onclick="askGeminiPhone('audit')" class="bg-zinc-900 border border-purple-400/30 active:scale-95 text-purple-200 font-bold py-2.5 rounded-xl text-[11px]">🎙️ Gemini : Pitch Live</button>
      </div>
    </div>
`;

if (!iph.includes('askGeminiPhone')) {
  iph = iph.replace('<!-- 3 BOUTONS D ACTION PRINCIPAUX -->', geminiIphoneBlock + '\n    <!-- 3 BOUTONS D ACTION PRINCIPAUX -->');

  const geminiJs = `
    function askGeminiPhone(mode) {
      var b = currentBridge || {};
      var promptIa = "";
      if (mode === "objection") {
        var obj = prompt("Que vient de te répondre l'artisan ? (ex: trop cher, j'ai pas le temps, rappelle le mois prochain)", "C'est trop cher pour moi en ce moment");
        if (!obj) return;
        promptIa = "Tu es mon closer B2B expert en vente de sites web à 790  (sans abonnement) pour les artisans. Voici mon prospect : " + (b.nom || "Artisan") + " (" + (b.metier || "") + " à " + (b.ville || "") + ", dirigeant : " + (b.dirigeant || "") + "). Lien de sa maquette prête : " + (b.urlPublique || "") + ". Il vient de me dire : \\"" + obj + "\\". Rédige-moi 2 réponses WhatsApp ultra-courtes, humaines et percutantes (prêtes à copier-coller) + la phrase exacte à lui dire au téléphone maintenant.";
      } else {
        promptIa = "Simule un appel à froid en mode jeu de rôle vocal (Gemini Live) : tu joues le rôle du dirigeant " + (b.dirigeant || "") + " de l'entreprise " + (b.nom || "") + " (" + (b.metier || "") + " à " + (b.ville || "") + "). Je t'appelle pour te proposer ta maquette de site vitrine à 790  (" + (b.urlPublique || "") + "). Sois un artisan occupé sur un chantier mais réaliste, et à la fin donne-moi une note sur 10.";
      }
      navigator.clipboard.writeText(promptIa).then(function() {
        alert("✓ Contexte de " + (b.nom || "l'artisan") + " copié ! L'application Gemini va s'ouvrir : fais simplement COLLER dans Gemini.");
        window.location.href = "https://gemini.google.com/app";
      }).catch(function() {
        prompt("Copie ce prompt pour Gemini :", promptIa);
      });
    }
  `;

  iph = iph.replace(
    'document.getElementById("mobSiteBtn").href = b.urlPublique || "#";',
    'document.getElementById("mobSiteBtn").href = b.urlPublique || "#";\n          if (document.getElementById("btnVcard")) document.getElementById("btnVcard").href = "/api/vcard?siren=" + encodeURIComponent(b.siren);'
  );
  iph = iph.replace('function sendPayFromPhone', geminiJs + '\n    function sendPayFromPhone');
  fs.writeFileSync('iphone_remote.html', iph, 'utf-8');
}

// 3. Ajoute aussi le bouton "✨ Copier Prompt Gemini" sur le Cockpit PC
let pc = fs.readFileSync('cockpit_argent.html', 'utf-8');
if (!pc.includes('copierPromptGeminiPc()')) {
  pc = pc.replace(
    '<button onclick="copyMsg()"',
    '<button onclick="copierPromptGeminiPc()" class="bg-purple-600/20 hover:bg-purple-600/30 border border-purple-400/30 text-purple-200 text-xs font-extrabold px-4 py-4 rounded-2xl transition">✨ Gemini IA</button>\n                <button onclick="copyMsg()"'
  );
  const pcGemJs = `
    function copierPromptGeminiPc() {
      var notes = (state[selected.siren] && state[selected.siren].notes) ? state[selected.siren].notes : "Aucune note";
      var pTxt = "Tu es mon copilote de closing B2B. Entreprise ciblée : " + selected.nom + " (" + selected.metier + " à " + selected.ville + ", SIREN " + selected.siren + ", Dirigeant : " + selected.dirigeant + "). Maquette en ligne : " + selected.urlPublique + ". Historique/Notes : " + notes + ". Donne-moi : 1) Un message WhatsApp ultra-personnalisé qui brise la glace, 2) L'argument massue spécifique à son métier (" + selected.metier + ") à " + selected.ville + " pour lui vendre le site à 790 .";
      navigator.clipboard.writeText(pTxt);
      notify("✨ Contexte copié pour Gemini ! Colle-le dans Gemini.");
    }
  `;
  pc = pc.replace('function copyMsg()', pcGemJs + '\n    function copyMsg()');
  fs.writeFileSync('cockpit_argent.html', pc, 'utf-8');
}

console.log('✓ Pont Gemini IA (iPhone + PC) et Fiches Contacts iOS (.vcf) installés !');
