const fs = require('fs');
const os = require('os');

// Détecte l'adresse IP Wi-Fi / LAN du PC Windows
function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();
const IPHONE_URL = 'http://' + LOCAL_IP + ':3000/iphone';

// Crée l'application Web Mobile dédiée à l'iPhone (iphone_remote.html)
const iphoneHtml = [
'<!DOCTYPE html>',
'<html lang="fr">',
'<head>',
'  <meta charset="UTF-8">',
'  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
'  <meta name="apple-mobile-web-app-capable" content="yes">',
'  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
'  <title>Kynext iPhone Remote</title>',
'  <script src="https://cdn.tailwindcss.com"></script>',
'  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&display=swap" rel="stylesheet">',
'  <style>body{font-family:"Plus Jakarta Sans",sans-serif;background:#050507;color:#fff;-webkit-tap-highlight-color:transparent}</style>',
'</head>',
'<body class="min-h-screen flex flex-col justify-between p-4 select-none">',
'  <!-- En-tête statut connexion PC -->',
'  <header class="flex items-center justify-between bg-zinc-900/90 border border-white/10 rounded-2xl px-4 py-3">',
'    <div class="flex items-center gap-2.5">',
'      <span class="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping"></span>',
'      <span class="font-extrabold text-xs tracking-wider uppercase text-emerald-400">iPhone Connecté au PC</span>',
'    </div>',
'    <label class="flex items-center gap-1.5 text-[11px] text-amber-300 font-bold">',
'      <input id="autoTrigger" type="checkbox" class="accent-amber-400 h-4 w-4"> Auto-Ouverture',
'    </label>',
'  </header>',
'',
'  <!-- Carte Entreprise Active -->',
'  <main class="my-4 flex-1 flex flex-col justify-center space-y-4">',
'    <div class="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-white/10 rounded-3xl p-5 shadow-2xl space-y-3">',
'      <div class="flex justify-between items-center">',
'        <span id="mobMetier" class="text-[10px] font-extrabold uppercase px-2.5 py-1 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/30">Métier</span>',
'        <span id="mobStatus" class="text-xs font-bold text-zinc-400">Statut</span>',
'      </div>',
'      <h1 id="mobNom" class="text-2xl font-extrabold text-white leading-tight">Sélectionne un prospect sur le PC...</h1>',
'      <p id="mobVille" class="text-xs text-zinc-400">—</p>',
'      <div id="mobTelBig" class="text-xl font-black text-emerald-400 pt-1">Aucun numéro</div>',
'    </div>',
'',
'    <!-- 3 Gros Boutons d exécution native iPhone -->',
'    <div class="space-y-2.5">',
'      <a id="btnCall" href="#" class="block w-full bg-gradient-to-r from-indigo-600 to-blue-600 active:scale-95 text-white font-extrabold text-center py-4 rounded-2xl shadow-lg text-base transition">📞 APPELER SUR IPHONE</a>',
'      <a id="btnWa" href="#" target="_blank" class="block w-full bg-gradient-to-r from-emerald-500 to-teal-500 active:scale-95 text-zinc-950 font-extrabold text-center py-4 rounded-2xl shadow-lg text-base transition">💬 ENVOYER WHATSAPP</a>',
'      <a id="btnSms" href="#" class="block w-full bg-gradient-to-r from-amber-400 to-amber-500 active:scale-95 text-zinc-950 font-extrabold text-center py-3.5 rounded-2xl shadow-lg text-sm transition">✉️ ENVOYER SMS IPHONE</a>',
'    </div>',
'',
'    <!-- Qualification 1-Tap depuis l iPhone -->',
'    <div class="bg-zinc-900/70 border border-white/10 rounded-2xl p-3 space-y-2">',
'      <div class="text-[10px] font-bold uppercase text-zinc-400 text-center">Qualifier l\'appel & Passer au suivant</div>',
'      <div class="grid grid-cols-3 gap-2">',
'        <button onclick="qualifyFromPhone(\'Répondeur\', \'sent\')" class="bg-zinc-800 active:bg-zinc-700 text-xs font-bold py-3 rounded-xl">📼 Répondeur</button>',
'        <button onclick="qualifyFromPhone(\'À rappeler\', \'sent\')" class="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold py-3 rounded-xl">⏰ Rappeler</button>',
'        <button onclick="qualifyFromPhone(\'Très intéressé\', \'hot\')" class="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-xs font-bold py-3 rounded-xl">🔥 Chaud</button>',
'      </div>',
'    </div>',
'  </main>',
'',
'  <!-- Navigation Précédent / Suivant depuis le lit ou le bureau -->',
'  <footer class="grid grid-cols-2 gap-3 pt-2">',
'    <button onclick="remoteNav(-1)" class="bg-zinc-900 border border-white/10 active:bg-zinc-800 py-3.5 rounded-2xl font-bold text-xs">◀ Précédent</button>',
'    <button onclick="remoteNav(1)" class="bg-zinc-900 border border-white/10 active:bg-zinc-800 py-3.5 rounded-2xl font-bold text-xs">Suivant ▶</button>',
'  </footer>',
'',
'  <script>',
'    var currentSiren = "";',
'    var lastActionId = 0;',
'',
'    async function pollBridge() {',
'      try {',
'        var r = await fetch("/api/bridge");',
'        var b = await r.json();',
'        if (b && b.siren) {',
'          document.getElementById("mobNom").innerText = b.nom || "—";',
'          document.getElementById("mobVille").innerText = "👤 " + (b.dirigeant || "Dirigeant") + " • 📍 " + (b.ville || "");',
'          document.getElementById("mobMetier").innerText = b.metier || "Artisan";',
'          document.getElementById("mobStatus").innerText = b.statusLabel || "À contacter";',
'          document.getElementById("mobTelBig").innerText = b.tel || "Pas de numéro";',
'',
'          var cleanTel = (b.tel || "").replace(/\\s+/g, "");',
'          var intlTel = "33" + cleanTel.replace(/^0/, "");',
'          var msg = b.message || "";',
'',
'          document.getElementById("btnCall").href = cleanTel ? ("tel:" + cleanTel) : "#";',
'          document.getElementById("btnWa").href = cleanTel ? ("https://wa.me/" + intlTel + "?text=" + encodeURIComponent(msg)) : "#";',
'          // Sur iOS, le séparateur de corps SMS est &body=',
'          document.getElementById("btnSms").href = cleanTel ? ("sms:" + cleanTel + "&body=" + encodeURIComponent(msg)) : "#";',
'',
'          if (b.siren !== currentSiren) {',
'            currentSiren = b.siren;',
'            if (navigator.vibrate) navigator.vibrate(40);',
'          }',
'',
'          // Si tu cliques sur un bouton d envoi sur le PC et que Auto-Ouverture est coché sur l iPhone',
'          if (b.actionId && b.actionId !== lastActionId) {',
'            lastActionId = b.actionId;',
'            if (document.getElementById("autoTrigger").checked && cleanTel) {',
'              if (b.actionType === "call") window.location.href = "tel:" + cleanTel;',
'              if (b.actionType === "wa") window.location.href = "https://wa.me/" + intlTel + "?text=" + encodeURIComponent(msg);',
'              if (b.actionType === "sms") window.location.href = "sms:" + cleanTel + "&body=" + encodeURIComponent(msg);',
'            }',
'          }',
'        }',
'      } catch (e) {}',
'    }',
'',
'    async function qualifyFromPhone(note, status) {',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "qualify", note: note, status: status })',
'      });',
'    }',
'',
'    async function remoteNav(dir) {',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "nav", dir: dir })',
'      });',
'    }',
'',
'    setInterval(pollBridge, 700);',
'    pollBridge();',
'  </scr' + 'ipt>',
'</body>',
'</html>'
].join('\n');

