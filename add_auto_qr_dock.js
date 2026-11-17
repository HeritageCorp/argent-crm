const fs = require('fs');
const os = require('os');

function getNetworkInterfacesList() {
  const nets = os.networkInterfaces();
  const res = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        res.push({ label: name + ' (' + net.address + ')', ip: net.address, url: 'http://' + net.address + ':3000/iphone?pair=auto' });
      }
    }
  }
  if (!res.length) res.push({ label: 'Localhost', ip: '127.0.0.1', url: 'http://127.0.0.1:3000/iphone?pair=auto' });
  return res;
}

const NET_LIST = getNetworkInterfacesList();

// 1. Met à jour server_argent.js pour suivre le ping temps réel de l'iPhone (statut connecté/déconnecté) et fournir la liste des IPs
let srv = fs.readFileSync('server_argent.js', 'utf-8');

if (!srv.includes('LAST_IPHONE_PING')) {
  srv = srv.replace('let BRIDGE_STATE = {};', 'let BRIDGE_STATE = {};\nlet LAST_IPHONE_PING = 0;');

  // Enregistre chaque requête de l'iPhone comme preuve de connexion active
  srv = srv.replace(
    "if (req.url === '/api/bridge' && req.method === 'GET') {",
    "if (req.url.startsWith('/api/net-info')) {\n    resHttp.writeHead(200, { 'Content-Type': 'application/json' });\n    return resHttp.end(JSON.stringify({ nets: " + JSON.stringify(NET_LIST) + ", iphoneOnline: (Date.now() - LAST_IPHONE_PING) < 4000 }));\n  }\n  if (req.url === '/api/bridge' && req.method === 'GET') {\n    LAST_IPHONE_PING = Date.now();"
  );

  fs.writeFileSync('server_argent.js', srv, 'utf-8');
}

// 2. Améliore iphone_remote.html avec bannière d'appairage automatique réussi et retour haptique
let iph = fs.readFileSync('iphone_remote.html', 'utf-8');

if (!iph.includes('pairBanner')) {
  const pairBannerHtml = `
  <!-- BANNIÈRE D APPAIRAGE AUTOMATIQUE -->
  <div id="pairBanner" class="hidden fixed top-3 inset-x-3 z-50 bg-emerald-500 text-zinc-950 font-extrabold text-xs px-4 py-3 rounded-2xl shadow-2xl flex items-center justify-between">
    <span>✓ Connexion automatique au PC réussie !</span>
    <button onclick="this.parentElement.classList.add('hidden')" class="font-black">✕</button>
  </div>`;

  iph = iph.replace('<body class="min-h-screen', pairBannerHtml + '\n<body class="min-h-screen');

  const autoPairScript = `
    if (window.location.search.indexOf("pair=auto") !== -1) {
      localStorage.setItem("argent_paired", "1");
      document.getElementById("autoTrigger").checked = true;
      var pb = document.getElementById("pairBanner");
      if (pb) { pb.classList.remove("hidden"); setTimeout(function(){ pb.classList.add("hidden"); }, 3500); }
    } else if (localStorage.getItem("argent_paired") === "1") {
      document.getElementById("autoTrigger").checked = true;
    }
  `;

  iph = iph.replace('pollBridge();', autoPairScript + '\n    pollBridge();');
  fs.writeFileSync('iphone_remote.html', iph, 'utf-8');
}

// 3. Met à jour cockpit_argent.html avec un Widget QR Code Flottant Permanent (en bas à gauche) + Voyant Live iPhone
let pc = fs.readFileSync('cockpit_argent.html', 'utf-8');

