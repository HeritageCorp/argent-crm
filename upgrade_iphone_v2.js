const fs = require('fs');
const os = require('os');

// Récupère toutes les adresses IPv4 utiles (Wi-Fi + Partage de connexion iPhone)
function getAllLocalIps() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        list.push({ name, ip: net.address });
      }
    }
  }
  return list.length ? list : [{ name: 'Local', ip: '127.0.0.1' }];
}

const IPS = getAllLocalIps();
const PRIMARY_URL = 'http://' + IPS[0].ip + ':3000/iphone';

// 2. Génère la nouvelle application iPhone Remote Pro v2 (Dictée Siri, Auto-Chain, Liens CB, Anti-Veille, Swipe)
const iphoneProHtml = [
'<!DOCTYPE html>',
'<html lang="fr">',
'<head>',
'  <meta charset="UTF-8">',
'  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
'  <meta name="apple-mobile-web-app-capable" content="yes">',
'  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
'  <meta name="apple-mobile-web-app-title" content="Kynext iOS">',
'  <title>Kynext — Télécommande iPhone</title>',
'  <script src="https://cdn.tailwindcss.com"></script>',
'  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;600;700;800&display=swap" rel="stylesheet">',
'  <style>',
'    body { font-family: "Plus Jakarta Sans", sans-serif; background: #050507; color: #fff; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }',
'    .glass { background: rgba(20, 20, 26, 0.82); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.08); }',
'    .gold-grad { background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); color: #09090b; }',
'    .em-grad { background: linear-gradient(135deg, #34d399 0%, #10b981 100%); color: #052e16; }',
'  </style>',
'</head>',
'<body class="min-h-screen flex flex-col justify-between p-3.5 select-none">',
'',
'  <!-- BARRE SUPÉRIEURE : CONNEXION + WAKE LOCK + AUTO-CHAIN -->',
'  <header class="glass rounded-2xl px-3.5 py-2.5 flex items-center justify-between">',
'    <div class="flex items-center gap-2">',
'      <span id="connDot" class="h-2.5 w-2.5 rounded-full bg-emerald-400 animate-ping"></span>',
'      <div>',
'        <div class="font-extrabold text-[11px] tracking-wide uppercase text-emerald-400">Live Sync PC</div>',
'        <div id="callTimer" class="text-[10px] text-zinc-400 font-mono">Prêt • Anti-veille actif</div>',
'      </div>',
'    </div>',
'    <div class="flex items-center gap-3">',
'      <label class="flex items-center gap-1 text-[10px] text-sky-300 font-bold">',
'        <input id="autoChain" type="checkbox" checked class="accent-sky-400 h-3.5 w-3.5"> Auto-Suivant',
'      </label>',
'      <label class="flex items-center gap-1 text-[10px] text-amber-300 font-bold">',
'        <input id="autoTrigger" type="checkbox" class="accent-amber-400 h-3.5 w-3.5"> Auto-Clic PC',
'      </label>',
'    </div>',
'  </header>',
'',
'  <!-- CARTE ENTREPRISE (SWIPE GAUCHE / DROITE SUPPORTÉ) -->',
'  <main id="swipeZone" class="my-3 flex-1 flex flex-col justify-between space-y-3">',
'    <div class="glass rounded-3xl p-4 space-y-2.5 relative overflow-hidden">',
'      <div class="flex justify-between items-center">',
'        <span id="mobMetier" class="text-[10px] font-extrabold uppercase px-2.5 py-0.5 rounded-full bg-amber-400/15 text-amber-300 border border-amber-400/30">Métier</span>',
'        <span id="mobStatus" class="text-[11px] font-bold text-zinc-300 bg-white/5 px-2.5 py-0.5 rounded-full">À contacter</span>',
'      </div>',
'      <h1 id="mobNom" class="text-xl font-extrabold text-white leading-snug">Sélectionne un artisan...</h1>',
'      <p id="mobVille" class="text-xs text-zinc-400">—</p>',
'      <div class="flex items-center justify-between pt-1 border-t border-white/10">',
'        <span id="mobTelBig" class="text-lg font-black text-emerald-400">Aucun numéro</span>',
'        <a id="mobSiteBtn" href="#" target="_blank" class="text-[11px] font-bold text-amber-300 underline">👁️ Voir sa maquette</a>',
'      </div>',
'',
'      <!-- TÉLÉPROMPTEUR PITCH INTÉGRÉ SUR L IPHONE -->',
'      <details class="bg-black/40 border border-white/5 rounded-xl p-2.5 text-xs text-zinc-300">',
'        <summary class="font-bold text-amber-400 cursor-pointer">🎙️ Afficher le Pitch Téléphone & Objections</summary>',
'        <p id="mobPitch" class="mt-2 text-[11px] leading-relaxed italic text-zinc-200"></p>',
'        <div class="mt-2 pt-2 border-t border-white/10 text-[10px] text-emerald-300 space-y-1">',
'          <div>• <strong>Tarif :</strong> 790  une seule fois (0  d\'abonnement)</div>',
'          <div>• <strong>Facilité :</strong> Payable en 2 × 395  sans frais</div>',
'          <div>• <strong>Délai :</strong> En ligne sous 48h (déjà prêt)</div>',
'        </div>',
'      </details>',
'    </div>',
'',
'    <!-- SÉLECTEUR RAPIDE DE SCÉNARIO WHATSAPP / SMS DEPUIS L IPHONE -->',
'    <div class="flex gap-1.5 overflow-x-auto pb-1">',
'      <button onclick="setScenarioFromPhone(\'v1\')" class="shrink-0 bg-zinc-900 border border-white/10 text-[11px] font-bold px-3 py-1.5 rounded-xl text-amber-300">✨ 1er Contact</button>',
'      <button onclick="setScenarioFromPhone(\'j3\')" class="shrink-0 bg-zinc-900 border border-white/10 text-[11px] font-bold px-3 py-1.5 rounded-xl text-zinc-300">🔁 Relance J+3</button>',
'      <button onclick="setScenarioFromPhone(\'tarif\')" class="shrink-0 bg-zinc-900 border border-white/10 text-[11px] font-bold px-3 py-1.5 rounded-xl text-zinc-300">💶 Prix 790</button>',
'      <button onclick="setScenarioFromPhone(\'2x\')" class="shrink-0 bg-zinc-900 border border-white/10 text-[11px] font-bold px-3 py-1.5 rounded-xl text-zinc-300">💳 2× 395</button>',
'      <button onclick="setScenarioFromPhone(\'fb\')" class="shrink-0 bg-zinc-900 border border-white/10 text-[11px] font-bold px-3 py-1.5 rounded-xl text-zinc-300">📱 Vs Facebook</button>',
'    </div>',
'',
'    <!-- 3 BOUTONS D ACTION PRINCIPAUX -->',
'    <div class="grid grid-cols-2 gap-2.5">',
'      <a id="btnCall" onclick="startLocalCallTimer()" href="#" class="col-span-2 bg-gradient-to-r from-indigo-600 to-blue-600 active:scale-95 text-white font-extrabold text-center py-4 rounded-2xl shadow-lg text-base">📞 APPELER L\'ARTISAN</a>',
'      <a id="btnWa" href="#" target="_blank" class="em-grad active:scale-95 font-extrabold text-center py-3.5 rounded-2xl shadow-lg text-xs">💬 WHATSAPP</a>',
'      <a id="btnSms" href="#" class="gold-grad active:scale-95 font-extrabold text-center py-3.5 rounded-2xl shadow-lg text-xs">✉️ SMS IPHONE</a>',
'    </div>',
'',
'    <!-- ENVOI DE LIENS DE PAIEMENT EN 1 TAP DEPUIS L IPHONE -->',
'    <div class="glass rounded-2xl p-2.5 space-y-1.5">',
'      <div class="text-[10px] font-bold uppercase text-zinc-400 text-center">💳 Envoyer Lien de Paiement WhatsApp en direct</div>',
'      <div class="grid grid-cols-3 gap-1.5">',
'        <button onclick="sendPayFromPhone(237, \'Acompte 30%\')" class="bg-sky-500/20 border border-sky-400/30 text-sky-200 text-[11px] font-extrabold py-2 rounded-xl">Acompte 237</button>',
'        <button onclick="sendPayFromPhone(395, \'1ère échéance 2x\')" class="bg-amber-500/20 border border-amber-400/30 text-amber-200 text-[11px] font-extrabold py-2 rounded-xl">2 × 395</button>',
'        <button onclick="sendPayFromPhone(790, \'Site Clé en Main\')" class="bg-emerald-500/20 border border-emerald-400/30 text-emerald-200 text-[11px] font-extrabold py-2 rounded-xl">Total 790</button>',
'      </div>',
'    </div>',
'',
'    <!-- DICTÉE VOCALE SIRI -> NOTES PC + QUALIFICATION 1-TAP -->',
'    <div class="glass rounded-2xl p-3 space-y-2">',
'      <div class="flex gap-1.5">',
'        <input id="quickNote" type="text" placeholder="🎙️ Touche le clavier puis le micro Siri..." class="flex-1 bg-black/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none">',
'        <button onclick="sendNoteToPc()" class="bg-amber-400 text-zinc-950 font-extrabold text-xs px-3.5 rounded-xl">Noter</button>',
'      </div>',
'      <div class="grid grid-cols-4 gap-1.5">',
'        <button onclick="qualifyFromPhone(\'Répondeur\', \'sent\')" class="bg-zinc-800 active:bg-zinc-700 text-[11px] font-bold py-2.5 rounded-xl">📼 Répond.</button>',
'        <button onclick="qualifyFromPhone(\'À rappeler\', \'sent\')" class="bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[11px] font-bold py-2.5 rounded-xl">⏰ Rappel</button>',
'        <button onclick="qualifyFromPhone(\'Très intéressé\', \'hot\')" class="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[11px] font-bold py-2.5 rounded-xl">🔥 Chaud</button>',
'        <button onclick="qualifyFromPhone(\'Vendu 790\', \'sold\')" class="bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 text-[11px] font-extrabold py-2.5 rounded-xl">✅ Vendu</button>',
'      </div>',
'    </div>',
'  </main>',
'',
'  <!-- NAVIGATION BASSE -->',
'  <footer class="grid grid-cols-3 gap-2">',
'    <button onclick="remoteNav(-1)" class="glass active:bg-white/10 py-3 rounded-2xl font-bold text-xs">◀ Préc.</button>',
'    <button onclick="remoteNextWithPhone()" class="bg-indigo-600/30 border border-indigo-400/40 text-indigo-200 active:bg-indigo-600/50 py-3 rounded-2xl font-extrabold text-xs">📞 Suiv. avec N°</button>',
'    <button onclick="remoteNav(1)" class="glass active:bg-white/10 py-3 rounded-2xl font-bold text-xs">Suiv. ▶</button>',
'  </footer>',
'',
'  <script>',
'    var currentSiren = "";',
'    var currentBridge = {};',
'    var lastActionId = 0;',
'    var callSec = 0;',
'    var callInterval = null;',
'',
'    // Active l anti-veille sur iOS Safari (WakeLock)',
'    async function enableWakeLock() {',
'      try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (e) {}',
'    }',
'    document.addEventListener("click", enableWakeLock, { once: true });',
'',
'    function startLocalCallTimer() {',
'      clearInterval(callInterval);',
'      callSec = 0;',
'      callInterval = setInterval(function() {',
'        callSec++;',
'        var m = String(Math.floor(callSec / 60)).padStart(2, "0");',
'        var s = String(callSec % 60).padStart(2, "0");',
'        document.getElementById("callTimer").innerText = "📞 En appel : " + m + ":" + s;',
'      }, 1000);',
'    }',
'',
'    async function pollBridge() {',
'      try {',
'        var r = await fetch("/api/bridge");',
'        var b = await r.json();',
'        if (b && b.siren) {',
'          currentBridge = b;',
'          document.getElementById("mobNom").innerText = b.nom || "—";',
'          document.getElementById("mobVille").innerText = "👤 " + (b.dirigeant || "Dirigeant") + " • 📍 " + (b.ville || "");',
'          document.getElementById("mobMetier").innerText = b.metier || "Artisan";',
'          document.getElementById("mobStatus").innerText = b.statusLabel || "À contacter";',
'          document.getElementById("mobTelBig").innerText = b.tel || "Aucun numéro";',
'          document.getElementById("mobSiteBtn").href = b.urlPublique || "#";',
'          document.getElementById("mobPitch").innerText = "« Bonjour, j\'ai vu que " + b.nom + " n\'avait pas de site vitrine sur Google à " + b.ville + ". Je vous ai préparé une maquette complète avec simulateur de devis. Je vous l\'envoie sur WhatsApp pour avoir votre avis ? »";',
'',
'          var cleanTel = (b.tel || "").replace(/\\s+/g, "");',
'          var intlTel = "33" + cleanTel.replace(/^0/, "");',
'          var msg = b.message || "";',
'',
'          document.getElementById("btnCall").href = cleanTel ? ("tel:" + cleanTel) : "#";',
'          document.getElementById("btnWa").href = cleanTel ? ("https://wa.me/" + intlTel + "?text=" + encodeURIComponent(msg)) : "#";',
'          document.getElementById("btnSms").href = cleanTel ? ("sms:" + cleanTel + "&body=" + encodeURIComponent(msg)) : "#";',
'',
'          if (b.siren !== currentSiren) {',
'            currentSiren = b.siren;',
'            if (navigator.vibrate) navigator.vibrate(35);',
'          }',
'',
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
'    function sendPayFromPhone(amount, label) {',
'      var cleanTel = (currentBridge.tel || "").replace(/\\s+/g, "");',
'      if (!cleanTel) return alert("Pas de numéro sur cette fiche");',
'      var intlTel = "33" + cleanTel.replace(/^0/, "");',
'      var base = (currentBridge.payBase || "https://paypal.me/").replace(/\\/$/, "");',
'      var txt = "Bonjour, voici le lien sécurisé (" + label + " : " + amount + " ) pour le site internet de " + currentBridge.nom + " : " + base + "/" + amount;',
'      window.open("https://wa.me/" + intlTel + "?text=" + encodeURIComponent(txt), "_blank");',
'    }',
'',
'    async function setScenarioFromPhone(sc) {',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "scenario", value: sc })',
'      });',
'      setTimeout(pollBridge, 250);',
'    }',
'',
'    async function sendNoteToPc() {',
'      var inp = document.getElementById("quickNote");',
'      if (!inp.value.trim()) return;',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "note", note: inp.value.trim() })',
'      });',
'      inp.value = "";',
'    }',
'',
'    async function qualifyFromPhone(note, status) {',
'      var autoNext = document.getElementById("autoChain").checked;',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "qualify", note: note, status: status, autoNext: autoNext })',
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
'    async function remoteNextWithPhone() {',
'      await fetch("/api/bridge-cmd", {',
'        method: "POST", headers: { "Content-Type": "application/json" },',
'        body: JSON.stringify({ cmd: "next_phone" })',
'      });',
'    }',
'',
'    // Gestes tactiles Swipe Gauche / Droite pour changer de fiche',
'    var touchStartX = 0;',
'    var zone = document.getElementById("swipeZone");',
'    zone.addEventListener("touchstart", function(e) { touchStartX = e.changedTouches[0].screenX; }, { passive: true });',
'    zone.addEventListener("touchend", function(e) {',
'      var diff = e.changedTouches[0].screenX - touchStartX;',
'      if (Math.abs(diff) > 75) { remoteNav(diff < 0 ? 1 : -1); }',
'    }, { passive: true });',
'',
'    setInterval(pollBridge, 600);',
'    pollBridge();',
'  </scr' + 'ipt>',
'</body>',
'</html>'
].join('\n');

