// ==UserScript==
// @name         Mult Manager
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Mult Manager para Tribal Wars: rotação de páginas com tempos fracionados e alertas via Discord.
// @match        https://*.tribalwars.com.br/game.php*
// @grant        GM_xmlhttpRequest
// @connect      discord.com
// @run-at       document-end
// ==/UserScript==

(function(){
  'use strict';

  // -------------------- AUX --------------------
  function getBrNumber(){ const m = location.hostname.match(/^br(\d+)\./); return m ? m[1] : '??'; }
  const BR_NUMBER = getBrNumber();

  const LOCK_KEY        = 'mm_lock_' + BR_NUMBER;
  const STATUS_KEY      = 'mm_status_' + BR_NUMBER;
  const TIMER_STATE_KEY = 'mm_timer_state_' + BR_NUMBER;
  const CAP_EVENT_KEY   = 'mm_cap_event_ts_' + BR_NUMBER;
  const INCOMINGS_STATE_KEY = 'mm_incomings_state_' + BR_NUMBER;
  const SELECTED_KEY    = 'mm_selected_' + BR_NUMBER;
  const SESSION_MASTER  = 'mm_is_master_' + BR_NUMBER;
  const VILLAGE_MAP_KEY = 'mm_vmap_' + BR_NUMBER;
  const PLAYER_CACHE_KEY = 'mm_player_cache_' + BR_NUMBER;

  // UI: Expand/Collapse (Comprar / Cunhar)
  const UI_EXPAND_EX_KEY = 'mm_ui_expand_exchange_' + BR_NUMBER;
  const UI_EXPAND_SN_KEY = 'mm_ui_expand_snob_' + BR_NUMBER;

  function lsGetBool(key, defVal = true){
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return defVal;
    return raw === '1' || raw === 'true';
  }
  function lsSetBool(key, val){
    localStorage.setItem(key, val ? '1' : '0');
  }


  // Ajuste de tempos
  const HEARTBEAT_INTERVAL = 1500;
  const LOCK_TOLERANCE     = 12000;
  const CAP_DEDUP_MS       = 60000;

  const COLORS = {
    ledOn:'#1fa949', ledOff:'#ff3333', ledCap:'#ffcc00',
    cur:'#1fa949', next:'#39a0ff', btnBorder:'#333',
    subTimerWait: '#888', subTimerActive: '#4eff60', subTimerDone: '#444',
    error: '#ff3333'
  };

  function pad(n){ return n<10?'0'+n:n; }
  function nowISO(){ const d=new Date(); return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

  // ---------- PLAYER / VILLAGE INFO ----------
  function getPlayerId(){
    try{
      if (window.game_data && window.game_data.player && window.game_data.player.id !== undefined && window.game_data.player.id !== null){
        return String(window.game_data.player.id);
      }
    }catch{}
    // Fallback: tenta achar o id em algum link de perfil
    const a = document.querySelector('a[href*="screen=info_player"][href*="id="], a[href*="screen=info_player"][href*="player_id="]');
    if(a){
      const href = a.getAttribute('href') || '';
      const m = href.match(/(?:player_id|id)=(\d+)/);
      if(m) return m[1];
    }
    return null;
  }

  function readPlayerCache(){
    try{
      const raw = localStorage.getItem(PLAYER_CACHE_KEY);
      return raw ? (JSON.parse(raw) || null) : null;
    } catch { return null; }
  }

  function writePlayerCache(id, name){
    if(!id || !name) return;
    try{
      localStorage.setItem(PLAYER_CACHE_KEY, JSON.stringify({ id:String(id), name:String(name), ts: Date.now() }));
    }catch{}
  }

  function isBadPlayerLabel(t){
    if(!t) return true;
    const s = String(t).trim();
    if(!s) return true;
    // Evita pegar labels de menu (ex.: "Perfil", "Perfil (1)", "Profile", etc.)
    const low = s.toLowerCase();
    const badStarts = ['perfil', 'profile', 'ranking', 'ajuda', 'help', 'configura', 'settings', 'mensagens', 'messages', 'fórum', 'forum', 'mapa', 'map', 'visão geral', 'overview'];
    if (badStarts.some(b => low === b || low.startsWith(b + ' ') || low.startsWith(b + ' (') || low.includes(b + ' ('))) return true;
    // Coordenadas não são nome
    if (/^\d+\|\d+$/.test(s)) return true;
    return false;
  }

  function getPlayerName(){
    // 1) Fonte preferencial
    try{
      if (window.game_data && window.game_data.player && window.game_data.player.name) {
        const n = String(window.game_data.player.name).trim();
        if (n && !isBadPlayerLabel(n)) {
          writePlayerCache(getPlayerId(), n);
          return n;
        }
      }
    }catch{}

    const pid = getPlayerId();

    // 2) Cache local (resolvido via /map/player.txt)
    const cache = readPlayerCache();
    if (cache && cache.id && cache.name && (!pid || String(cache.id) === String(pid))) {
      if (!isBadPlayerLabel(cache.name)) return String(cache.name);
    }

    // 3) DOM específico (quando o header expõe o nome real)
    const selectors = [
      '#player_info a[href*="info_player"]',
      '#player_info a',
      '#header_info a[href*="info_player"]',
      '#topbar a[href*="screen=info_player"]'
    ];
    for (const sel of selectors){
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes){
        const t = (el.textContent || '').replace(/\s+/g,' ').trim();
        if (!t || isBadPlayerLabel(t) || t.length < 2 || t.length > 60) continue;

        // Se temos player id, tenta validar o link
        const href = (el.getAttribute && el.getAttribute('href')) ? el.getAttribute('href') : '';
        if (pid && href){
          const m = href.match(/(?:player_id|id)=(\d+)/);
          if (m && m[1] && String(m[1]) !== String(pid)) continue;
        }

        writePlayerCache(pid, t);
        return t;
      }
    }

    return 'Desconhecido';
  }

  function prefetchPlayerName(){
    try{
      const pid = getPlayerId();
      if(!pid) return;

      const cache = readPlayerCache();
      const ttl = 7 * 24 * 60 * 60 * 1000; // 7 dias
      if (cache && cache.id === String(pid) && cache.name && cache.ts && (Date.now() - cache.ts) < ttl) return;

      const url = location.origin + '/map/player.txt';

      const parseAndStore = (txt)=>{
        try{
          const re = new RegExp('^' + pid + ',([^,]+),', 'm');
          const m = String(txt||'').match(re);
          if (m && m[1]){
            const name = String(m[1]).trim();
            if (name && !isBadPlayerLabel(name)) writePlayerCache(pid, name);
          }
        }catch{}
      };

      if (typeof GM_xmlhttpRequest === 'function'){
        GM_xmlhttpRequest({
          method:'GET',
          url,
          onload:(res)=>parseAndStore(res.responseText),
          onerror:()=>{}
        });
        return;
      }

      fetch(url, { credentials:'include' })
        .then(r=>r.text())
        .then(parseAndStore)
        .catch(()=>{});
    } catch {}
  }


  // --- MAPEAMENTO COORDENADA -> ID (Com Auto-Fetch) ---
  function getLocalMap() {
      try { return JSON.parse(localStorage.getItem(VILLAGE_MAP_KEY) || '{}'); } catch { return {}; }
  }

  function saveLocalMap(map) {
      localStorage.setItem(VILLAGE_MAP_KEY, JSON.stringify(map));
  }

  // Atualiza mapa com dados da página atual (sem fetch)
  function updateVillageMapLocal(){
    try {
        let map = getLocalMap();
        let changed = false;

        // 1. Mapeia a aldeia ATUAL (sempre garantido)
        if (window.game_data && window.game_data.village) {
            const v = window.game_data.village;
            const coord = v.x + '|' + v.y;
            if (v.id && map[coord] !== String(v.id)) {
                map[coord] = String(v.id);
                changed = true;
            }
        }

        // 2. Tenta game_data.player.villages (se disponível)
        if (typeof window.game_data !== 'undefined' && window.game_data.player && window.game_data.player.villages) {
            const villages = window.game_data.player.villages;
            if (typeof villages === 'object') {
                 Object.values(villages).forEach(v => {
                    let coord = null;
                    if(v.x != undefined && v.y != undefined) coord = v.x + '|' + v.y;
                    else if(v.coords) coord = v.coords;

                    if (coord && v.id) {
                        if (map[coord] !== String(v.id)) { map[coord] = String(v.id); changed = true; }
                    }
                });
            }
        }

        if (changed) saveLocalMap(map);
    } catch(e) { console.warn('Mult Manager: Local map update warning', e); }
  }

  // --- NOVO: BUSCA PROFUNDA DE IDs EM BACKGROUND ---
  let isFetching = false;
  function forceFetchVillageList() {
      if (isFetching) return;
      // Verifica se realmente precisa (se tem alguma coordenada configurada sem ID)
      const map = getLocalMap();
      const exList = (config.exchange && Array.isArray(config.exchange.villages)) ? config.exchange.villages : [];
      const snList = (config.snob && Array.isArray(config.snob.villages)) ? config.snob.villages : [];
      const missing = [...exList, ...snList].some(coord => coord && !map[coord]);
      if (!missing && Object.keys(map).length > 0) return; // Se já temos tudo, não faz fetch

      isFetching = true;
      console.log('Mult Manager: Buscando lista completa de aldeias em background...');

      const url = location.origin + '/game.php?screen=overview_villages&mode=combined';

      const req = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest : null;

      if (req) {
          req({
              method: "GET", url: url,
              onload: function(res) { parseAndSaveOverview(res.responseText); }
          });
      } else {
          fetch(url).then(r => r.text()).then(html => parseAndSaveOverview(html)).catch(()=>{ isFetching=false; });
      }
  }

  function parseAndSaveOverview(html) {
      try {
          const map = getLocalMap();
          let changed = false;

          // Vamos usar DOMParser para ser mais preciso
          const doc = new DOMParser().parseFromString(html, "text/html");
          const rows = doc.querySelectorAll('tr.nowrap'); // Linhas da tabela combinado

          rows.forEach(row => {
              // Tenta achar coordenadas
              const text = row.textContent;
              const coordMatch = text.match(/(\d{3}\|\d{3})/);
              if (!coordMatch) return;
              const coord = coordMatch[1];

              // Tenta achar link com ID
              const link = row.querySelector('a[href*="village="]');
              if (!link) return;
              const idMatch = link.href.match(/village=(\d+)/);
              if (!idMatch) return;
              const id = idMatch[1];

              if (map[coord] !== id) {
                  map[coord] = id;
                  changed = true;
              }
          });

          if (changed) {
              saveLocalMap(map);
              console.log('Mult Manager: Mapa atualizado via Fetch!', Object.keys(map).length + ' aldeias.');
              // Força re-render da UI para tirar o vermelho
              const uiList = document.getElementById('mm-list');
              if (uiList) createUI();
          }
      } catch (e) { console.error('Mult Manager: Erro no parse', e); }
      finally { isFetching = false; }
  }

  function getIdByCoord(coord) {
      const map = getLocalMap();
      return map[coord] || null;
  }

  function getCurrentId() {
      try {
          if (window.game_data && window.game_data.village && window.game_data.village.id) {
              return String(window.game_data.village.id);
          }
          const m = location.search.match(/[?&]village=(\d+)/);
          if(m) return m[1];
      } catch {}
      return null;
  }

  function getCurrentCoord() {
      try {
          if (window.game_data && window.game_data.village) {
              return window.game_data.village.x + '|' + window.game_data.village.y;
          }
      } catch {}
      return null;
  }

  // ---------------- CAPTCHA --------------------
  function detectCaptcha(){ return document.body && ((document.body.dataset && document.body.dataset.botProtect!==undefined) || document.body.hasAttribute('data-bot-protect')); }
  let captchaDetected=false;

  // ---------------- LOCK (MASTER / SLAVE) ---------------
  let myLockId = Math.random().toString(36).slice(2)+'_'+Date.now();
  let isActiveTab = false;
  let heartbeatWorker = null;

  function createWorker(interval) {
      const blob = new Blob([`
          let intervalId;
          self.onmessage = function(e) {
              if (e.data === 'start') {
                  if (intervalId) clearInterval(intervalId);
                  intervalId = setInterval(() => postMessage('tick'), ${interval});
              } else if (e.data === 'stop') {
                  if (intervalId) clearInterval(intervalId);
              }
          };
      `], { type: 'application/javascript' });
      return new Worker(URL.createObjectURL(blob));
  }

  function tryAcquireLock(forceOverride = false, checkStale = false){
    const now = Date.now();
    const raw = localStorage.getItem(LOCK_KEY);
    const wasMaster = sessionStorage.getItem(SESSION_MASTER) === 'true';

    if (!raw) { takeLock(now); return true; }
    let obj; try { obj = JSON.parse(raw); } catch { obj = null; }

    if (obj && obj.id === myLockId) { takeLock(now); return true; }
    if (forceOverride) { takeLock(now); return true; }
    if (checkStale) {
        const isStale = !obj || (now - obj.time > LOCK_TOLERANCE);
        if (isStale || wasMaster) { takeLock(now); return true; }
    }
    return false;
  }

  function takeLock(time){
      localStorage.setItem(LOCK_KEY, JSON.stringify({id: myLockId, time: time}));
      sessionStorage.setItem(SESSION_MASTER, 'true');
  }

  function startHeartbeat(){
    if (!heartbeatWorker) {
        heartbeatWorker = createWorker(HEARTBEAT_INTERVAL);
        heartbeatWorker.onmessage = () => {
            if (isActiveTab) { takeLock(Date.now()); } else { checkMasterStatus(); }
        };
    }
    heartbeatWorker.postMessage('start');
  }

  function checkMasterStatus(){
     if (!isActiveTab) {
         const raw = localStorage.getItem(LOCK_KEY);
         let isStale = false;
         if(!raw) isStale = true;
         else {
             try { const obj = JSON.parse(raw); if(Date.now() - obj.time > LOCK_TOLERANCE) isStale = true; } catch { isStale = true; }
         }
         if (isStale) { if(config.active && getCurrentKey()) becomeMaster(); }
     }
  }

  function becomeMaster(){
      if (tryAcquireLock(true, true)) {
          isActiveTab = true;
          startTimer();
          updateLed();
      }
  }

  function releaseLock(){
      try{
          const raw=localStorage.getItem(LOCK_KEY);
          if(raw){ const obj=JSON.parse(raw); if(obj.id===myLockId) localStorage.removeItem(LOCK_KEY); }
          if (!config.active) sessionStorage.removeItem(SESSION_MASTER);
      }catch{}
  }

  if (tryAcquireLock(false, true)) { isActiveTab = true; }
  startHeartbeat();

  window.addEventListener('beforeunload', ()=>{
      if (isActiveTab) {
          try {
              const raw=localStorage.getItem(LOCK_KEY);
              if(raw){ const obj=JSON.parse(raw); if(obj.id===myLockId) localStorage.removeItem(LOCK_KEY); }
          } catch {}
      }
  });

  // ---------------- CONFIG ---------------------
  const DEFAULTS={
    active:true,

    // Páginas (setup padrão apenas no 1º uso – ver init abaixo)
    edp:{enabled:true,minutes:3},                 // Construir
    scave:{enabled:true,minutes:1.5},             // Coletar
    recrut:{enabled:true,minutes:0.5},            // Recrutar
    exchange:{enabled:true,minutes:10,villages:[]}, // Comprar (coord será preenchida no 1º uso)

    // Mantidas para uso posterior (o usuário pode ativar quando quiser)
    farm:{enabled:false,minutes:5},
    balance:{enabled:false,minutes:2},
    store:{enabled:false,minutes:2},
    snob:{enabled:false,minutes:2,villages:[]},

    // Segurança / integrações
    captcha:{enabled:true},
    discord:{enabled:false,webhook:''},
    attacks:{enabled:false} // Notificar ataques (via Discord webhook)
  };
  const CONFIG_KEY = 'mult_manager_' + BR_NUMBER;

  function saveConfig(cfg){
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  function deepMergeDefaults(target, defaults){
    for (const k of Object.keys(defaults)){
      const dv = defaults[k];

      // missing key -> clone default
      if (target[k] === undefined || target[k] === null){
        target[k] = JSON.parse(JSON.stringify(dv));
        continue;
      }

      // deep-merge plain objects (não mexe em arrays)
      const tv = target[k];
      const dvIsObj = (typeof dv === 'object' && dv !== null && !Array.isArray(dv));
      const tvIsObj = (typeof tv === 'object' && tv !== null && !Array.isArray(tv));
      if (dvIsObj){
        if (!tvIsObj) target[k] = {};
        deepMergeDefaults(target[k], dv);
      }
    }
  }

  function seedFirstVillageCoords(cfg){
    const coord = getCurrentCoord();
    if (!coord || !coord.match(/^\d+\|\d+$/)) return;

    if (!Array.isArray(cfg.exchange.villages)) cfg.exchange.villages = [];
    if (!Array.isArray(cfg.snob.villages)) cfg.snob.villages = [];

    // regra: na 1ª instalação, já entra a primeira coordenada disponível
    if (cfg.exchange.villages.length === 0) cfg.exchange.villages.push(coord);
    if (cfg.snob.villages.length === 0) cfg.snob.villages.push(coord);
  }

  function loadConfig(){
    const raw = localStorage.getItem(CONFIG_KEY);
    const firstInstall = !raw;

    let cfg;
    try{
      cfg = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULTS));
    } catch {
      cfg = JSON.parse(JSON.stringify(DEFAULTS));
    }

    // merge seguro (não sobrescreve falsy como false/0)
    deepMergeDefaults(cfg, DEFAULTS);

    // normalizações
    if (!cfg.exchange) cfg.exchange = JSON.parse(JSON.stringify(DEFAULTS.exchange));
    if (!cfg.snob) cfg.snob = JSON.parse(JSON.stringify(DEFAULTS.snob));
    if (!Array.isArray(cfg.exchange.villages)) cfg.exchange.villages = [];
    if (!Array.isArray(cfg.snob.villages)) cfg.snob.villages = [];

    if (!cfg.captcha) cfg.captcha = { enabled:true };
    cfg.captcha.enabled = !!cfg.captcha.enabled;

    if (!cfg.discord) cfg.discord = { enabled:false, webhook:'' };
    cfg.discord.enabled = !!cfg.discord.enabled;
    cfg.discord.webhook = String(cfg.discord.webhook || '');

    if (!cfg.attacks) cfg.attacks = { enabled:false };
    cfg.attacks.enabled = !!cfg.attacks.enabled;

    if (typeof cfg.active !== 'boolean') cfg.active = true;

    // Setup padrão apenas no 1º uso (inclui coord padrão para páginas com coordenadas)
    if (firstInstall){
      seedFirstVillageCoords(cfg);
      saveConfig(cfg);
    } else {
      // fallback: se Comprar estiver ativo mas sem coords, tenta popular uma vez
      if (cfg.exchange?.enabled && cfg.exchange.villages.length === 0){
        seedFirstVillageCoords(cfg);
        saveConfig(cfg);
      }
    }

    return cfg;
  }
  let config=loadConfig();

  // ---------------- PÁGINAS --------------------
  function isScreen(name, mode=null) {
    if (window.game_data && window.game_data.screen) {
        if (window.game_data.screen !== name) return false;
        if (mode && window.game_data.mode !== mode) return false;
        return true;
    }
    const url = location.href.split('#')[0];
    const searchPart = url.split('?')[1] || '';
    const p = new URLSearchParams(searchPart);
    if (p.get('screen') !== name) return false;
    if (mode && p.get('mode') !== mode) return false;
    return true;
  }

  const PAGE_DEFS={
    farm:    { name:'Farm',      check:()=>isScreen('am_farm'), url:'game.php?screen=am_farm' },
    scave:   { name:'Coleta',    check:()=>isScreen('place','scavenge_mass'), url:'game.php?screen=place&mode=scavenge_mass' },
    balance: { name:'Balancear', check:()=>isScreen('info_player'), url:'game.php?screen=info_player' },
    store:   { name:'Geral',     check:()=>isScreen('overview_villages','prod'), url:'game.php?screen=overview_villages&mode=prod' },
    recrut:  { name:'Recrutar',  check:()=>isScreen('train'), url:'game.php?screen=train' },
    edp:     { name:'Construir', check:()=>isScreen('main'), url:'game.php?screen=main' },
    exchange:{ name:'Comprar',   check:()=>isScreen('market','exchange'), url:'game.php?screen=market&mode=exchange' },
    snob:    { name:'Cunhar',   check:()=>isScreen('snob'), url:'game.php?screen=snob' }
  };
  const ALL_KEYS = Object.keys(PAGE_DEFS);

  function loadSelected(){ const raw=localStorage.getItem(SELECTED_KEY); try{ const arr=raw?JSON.parse(raw):[]; return Array.isArray(arr)?arr.filter(k=>ALL_KEYS.includes(k)):[]; }catch{ return []; } }
  function saveSelected(arr){ localStorage.setItem(SELECTED_KEY, JSON.stringify(arr)); }
  let ROTATION = loadSelected();

  // Setup padrão de rotação (1ª instalação ou quando ainda não há seleção salva)
  const DEFAULT_ROTATION = ['edp','scave','recrut','exchange'];
  if (!Array.isArray(ROTATION) || ROTATION.length === 0){
    const hasSaved = !!localStorage.getItem(SELECTED_KEY);
    if (!hasSaved){
      ROTATION = DEFAULT_ROTATION.slice();
      saveSelected(ROTATION);
    }
  }

  function getVillageId(){
    try { if(window.game_data && window.game_data.village && window.game_data.village.id) return window.game_data.village.id; } catch(e){}
    const m = location.search.match(/[?&]village=(\d+)/);
    if (m) return m[1];
    return null;
  }

  function pageUrl(key){
    const def = PAGE_DEFS[key];
    const vid = getVillageId();
    const parts = def.url.split('?');
    const queryParams = parts[1] || '';
    if (vid) return location.origin + '/game.php?village=' + vid + '&' + queryParams;
    return location.origin + '/' + def.url;
  }

  function getCurrentKey(){ for (const k of ROTATION){ if (PAGE_DEFS[k]?.check()) return k; } return null; }
  function firstEnabledKey(){ return ROTATION.find(k=>config[k]?.enabled)||null; }
  function nextEnabledKey(fromKey){ const en=ROTATION.filter(k=>config[k]?.enabled); if(!en.length) return null; const i=en.indexOf(fromKey); return (i===-1)?en[0]:en[(i+1)%en.length]; }
  function nextPageUrl(){ const cur=getCurrentKey(); const nk=nextEnabledKey(cur); return nk ? pageUrl(nk) : null; }

  // ---------------- LÓGICA DE SUB-ROTAÇÃO (Comprar / Cunhar) ----------------
  function getSubRotationTarget(remainingMs, totalMinutes, villages){
      if (!villages || villages.length === 0) return null;
      const totalMs = totalMinutes * 60 * 1000;
      const elapsed = totalMs - remainingMs;
      const timePerVillage = totalMs / villages.length;

      let index = Math.floor(elapsed / timePerVillage);
      if (index >= villages.length) index = villages.length - 1;
      if (index < 0) index = 0;

      return {
          coord: villages[index],
          index: index,
          elapsed: elapsed,
          totalMs: totalMs,
          timePerVillage: timePerVillage
      };
  }

  function getExchangeTarget(remainingMs, totalMinutes, villages){
      return getSubRotationTarget(remainingMs, totalMinutes, villages);
  }

  function getSnobTarget(remainingMs, totalMinutes, villages){
      return getSubRotationTarget(remainingMs, totalMinutes, villages);
  }

function checkExchangeRotation(remainingMs){
     if (getCurrentKey() !== 'exchange') return;
     if (!config.exchange.enabled || !config.exchange.villages || !config.exchange.villages.length) return;

     const target = getExchangeTarget(remainingMs, config.exchange.minutes, config.exchange.villages);
     if (!target) return;

     const currentId = getCurrentId();
     const targetId = getIdByCoord(target.coord);

     if (targetId && currentId !== targetId) {
         const newUrl = location.origin + '/game.php?village=' + targetId + '&screen=market&mode=exchange';
         location.href = newUrl;
     }
  }

  function checkSnobRotation(remainingMs){
     if (getCurrentKey() !== 'snob') return;
     if (!config.snob.enabled || !config.snob.villages || !config.snob.villages.length) return;

     const target = getSnobTarget(remainingMs, config.snob.minutes, config.snob.villages);
     if (!target) return;

     const currentId = getCurrentId();
     const targetId = getIdByCoord(target.coord);

     if (targetId && currentId !== targetId) {
         const newUrl = location.origin + '/game.php?village=' + targetId + '&screen=snob';
         location.href = newUrl;
     }
  }

  // ---------------- DISCORD --------------------
  const FIXED_TEMPLATE =
    "📣 **{typeEmoji} {type}**\n" +
    "👤 Conta: **{player}**\n" +
    "🌎 Mundo: **{world}**\n" +
    "🕒 Quando: {when}\n" +
    "{details}\n" +
    "🔗 {url}";
  function fillTemplate(tpl,d){
    const t = (tpl || FIXED_TEMPLATE);
    const details = (d.details || '').trim();
    return t
      .replaceAll('{typeEmoji}', d.typeEmoji || '')
      .replaceAll('{type}', d.type || '')
      .replaceAll('{player}', d.player || 'Desconhecido')
      .replaceAll('{world}', d.world || '')
      .replaceAll('{when}', d.when || '')
      .replaceAll('{page}', d.page || '')
      .replaceAll('{count}', (d.count===0 || d.count) ? String(d.count) : '')
      .replaceAll('{details}', details)
      .replaceAll('{url}', d.url || '');
  }
  function sendDiscord(message){
    if(!config.discord.enabled) return; const url=(config.discord.webhook||'').trim(); if(!url) return;
    if (typeof GM_xmlhttpRequest==='function'){ try{ GM_xmlhttpRequest({method:'POST',url,headers:{'Content-Type':'application/json'},data:JSON.stringify({username:'Mult Manager',content:message})}); return; }catch{} }
    try{ fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Mult Manager',content:message})}); }catch{}
  }
  function notifyCaptchaOnce(reason){
    const now=Date.now(); let last=parseInt(localStorage.getItem(CAP_EVENT_KEY)||'0',10); if(isNaN(last)) last=0;
    if(now-last<CAP_DEDUP_MS) return; localStorage.setItem(CAP_EVENT_KEY,String(now));
    if(parseInt(localStorage.getItem(CAP_EVENT_KEY)||'0',10)!==now) return;

    const cur=getCurrentKey();
    const pageName = (cur? PAGE_DEFS[cur].name : '(fora de destino)');
    const details = [
      `📄 Página: **${pageName}**`,
      (reason ? `📝 Obs: ${reason}` : '')
    ].filter(Boolean).join('\n');

    const msg=fillTemplate(FIXED_TEMPLATE,{
      typeEmoji:'🧩',
      type:'Captcha',
      player:getPlayerName(),
      world:`BR${BR_NUMBER}`,
      when:nowISO(),
      details,
      url:location.href
    });

    sendDiscord(msg);
  }

  // ---------------- UI / ESTILO ----------------
  let timerInterval=null, timerTimeout=null, uiReady=false;

  function renderBrLabel(){
    const h=document.getElementById('mm-header'); if(!h) return;
    let s=h.querySelector('.mm-br'); if(!s){ s=document.createElement('span'); s.className='mm-br'; s.style.padding='6px 8px'; h.insertBefore(s,h.firstChild); }
    s.innerHTML = captchaDetected ? `Mult Manager (${BR_NUMBER} <span style="font-size:14px;" title="Captcha detectado! Script pausado.">⚠️</span>)` : `Mult Manager (${BR_NUMBER})`;
  }

  function createUI(){
    const old=document.getElementById('mm-ui'); if(old) old.remove();

    const style=document.createElement('style'); style.innerHTML=`
      .mm-row{display:flex;align-items:center;gap:4px;margin-bottom:4px}
      .mm-subrow{display:flex;align-items:center;gap:4px;margin-bottom:2px;padding-left:26px;}
      .mm-subtoggle{display:flex;align-items:center;gap:4px;margin-bottom:2px;padding-left:0;}
      .mm-goto{flex:1;min-width:56px;font-size:13px;background:#232323;border:1.25px solid ${COLORS.btnBorder};border-radius:7px;color:#f2f2f2;font-weight:700;cursor:pointer;padding:2px 12px;margin:0 6px;box-shadow:0 1.2px 3px #0007,0 .5px 0 #444 inset;transition:background .16s,color .15s,border .13s, box-shadow .15s; user-select:none}
      .mm-goto:hover{background:#181818;color:#9df47e;border-color:#494949;box-shadow:0 2px 6px #000b,0 0 0 1.25px #6fd9927a}
      .mm-onoff{display:inline-block;width:32px;height:18px;position:relative;vertical-align:middle}
      .mm-onoff input{display:none}
      .mm-slider{position:absolute;cursor:pointer;inset:0;background:#888;border-radius:18px;transition:.2s}
      .mm-onoff input:checked + .mm-slider{background:${COLORS.ledOn}}
      .mm-slider:before{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;background:#fff;border-radius:50%;transition:.2s}
      .mm-onoff input:checked + .mm-slider:before{transform:translateX(12px)}
      .mm-next{font-size:14px;margin-top:4px;color:#4eff60;text-align:center;font-weight:bold;letter-spacing:.4px}
      #mm-save{font-size:13px;width:66px;padding:3px 0;margin:0}
      #mm-actions{margin:8px 6px 6px;display:flex;gap:8px;align-items:center;justify-content:space-between}
      #mm-ui{position:fixed;z-index:2147483647;background:#222;color:#fff;border-radius:10px;box-shadow:0 0 8px #000a;min-width:210px;max-width:300px;font-family:sans-serif;padding:0;display:none}
      #mm-header{cursor:move;background:#111;border-radius:10px 10px 0 0;font-size:13.5px;display:flex;justify-content:space-between;align-items:center;padding:6px 8px}
      .mm-minput{width:56px;padding:2px 4px;background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;font-size:13px}
      .mm-coord-input{width:60px;padding:2px 4px;background:#1a1a1a;color:#9df47e;border:1px solid #333;border-radius:6px;font-size:12px;text-align:center;}
      .mm-coord-error{border-color:${COLORS.error} !important; color:${COLORS.error} !important;}
      .mm-minput-wide{width:100%;max-width:210px;padding:3px 6px;background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;font-size:13px}
      .mm-small{font-size:11.5px;color:#bbb}
      .mm-sub-timer{font-size:11px; color:#888; min-width:40px; text-align:right; font-family:monospace; margin-right:4px;}
      .mm-current{outline:2px solid ${COLORS.cur}; outline-offset:2px; box-shadow:0 0 0 1px ${COLORS.cur}55}
      .mm-nextkey{outline:2px solid ${COLORS.next}; outline-offset:2px; box-shadow:0 0 0 1px ${COLORS.next}55}
      .mm-led-small{width:6px;height:6px;border-radius:50%;background:#444;margin-right:4px;}
      .mm-led-cur{background:${COLORS.cur};box-shadow:0 0 4px ${COLORS.cur};}
      .mm-led-next{background:${COLORS.next};box-shadow:0 0 4px ${COLORS.next};}
      #mm-icon{background:#222;color:#fff;text-align:center;line-height:25px;font-family:sans-serif;font-size:12px;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative}
      #mm-led{position:absolute;width:8px;height:8px;border-radius:50%;top:2px;right:2px}
      .mm-list{display:flex;flex-direction:column;gap:4px;margin:4px 0}
      .mm-item{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
      .mm-item.dragging{opacity:.6}
      .mm-add{width:24px;height:24px;border-radius:6px;background:#2a2a2a;border:1px solid #3a3a3a;color:#fff;cursor:pointer}
      .mm-select{flex:1;min-width:120px;background:#1a1a1a;color:#fff;border:1px solid #333;border-radius:6px;padding:3px 6px}
    `; document.head.appendChild(style);

    const ui=document.createElement('div'); ui.id='mm-ui';
    const saved=localStorage.getItem('mm_position_'+BR_NUMBER); let left='100px', top='80px'; if(saved){ try{ const p=JSON.parse(saved); left=p.left; top=p.top; }catch{} }
    ui.style.left=left; ui.style.top=top;

    ui.innerHTML=`
      <div id="mm-header">
        <span class="mm-br">Mult Manager (${BR_NUMBER})</span>
        <button id="mm-min" style="background:transparent;border:none;color:#fff;font-size:14px;cursor:pointer;padding:6px 8px;">[-]</button>
      </div>
      <div id="mm-actions">
        <button id="mm-save">Salvar</button>
        <label class="mm-onoff" title="Ativar/desativar script">
          <input type="checkbox" id="mm-active"><span class="mm-slider"></span>
        </label>
      </div>
      <div id="mm-mid" style="display:block; padding:0 8px 8px;">
        <div class="mm-list" id="mm-list"></div>
        <hr style="border-color:#333; margin:6px 0;">
        <div class="mm-row"><input type="checkbox" id="mm-captcha"><span class="mm-goto" style="cursor:default">Captcha</span></div>
        <div class="mm-row"><input type="checkbox" id="mm-attacks"><span class="mm-goto" style="cursor:default">Ataques</span></div>
        <div class="mm-row"><input type="checkbox" id="mm-discord"><span class="mm-goto" style="cursor:default">Discord</span></div>
        <div class="mm-row" style="gap:6px;">
          <label class="mm-small" style="min-width:54px;">Webhook</label>
          <input type="text" id="mm-discord-url" class="mm-minput-wide" placeholder="https://discord.com/api/webhooks/...">
          <button id="mm-discord-test" class="mm-goto" style="max-width:96px;">Testar</button>
        </div>
        <div class="mm-next">Next: <span id="mm-timer">--:--</span></div>
      </div>`;
    document.body.appendChild(ui);

    document.getElementById('mm-active').checked  = config.active;
    document.getElementById('mm-captcha').checked = config.captcha.enabled;
    document.getElementById('mm-attacks').checked = !!(config.attacks && config.attacks.enabled);
    document.getElementById('mm-discord').checked = config.discord.enabled;
    document.getElementById('mm-discord-url').value = config.discord.webhook;

    const mid=document.getElementById('mm-mid'), btnMin=document.getElementById('mm-min'); let isMin=false;
    btnMin.textContent='[-]'; mid.style.display='block';
    btnMin.onclick=()=>{ isMin=!isMin; mid.style.display=isMin?'none':'block'; btnMin.textContent=isMin?'[+]':'[-]'; };

    let draggingPanel=false, offX=0, offY=0; const header=document.getElementById('mm-header');
    header.addEventListener('mousedown',e=>{ draggingPanel=true; const r=ui.getBoundingClientRect(); offX=e.clientX-r.left; offY=e.clientY-r.top; document.body.style.userSelect='none'; });
    document.addEventListener('mousemove',e=>{ if(!draggingPanel) return; ui.style.left=(e.clientX-offX)+'px'; ui.style.top=(e.clientY-offY)+'px'; });
    document.addEventListener('mouseup',()=>{ if(draggingPanel) localStorage.setItem('mm_position_'+BR_NUMBER, JSON.stringify({left:ui.style.left, top:ui.style.top})); draggingPanel=false; document.body.style.userSelect=''; });

    function renderList(){
      const list = document.getElementById('mm-list');
      list.innerHTML = '';
      ROTATION.forEach((k)=>{
        const row = document.createElement('div');
        row.className='mm-item';
        row.dataset.key = k;
        const chk = document.createElement('input'); chk.type='checkbox'; chk.id='mm-'+k; chk.checked=!!config[k]?.enabled;
        const btn = document.createElement('button'); btn.className='mm-goto drag-handle'; btn.id='btn-'+k; btn.dataset.goto=k; btn.textContent=PAGE_DEFS[k].name;
        const min = document.createElement('input'); min.type='number'; min.step='0.5'; min.min='0.5'; min.className='mm-minput'; min.id='mm-'+k+'-min'; min.value=String(config[k]?.minutes ?? 1); // mantém valor válido para <input type="number"> (suporta frações)
        const rm  = document.createElement('button'); rm.className='mm-add'; rm.textContent='−'; rm.title='Remover'; rm.dataset.action='remove'; rm.dataset.key=k;

        row.append(chk, btn, min, rm);
        list.appendChild(row);

        if (k === 'exchange') {
            const vList = config.exchange.villages || [];
            const exExpanded = (vList.length === 0) ? true : lsGetBool(UI_EXPAND_EX_KEY, true);

            // UI: botão único de expandir/retrair alinhado na coluna do checkbox (sem criar linha extra quando expandido)
            if (vList.length > 0 && !exExpanded) {
                const collapsedRow = document.createElement('div');
                collapsedRow.className = 'mm-subrow';

                const tbtn = document.createElement('button');
                tbtn.className = 'mm-add';
                tbtn.style.width = '20px';
                tbtn.style.height = '20px';
                tbtn.style.fontSize = '12px';
                tbtn.style.marginLeft = '-24px';
                tbtn.style.marginRight = '4px';
                tbtn.textContent = '+';
                tbtn.title = 'Expandir coordenadas (Comprar)';
                tbtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); lsSetBool(UI_EXPAND_EX_KEY, true); renderList(); };

                collapsedRow.appendChild(tbtn);
                list.appendChild(collapsedRow);
            }

            if (exExpanded && vList.length > 0) {
                vList.forEach((coord, idx) => {
                    const sub = document.createElement('div');
                    sub.className = 'mm-subrow';

                    // Toggle fica no primeiro item, recuado para a coluna do checkbox
                    if (idx === 0) {
                        const tbtn = document.createElement('button');
                        tbtn.className = 'mm-add';
                        tbtn.style.width = '20px';
                        tbtn.style.height = '20px';
                        tbtn.style.fontSize = '12px';
                        tbtn.style.marginLeft = '-24px';
                        tbtn.style.marginRight = '4px';
                        tbtn.textContent = '−';
                        tbtn.title = 'Retrair coordenadas (Comprar)';
                        tbtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); lsSetBool(UI_EXPAND_EX_KEY, false); renderList(); };
                        sub.appendChild(tbtn);
                    }

                    const led = document.createElement('div');
                    led.className = 'mm-led-small';
                    led.id = `led-ex-${idx}`;
                    sub.appendChild(led);

                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'mm-coord-input';
                    inp.value = coord;
                    inp.placeholder = 'XXX|YYY';
                    inp.id = `mm-ex-coord-${idx}`;

                    if (coord && !getIdByCoord(coord)) inp.classList.add('mm-coord-error');

                    const timerSpan = document.createElement('span');
                    timerSpan.className = 'mm-sub-timer';
                    timerSpan.id = `mm-ex-timer-${idx}`;
                    timerSpan.textContent = '[--:--]';

                    const rmb = document.createElement('button');
                    rmb.className = 'mm-add';
                    rmb.textContent = '−';
                    rmb.style.width = '20px';
                    rmb.style.height = '20px';
                    rmb.style.fontSize = '10px';

                    rmb.onclick = (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        config.exchange.villages.splice(idx, 1);
                        saveConfig(config);
                        renderList();
                    };

                    sub.append(inp, timerSpan, rmb);
                    list.appendChild(sub);
                });
            }

            // Botão "+" (adicionar) só aparece quando expandido (ou quando ainda não há coordenadas)
            if (exExpanded) {
                const addSub = document.createElement('div');
                addSub.className = 'mm-subrow';

                const addB = document.createElement('button');
                addB.className = 'mm-add';
                addB.textContent = '+';
                addB.style.width = '100%';
                addB.style.fontSize = '12px';
                addB.style.height = '20px';
                addB.onclick = (e) => { e.stopPropagation(); e.preventDefault(); config.exchange.villages.push(''); saveConfig(config); renderList(); };

                addSub.appendChild(addB);
                list.appendChild(addSub);
            }
        }

        if (k === 'snob') {
            const vList = config.snob.villages || [];
            const snExpanded = (vList.length === 0) ? true : lsGetBool(UI_EXPAND_SN_KEY, true);

            // UI: botão único de expandir/retrair alinhado na coluna do checkbox (sem criar linha extra quando expandido)
            if (vList.length > 0 && !snExpanded) {
                const collapsedRow = document.createElement('div');
                collapsedRow.className = 'mm-subrow';

                const tbtn = document.createElement('button');
                tbtn.className = 'mm-add';
                tbtn.style.width = '20px';
                tbtn.style.height = '20px';
                tbtn.style.fontSize = '12px';
                tbtn.style.marginLeft = '-24px';
                tbtn.style.marginRight = '4px';
                tbtn.textContent = '+';
                tbtn.title = 'Expandir coordenadas (Cunhar)';
                tbtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); lsSetBool(UI_EXPAND_SN_KEY, true); renderList(); };

                collapsedRow.appendChild(tbtn);
                list.appendChild(collapsedRow);
            }

            if (snExpanded && vList.length > 0) {
                vList.forEach((coord, idx) => {
                    const sub = document.createElement('div');
                    sub.className = 'mm-subrow';

                    // Toggle fica no primeiro item, recuado para a coluna do checkbox
                    if (idx === 0) {
                        const tbtn = document.createElement('button');
                        tbtn.className = 'mm-add';
                        tbtn.style.width = '20px';
                        tbtn.style.height = '20px';
                        tbtn.style.fontSize = '12px';
                        tbtn.style.marginLeft = '-24px';
                        tbtn.style.marginRight = '4px';
                        tbtn.textContent = '−';
                        tbtn.title = 'Retrair coordenadas (Cunhar)';
                        tbtn.onclick = (e) => { e.stopPropagation(); e.preventDefault(); lsSetBool(UI_EXPAND_SN_KEY, false); renderList(); };
                        sub.appendChild(tbtn);
                    }

                    const led = document.createElement('div');
                    led.className = 'mm-led-small';
                    led.id = `led-sn-${idx}`;
                    sub.appendChild(led);

                    const inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'mm-coord-input';
                    inp.value = coord;
                    inp.placeholder = 'XXX|YYY';
                    inp.id = `mm-sn-coord-${idx}`;

                    if (coord && !getIdByCoord(coord)) inp.classList.add('mm-coord-error');

                    const timerSpan = document.createElement('span');
                    timerSpan.className = 'mm-sub-timer';
                    timerSpan.id = `mm-sn-timer-${idx}`;
                    timerSpan.textContent = '[--:--]';

                    const rmb = document.createElement('button');
                    rmb.className = 'mm-add';
                    rmb.textContent = '−';
                    rmb.style.width = '20px';
                    rmb.style.height = '20px';
                    rmb.style.fontSize = '10px';

                    rmb.onclick = (e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        config.snob.villages.splice(idx, 1);
                        saveConfig(config);
                        renderList();
                    };

                    sub.append(inp, timerSpan, rmb);
                    list.appendChild(sub);
                });
            }

            // Botão "+" (adicionar) só aparece quando expandido (ou quando ainda não há coordenadas)
            if (snExpanded) {
                const addSub = document.createElement('div');
                addSub.className = 'mm-subrow';

                const addB = document.createElement('button');
                addB.className = 'mm-add';
                addB.textContent = '+';
                addB.style.width = '100%';
                addB.style.fontSize = '12px';
                addB.style.height = '20px';
                addB.onclick = (e) => { e.stopPropagation(); e.preventDefault(); config.snob.villages.push(''); saveConfig(config); renderList(); };

                addSub.appendChild(addB);
                list.appendChild(addSub);
            }
        }

      });

      const remaining = ALL_KEYS.filter(x=>!ROTATION.includes(x));
      const addRow = document.createElement('div'); addRow.className='mm-item'; addRow.dataset.key='';
      const select = document.createElement('select'); select.className='mm-select';
      const opt0 = document.createElement('option'); opt0.value=''; opt0.textContent='Escolher página…'; opt0.disabled=true; opt0.selected=true; select.appendChild(opt0);
      remaining.forEach(k=>{ const o=document.createElement('option'); o.value=k; o.textContent=PAGE_DEFS[k].name; select.appendChild(o); });
      const addBtn = document.createElement('button'); addBtn.className='mm-add'; addBtn.textContent='+'; addBtn.title='Adicionar'; addBtn.dataset.action='add';
      addRow.append(select, addBtn);
      list.appendChild(addRow);
      wireListEvents();
      updateVisuals();
    }

    let draggingRow = null; let dragActive = false;
    function wireListEvents(){
      const list = document.getElementById('mm-list');
      list.querySelectorAll('.mm-goto.drag-handle').forEach(btn=>{
        btn.addEventListener('click', (e)=>{
          if (dragActive) { e.preventDefault(); return; }
          const key = btn.dataset.goto;
          if (key) location.href = pageUrl(key);
        });
        btn.addEventListener('mousedown', (e)=>{
          const row = btn.closest('.mm-item'); row.setAttribute('draggable','true'); row.classList.add('drag-source');
        });
      });
      list.querySelectorAll('.mm-add').forEach(b=>{
        if(!b.dataset.action) return;
        b.onclick = (e)=>{
          e.stopPropagation(); e.preventDefault();
          const action = b.dataset.action;
          if (action==='remove'){
            const k = b.dataset.key; ROTATION = ROTATION.filter(x=>x!==k); saveSelected(ROTATION); renderList();
          } else if (action==='add'){
            const sel = b.previousElementSibling; const val = sel && sel.value;
            if (val && !ROTATION.includes(val)){
              ROTATION.push(val); if (!config[val]) config[val] = {enabled:true, minutes:1}; saveSelected(ROTATION); renderList();
            }
          }
        };
      });
      list.addEventListener('dragstart', (e)=>{
        const row = e.target.closest('.mm-item'); if (!row || !row.classList.contains('drag-source')) { e.preventDefault(); return; }
        draggingRow = row; dragActive = true; row.classList.add('dragging'); e.dataTransfer.effectAllowed='move';
      });
      list.addEventListener('dragover', (e)=>{
        if (!draggingRow) return; e.preventDefault(); const container = list;
        const after = getDragAfterElement(container, e.clientY);
        if (!after) container.insertBefore(draggingRow, container.firstChild); else container.insertBefore(draggingRow, after.nextSibling ? after.nextSibling : after);
      });
      list.addEventListener('dragend', ()=>{
        if (!draggingRow) return; draggingRow.classList.remove('dragging','drag-source'); draggingRow.removeAttribute('draggable');
        const keys = [...list.querySelectorAll('.mm-item')].map(r=>r.dataset.key).filter(Boolean);
        ROTATION = keys; saveSelected(ROTATION); draggingRow = null; setTimeout(()=>{ dragActive=false; }, 30);
      });
      function getDragAfterElement(container, y){
        const els = [...container.querySelectorAll('.mm-item:not(.dragging)')].filter(r=>r.dataset.key); if (!els.length) return null;
        return els.reduce((closest, child)=>{ const box = child.getBoundingClientRect(); const offset = y - box.top - box.height / 2; if (offset > 0 && offset < closest.offset) return { offset, element: child }; return closest; }, { offset: Number.POSITIVE_INFINITY }).element || els[els.length-1] || null;
      }
    }
    renderList();

    document.getElementById('mm-discord-test').onclick=()=>{
      config.discord.enabled=!!document.getElementById('mm-discord').checked;
      config.discord.webhook=(document.getElementById('mm-discord-url').value||'').trim();
      saveConfig(config);

      const msg = fillTemplate(FIXED_TEMPLATE,{
        typeEmoji:'✅',
        type:'Teste',
        player:getPlayerName(),
        world:`BR${BR_NUMBER}`,
        when:nowISO(),
        details:'🧪 Notificação de teste enviada com sucesso.',
        url:location.href
      });

      sendDiscord(msg);
    };

    document.getElementById('mm-save').onclick=()=>{
      // Tenta atualizar com o que tem na pagina
      updateVillageMapLocal();
      // Dispara fetch se tiver coordenadas sem ID
      forceFetchVillageList();
    prefetchPlayerName();

      const parsePtBr=v=>parseFloat(String(v).replace(',','.'))||1;
      ROTATION.forEach(k=>{
        const chk=document.getElementById(`mm-${k}`); const min=document.getElementById(`mm-${k}-min`);
        if (!config[k]) config[k]={enabled:true, minutes:1};
        if (chk) config[k].enabled=chk.checked;
        if (min) config[k].minutes=parsePtBr(min.value);
        if (k === 'exchange' && config.exchange.villages) {
            config.exchange.villages.forEach((_, idx) => {
                const inp = document.getElementById(`mm-ex-coord-${idx}`);
                if (inp) config.exchange.villages[idx] = inp.value.trim();
            });
            config.exchange.villages = config.exchange.villages.filter(x => x.match(/\d+\|\d+/));
        }

        if (k === 'snob' && config.snob.villages) {
            config.snob.villages.forEach((_, idx) => {
                const inp = document.getElementById(`mm-sn-coord-${idx}`);
                if (inp) config.snob.villages[idx] = inp.value.trim();
            });
            config.snob.villages = config.snob.villages.filter(x => x.match(/\d+\|\d+/));
        }
      });
      config.captcha.enabled=!!document.getElementById('mm-captcha').checked;
      if (!config.attacks) config.attacks={enabled:false};
      config.attacks.enabled=!!document.getElementById('mm-attacks').checked;
      config.discord.enabled=!!document.getElementById('mm-discord').checked;
      config.discord.webhook=(document.getElementById('mm-discord-url').value||'').trim();

      const isActiveNow = !!document.getElementById('mm-active').checked;
      config.active = isActiveNow;

      saveConfig(config); saveSelected(ROTATION);
      renderList();

      if(!isActiveNow) {
          localStorage.removeItem(TIMER_STATE_KEY);
          if (isActiveTab) releaseLock();
          isActiveTab = false;
          clearTimers();
          updateLed();
      } else {
          localStorage.removeItem(TIMER_STATE_KEY);
          becomeMaster();
      }
    };

    renderBrLabel();
    uiReady=true;
    document.addEventListener('click',(e)=>{
        const panel=document.getElementById('mm-ui');
        if(panel.style.display==='block' && !panel.contains(e.target) && !e.target.closest('#mm-icon')){
            panel.style.display='none';
        }
    });
  }

  // Atualiza cores dos botões e dos LEDs de coordenadas
  function updateVisuals() {
    const cur = getCurrentKey();
    const next = nextEnabledKey(cur || firstEnabledKey());
    ROTATION.forEach(k=>{ const el=document.getElementById('btn-'+k); if(!el) return; el.classList.remove('mm-current','mm-nextkey'); if(!config[k]?.enabled) return; if(k===cur) el.classList.add('mm-current'); else if(k===next) el.classList.add('mm-nextkey'); });
  }

  // Atualiza display e lógica de sub-rotação
  function updateTimerDisplay(ms){
      const t=document.getElementById('mm-timer'); if(!t) return;
      if(ms==null||isNaN(ms)){ t.textContent='--:--'; return; }
      const s=Math.max(0,Math.round(ms/1000)); t.textContent=`${pad(Math.floor(s/60))}:${pad(s%60)}`;

      // Update Sub-rotação LEDs e Sub-Timers (Comprar / Cunhar)
      const curKey = getCurrentKey();
      const subCfg = (curKey === 'exchange') ? { prefix:'ex', villages: (config.exchange.villages||[]), minutes: config.exchange.minutes, getTarget: getExchangeTarget }
                   : (curKey === 'snob')    ? { prefix:'sn', villages: (config.snob.villages||[]), minutes: config.snob.minutes, getTarget: getSnobTarget }
                   : null;

      if (subCfg && subCfg.villages.length > 0) {
          const target = subCfg.getTarget(ms, subCfg.minutes, subCfg.villages);

          subCfg.villages.forEach((_, i) => {
              const l=document.getElementById(`led-${subCfg.prefix}-${i}`);
              const ts=document.getElementById(`mm-${subCfg.prefix}-timer-${i}`);

              if(l && ts && target) {
                  l.className='mm-led-small';
                  // Logica de visualização do subtimer
                  if (i === target.index) {
                      l.classList.add('mm-led-cur');
                      ts.style.color = COLORS.subTimerActive;
                      const subS = Math.max(0, Math.ceil((target.timePerVillage - (target.elapsed % target.timePerVillage)) / 1000));
                      ts.textContent = `[${pad(Math.floor(subS/60))}:${pad(subS%60)}]`;
                  } else if (i > target.index) {
                      l.classList.add('mm-led-next');
                      ts.style.color = COLORS.subTimerWait;
                      const waitS = Math.round(target.timePerVillage / 1000);
                      ts.textContent = `[${pad(Math.floor(waitS/60))}:${pad(waitS%60)}]`;
                  } else {
                      ts.style.color = COLORS.subTimerDone;
                      ts.textContent = `[00:00]`;
                  }
              }
          });
      }
  }

  function updateLed(){
      const led=document.getElementById('mm-led'); if(!led) return;
      if(captchaDetected){ led.style.background=COLORS.ledCap; return; }
      const running = isActiveTab && config.active && getCurrentKey();
      led.style.background = running ? COLORS.ledOn : COLORS.ledOff;
  }

  function writeSharedStatus(currentKey,nextKey,remainingMs){ const st={holderId:(isActiveTab?myLockId:null),currentKey,nextKey,remainingMs,active:config.active,captcha:captchaDetected,ts:Date.now()}; localStorage.setItem(STATUS_KEY, JSON.stringify(st)); }

  // -------- TIMERS -------------
  function saveTimerState(remaining,currentKey){ localStorage.setItem(TIMER_STATE_KEY, JSON.stringify({remaining,lastKey:currentKey})); }
  function loadTimerState(currentKey){ const s=localStorage.getItem(TIMER_STATE_KEY); if(!s) return null; try{ const o=JSON.parse(s); if(o.lastKey===currentKey) return {remaining:o.remaining}; localStorage.removeItem(TIMER_STATE_KEY); }catch{ localStorage.removeItem(TIMER_STATE_KEY); } return null; }
  function clearTimers(){ if(timerInterval) clearInterval(timerInterval); if(timerTimeout) clearTimeout(timerTimeout); timerInterval=null; timerTimeout=null; updateTimerDisplay(null); }

  function startTimer(){
    clearTimers();
    const curKey=getCurrentKey();
    if(!isActiveTab || !config.active || !curKey || !config[curKey]?.enabled || captchaDetected){
      const nx=nextEnabledKey(curKey||firstEnabledKey()); writeSharedStatus(curKey,nx,null); updateLed(); return;
    }
    const nxKey=nextEnabledKey(curKey);
    const ms=Math.round((config[curKey].minutes||1)*60*1000);
    const restored=loadTimerState(curKey);
    const duration=restored?Math.min(restored.remaining,ms):ms;
    const end=Date.now()+duration;

    // Timer visual e checagem de sub-rotação
    timerInterval=setInterval(()=>{
        const left=Math.max(0,end-Date.now());
        updateTimerDisplay(left);
        saveTimerState(left,curKey);
        writeSharedStatus(curKey,nxKey,left);
        updateVisuals();

        checkExchangeRotation(left);
        checkSnobRotation(left);

        if(left<=0) clearInterval(timerInterval);
    },500);

    timerTimeout=setTimeout(()=>{ if(!isActiveTab || !config.active || captchaDetected) return; const url=nextPageUrl(); if(url) location.href=url; }, end-Date.now());

    writeSharedStatus(curKey,nxKey,end-Date.now()); updateVisuals(); updateLed();
  }

  // ------ Espelho de status ---
  function readSharedStatusAndRender(){
    const ui=document.getElementById('mm-ui'); if(!uiReady||!ui) return;
    let st=null; const raw=localStorage.getItem(STATUS_KEY); if(raw){ try{ st=JSON.parse(raw); }catch{} }
    let cur=null,next=null,rem=null,act=true;
    if(st){ cur=st.currentKey||null; next=st.nextKey||null; rem=(typeof st.remainingMs==='number')?st.remainingMs:null; act=!!st.active; captchaDetected=!!st.captcha; renderBrLabel(); }
    if(!cur){ cur=getCurrentKey(); next=nextEnabledKey(cur||firstEnabledKey()); }
    if (!isActiveTab) updateTimerDisplay(rem);
    updateVisuals();
    updateLed();
  }

  // --------- Watchers -----------
  setInterval(()=>{
    try{
      const found=detectCaptcha(); if(!config.captcha.enabled) return;
      if(found && !captchaDetected){
        captchaDetected=true; clearTimers(); renderBrLabel(); notifyCaptchaOnce('Detectado nesta aba');
        const cur=getCurrentKey(); const nx=nextEnabledKey(cur||firstEnabledKey()); writeSharedStatus(cur,nx,null);
      } else if(!found && captchaDetected){
        captchaDetected=false; renderBrLabel(); if(isActiveTab) startTimer();
      }
      updateLed();
    }catch{}
  

  // --------- Alertas de ATAQUE (Discord webhook) ----------
  function getIncomingAttacksCount(){
    try{
      const el = document.querySelector('#incomings_amount') ||
                 document.querySelector('#incomings_cell #incomings_amount') ||
                 document.querySelector('a[href*="mode=incomings"][href*="subtype=attacks"] #incomings_amount');
      if(!el) return null;
      const n = parseInt(String(el.textContent||'').trim(),10);
      return Number.isFinite(n) ? n : 0;
    } catch { return null; }
  }

  function readIncomingsState(){
    const raw = localStorage.getItem(INCOMINGS_STATE_KEY);
    if(!raw) return { last: null, ts: 0, lockTs: 0 };
    try{
      const st = JSON.parse(raw) || {};
      return {
        last: (typeof st.last === 'number') ? st.last : null,
        ts: (typeof st.ts === 'number') ? st.ts : 0,
        lockTs: (typeof st.lockTs === 'number') ? st.lockTs : 0
      };
    } catch { return { last: null, ts: 0, lockTs: 0 }; }
  }

  function writeIncomingsState(st){
    localStorage.setItem(INCOMINGS_STATE_KEY, JSON.stringify(st));
  }

  function checkAndNotifyIncomings(){
    if(!config?.attacks?.enabled) return;
    if(!config?.discord?.enabled) return;

    const url = (config.discord.webhook||'').trim();
    if(!url) return;

    const count = getIncomingAttacksCount();
    if(count===null) return;

    const st = readIncomingsState();

    // Primeira leitura: só registra baseline (evita notificar na instalação)
    if(st.last === null){
      writeIncomingsState({ last: count, ts: Date.now(), lockTs: 0 });
      return;
    }

    // Evita duplicidade em múltiplas abas (janela curta de lock)
    const now = Date.now();
    if(st.lockTs && (now - st.lockTs) < 4500) return;

    if(count > st.last){
      // novo(s) ataque(s)
      writeIncomingsState({ last: count, ts: now, lockTs: now });

      const details = `⚔️ Ataques chegando: **${count}**`;
      const msg = fillTemplate(FIXED_TEMPLATE,{
        typeEmoji:'⚔️',
        type:'Ataque',
        player:getPlayerName(),
        world:`BR${BR_NUMBER}`,
        when:nowISO(),
        details,
        url:location.href
      });

      sendDiscord(msg);
    } else if(count < st.last){
      // baixou (ataques chegaram/foram removidos) -> atualiza baseline
      writeIncomingsState({ last: count, ts: now, lockTs: 0 });
    }
  }

  setInterval(()=>{ try{ checkAndNotifyIncomings(); }catch{} }, 2500);

},1200);

  window.addEventListener('storage',(ev)=>{
    if(ev.key===STATUS_KEY || ev.key===TIMER_STATE_KEY){ readSharedStatusAndRender(); }
    if (ev.key === LOCK_KEY && isActiveTab) {
        const x = JSON.parse(localStorage.getItem(LOCK_KEY)||'{}');
        if (x.id && x.id !== myLockId) {
            isActiveTab = false;
            clearTimers();
            updateLed();
            sessionStorage.removeItem(SESSION_MASTER);
        }
    }
  });

  setInterval(readSharedStatusAndRender,800);

  // ------------- Ícone lateral -------------
  function createSideIconElement(ref){
    const ico=document.createElement('div'); ico.id='mm-icon'; ico.innerHTML='MM<span id="mm-led"></span>'; ico.className='quest opened'; ico.style.position='relative'; ico.style.zIndex='2147483647';
    if(ref){ ico.style.width=ref.offsetWidth+'px'; ico.style.height=ref.offsetHeight+'px'; ico.style.lineHeight=ref.offsetHeight+'px'; const cs=getComputedStyle(ref); ico.style.marginTop=cs.marginTop; ico.style.marginBottom=cs.marginBottom; }
    else {
        Object.assign(ico.style, {
            position: 'fixed', top: '120px', right: '10px', width: '35px', height: '35px',
            background: '#d2c09e', border: '2px solid #6c4824', borderRadius: '4px',
            lineHeight: '35px', fontWeight:'bold', color: '#553311', cursor:'pointer'
        });
    }

    ico.onclick=(e)=>{
        const panel=document.getElementById('mm-ui');
        if(panel){
            panel.style.display='block';
            const mid=document.getElementById('mm-mid');
            const btn=document.getElementById('mm-min');
            if(mid&&btn){ mid.style.display='block'; btn.textContent='[-]'; }
        }
        e.stopPropagation();
    };
    let led=ico.querySelector('#mm-led'); if(!led){ led=document.createElement('span'); led.id='mm-led'; Object.assign(led.style,{position:'absolute',width:'8px',height:'8px',borderRadius:'50%',top:'2px',right:'2px'}); ico.appendChild(led); }
    return ico;
  }
  function findSideStackAnchor(){
    const sels=['#questlog_new','#questlog','.questlog','#new_quest','#event-notification','#daily_bonus','.quest.opened','.quest'];
    for (const s of sels){ const el=document.querySelector(s); if(el) return el; }
    return null;
  }
  function placeIconInSideStack(){
    const a=findSideStackAnchor();
    if(!a) {
        let ico = document.getElementById('mm-icon');
        if(ico && ico.parentNode !== document.body) { ico.remove(); ico=null; }
        if(!ico) {
            ico = createSideIconElement(null);
            document.body.appendChild(ico);
        }
        updateLed();
        return true;
    }
    const parent=(a.id==='questlog'||a.id==='questlog_new'||a.classList?.contains('questlog'))?a:a.parentElement; if(!parent) return false;
    const ref=(a.id==='questlog'||a.id==='questlog_new'||a.classList?.contains('questlog'))?(parent.querySelector('.quest, .opened, #new_quest')||a):a;
    const ico=createSideIconElement(ref); const old=parent.querySelector('#mm-icon'); if(old) old.remove(); parent.appendChild(ico); updateLed(); return true;
  }
  let sideObserver=null;
  function ensureIconPresent(){ if(document.getElementById('mm-icon')) return true; return placeIconInSideStack(); }
  function watchSideStack(){
    if (ensureIconPresent()) return;
    if (sideObserver) sideObserver.disconnect();
    sideObserver=new MutationObserver(()=>{ if(ensureIconPresent()){ sideObserver.disconnect(); sideObserver=null; } });
    sideObserver.observe(document.body,{childList:true,subtree:true});
  }
  setInterval(()=>{ if(!document.getElementById('mm-icon')) watchSideStack(); },3000);
  (function(){ let last=location.href; setInterval(()=>{ if(location.href!==last){ last=location.href; setTimeout(()=>watchSideStack(),50); } },400); })();
  function createIcon(){ watchSideStack(); }

  // ------------- Boot -------------
  function safeBoot(){
    try{
      if(!document.body) return setTimeout(safeBoot,50);

      updateVillageMapLocal();
      forceFetchVillageList(); // Tenta corrigir IDs vermelhos

      createUI(); createIcon(); updateLed();

      if (!isActiveTab) { checkMasterStatus(); }
      if (isActiveTab && config.active) { startTimer(); } else { readSharedStatusAndRender(); }
    }catch{ setTimeout(safeBoot,100); }
  }
  safeBoot();

})();