const qrDockHtml = [
  '  <!-- DOCK FLOTTANT QR CODE CONNEXION AUTO IPHONE -->',
  '  <div id="qrFloatingDock" class="fixed bottom-5 left-5 z-50">',
  '    <!-- Carte QR Dépliée -->',
  '    <div id="qrDockCard" class="lux-panel rounded-3xl p-4 border border-amber-400/40 shadow-2xl w-72 mb-2.5 space-y-3 transition-all duration-200">',
  '      <div class="flex items-center justify-between">',
  '        <div class="flex items-center gap-2">',
  '          <span id="dockLiveDot" class="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse"></span>',
  '          <span id="dockLiveText" class="text-[11px] font-extrabold uppercase tracking-wider text-amber-300">Scan Auto iPhone</span>',
  '        </div>',
  '        <button onclick="toggleQrDock()" class="text-zinc-400 hover:text-white text-xs font-bold px-1.5"> Réduire ▾</button>',
  '      </div>',
  '      <div class="bg-white p-2.5 rounded-2xl mx-auto w-44 h-44 flex items-center justify-center shadow-inner">',
  '        <img id="dockQrImg" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(NET_LIST[0].url) + '" class="w-40 h-40 rounded-lg">',
  '      </div>',
  '      <div class="space-y-1.5">',
  '        <label class="text-[10px] font-bold text-zinc-400 block text-center">Réseau détecté (Wi-Fi / Partage 4G) :</label>',
  '        <select id="netSelect" onchange="changeQrNetwork(this.value)" class="w-full lux-input rounded-xl px-2.5 py-1.5 text-[11px] text-amber-300 font-mono outline-none">',
  NET_LIST.map(n => '          <option value="' + n.url + '">' + n.label + '</option>').join('\n'),
  '        </select>',
  '      </div>',
  '      <p class="text-[10px] text-zinc-400 text-center leading-snug">Vise ce QR avec l\'appareil photo de l\'iPhone : connexion et synchronisation immédiates.</p>',
  '    </div>',
  '',
  '    <!-- Bouton Pilule Permanent -->',
  '    <button onclick="toggleQrDock()" class="lux-panel hover:bg-white/10 border border-white/15 px-4 py-2.5 rounded-2xl shadow-2xl flex items-center gap-2.5 transition">',
  '      <span id="pillLiveDot" class="h-2.5 w-2.5 rounded-full bg-amber-400"></span>',
  '      <span id="pillLiveText" class="text-xs font-extrabold text-white">📱 QR Connexion iPhone</span>',
  '    </button>',
  '  </div>'
].join('\n');

if (!pc.includes('qrFloatingDock')) {
  pc = pc.replace('<!-- NOTIFICATION ÉLÉGANTE -->', qrDockHtml + '\n  <!-- NOTIFICATION ÉLÉGANTE -->');

  const qrDockJs = [
    '    var wasIphoneOnline = false;',
    '    function toggleQrDock() {',
    '      document.getElementById("qrDockCard").classList.toggle("hidden");',
    '    }',
    '    function changeQrNetwork(url) {',
    '      document.getElementById("dockQrImg").src = "https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=" + encodeURIComponent(url);',
    '    }',
    '    setInterval(async function() {',
    '      try {',
    '        var r = await fetch("/api/net-info");',
    '        var info = await r.json();',
    '        var dot1 = document.getElementById("dockLiveDot");',
    '        var txt1 = document.getElementById("dockLiveText");',
    '        var dot2 = document.getElementById("pillLiveDot");',
    '        var txt2 = document.getElementById("pillLiveText");',
    '        if (info.iphoneOnline) {',
    '          dot1.className = "h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping";',
    '          txt1.innerText = "🟢 iPhone Connecté";',
    '          txt1.className = "text-[11px] font-extrabold uppercase tracking-wider text-emerald-400";',
    '          dot2.className = "h-2.5 w-2.5 rounded-full bg-emerald-400";',
    '          txt2.innerText = "🟢 iPhone Connecté en Live";',
    '          if (!wasIphoneOnline) {',
    '            wasIphoneOnline = true;',
    '            notify("📱 iPhone connecté automatiquement !");',
    '            document.getElementById("qrDockCard").classList.add("hidden");',
    '          }',
    '        } else {',
    '          dot1.className = "h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse";',
    '          txt1.innerText = "Scan Auto iPhone";',
    '          txt1.className = "text-[11px] font-extrabold uppercase tracking-wider text-amber-300";',
    '          dot2.className = "h-2.5 w-2.5 rounded-full bg-amber-400";',
    '          txt2.innerText = "📱 QR Connexion iPhone";',
    '          wasIphoneOnline = false;',
    '        }',
    '      } catch(e){}',
    '    }, 1500);'
  ].join('\n');

  pc = pc.replace('updateKpis();', qrDockJs + '\n    updateKpis();');
  fs.writeFileSync('cockpit_argent.html', pc, 'utf-8');
}

console.log('✓ Dock QR Code de Connexion Automatique intégré avec détection Live !');