fs.writeFileSync('iphone_remote.html', iphoneProHtml, 'utf-8');

// 3. Met à jour cockpit_argent.html pour gérer toutes les nouvelles commandes venant de l'iPhone (Dictée, Scénario, Prochain avec N°, Liens CB)
let cockpit = fs.readFileSync('cockpit_argent.html', 'utf-8');

// Met à jour la fonction pushToIphone pour inclure urlPublique et payBase
cockpit = cockpit.replace(
  /function pushToIphone\(actionType\)\s*\{[\s\S]*?\}\n/,
  `function pushToIphone(actionType) {
      if (!selected) return;
      var msgEl = document.getElementById("cpMessage");
      fetch("/api/bridge", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siren: selected.siren, nom: selected.nom, dirigeant: selected.dirigeant,
          ville: selected.ville, metier: selected.metier, tel: selected.tel || "",
          urlPublique: selected.urlPublique || "", payBase: cfg.pay || "https://paypal.me/",
          statusLabel: STATUS_LABELS[getStatus(selected.siren)] || "À contacter",
          message: msgEl ? msgEl.value : selected.sms,
          actionType: actionType || "", actionId: actionType ? Date.now() : 0
        })
      }).catch(function(){});
    }\n`
);

// Enrichit le récepteur d'ordres iPhone sur le PC
cockpit = cockpit.replace(
  /setInterval\(async function\(\)\s*\{\s*try\s*\{\s*var r = await fetch\("\/api\/bridge-poll-pc"\);[\s\S]*?\}, 800\);/,
  `setInterval(async function() {
      try {
        var r = await fetch("/api/bridge-poll-pc");
        var cmd = await r.json();
        if (!cmd || !cmd.type) return;
        if (cmd.type === "nav") navProspect(cmd.dir);
        if (cmd.type === "next_phone") {
          var list = filteredList.length ? filteredList : DATA;
          var idx = list.findIndex(function(p) { return p.siren === selected.siren; });
          for (var i = idx + 1; i < list.length; i++) {
            if (list[i].tel && getStatus(list[i].siren) === "todo") { selectProspect(list[i].siren); break; }
          }
        }
        if (cmd.type === "scenario") {
          document.getElementById("scenarioSelect").value = cmd.value;
          choisirScenario(cmd.value);
          notify("📱 Scénario changé depuis l'iPhone");
        }
        if (cmd.type === "note") {
          var prev = (state[selected.siren] && state[selected.siren].notes) ? state[selected.siren].notes : "";
          var h = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
          var newNote = (prev ? prev + " | " : "") + "[🎙️ iPhone " + h + "] " + cmd.note;
          state[selected.siren] = Object.assign({}, state[selected.siren] || {}, { notes: newNote });
          document.getElementById("callNotes").value = newNote;
          saveState();
          notify("🎙️ Note dictée reçue de l'iPhone !");
        }
        if (cmd.type === "qualify") {
          qualifierAppel(cmd.note, cmd.status);
          if (cmd.autoNext) {
            var list2 = filteredList.length ? filteredList : DATA;
            var idx2 = list2.findIndex(function(p) { return p.siren === selected.siren; });
            for (var j = idx2 + 1; j < list2.length; j++) {
              if (list2[j].tel) { selectProspect(list2[j].siren); break; }
            }
          }
        }
      } catch(e){}
    }, 650);`
);

// Ajoute un bouton "📲 Envoyer vers iPhone" à côté du bouton d'appel sur le PC
cockpit = cockpit.replace(
  '📞 " + selected.tel + "</a>"',
  '📞 " + selected.tel + "</a><button onclick=\\"pushToIphone(\'call\'); notify(\'📲 Appel envoyé sur ton iPhone !\')\\" class=\\"bg-amber-400 hover:bg-amber-300 text-zinc-950 text-xs font-extrabold px-3.5 py-2.5 rounded-xl shadow transition\\">📲 Appeler via iPhone</button>"'
);

fs.writeFileSync('cockpit_argent.html', cockpit, 'utf-8');

// 4. Met à jour server_argent.js pour router les nouvelles commandes iPhone -> PC
let srv = fs.readFileSync('server_argent.js', 'utf-8');
srv = srv.replace(
  /if \(d\.cmd === 'qualify'\) PC_QUEUE\.push\(\{ type: 'qualify', note: d\.note, status: d\.status \}\);/,
  `if (d.cmd === 'qualify') PC_QUEUE.push({ type: 'qualify', note: d.note, status: d.status, autoNext: d.autoNext });
        if (d.cmd === 'note') PC_QUEUE.push({ type: 'note', note: d.note });
        if (d.cmd === 'scenario') PC_QUEUE.push({ type: 'scenario', value: d.value });
        if (d.cmd === 'next_phone') PC_QUEUE.push({ type: 'next_phone' });`
);
fs.writeFileSync('server_argent.js', srv, 'utf-8');

console.log('✓ Télécommande iPhone Pro v2 activée sur : ' + PRIMARY_URL);
