const fs = require('fs');
let code = fs.readFileSync('server_argent.js', 'utf-8');

// Remplace la clé localStorage corrompue par une clé propre v2 (remet les faux "Vendu" à zéro)
code = code.replace(/crm_ultimate_v1/g, 'crm_argent_clean_v2');

// Sécurise la fonction getStatus contre les bugs d'accents UTF-8 / ANSI
code = code.replace(
  /function getStatus\(siren\)\s*\{[^\}]+\}/,
  'function getStatus(siren) { var st = (state[siren] && state[siren].status) ? state[siren].status : "A_CONTACTER"; if (st.indexOf("contacter") !== -1 || st === "A_CONTACTER") return "À contacter"; return st; }'
);

// Force la sélection sur la première option ("À contacter") si le statut est neuf
code = code.replace(
  'document.getElementById("cpStatus").value = getStatus(selected.siren);',
  'var curSt = getStatus(selected.siren); var selEl = document.getElementById("cpStatus"); selEl.value = curSt; if (selEl.selectedIndex === -1) selEl.selectedIndex = 0;'
);

// Ajoute un bouton "Reset Statuts" dans la barre supérieure pour tout remettre à zéro en 1 clic si besoin
code = code.replace(
  'ouvrirDossierWindows()" class="bg-zinc-800',
  'resetAllStatuts()" class="bg-zinc-800 hover:bg-red-950 text-zinc-300 text-xs font-bold px-3 py-2 rounded-xl transition">🔄 Reset Statuts</button><button onclick="ouvrirDossierWindows()" class="bg-zinc-800'
);

code = code.replace(
  'function ouvrirDossierWindows()',
  'function resetAllStatuts() { if(confirm("Remettre tous les prospects sur À contacter (0 ) ?")) { localStorage.removeItem("crm_argent_clean_v2"); state = {}; saveState(); renderList(); selectProspect(selected.siren); notify("Tous les statuts sont remis à zéro ✓"); } }\n    function ouvrirDossierWindows()'
);

fs.writeFileSync('server_argent.js', code, 'utf-8');
console.log('✓ Bug du statut "Client Vendu" corrigé et compteurs remis à zéro !');