fs.writeFileSync('iphone_remote.html', iphoneHtml, 'utf-8');

// 4. Met à jour cockpit_argent.html pour afficher la modale QR Code iPhone et synchroniser chaque clic avec l'iPhone
let cockpit = fs.readFileSync('cockpit_argent.html', 'utf-8');

if (!cockpit.includes('openIphoneModal()')) {
  // Ajoute le bouton "📱 Connecter iPhone" dans la barre supérieure
  cockpit = cockpit.replace(
    '<button onclick="lancerRafale()"',
    '<button onclick="openIphoneModal()" class="bg-gradient-to-r from-amber-400 to-yellow-300 text-zinc-950 text-xs font-extrabold px-3.5 py-2 rounded-xl shadow transition">📱 Connecter iPhone</button>\n      <button onclick="lancerRafale()"'
  );

  // Ajoute la fenêtre modale avec le QR Code Wi-Fi direct
  const modalHtml = [
    '  <!-- MODALE CONNEXION IPHONE -->',
    '  <div id="iphoneModal" class="fixed inset-0 bg-black/80 backdrop-blur-md z-50 hidden flex items-center justify-center p-4">',
    '    <div class="lux-card max-w-md w-full rounded-3xl p-6 border border-amber-400/30 text-center space-y-4">',
    '      <div class="inline-flex items-center gap-2 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-3 py-1 rounded-full text-xs font-bold">📱 Passerelle Temps Réel iPhone ↔ PC</div>',
    '      <h3 class="text-xl font-extrabold text-white">Scanne avec l\'appareil photo de ton iPhone</h3>',
    '      <p class="text-xs text-zinc-400 leading-relaxed">Assure-toi que ton iPhone est sur le même Wi-Fi que ton PC. Dès que tu cliques sur une fiche sur le PC, elle s\'affiche instantanément sur ton iPhone !</p>',
    '      <div class="bg-white p-3 rounded-2xl inline-block mx-auto shadow-2xl">',
    '        <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(IPHONE_URL) + '" class="w-48 h-48">',
    '      </div>',
    '      <div class="bg-black/50 border border-white/10 rounded-xl p-2.5 text-xs font-mono text-amber-300">' + IPHONE_URL + '</div>',
    '      <button onclick="document.getElementById(\'iphoneModal\').classList.add(\'hidden\')" class="w-full bg-white/10 hover:bg-white/15 text-white font-bold py-3 rounded-xl text-xs">Fermer</button>',
    '    </div>',
    '  </div>'
  ].join('\n');

  cockpit = cockpit.replace('<!-- TOPBAR ULTRA-FINE -->', modalHtml + '\n  <!-- TOPBAR ULTRA-FINE -->');

  // Ajoute la synchronisation automatique PC <-> iPhone dans le script du cockpit
  const bridgeClientJs = [
    '    function openIphoneModal() { document.getElementById("iphoneModal").classList.remove("hidden"); }',
    '    function pushToIphone(actionType) {',
    '      if (!selected) return;',
    '      var msgEl = document.getElementById("cpMessage");',
    '      fetch("/api/bridge", {',
    '        method: "POST", headers: { "Content-Type": "application/json" },',
    '        body: JSON.stringify({',
    '          siren: selected.siren, nom: selected.nom, dirigeant: selected.dirigeant,',
    '          ville: selected.ville, metier: selected.metier, tel: selected.tel || "",',
    '          statusLabel: STATUS_LABELS[getStatus(selected.siren)] || "À contacter",',
    '          message: msgEl ? msgEl.value : selected.sms,',
    '          actionType: actionType || "", actionId: actionType ? Date.now() : 0',
    '        })',
    '      }).catch(function(){});',
    '    }',
    '    setInterval(async function() {',
    '      try {',
    '        var r = await fetch("/api/bridge-poll-pc");',
    '        var cmd = await r.json();',
    '        if (cmd && cmd.type === "nav") navProspect(cmd.dir);',
    '        if (cmd && cmd.type === "qualify") { qualifierAppel(cmd.note, cmd.status); navProspect(1); }',
    '      } catch(e){}',
    '    }, 800);'
  ].join('\n');

  cockpit = cockpit.replace('choisirScenario(document.getElementById("scenarioSelect").value);', 'choisirScenario(document.getElementById("scenarioSelect").value);\n      pushToIphone("");');
  cockpit = cockpit.replace('document.getElementById("cpMessage").value = map[val] || map.v1;', 'document.getElementById("cpMessage").value = map[val] || map.v1;\n      pushToIphone("");');
  cockpit = cockpit.replace('window.open("https://wa.me/" + intl + "?text=" + encodeURIComponent(txt), "_blank");', 'pushToIphone("wa");\n      window.open("https://wa.me/" + intl + "?text=" + encodeURIComponent(txt), "_blank");');
  cockpit = cockpit.replace('updateKpis();', bridgeClientJs + '\n    updateKpis();');

  fs.writeFileSync('cockpit_argent.html', cockpit, 'utf-8');
}

// 5. Met à jour server_argent.js pour écouter sur 0.0.0.0:3000 (Wi-Fi LAN) et gérer les routes /iphone et /api/bridge
let srv = fs.readFileSync('server_argent.js', 'utf-8');

const bridgeServerCode = `
let BRIDGE_STATE = {};
let PC_QUEUE = [];
`;

if (!srv.includes('BRIDGE_STATE')) {
  srv = bridgeServerCode + '\n' + srv;
  srv = srv.replace(
    'const server = http.createServer(async (req, resHttp) => {',
    `const server = http.createServer(async (req, resHttp) => {
  resHttp.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/iphone') {
    resHttp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return resHttp.end(fs.readFileSync('iphone_remote.html'));
  }
  if (req.url === '/api/bridge' && req.method === 'GET') {
    resHttp.writeHead(200, { 'Content-Type': 'application/json' });
    return resHttp.end(JSON.stringify(BRIDGE_STATE));
  }
  if (req.url === '/api/bridge' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      try { BRIDGE_STATE = Object.assign(BRIDGE_STATE, JSON.parse(b)); } catch(e){}
      resHttp.writeHead(200, { 'Content-Type': 'application/json' });
      resHttp.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url === '/api/bridge-cmd' && req.method === 'POST') {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      try {
        const d = JSON.parse(b);
        if (d.cmd === 'nav') PC_QUEUE.push({ type: 'nav', dir: d.dir });
        if (d.cmd === 'qualify') PC_QUEUE.push({ type: 'qualify', note: d.note, status: d.status });
      } catch(e){}
      resHttp.writeHead(200, { 'Content-Type': 'application/json' });
      resHttp.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (req.url === '/api/bridge-poll-pc') {
    const nextCmd = PC_QUEUE.shift() || {};
    resHttp.writeHead(200, { 'Content-Type': 'application/json' });
    return resHttp.end(JSON.stringify(nextCmd));
  }`
  );

  // Écoute sur 0.0.0.0:3000 pour accepter la connexion Wi-Fi de l'iPhone
  srv = srv.replace("server.listen(3000, '127.0.0.1'", "server.listen(3000, '0.0.0.0'");
  fs.writeFileSync('server_argent.js', srv, 'utf-8');
}

console.log('====================================================');
console.log('📱 PONT IPHONE ACTIVÉ SUR : ' + IPHONE_URL);
console.log('Clique sur "📱 Connecter iPhone" en haut de ton logiciel PC et scanne le QR Code !');
console.log('====================================================');
