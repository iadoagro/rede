/* Portas e ligações da Topologia: quantas portas cada equipamento tem, em qual porta cada cabo
   está ligado, painel de portas (com dados ao vivo do SSH quando houver), inspetor de porta,
   formulário "Ligar cabo", gráfico de tráfego e a gaveta de detalhes (abas Resumo/Portas/Tráfego).
   Depende de app.js (S, TYPE_INFO, ipCmp, esc, fmtRT, fmtClock, svcChips, openModal), icons.js (NetIcons)
   e topo-ui.js (topoName, physPortsOf, portSpeedCls, trafficRates, fmtRate, fmtSpeed, activeView...). */
'use strict';

S.topoCfg = { links: null, inventory: {} };   // links: null = ainda não carregou (usa S.cfg.links)
S._cfgRev = 0;                                 // sobe a cada mudança de ligações/inventário (invalida caches)
S.topoPortSel = null;                          // rótulo da porta selecionada ("3", "S1")
S.topoForm = null;                             // formulário "Ligar cabo" aberto
S.topoCfgOpen = false;                         // bloco "configurar portas" aberto
S.topoSw = null;                               // formulário "Adicionar switch" aberto
S.trafHist = {};                               // host -> { agg:[{t,rx,tx}], ports:{ nome:[...] } }
let _tdKey = '', _tdIp = null, _tdMsgT = null;

const gid = id => document.getElementById(id);
const fmtBytesN = b => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; };

/* ───────── rótulos de porta: "3" (RJ45) e "S1" (SFP) ───────── */
function portLabelOf(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^s\d+$/i.test(s)) return 'S' + String(+s.slice(1));
  if (/^\d+$/.test(s)) return String(+s);
  const m = s.match(/^(\d+)[.,]/) || s.match(/(\d+)\s*$/);               // "1.LAN" ou "ether3"
  if (!m) return '';
  return (/sfp|qsfp/i.test(s) ? 'S' : '') + String(+m[1]);
}
const livePortLabel = (p, i) => portLabelOf(p.name) || ((p.kind === 'sfp' ? 'S' : '') + (i + 1));
const labelNum = l => +String(l).replace(/\D/g, '') || 0;
const labelIsSfp = l => /^S/i.test(String(l));
const cmpLabel = (a, b) => (labelIsSfp(a) - labelIsSfp(b)) || labelNum(a) - labelNum(b);
const actPctOf = p => Math.min(100, Math.sqrt(((p.rxBps || 0) + (p.txBps || 0)) / ((p.speed || 1000) * 1e6)) * 100);

/* ───────── configuração: ligações e inventário (salvos no servidor) ───────── */
const invOf = ip => (S.topoCfg.inventory && S.topoCfg.inventory[ip]) || {};
function normLink(l) {
  if (!Array.isArray(l) || l.length < 2 || !l[0] || !l[1]) return null;
  const m = String(l[4] || '').toLowerCase();
  return { from: String(l[0]).trim(), to: String(l[1]).trim(), fp: portLabelOf(l[2]), tp: portLabelOf(l[3]), m: m === 'utp' || m === 'fibra' ? m : '' };
}
let _lk = { ref: null, rev: -1, list: [], idx: new Map() };
// ligações normalizadas {from,to,fp,tp}; fp/tp = rótulo da porta de cada lado ('' = não definida)
function topoLinks() {
  const raw = (S.topoCfg.links !== null ? S.topoCfg.links : S.cfg.links) || [];
  if (_lk.ref === raw && _lk.rev === S._cfgRev) return _lk.list;
  const list = [], seen = new Set(), idx = new Map();
  const put = (ip, label, info) => { if (!label) return; if (!idx.has(ip)) idx.set(ip, new Map()); idx.get(ip).set(label, info); };
  raw.forEach(r => {
    const l = normLink(r);
    if (!l || l.from === l.to || seen.has(l.to)) return;           // cada equipamento tem um único pai
    seen.add(l.to); list.push(l);
    put(l.from, l.fp, { link: l, other: l.to, otherPort: l.tp, dir: 'down' });
    put(l.to, l.tp, { link: l, other: l.from, otherPort: l.fp, dir: 'up' });
  });
  _lk = { ref: raw, rev: S._cfgRev, list, idx };
  return list;
}
const cablesOf = ip => { topoLinks(); return _lk.idx.get(ip) || new Map(); };   // rótulo -> {link, other, otherPort, dir}
const isSwitch = ip => !!invOf(ip).sw;
// tipos de equipamento de rack (cadastrados à mão): rótulo, portas RJ45/SFP e altura (U) sugeridas
const RK_TYPES = {
  switch:    { label: 'Switch',               eth: 24, sfp: 0, u: 1 },
  patch:     { label: 'Patch panel',          eth: 24, sfp: 0, u: 1 },
  router:    { label: 'Roteador',             eth: 5,  sfp: 1, u: 1 },
  server:    { label: 'Servidor',             eth: 4,  sfp: 0, u: 2 },
  ups:       { label: 'Nobreak (UPS)',        eth: 0,  sfp: 0, u: 2 },
  organizer: { label: 'Organizador de cabos', eth: 0,  sfp: 0, u: 1 },
  blank:     { label: 'Frente falsa (painel cego)', eth: 0, sfp: 0, u: 1 },
  other:     { label: 'Outro equipamento',    eth: 0,  sfp: 0, u: 1 },
};
// concentradores (um rack cada): os MikroTik com acesso SSH, os criados à mão e os que têm portas definidas
const rackIps = () => {
  const s = new Set(Object.keys(S.traffic || {}));
  Object.entries(S.topoCfg.inventory || {}).forEach(([k, v]) => { if (v.conc || (!v.sw && ((v.ports | 0) || (v.sfp | 0)))) s.add(k); });
  return [...s].filter(ip => !isSwitch(ip));
};
// nome do cadastro de um concentrador: o nome do hack (se definido), senão "Hack <nº> - <setor>", senão o nome digitado no equipamento
function rackTitleOf(ip) {
  const v = invOf(ip);
  if (v.rackName) return v.rackName;
  if (v.hnum) return `Hack ${v.hnum}${v.setor ? ' - ' + v.setor : ''}`;
  return v.name || '';
}
const rackChoices = () => (rackView && rackView.rackList ? rackView.rackList() : []);           // switch cadastrado à mão (sem IP/SSH) abaixo de um concentrador
// meio do cabo: o escolhido à mão; senão fibra quando alguma ponta é porta SFP, senão cabo de rede (UTP)
const linkMedium = l => (l.m === 'fibra' || l.m === 'utp') ? l.m : ((labelIsSfp(l.fp) || labelIsSfp(l.tp)) ? 'fibra' : 'utp');
const MEDIUM_NAME = { utp: 'Cabo de rede (UTP)', fibra: 'Fibra óptica' };
const MEDIUM_SHORT = { utp: 'UTP', fibra: 'Fibra' };

/* ───────── desfazer: cada gravação guarda o estado anterior ───────── */
S.topoUndo = [];
let _snap = null, _undoing = false;
const snapNow = () => JSON.stringify({ l: S.topoCfg.links || [], i: S.topoCfg.inventory || {} });
function updateUndoBtn() {
  const b = gid('btnUndo'); if (!b) return;
  b.disabled = !S.topoUndo.length;
  b.title = S.topoUndo.length ? `Desfazer a última alteração (${S.topoUndo.length}) — Ctrl+Z` : 'Nada para desfazer';
}
async function undoTopo() {
  const s = S.topoUndo.pop(); if (!s) return;
  const o = JSON.parse(s);
  S.topoCfg.links = o.l; S.topoCfg.inventory = o.i;
  S.topoForm = null; S.topoSw = null;
  _undoing = true; S._cfgRev++; _topoT = 0; renderTopology();
  const ok = await saveTopoCfg();
  _undoing = false; updateUndoBtn();
  const b = gid('btnUndo'), sp = b && b.querySelector('span');
  if (sp) { sp.textContent = ok ? 'Desfeito' : 'Erro ao salvar'; setTimeout(() => { sp.textContent = 'Desfazer'; }, 1400); }
}

async function loadTopoCfg() {
  try {
    const r = await fetch('/api/topology', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      S.topoCfg.links = Array.isArray(j.links) ? j.links : [];
      S.topoCfg.inventory = j.inventory && typeof j.inventory === 'object' ? j.inventory : {};
      S.topoRev = j.rev;
      S._cfgRev++; _snap = snapNow(); updateUndoBtn();
    }
  } catch { /* servidor antigo: segue com as ligações de /api/config */ }
}
async function saveTopoCfg() {
  const cur = snapNow();
  if (!_undoing && _snap && cur !== _snap) { S.topoUndo.push(_snap); if (S.topoUndo.length > 50) S.topoUndo.shift(); }
  _snap = cur; updateUndoBtn();
  try {
    const r = await fetch('/api/topology', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: S.topoCfg.links || [], inventory: S.topoCfg.inventory || {}, rev: S.topoRev }) });
    if (r.status === 409) { const j = await r.json().catch(() => ({})); alert(j.error || 'Página desatualizada. Recarregue (F5).'); throw new Error('página desatualizada'); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
    const jr = await r.json().catch(() => ({})); if (jr.rev) S.topoRev = jr.rev;
    try { const f = gid('trafficFrame'); if (f && f.contentWindow && f.contentWindow.reloadTopo) f.contentWindow.reloadTopo(); } catch (_) { /* aba Tráfego ainda não carregou */ }
    return true;
  } catch (e) { tdNote('Não foi possível salvar no servidor (' + e.message + '). A alteração vale até recarregar a página.', 'err'); return false; }
}
function commitLinks(list) {
  S.topoCfg.links = list.map(l => [l.from, l.to, l.fp || '', l.tp || '', l.m || '']);
  S._cfgRev++; _topoT = 0; renderTopology();
  return saveTopoCfg();
}
function commitInventory() { S._cfgRev++; _topoT = 0; renderTopology(); return saveTopoCfg(); }

// aplica uma ligação nova: o filho tem um só pai e cada porta, um só cabo. Devolve {links, dropped}.
function applyLink(links, nl) {
  if (!nl.from || !nl.to || nl.from === nl.to) throw new Error('Escolha outro equipamento para ligar.');
  const dropped = [];
  let out = links.filter(l => { if (l.to === nl.to) { dropped.push(l); return false; } return true; });
  const clash = (ip, label) => label ? out.filter(l => (l.from === ip && l.fp === label) || (l.to === ip && l.tp === label)) : [];
  const gone = new Set([...clash(nl.from, nl.fp), ...clash(nl.to, nl.tp)]);
  if (gone.size) { out = out.filter(l => !gone.has(l)); dropped.push(...gone); }
  const parentOf = new Map(out.map(l => [l.to, l.from]));
  for (let a = nl.from; a; a = parentOf.get(a)) if (a === nl.to) throw new Error(`Essa ligação criaria um laço: ${devName(nl.to)} já está acima de ${devName(nl.from)} na árvore.`);
  out.push(nl);
  return { links: out, dropped };
}

/* ───────── equipamentos e portas ───────── */
function devName(ip) {
  const d = S.devices[ip] || {}, t = S.traffic[ip];
  return invOf(ip).name || d.name || d.hostname || (t && t.name !== ip ? t.name : '') || (isSwitch(ip) ? 'Switch' : ip);
}
function livePortsLabeled(ip) {
  const t = S.traffic[ip];
  if (!t || !t.ok) return [];
  const seen = new Set();
  return physPortsOf(t).map((p, i) => ({ label: livePortLabel(p, i), p })).filter(x => !seen.has(x.label) && seen.add(x.label));
}
// portas do equipamento: o que o SSH enxerga tem prioridade; senão o que foi definido à mão
function devPorts(ip) {
  const live = livePortsLabeled(ip);
  if (live.length) return { source: 'live', items: live.map(x => ({ label: x.label, live: x.p, sfp: labelIsSfp(x.label) })).sort((a, b) => cmpLabel(a.label, b.label)) };
  const inv = invOf(ip), n = Math.max(0, inv.ports | 0), m = Math.max(0, inv.sfp | 0), items = [];
  for (let i = 1; i <= n; i++) items.push({ label: String(i), sfp: false });
  for (let i = 1; i <= m; i++) items.push({ label: 'S' + i, sfp: true });
  return { source: items.length ? 'manual' : 'none', items };
}
function portState(item, cab) {
  const p = item.live;
  if (p) {
    if (p.disabled) return { cls: 'dis', key: 'dis' };
    if (!p.running) return cab ? { cls: 'cabdown', key: 'cabdown' } : { cls: 'sp-off', key: 'off' };
    const sp = 'sp-' + portSpeedCls(p);
    return cab ? { cls: sp + ' has', key: sp + '+' } : { cls: sp + ' unm', key: sp };
  }
  return cab ? { cls: 'cab has', key: 'cab' } : { cls: 'free', key: 'free' };
}
function portTitle(ip, item, cab) {
  const p = item.live, parts = ['Porta ' + item.label + (p ? ' · ' + p.name : '')];
  if (p) parts.push(!p.running ? 'sem link' : (p.speed ? fmtSpeed(p.speed) : 'ativa') + ' — ↓ ' + fmtRate(p.rxBps) + '  ↑ ' + fmtRate(p.txBps));
  parts.push(cab ? 'cabo: ' + devName(cab.other) + (cab.otherPort ? ' (porta ' + cab.otherPort + ')' : '') : 'sem cabo definido');
  return parts.join(' · ');
}
// equipamentos que podem ficar do outro lado do cabo
function candidateDevices(except) {
  const ips = new Set();
  ((S._topoModel && S._topoModel.nodes) || []).forEach(n => { if (n.kind !== 'internet' && n.kind !== 'group') ips.add(n.id); });
  Object.values(S.devices).forEach(d => { if (d.known || d.manual) ips.add(d.ip); });
  Object.keys(S.topoCfg.inventory || {}).forEach(ip => ips.add(ip));
  Object.keys(S.traffic).forEach(ip => ips.add(ip));
  topoLinks().forEach(l => { ips.add(l.from); ips.add(l.to); });
  ips.delete(except);
  return [...ips].sort((a, b) => ipCmp(a, b) || String(a).localeCompare(b)).map(ip => ({ ip, name: devName(ip) }));
}

// portas para desenhar a placa frontal no rack: [rótulo, sfp, led, meio do cabo, dica]
function rackPorts(ip) {
  const inv = invOf(ip), cab = cablesOf(ip);
  let items;
  if ((inv.ports | 0) || (inv.sfp | 0)) {            // a quantidade definida nas configurações é a que se desenha (o SSH só colore o estado)
    const lm = new Map(livePortsLabeled(ip).map(x => [x.label, x.p]));
    items = [];
    for (let i = 1; i <= (inv.ports | 0); i++) items.push({ label: String(i), sfp: false, live: lm.get(String(i)) });
    for (let i = 1; i <= (inv.sfp | 0); i++) items.push({ label: 'S' + i, sfp: true, live: lm.get('S' + i) });
  } else items = devPorts(ip).items;
  return items.map(x => {
    const c = cab.get(x.label), st = portState(x, c).cls.split(' ')[0], md = c ? linkMedium(c.link) : '';
    const led = st === 'cab' ? 'on' : st === 'cabdown' ? 'down' : (st === 'free' || st === 'dis' || st === 'sp-off') ? 'off' : st;
    return [x.label, x.sfp ? 1 : 0, led, md, 'Porta ' + x.label + (c ? ` → ${devName(c.other)}${c.otherPort ? ' (' + c.otherPort + ')' : ''} · ${MEDIUM_SHORT[md]}` : ' · livre — arraste até outra porta para ligar um cabo')];
  });
}

// matriz de portas em miniatura (lista lateral, cartões da infraestrutura, aba Portas)
function portMatrix(ip) {
  const dp = devPorts(ip);
  if (!dp.items.length) return '';
  const cab = cablesOf(ip);
  const sq = x => `<i class="${portState(x, cab.get(x.label)).cls.replace(/ (has|unm)/g, '')}${cab.get(x.label) ? ' cabl' + (linkMedium(cab.get(x.label).link) === 'fibra' ? ' fib' : '') : ''}" title="${esc(portTitle(ip, x, cab.get(x.label)))}"></i>`;
  const eth = dp.items.filter(x => !x.sfp), sfp = dp.items.filter(x => x.sfp);
  const rows = eth.length > 8 ? [eth.filter((_, i) => i % 2 === 0), eth.filter((_, i) => i % 2 === 1)] : [eth];
  return `<span class="pm">${rows.map(r => `<span>${r.map(sq).join('')}</span>`).join('')}${sfp.length ? `<span class="pm-sfp">${sfp.map(sq).join('')}</span>` : ''}</span>`;
}

/* ───────── histórico de tráfego (gráficos da gaveta) ───────── */
function pushTrafHist(devs) {
  const now = Date.now();
  (devs || []).forEach(d => {
    if (!d.ok) return;
    const h = S.trafHist[d.host] || (S.trafHist[d.host] = { agg: [], ports: {}, loaded: false });
    const r = trafficRates(d);
    h.agg.push({ t: now, rx: r.rx, tx: r.tx }); if (h.agg.length > 360) h.agg.shift();
    (d.ports || []).forEach(p => {
      const a = h.ports[p.name] || (h.ports[p.name] = []);
      a.push({ t: now, rx: p.rxBps, tx: p.txBps }); if (a.length > 360) a.shift();
    });
  });
}
async function ensureTrafHist(host) {
  const h = S.trafHist[host] || (S.trafHist[host] = { agg: [], ports: {}, loaded: false });
  if (h.loaded) return;
  h.loaded = true;
  try {
    const j = await (await fetch('/api/hist-ports?host=' + encodeURIComponent(host), { signal: AbortSignal.timeout(5000) })).json();
    const merge = (cur, old) => { const t0 = cur.length ? cur[0].t : Infinity; return [...(old || []).filter(s => s.t < t0 && Date.now() - s.t < 360e3), ...cur].slice(-360); };
    h.agg = merge(h.agg, j.agg);
    Object.entries(j.ports || {}).forEach(([n, arr]) => { h.ports[n] = merge(h.ports[n] || [], arr); });
  } catch { h.loaded = false; }
}
function niceMaxRate(v) {
  if (v <= 0) return 1e5;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function histChartSVG(series, win) {
  win = win || 180e3;
  const now = Date.now(), pts = (series || []).filter(s => now - s.t <= win);
  if (pts.length < 2) return '<div class="td-chart-empty">coletando histórico…</div>';
  const W = 400, H = 130, L = 52, R = 8, T = 8, B = 18;
  const max = niceMaxRate(Math.max(...pts.map(p => Math.max(p.rx, p.tx))) * 1.1);
  const x = t => L + (W - L - R) * (t - (now - win)) / win, y = v => H - B - (H - T - B) * v / max;
  const line = k => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[k]).toFixed(1)}`).join(' ');
  const area = k => `${line(k)} L${x(pts[pts.length - 1].t).toFixed(1)},${H - B} L${x(pts[0].t).toFixed(1)},${H - B} Z`;
  const grid = [0, .5, 1].map(f => `<line x1="${L}" x2="${W - R}" y1="${y(max * f).toFixed(1)}" y2="${y(max * f).toFixed(1)}"/><text x="${L - 6}" y="${(y(max * f) + 3).toFixed(1)}" text-anchor="end">${fmtRate(max * f).replace('.00', '')}</text>`).join('');
  return `<svg class="td-chart" viewBox="0 0 ${W} ${H}"><defs>
    <linearGradient id="tdgRx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0ea5e9" stop-opacity=".3"/><stop offset="1" stop-color="#0ea5e9" stop-opacity="0"/></linearGradient>
    <linearGradient id="tdgTx" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a855f7" stop-opacity=".25"/><stop offset="1" stop-color="#a855f7" stop-opacity="0"/></linearGradient></defs>
    <g class="g">${grid}</g><text x="${L}" y="${H - 4}">−3 min</text><text x="${W - R}" y="${H - 4}" text-anchor="end">agora</text>
    <path d="${area('rx')}" fill="url(#tdgRx)"/><path d="${area('tx')}" fill="url(#tdgTx)"/>
    <path d="${line('rx')}" fill="none" stroke="#0ea5e9" stroke-width="1.8" stroke-linejoin="round"/>
    <path d="${line('tx')}" fill="none" stroke="#a855f7" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}

/* ───────── mensagens ───────── */
function tdNote(msg, kind) {
  const el = gid('tdMsg'); if (!el) return;
  el.textContent = msg || ''; el.className = 'td-msg' + (msg ? ' show ' + (kind || 'ok') : '');
  clearTimeout(_tdMsgT);
  if (msg) _tdMsgT = setTimeout(() => { el.className = 'td-msg'; el.textContent = ''; }, kind === 'err' ? 9000 : 3500);
}

/* ═════════════ gaveta de detalhes ═════════════ */
const DTABS = [['summary', 'Resumo'], ['ports', 'Portas'], ['traffic', 'Tráfego']];

function renderTopoDetails(force) {
  const panel = gid('topoDetailsPanel'), ip = S.topoSel;
  if (!panel) return;
  const known = ip && (S.devices[ip] || S.traffic[ip] || isSwitch(ip) || invOf(ip).name || invOf(ip).ports || invOf(ip).sfp || topoLinks().some(l => l.from === ip || l.to === ip));
  // usa o ancestral do próprio painel: ".topo-map-section" também existe (reaproveitada) na
  // aba Monitor, e document.querySelector pegava essa de lá por vir antes no documento
  const section = panel.closest('.topo-map-section');
  if (!known) {
    if (section) section.classList.remove('has-sel');
    [topoView, infraView, rackView].forEach(v => v && v.setInset(0));
    _tdKey = ''; _tdIp = null;
    panel.innerHTML = '<div class="td-empty"><i class="fas fa-circle-nodes"></i>Clique em um equipamento no mapa para ver detalhes</div>';
    return;
  }
  if (section) section.classList.add('has-sel');
  const dw = (gid('topoDetails') || {}).offsetWidth || 400;
  [topoView, infraView, rackView].forEach(v => v && v.setInset(dw));

  if (ip !== _tdIp) { _tdIp = ip; S.topoPortSel = null; S.topoForm = null; S.topoSw = null; S.topoCfgOpen = false; force = true; ensureTrafHist(ip); }
  const key = ip + '|' + S.topoUi.dtab;
  if (force || key !== _tdKey) { _tdKey = key; panel.innerHTML = frameHTML(ip); initBody(ip); }
  refreshDetails(ip);
}

function frameHTML(ip) {
  const tab = S.topoUi.dtab;
  return `<div class="td">
    <div class="td-head" id="tdHead"></div>
    <div class="td-tabs" role="tablist">${DTABS.map(([k, l]) => `<button type="button" role="tab" data-dtab="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div class="td-msg" id="tdMsg" role="status"></div>
    <div id="tdBody">${tab === 'ports' ? '<div id="tdCfg"></div><div id="tdSw"></div><div id="tdPanel"></div><div id="tdInsp"></div><div id="tdPorts"></div>'
      : tab === 'traffic' ? '<div id="tdTraf"></div>' : '<div id="tdSummary"></div>'}</div></div>`;
}
// partes que NÃO são refeitas a cada atualização (formulários): montadas aqui
function initBody(ip) {
  if (S.topoUi.dtab === 'ports') { renderCfg(); renderSw(); renderInspector(); }
}

function headHTML(ip) {
  const d = S.devices[ip] || { ip, name: '', hostname: '', type: 'nucleo', status: 'unknown' };
  const st = topoStatus(d), node = (activeView() && activeView().byId && activeView().byId.get(ip)) || {};
  const nm = devName(ip);
  return `<div class="td-ico">${NetIcons.svg(node.kind || topoKind(d, true), { size: 40 })}</div>
    <div style="min-width:0"><h3>${esc(nm)}</h3>${nm !== ip && !isSwitch(ip) ? `<div class="ip">${esc(ip)}</div>` : ''}
      <span class="td-pill ${st === 'online' ? 'on' : st === 'offline' ? 'off' : ''}"><i></i>${isSwitch(ip) ? RK_TYPES[invOf(ip).etype || 'switch'].label + ' · sem monitoramento' : st === 'online' ? 'Online' : st === 'offline' ? 'Offline' : st === 'scanning' ? 'Verificando' : 'Sem informação'}</span></div>`;
}

// atualiza só o que muda com o tempo (estado, taxas, painel, listas); formulários ficam intactos
function refreshDetails(ip) {
  const head = gid('tdHead'); if (head) { const h = headHTML(ip); if (head.dataset.h !== h) { head.dataset.h = h; head.innerHTML = h; } }
  const tab = S.topoUi.dtab;
  const put = (id, html) => { const el = gid(id); if (el && el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };   // só mexe no DOM se mudou
  if (tab === 'summary') put('tdSummary', summaryHTML(ip));
  else if (tab === 'traffic') put('tdTraf', trafficTabHTML(ip));
  else { refreshCfgSum(ip); refreshSwList(ip); refreshPanel(ip); refreshPortList(ip); refreshPortLive(ip); }
}

/* ───────── disponibilidade: ping contínuo + histórico guardado em arquivo no servidor ───────── */
function ensurePingHist(key) {
  const c = S.pingHist[key];
  if (c && (c.busy || Date.now() - c.t < 8000)) return;
  S.pingHist[key] = { ...(c || {}), busy: true, t: c ? c.t : 0 };
  fetch('/api/ping/history?ip=' + encodeURIComponent(key), { signal: AbortSignal.timeout(4000) })
    .then(r => r.json()).then(d => { S.pingHist[key] = { t: Date.now(), data: d }; })
    .catch(() => { S.pingHist[key] = { ...(S.pingHist[key] || {}), busy: false, t: Date.now() }; });
}
function availabilityHTML(ip) {
  const key = pingKey(ip);
  if (!key) return `<div class="td-sec"><h6><i class="fas fa-heart-pulse"></i>Disponibilidade</h6><p class="td-note">Sem IP definido: informe o IP em <b>Portas → Configurar</b> para monitorar online/offline por ping.</p></div>`;
  ensurePingHist(key);
  const p = S.ping[key], hh = (S.pingHist[key] || {}).data, up = p && p.online;
  const pct = v => v == null ? '—' : v.toFixed(1).replace('.0', '') + '%';
  const when = ts => new Date(ts).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
  const strip = hh ? hh.strip.map(c => `<i class="c${c < 0 ? 'x' : c}"></i>`).join('') : '';
  const evs = hh ? hh.events.slice(0, 8).map(e => `<li class="${e.event === 'online' ? 'on' : 'off'}"><i></i><time>${esc(when(e.ts))}</time>${e.event === 'online' ? 'ficou online' : 'ficou offline'}${e.rt != null ? ' · ' + e.rt + ' ms' : ''}</li>`).join('') : '';
  return `<div class="td-sec"><h6><i class="fas fa-heart-pulse"></i>Disponibilidade · ping a cada 2 s</h6>
    <div class="av-top"><b style="color:var(--${p ? (up ? 'ok' : 'bad') : 'text-muted'})">${p ? (up ? 'Online' : 'Offline') : 'Aguardando ping…'}</b>
      <small>${p ? (up ? (p.rt != null ? p.rt + ' ms · ' : '') + 'online há ' : 'offline há ') + esc(fmtDur(Date.now() - p.since)) : ''}</small><small>${esc(key)}</small></div>
    ${hh ? `<div class="av-top"><small>1 h <b>${pct(hh.uptime1h)}</b></small><small>24 h <b>${pct(hh.uptime24h)}</b></small><small>72 h <b>${pct(hh.uptime72h)}</b></small></div>
      <div class="av-strip" title="cada célula = 1 minuto: verde online, amarelo parcial, vermelho offline, cinza sem dados">${strip}</div>
      <div class="av-lg"><span>−60 min</span><span>agora</span></div>
      ${evs ? `<ul class="av-ev">${evs}</ul>` : '<p class="td-note">Nenhuma mudança de estado registrada ainda.</p>'}` : '<p class="td-note">carregando histórico…</p>'}</div>`;
}

/* ───────── aba Resumo ───────── */
function summaryHTML(ip) {
  const d = S.devices[ip] || { ip, name: '', hostname: '', type: 'nucleo', status: 'unknown' }, t = S.traffic[ip];
  const ti = TYPE_INFO[d.type] || TYPE_INFO.unknown, st = topoStatus(d), m = (t && t.meta) || {};
  const view = activeView(), parent = view && view.parent && view.parent.get(ip);
  const link = parent ? topoLinks().find(l => l.from === parent && l.to === ip) : null;
  const li = link ? topoLinkInfo(link) : null;
  const row = (k, v, mono) => v ? `<div class="td-row"><span>${k}</span><b${mono ? ' class="m"' : ''}>${v}</b></div>` : '';
  const dp = devPorts(ip), cab = cablesOf(ip);
  let h = '';
  if (t && t.ok) { const r = trafficRates(t); h += `<div class="td-big"><div><div class="k">Recebendo</div><div class="v d">↓ ${fmtRate(r.rx)}</div></div><div><div class="k">Enviando</div><div class="v u">↑ ${fmtRate(r.tx)}</div></div></div>`; }
  h += `<div class="td-sec"><h6><i class="fas fa-circle-info"></i>Equipamento</h6><div class="td-rows">
    ${row('Tipo', esc(isSwitch(ip) ? RK_TYPES[invOf(ip).etype || 'switch'].label : ti.label))}${isSwitch(ip) ? row('Rack', esc(rackNameOf(ip))) : ''}${row('Modelo', esc(m.board || ''))}${row('Versão', m.version ? 'RouterOS ' + esc(m.version) : '')}
    ${row('Hostname', esc(d.hostname || ''))}${row('Resposta', d.rt != null ? esc(fmtRT(d.rt)) : '')}${row('Ativo há', esc(m.uptime || ''), true)}
    ${row('CPU', m.cpuLoad != null ? m.cpuLoad + '%' : '')}${row('Memória', memUsedPct(m) != null ? memUsedPct(m) + '%' : '')}
    ${row('Portas', dp.items.length ? `${dp.items.length} · ${cab.size} com cabo` : '')}
    ${row(st === 'online' ? 'Online desde' : 'Último contato', d.onlineSince ? fmtClock(d.onlineSince) : (d.lastSeen ? fmtClock(d.lastSeen) : ''))}
    ${(d.ports && d.ports.length) ? row('Serviços', svcChips(d.ports, 6)) : ''}</div></div>`;
  if (parent && li) {
    h += `<div class="td-sec"><h6><i class="fas fa-link"></i>Ligação</h6><div class="td-rows">
      ${row('Conectado a', esc(devName(parent)))}${row('Porta (pai)', esc(li.pLabel || ''), true)}${row('Porta (este)', esc(li.cLabel || ''), true)}
      ${row('Cabo', `<span class="mt ${linkMedium(link)}">${esc(MEDIUM_NAME[linkMedium(link)])}</span>`)}${row('Velocidade', li.speed ? esc(fmtSpeed(li.speed)) : '')}</div></div>`;
  }
  if (d.notes) h += `<div class="td-sec"><h6><i class="fas fa-note-sticky"></i>Notas</h6><p class="td-note">${esc(d.notes)}</p></div>`;
  h += availabilityHTML(ip);
  if (isSwitch(ip)) return h + `<div class="td-actions"><button type="button" class="nm-btn" data-act="goPorts"><i class="fas fa-ethernet"></i>Ver portas e cabos</button></div>`;
  h += `<div class="td-actions">
    ${t && t.ok ? `<button type="button" class="nm-btn nm-btn-primary" data-act="openTraffic"><i class="fas fa-chart-line"></i>Abrir em Tráfego</button>` : `<button type="button" class="nm-btn" data-act="sshCfg"><i class="fas fa-key"></i>Configurar acesso SSH</button>`}
    ${S.devices[ip] ? `<button type="button" class="nm-btn" data-act="editDev"><i class="fas fa-pen"></i>Editar</button>` : ''}</div>`;
  return h;
}

/* ───────── aba Tráfego ───────── */
function trafficTabHTML(ip) {
  const t = S.traffic[ip];
  if (!t || !t.ok) {
    return `<div class="td-empty small"><i class="fas fa-plug-circle-exclamation"></i>Sem dados de tráfego.<br>O equipamento não responde por SSH${t && t.error ? ' (' + esc(t.error) + ')' : ''}.
      <div style="margin-top:12px"><button type="button" class="nm-btn nm-btn-primary" data-act="sshCfg"><i class="fas fa-key"></i>Configurar acesso SSH</button></div></div>`;
  }
  const ph = physPortsOf(t), up = ph.filter(p => p.running).length, r = trafficRates(t), hist = S.trafHist[ip] || { agg: [], ports: {} };
  const top = [...ph].filter(p => p.rxBps + p.txBps > 0).sort((a, b) => (b.rxBps + b.txBps) - (a.rxBps + a.txBps)).slice(0, 6);
  const mx = Math.max(1e5, ...top.map(p => p.rxBps + p.txBps)), cab = cablesOf(ip);
  const selP = S.topoPortSel && livePortsLabeled(ip).find(x => x.label === S.topoPortSel);
  return `<div class="td-big"><div><div class="k">Recebendo</div><div class="v d">↓ ${fmtRate(r.rx)}</div></div><div><div class="k">Enviando</div><div class="v u">↑ ${fmtRate(r.tx)}</div></div></div>
    <div class="td-sec"><h6><i class="fas fa-wave-square"></i>Tráfego do equipamento · ${up} de ${ph.length} portas ativas</h6>${histChartSVG(hist.agg)}
      <div class="td-lg"><span><i style="background:#0ea5e9"></i>Download ↓</span><span><i style="background:#a855f7"></i>Upload ↑</span></div></div>
    ${selP ? `<div class="td-sec"><h6><i class="fas fa-ethernet"></i>Porta ${esc(selP.label)} · ${esc(selP.p.name)}</h6>${histChartSVG(hist.ports[selP.p.name])}</div>` : ''}
    <div class="td-sec"><h6><i class="fas fa-ranking-star"></i>Portas mais ativas</h6><div class="td-ports">${top.length ? top.map(p => {
      const lab = livePortLabel(p, 0), item = livePortsLabeled(ip).find(x => x.p === p), c = item && cab.get(item.label);
      return `<button type="button" class="td-port" data-port="${esc(item ? item.label : lab)}" data-goto="ports"><span title="${esc(p.name)}">${esc(p.comment || p.name)}${c ? ` <em class="to">→ ${esc(devName(c.other))}</em>` : ''}</span>
        <span class="bar"><i style="width:${(p.rxBps + p.txBps) / mx * 100}%"></i></span><em>${fmtRate(p.rxBps + p.txBps)}</em></button>`;
    }).join('') : '<span class="nm-muted">Nenhuma porta com tráfego agora.</span>'}</div></div>
    <div class="td-actions"><button type="button" class="nm-btn nm-btn-primary" data-act="openTraffic"><i class="fas fa-chart-line"></i>Abrir em Tráfego</button></div>`;
}

/* ───────── aba Portas: configuração (nº de portas) ───────── */
function maxUsedLabel(ip, sfp) {
  let mx = 0;
  cablesOf(ip).forEach((c, label) => { if (labelIsSfp(label) === sfp) mx = Math.max(mx, labelNum(label)); });
  return mx;
}
function cfgHTML(ip) {
  const dp = devPorts(ip), inv = invOf(ip), live = dp.source === 'live';
  const nEth = dp.items.filter(x => !x.sfp).length, nSfp = dp.items.filter(x => x.sfp).length;
  const open = S.topoCfgOpen || dp.source === 'none';
  const linked = topoLinks().some(l => l.from === ip || l.to === ip);
  const sum = `<div class="pc-sum"><div><b id="pcCount"></b><span id="pcCab"></span></div>
    <button type="button" class="nm-btn" data-act="cfgToggle"><i class="fas fa-sliders"></i>${open && dp.source !== 'none' ? 'Fechar' : 'Configurar'}</button></div>`;
  if (!open) return sum;
  return `${sum}<div class="pc-form">
    ${dp.source === 'none' ? '<p class="pc-hint">Este equipamento ainda não tem portas definidas. Informe quantas ele tem para poder marcar em qual porta cada cabo está ligado.</p>' : ''}
    ${live ? `<p class="pc-hint ok"><i class="fas fa-circle-check"></i> Portas detectadas pelo SSH: ${nEth} RJ45${nSfp ? ' · ' + nSfp + ' SFP' : ''}. Não precisa definir à mão.</p>` : ''}
    ${!isSwitch(ip) && rackIps().includes(ip) ? roleFieldHTML(ip) : ''}
    ${isSwitch(ip) ? rackFieldsHTML(ip) : ''}
    <div class="pf-row"><label for="pcName">Nome (opcional)</label><input id="pcName" value="${esc(inv.name || '')}" placeholder="${esc(S.devices[ip] ? (S.devices[ip].name || S.devices[ip].hostname || ip) : ip)}" maxlength="60"></div>
    <div class="pf-row two"><div><label for="pcEth">Portas RJ45</label><input id="pcEth" type="number" min="0" max="96" value="${live ? nEth : (inv.ports != null && inv.ports !== 0 ? inv.ports : (dp.source === 'none' ? 24 : 0))}"${live ? ' disabled' : ''}></div>
      <div><label for="pcSfp">Portas SFP</label><input id="pcSfp" type="number" min="0" max="32" value="${live ? nSfp : (inv.sfp || 0)}"${live ? ' disabled' : ''}></div></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-act="saveInv">Salvar</button>
      ${linked || isSwitch(ip) ? `<button type="button" class="nm-btn nm-btn-danger-o" data-act="detach"><i class="fas fa-link-slash"></i>${isSwitch(ip) ? 'Excluir switch' : 'Remover do mapa'}</button>` : ''}</div></div>`;
}
function renderCfg() {
  const ip = S.topoSel, el = gid('tdCfg'); if (!ip || !el) return;
  el.innerHTML = cfgHTML(ip);
  refreshCfgSum(ip);
}
function refreshCfgSum(ip) {
  const c = gid('pcCount'), k = gid('pcCab'); if (!c) return;
  const dp = devPorts(ip), cab = cablesOf(ip);
  const nEth = dp.items.filter(x => !x.sfp).length, nSfp = dp.items.filter(x => x.sfp).length;
  c.textContent = dp.source === 'none' ? 'Portas não definidas' : `${nEth} RJ45${nSfp ? ' · ' + nSfp + ' SFP' : ''}`;
  k.textContent = dp.source === 'none' ? '' : ` · ${cab.size} com cabo`;
  // aviso: cabos em portas que o equipamento não tem
  const have = new Set(dp.items.map(x => x.label)), orphan = [...cab.keys()].filter(l => dp.items.length && !have.has(l));
  let w = gid('tdWarnPorts');
  if (orphan.length) {
    if (!w) { w = document.createElement('div'); w.id = 'tdWarnPorts'; w.className = 'pc-warn'; gid('tdCfg').appendChild(w); }
    w.textContent = `Há cabo definido em porta que o equipamento não tem: ${orphan.join(', ')}. Ajuste o número de portas ou refaça a ligação.`;
  } else if (w) w.remove();
}
async function saveInventory() {
  const ip = S.topoSel; if (!ip) return;
  const dp = devPorts(ip);
  const name = (gid('pcName').value || '').trim();
  const live = dp.source === 'live';
  const eth = live ? 0 : Math.round(+gid('pcEth').value || 0), sfp = live ? 0 : Math.round(+gid('pcSfp').value || 0);
  if (!live) {
    if (eth < 0 || eth > 96) return tdNote('Portas RJ45: informe de 0 a 96.', 'err');
    if (sfp < 0 || sfp > 32) return tdNote('Portas SFP: informe de 0 a 32.', 'err');
    const usedE = maxUsedLabel(ip, false), usedS = maxUsedLabel(ip, true);
    if (eth < usedE) return tdNote(`A porta ${usedE} tem cabo definido: desconecte-a antes de reduzir para ${eth} portas.`, 'err');
    if (sfp < usedS) return tdNote(`A porta S${usedS} tem cabo definido: desconecte-a antes de reduzir para ${sfp} SFP.`, 'err');
  }
  const inv = { ...(S.topoCfg.inventory || {}) };
  const cur = { ...(inv[ip] || {}) };
  if (name) cur.name = name; else delete cur.name;
  if (!live) { cur.ports = eth; cur.sfp = sfp; }
  if (isSwitch(ip) && gid('pcType')) {
    const et = gid('pcType').value, u = +gid('pcU').value || 1, rk = gid('pcRack').value;
    if (et !== 'switch') cur.etype = et; else delete cur.etype;
    if (u > 1) cur.u = u; else delete cur.u;
    if (rk) cur.rack = rk; else delete cur.rack;
  }
  if (gid('pcIp')) { const ipv = gid('pcIp').value.trim(); if (ipv && !/^[\w.:-]{1,64}$/.test(ipv)) return tdNote('IP inválido.', 'err'); if (ipv) cur.ip = ipv; else delete cur.ip; }
  if (gid('pcHnum')) { const h = gid('pcHnum').value.trim(); if (h) cur.hnum = h; else delete cur.hnum; }
  if (gid('pcAndar')) { const a = gid('pcAndar').value.trim(), st = gid('pcSetor').value.trim(); if (a) cur.andar = a; else delete cur.andar; if (st) cur.setor = st; else delete cur.setor; }
  if (gid('pcRtype')) { const t = gid('pcRtype').value; if (t) cur.rtype = t; else delete cur.rtype; }
  if (gid('pcRole')) { const r = gid('pcRole').value; if (r) cur.role = r; else delete cur.role; }
  if (cur.name || cur.ports || cur.sfp || cur.sw || cur.pos || cur.role || cur.rtype || cur.andar || cur.setor || cur.hnum) inv[ip] = cur; else delete inv[ip];
  S.topoCfg.inventory = inv; S.topoCfgOpen = false;
  renderCfg(); renderInspector();
  const ok = await commitInventory();
  if (ok) tdNote('Salvo.', 'ok');
}

/* ───────── equipamentos de rack: tipo, altura e a qual rack pertencem ───────── */
function rackNameOf(ip) {
  const r = invOf(ip).rack || (rackView && rackView.rackOf ? rackView.rackOf(ip) : '');
  return r ? devName(r) : '—';
}
const ROLE_LABELS = { internet: 'Internet', nucleo: 'Núcleo', concentrador: 'Concentrador', core: 'Core', distribuicao: 'Distribuição', secondary: 'Secundário' };
const RTYPE_LABELS = { internet: 'Internet', principal: 'Principal (hack principal)', secundario: 'Secundário' };
const rtypeOpts = cur => Object.entries(RTYPE_LABELS).map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${l}</option>`).join('');
const AUTO_ROLE = 'Automático (Concentrador no principal, Core nos secundários)';
const roleOpts = (cur, blank, blankLabel) => (blank ? `<option value=""${cur ? '' : ' selected'}>${blankLabel || '— sem papel —'}</option>` : '') + Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${l}</option>`).join('');
async function setLoc(id, field, value) {
  const inv = { ...(S.topoCfg.inventory || {}) }, cur = { ...(inv[id] || {}) };
  if (value) cur[field] = value; else delete cur[field];
  inv[id] = cur; S.topoCfg.inventory = inv;
  await commitInventory();
}
async function setName(id, name) {
  const inv = { ...(S.topoCfg.inventory || {}) }, cur = { ...(inv[id] || {}) };
  if (name) cur.name = name; else delete cur.name;
  if (cur.name || cur.ports || cur.sfp || cur.sw || cur.conc || cur.pos || cur.role || cur.rtype) inv[id] = cur; else delete inv[id];
  S.topoCfg.inventory = inv;
  await commitInventory();
}
async function setRtype(id, rt) {
  const inv = { ...(S.topoCfg.inventory || {}) }, cur = { ...(inv[id] || {}) };
  if (rt) cur.rtype = rt; else delete cur.rtype;
  inv[id] = cur; S.topoCfg.inventory = inv;
  await commitInventory();
}
async function setRole(id, role) {
  const inv = { ...(S.topoCfg.inventory || {}) }, cur = { ...(inv[id] || {}) };
  if (role) cur.role = role; else delete cur.role;
  if (cur.name || cur.ports || cur.sfp || cur.sw || cur.conc || cur.pos || cur.role) inv[id] = cur; else delete inv[id];
  S.topoCfg.inventory = inv;
  await commitInventory();
}
function roleFieldHTML(ip) {
  return `<div class="pf-row"><label for="pcHnum">Número do hack</label><input id="pcHnum" maxlength="12" value="${esc(invOf(ip).hnum || '')}" placeholder="ex.: 1"></div>
    <div class="pf-row two"><div><label for="pcAndar">Andar do rack</label><input id="pcAndar" maxlength="30" value="${esc(invOf(ip).andar || '')}" placeholder="ex.: 2º"></div><div><label for="pcSetor">Setor do rack</label><input id="pcSetor" maxlength="60" value="${esc(invOf(ip).setor || '')}" placeholder="ex.: TI"></div></div>
    <div class="pf-row two"><div><label for="pcRtype">Tipo do rack (hack)</label><select id="pcRtype">${rtypeOpts(invOf(ip).rtype || 'secundario')}</select></div>
    <div><label for="pcRole">Papel do MikroTik</label><select id="pcRole">${roleOpts(invOf(ip).role || '', true, AUTO_ROLE)}</select></div></div>`;
}
function rackFieldsHTML(ip) {
  const inv = invOf(ip), et = inv.etype || 'switch', u = inv.u || 1, cur = inv.rack || '';
  const racks = rackChoices();
  return `<div class="pf-row two"><div><label for="pcType">Tipo</label><select id="pcType">${Object.entries(RK_TYPES).map(([k, v]) => `<option value="${k}"${k === et ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>
      <div><label for="pcU">Altura no rack</label><select id="pcU">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === u ? ' selected' : ''}>${n} U</option>`).join('')}</select></div></div>
    <div class="pf-row"><label for="pcIp">IP do equipamento (para o ping)</label><input id="pcIp" maxlength="64" value="${esc(inv.ip || '')}" placeholder="ex.: 10.20.12.40"></div>
    <div class="pf-row"><label for="pcRole">Papel</label><select id="pcRole">${roleOpts(inv.role || '', true)}</select></div>
    <div class="pf-row"><label for="pcRack">Pertence ao rack (concentrador)</label><select id="pcRack">${racks.map(r => `<option value="${esc(r.id)}"${r.id === (cur || rackView.rackOf(ip)) ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>`;
}

/* ───────── arrastar no rack: posição e rack a que o equipamento pertence ───────── */
async function moveRackItem(id, rackId, idx) {
  if (!isSwitch(id) || !rackId) return;
  const units = rackView.unitIds(rackId).filter(x => x !== id);            // [concentrador, ...equipamentos] sem o que foi movido
  units.splice(Math.max(1, Math.min(idx, units.length)), 0, id);
  const inv = { ...(S.topoCfg.inventory || {}) };
  units.forEach((x, i) => { if (isSwitch(x)) inv[x] = { ...(inv[x] || {}), pos: i }; });
  inv[id] = { ...inv[id], rack: rackId };
  S.topoCfg.inventory = inv;
  await commitInventory();
}

/* ───────── ligar cabo arrastando de uma porta até outra (visão Racks) ───────── */
async function linkJacks(aId, aPort, bId, bPort) {
  if (aId === bId) return;
  const links = topoLinks(), parentOf = new Map(links.map(l => [l.to, l.from]));
  const isAnc = (x, y) => { for (let a = parentOf.get(x); a; a = parentOf.get(a)) if (a === y) return true; return false; };   // y está acima de x
  // quem é o pai: o que já está acima; senão, o que ainda não tem pai fica como filho
  let from = aId, fp = aPort, to = bId, tp = bPort;
  if (isAnc(aId, bId) || (!parentOf.has(aId) && parentOf.has(bId) && !isAnc(bId, aId))) { from = bId; fp = bPort; to = aId; tp = aPort; }
  let res;
  try { res = applyLink(links, { from, to, fp: portLabelOf(fp), tp: portLabelOf(tp), m: '' }); } catch (e) { alert(e.message); return; }
  const lost = res.dropped.filter(l => !(l.from === from && l.to === to));
  if (lost.length && !confirm('Esta ligação substitui:'+'\n'+lost.map(l => `• ${devName(l.from)}${l.fp ? ' (porta ' + l.fp + ')' : ''} → ${devName(l.to)}${l.tp ? ' (porta ' + l.tp + ')' : ''}`).join('\n')+'\n\nContinuar?')) return;
  await commitLinks(res.links);
}
async function unlinkChild(id) {
  const l = topoLinks().find(x => x.to === id); if (!l) return;
  if (!confirm(`Remover o cabo ${devName(l.from)}${l.fp ? ' (porta ' + l.fp + ')' : ''} ⇌ ${devName(l.to)}${l.tp ? ' (porta ' + l.tp + ')' : ''}?`)) return;
  await commitLinks(topoLinks().filter(x => x !== l));
}

/* ───────── racks: adicionar, ligar no macro, remover ───────── */
function rackPortSel(id, selId, hint) {
  const dp = devPorts(id);
  return dp.items.length ? `<select id="${selId}"><option value="">— não definida —</option>${portOptions(id, '', null)}</select>` : `<input id="${selId}" placeholder="${hint || 'ex.: 5 ou S1'}" maxlength="4">`;
}
const MED_OPTS = '<option value="">Automático (SFP = fibra)</option><option value="utp">Cabo de rede (UTP)</option><option value="fibra">Fibra óptica</option>';
function openRackNew() {
  const box = rdEl('rkDlg'); if (!box) return;
  const racks = rackChoices();
  _rd = { mode: 'rack' };
  box.innerHTML = `<div class="box pf" role="dialog" aria-label="Adicionar rack">
    <h5><i class="fas fa-server"></i> Adicionar rack (concentrador MikroTik)</h5>
    <p class="pc-hint">Cada rack tem um único concentrador MikroTik. Depois de criado, ele ganha uma aba e pode receber switches e outros equipamentos.</p>
    <div class="pf-row two"><div><label for="rnName">Nome</label><input id="rnName" maxlength="60" value="Rack ${racks.length + 1}"></div><div><label for="rnIp">IP do concentrador</label><input id="rnIp" maxlength="64" placeholder="10.20.12.8"></div></div>
    <div class="pf-row two"><div><label for="rnEth">Portas RJ45</label><input id="rnEth" type="number" min="0" max="96" value="24"></div><div><label for="rnSfp">Portas SFP</label><input id="rnSfp" type="number" min="0" max="32" value="4"></div></div>
    <div class="pf-row"><label for="rnHnum">Número do hack</label><input id="rnHnum" maxlength="12" placeholder="ex.: 2"></div>
    <div class="pf-row two"><div><label for="rnAndar">Andar</label><input id="rnAndar" maxlength="30" placeholder="ex.: 2º"></div><div><label for="rnSetor">Setor</label><input id="rnSetor" maxlength="60" placeholder="ex.: TI"></div></div>
    <div class="pf-row two"><div><label for="rnRtype">Tipo do rack (hack)</label><select id="rnRtype">${rtypeOpts('secundario')}</select></div>
      <div><label for="rnRole">Papel do MikroTik</label><select id="rnRole">${roleOpts('', true, AUTO_ROLE)}</select></div></div>
    <div class="pf-row"><label for="rnParent">Ligado a (rack acima)</label><select id="rnParent"><option value="">— nenhum (rack independente) —</option>${racks.map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></div>
    <div id="rnLink"></div><div class="td-msg" id="rdMsg" role="status"></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-rd="save"><i class="fas fa-floppy-disk"></i>Adicionar rack</button><button type="button" class="nm-btn" data-rd="cancel">Cancelar</button></div></div>`;
  box.classList.add('open'); rnLink();
  setTimeout(() => { const n = rdEl('rnIp'); if (n) n.focus(); }, 30);
}
function rnLink() {
  const box = rdEl('rnLink'), par = rdEl('rnParent') && rdEl('rnParent').value; if (!box) return;
  box.innerHTML = par ? `<div class="pf-row two"><div><label for="rnPP">Porta de ${esc(devName(par))}</label>${rackPortSel(par, 'rnPP')}</div><div><label for="rnUP">Porta do novo rack</label><input id="rnUP" placeholder="ex.: 1 ou S1" maxlength="4"></div></div>
    <div class="pf-row"><label for="rnMed">Tipo de cabo</label><select id="rnMed">${MED_OPTS}</select></div>` : '';
}
async function saveRackNew() {
  const v = id => (rdEl(id) || {}).value || '';
  const ip = v('rnIp').trim(), name = v('rnName').trim(), eth = Math.round(+v('rnEth') || 0), sfp = Math.round(+v('rnSfp') || 0), par = v('rnParent');
  if (!/^[\w.:-]{1,64}$/.test(ip)) return rdNote('Informe o IP do concentrador (ex.: 10.20.12.8).');
  if (rackChoices().some(r => r.id === ip)) return rdNote('Já existe um rack com esse IP.');
  if (isSwitch(ip)) return rdNote('Esse identificador já é de um equipamento de rack.');
  if (eth < 0 || eth > 96 || sfp < 0 || sfp > 32) return rdNote('Confira o número de portas.');
  let links = topoLinks();
  if (par) {
    const pp = portLabelOf(v('rnPP')), up = portLabelOf(v('rnUP'));
    if ((v('rnPP').trim() && !pp) || (v('rnUP').trim() && !up)) return rdNote('Porta inválida (use 3 ou S1).');
    if (pp) { const c = cablesOf(par).get(pp); if (c) return rdNote(`A porta ${pp} de ${devName(par)} já está ligada a ${devName(c.other)}.`); }
    try { links = applyLink(links, { from: par, to: ip, fp: pp, tp: up, m: v('rnMed') }).links; } catch (e) { return rdNote(e.message); }
  }
  const role = v('rnRole'), rtype = v('rnRtype') || 'secundario', inv0 = { ...(S.topoCfg.inventory || {}) };
  S.topoCfg.inventory = { ...inv0, [ip]: { ...invOf(ip), ...(name ? { name } : {}), ports: eth, sfp, conc: true, rtype, ...(role ? { role } : {}), ...(v('rnHnum').trim() ? { hnum: v('rnHnum').trim() } : {}), ...(v('rnAndar').trim() ? { andar: v('rnAndar').trim() } : {}), ...(v('rnSetor').trim() ? { setor: v('rnSetor').trim() } : {}) } };
  closeRackAdd();
  const ok = await commitLinks(links);
  if (ok && rackView) rackView.setTab(ip);
}
function openRackLink(a, b) {
  const box = rdEl('rkDlg'); if (!box || a === b) return;
  const parentOf = new Map(topoLinks().map(l => [l.to, l.from]));
  for (let x = parentOf.get(a); x; x = parentOf.get(x)) if (x === b) { [a, b] = [b, a]; break; }      // o que já está acima é o pai
  _rd = { mode: 'link', a, b };
  const old = parentOf.get(b);
  box.innerHTML = `<div class="box pf" role="dialog" aria-label="Ligar racks">
    <h5><i class="fas fa-link"></i> Ligar racks</h5>
    <p class="pc-hint"><b>${esc(devName(a))}</b> (acima) ⇌ <b>${esc(devName(b))}</b> (abaixo)${old && old !== a ? `<br>⚠ Isto substitui a ligação atual de ${esc(devName(b))} com ${esc(devName(old))}.` : ''}</p>
    <div class="pf-row two"><div><label for="rlAP">Porta de ${esc(devName(a))}</label>${rackPortSel(a, 'rlAP')}</div><div><label for="rlBP">Porta de ${esc(devName(b))}</label>${rackPortSel(b, 'rlBP')}</div></div>
    <div class="pf-row"><label for="rlMed">Tipo de cabo</label><select id="rlMed">${MED_OPTS}</select></div>
    <div class="td-msg" id="rdMsg" role="status"></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-rd="save"><i class="fas fa-floppy-disk"></i>Ligar</button><button type="button" class="nm-btn" data-rd="cancel">Cancelar</button></div></div>`;
  box.classList.add('open');
}
async function saveRackLink() {
  const v = id => (rdEl(id) || {}).value || '', { a, b } = _rd;
  const ap = portLabelOf(v('rlAP')), bp = portLabelOf(v('rlBP'));
  if ((v('rlAP').trim() && !ap) || (v('rlBP').trim() && !bp)) return rdNote('Porta inválida (use 3 ou S1).');
  let res;
  try { res = applyLink(topoLinks(), { from: a, to: b, fp: ap, tp: bp, m: v('rlMed') }); } catch (e) { return rdNote(e.message); }
  const lost = res.dropped.filter(l => !(l.from === a && l.to === b));
  if (lost.length && !confirm('Isto substitui:\n' + lost.map(l => `• ${devName(l.from)} → ${devName(l.to)}`).join('\n') + '\n\nContinuar?')) return;
  closeRackAdd();
  await commitLinks(res.links);
}
async function removeRack(id) {
  if (rackView.unitIds(id).length > 1) return alert('Este rack tem equipamentos. Mova-os para outro rack (arraste) ou exclua-os antes de remover o rack.');
  const links = topoLinks(), up = links.find(l => l.to === id), down = links.filter(l => l.from === id);
  if (down.length && !up) return alert('Há racks ligados abaixo deste e ele não está ligado a nenhum rack acima. Desfaça essas ligações antes.');
  if (!confirm(`Remover o rack ${devName(id)}?` + (down.length ? `\nOs ${down.length} rack(s) abaixo dele passam a ficar ligados a ${devName(up.from)}.` : ''))) return;
  const inv = { ...(S.topoCfg.inventory || {}) }; if (invOf(id).conc) delete inv[id];
  S.topoCfg.inventory = inv;
  const rest = links.filter(l => l.from !== id && l.to !== id);
  down.forEach(l => rest.push({ from: up.from, to: l.to, fp: '', tp: l.tp, m: l.m }));
  if (rackView.tab === id) rackView.setTab('macro');
  await commitLinks(rest);
}
function rdSave() { if (!_rd) return; if (_rd.mode === 'rack') saveRackNew(); else if (_rd.mode === 'link') saveRackLink(); else saveRackAdd(); }

/* ───────── diálogo "Adicionar equipamento ao rack" ───────── */
let _rd = null;
function rdEl(id) { return document.getElementById(id); }
function openRackAdd(rackId) {
  const racks = rackChoices(), box = rdEl('rkDlg');
  if (!box) return;
  if (!racks.length) { alert('Ainda não há nenhum rack: cadastre os concentradores (ligações) primeiro.'); return; }
  const sel = rackId || (S.topoSel && rackView.rackOf(S.topoSel)) || racks[0].id;
  _rd = { mode: 'equip', rack: racks.some(r => r.id === sel) ? sel : racks[0].id };
  const t = RK_TYPES.switch;
  box.innerHTML = `<div class="box pf" role="dialog" aria-label="Adicionar equipamento ao rack">
    <h5><i class="fas fa-server"></i> Adicionar equipamento ao rack</h5>
    <p class="pc-hint">Todo equipamento fica dentro de um rack, que tem um único concentrador MikroTik. Depois é só arrastar para mudar a posição ou o rack.</p>
    <div class="pf-row"><label for="rdRack">Rack (a qual pertence)</label><select id="rdRack">${racks.map(r => `<option value="${esc(r.id)}"${r.id === _rd.rack ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
    <div class="pf-row two"><div><label for="rdType">Tipo</label><select id="rdType">${Object.entries(RK_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
      <div><label for="rdU">Altura</label><select id="rdU">${[1, 2, 3, 4].map(n => `<option value="${n}">${n} U</option>`).join('')}</select></div></div>
    <div class="pf-row"><label for="rdIp">IP (opcional, ativa o ping)</label><input id="rdIp" maxlength="64" placeholder="ex.: 10.20.12.40"></div>
    <div class="pf-row"><label for="rdRole">Papel (opcional)</label><select id="rdRole">${roleOpts('', true)}</select></div>
    <div class="pf-row"><label for="rdName">Nome</label><input id="rdName" maxlength="60" value="Switch ${rackView.unitIds(_rd.rack).length}"></div>
    <div class="pf-row two"><div><label for="rdEth">Portas RJ45</label><input id="rdEth" type="number" min="0" max="96" value="${t.eth}"></div>
      <div><label for="rdSfp">Portas SFP</label><input id="rdSfp" type="number" min="0" max="32" value="${t.sfp}"></div></div>
    <div class="pf-row"><label for="rdParent">Ligado a</label><select id="rdParent"></select></div>
    <div id="rdLink"></div>
    <div class="td-msg" id="rdMsg" role="status"></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-rd="save"><i class="fas fa-floppy-disk"></i>Adicionar</button><button type="button" class="nm-btn" data-rd="cancel">Cancelar</button></div></div>`;
  box.classList.add('open');
  rdParents(); rdLink();
  setTimeout(() => { const n = rdEl('rdName'); if (n) { n.focus(); n.select(); } }, 30);
}
function closeRackAdd() { const b = rdEl('rkDlg'); if (b) { b.classList.remove('open'); b.innerHTML = ''; } _rd = null; }
function rdParents() {
  const el = rdEl('rdParent'); if (!el) return;
  const ids = rackView.unitIds(rdEl('rdRack').value);
  el.innerHTML = `<option value="">— não ligado (só fica neste rack) —</option>${ids.map(id => `<option value="${esc(id)}">${esc(devName(id))}</option>`).join('')}`;
}
function rdLink() {
  const box = rdEl('rdLink'), par = rdEl('rdParent') && rdEl('rdParent').value; if (!box) return;
  if (!par) { box.innerHTML = ''; return; }
  const dp = devPorts(par);
  const pp = dp.items.length ? `<select id="rdPP"><option value="">— escolha —</option>${portOptions(par, '', null)}</select>` : `<input id="rdPP" placeholder="ex.: 5 ou S1" maxlength="4">`;
  box.innerHTML = `<div class="pf-row two"><div><label for="rdPP">Porta de ${esc(devName(par))}</label>${pp}</div>
      <div><label for="rdUP">Porta deste equipamento</label><input id="rdUP" placeholder="ex.: 1 ou S1" maxlength="4"></div></div>
    <div class="pf-row"><label for="rdMed">Tipo de cabo</label><select id="rdMed"><option value="">Automático (SFP = fibra)</option><option value="utp">Cabo de rede (UTP)</option><option value="fibra">Fibra óptica</option></select></div>`;
}
function rdNote(msg) { const e = rdEl('rdMsg'); if (e) { e.textContent = msg; e.className = 'td-msg show err'; } }
async function saveRackAdd() {
  if (!_rd) return;
  const v = id => (rdEl(id) || {}).value || '';
  const type = v('rdType'), rack = v('rdRack'), par = v('rdParent');
  const name = v('rdName').trim() || RK_TYPES[type].label, eth = Math.round(+v('rdEth') || 0), sfp = Math.round(+v('rdSfp') || 0), u = +v('rdU') || 1;
  if (eth < 0 || eth > 96) return rdNote('Portas RJ45: informe de 0 a 96.');
  if (sfp < 0 || sfp > 32) return rdNote('Portas SFP: informe de 0 a 32.');
  const id = 'sw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  let links = topoLinks();
  if (par) {
    const pp = portLabelOf(v('rdPP')), up = portLabelOf(v('rdUP'));
    if (v('rdPP').trim() && !pp) return rdNote('Porta de ' + devName(par) + ' inválida (use 3 ou S1).');
    if (v('rdUP').trim() && !up) return rdNote('Porta do equipamento inválida (use 3 ou S1).');
    if (pp) { const c = cablesOf(par).get(pp); if (c) return rdNote(`A porta ${pp} de ${devName(par)} já está ligada a ${devName(c.other)}. Escolha outra.`); }
    if (up && (labelIsSfp(up) ? !sfp || labelNum(up) > sfp : !eth || labelNum(up) > eth)) return rdNote(`O equipamento não tem a porta ${up}: confira o número de portas.`);
    links = [...links, { from: par, to: id, fp: pp, tp: up, m: v('rdMed') }];
  }
  const ent = { name, ports: eth, sfp, sw: true, rack }; if (v('rdRole')) ent.role = v('rdRole'); if (/^[\w.:-]{1,64}$/.test(v('rdIp').trim())) ent.ip = v('rdIp').trim(); if (type !== 'switch') ent.etype = type; if (u > 1) ent.u = u;
  S.topoCfg.inventory = { ...(S.topoCfg.inventory || {}), [id]: ent };
  closeRackAdd();
  const ok = await commitLinks(links);
  if (ok && activeView()) { activeView().select(id); activeView().centerOn(id); }
}
function onRackDlgEvent(e) {
  if (e.type === 'click') {
    const b = e.target.closest('[data-rd]');
    if (b) { if (b.dataset.rd === 'save') rdSave(); else closeRackAdd(); return; }
    if (e.target.id === 'rkDlg') closeRackAdd();
  } else if (e.type === 'change') {
    const t = e.target;
    if (t.id === 'rdType') {
      const d = RK_TYPES[t.value]; rdEl('rdEth').value = d.eth; rdEl('rdSfp').value = d.sfp; rdEl('rdU').value = d.u; rdEl('rdName').value = d.label + ' ' + (rackView.unitIds(rdEl('rdRack').value).length);
    } else if (t.id === 'rdRack') { rdParents(); rdLink(); }
    else if (t.id === 'rdParent') rdLink();
    else if (t.id === 'rnParent') rnLink();
  } else if (e.type === 'keydown') {
    if (e.key === 'Escape') { e.stopPropagation(); closeRackAdd(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'SELECT') { e.preventDefault(); rdSave(); }
  }
}

/* ───────── aba Portas: switches abaixo deste equipamento ───────── */
const swKids = ip => topoLinks().filter(l => l.from === ip && isSwitch(l.to));
function swListHTML(ip) {
  const kids = swKids(ip);
  const deep = id => swKids(id).reduce((n, l) => n + 1 + deep(l.to), 0);
  return kids.length ? `<div class="sw-list">${kids.map(l => { const d = deep(l.to), md = linkMedium(l), inv = invOf(l.to);
    return `<button type="button" class="sw-row" data-act="goOther" data-ip="${esc(l.to)}"><i class="fas fa-network-wired"></i>
      <span><b>${esc(devName(l.to))}</b><small>${(inv.ports | 0) + (inv.sfp | 0) ? (inv.ports | 0) + ' RJ45' + (inv.sfp ? ' · ' + inv.sfp + ' SFP' : '') : 'portas não definidas'}${d ? ' · +' + d + ' abaixo' : ''}</small></span>
      <span class="mt ${md}">${esc(MEDIUM_SHORT[md])}${l.fp || l.tp ? ' · ' + esc(l.fp || '?') + ' ⇌ ' + esc(l.tp || '?') : ''}</span></button>`; }).join('')}</div>`
    : '<p class="pc-hint">Nenhum switch cadastrado abaixo deste equipamento.</p>';
}
function swFormHTML(ip) {
  const dp = devPorts(ip), n = swKids(ip).length + 1;
  const pp = dp.items.length ? `<select id="swfPP"><option value="">— escolha —</option>${portOptions(ip, '', null)}</select>` : `<input id="swfPP" placeholder="ex.: 5 ou S1" maxlength="4">`;
  return `<div class="pf swf"><h6>Novo switch abaixo de ${esc(devName(ip))}</h6>
    <div class="pf-row"><label for="swfName">Nome</label><input id="swfName" value="Switch ${n}" maxlength="60"></div>
    <div class="pf-row two"><div><label for="swfEth">Portas RJ45</label><input id="swfEth" type="number" min="0" max="96" value="24"></div>
      <div><label for="swfSfp">Portas SFP</label><input id="swfSfp" type="number" min="0" max="32" value="0"></div></div>
    <div class="pf-row two"><div><label for="swfPP">Porta de ${esc(devName(ip))}</label>${pp}</div>
      <div><label for="swfUP">Porta do switch (uplink)</label><input id="swfUP" placeholder="ex.: 1 ou S1" maxlength="4"></div></div>
    <div class="pf-row"><label for="swfIp">IP (opcional, ativa o ping)</label><input id="swfIp" maxlength="64" placeholder="ex.: 10.20.12.40"></div>
    <div class="pf-row"><label for="swfRole">Papel (opcional)</label><select id="swfRole">${roleOpts('', true)}</select></div>
    <div class="pf-row"><label for="swfMed">Tipo de cabo</label><select id="swfMed"><option value="">Automático (SFP = fibra)</option><option value="utp">Cabo de rede (UTP)</option><option value="fibra">Fibra óptica</option></select></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-act="swSave"><i class="fas fa-floppy-disk"></i>Adicionar switch</button><button type="button" class="nm-btn" data-act="swCancel">Cancelar</button></div></div>`;
}
function renderSw() {
  const ip = S.topoSel, el = gid('tdSw'); if (!ip || !el) return;
  el.innerHTML = `<div class="sw-sec"><div class="pl-head"><h6>Switches abaixo</h6>${S.topoSw ? '' : '<button type="button" class="pl-all" data-act="swNew"><i class="fas fa-plus"></i> Adicionar switch</button>'}</div>
    <div id="tdSwList"></div>${S.topoSw ? swFormHTML(ip) : ''}</div>`;
  refreshSwList(ip);
}
function refreshSwList(ip) {
  const el = gid('tdSwList'); if (!el) return;
  const h = swListHTML(ip);
  if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; }
}
async function saveSwitch() {
  const ip = S.topoSel; if (!ip || !S.topoSw) return;
  const v = id => (gid(id) || {}).value || '';
  const name = v('swfName').trim() || 'Switch', eth = Math.round(+v('swfEth') || 0), sfp = Math.round(+v('swfSfp') || 0);
  if (eth < 0 || eth > 96) return tdNote('Portas RJ45: informe de 0 a 96.', 'err');
  if (sfp < 0 || sfp > 32) return tdNote('Portas SFP: informe de 0 a 32.', 'err');
  const pp = portLabelOf(v('swfPP')), up = portLabelOf(v('swfUP'));
  if (v('swfPP').trim() && !pp) return tdNote('Porta de ' + devName(ip) + ' inválida (use 3 ou S1).', 'err');
  if (v('swfUP').trim() && !up) return tdNote('Porta do switch inválida (use 3 ou S1).', 'err');
  if (pp) { const c = cablesOf(ip).get(pp); if (c) return tdNote(`A porta ${pp} de ${devName(ip)} já está ligada a ${devName(c.other)}. Escolha outra porta.`, 'err'); }
  if (up && labelIsSfp(up) ? !sfp || labelNum(up) > sfp : (up && (!eth || labelNum(up) > eth))) return tdNote(`O switch não tem a porta ${up}: confira o número de portas.`, 'err');
  const id = 'sw-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  S.topoCfg.inventory = { ...(S.topoCfg.inventory || {}), [id]: { name, ports: eth, sfp, sw: true, ...(/^[\w.:-]{1,64}$/.test(v('swfIp').trim()) ? { ip: v('swfIp').trim() } : {}), ...(v('swfRole') ? { role: v('swfRole') } : {}), ...(rackView.rackOf(ip) ? { rack: rackView.rackOf(ip) } : {}) } };
  S.topoSw = null; renderSw();
  const ok = await commitLinks([...topoLinks(), { from: ip, to: id, fp: pp, tp: up, m: v('swfMed') }]);
  if (ok) tdNote(`${name} adicionado.`, 'ok');
  renderSw(); renderCfg(); refreshPanel(ip); refreshPortList(ip);
}
async function removeSwitch(id) {
  const all = new Set([id]);                                      // o switch e os switches abaixo dele
  for (let grew = true; grew;) { grew = false; topoLinks().forEach(l => { if (all.has(l.from) && isSwitch(l.to) && !all.has(l.to)) { all.add(l.to); grew = true; } }); }
  const extra = all.size - 1;
  if (!confirm(`Remover ${devName(id)}${extra ? ' e mais ' + extra + ' switch(es) abaixo dele' : ''}? As ligações deles também serão apagadas.`)) return;
  const inv = { ...(S.topoCfg.inventory || {}) }; all.forEach(x => delete inv[x]);
  S.topoCfg.inventory = inv;
  const ok = await commitLinks(topoLinks().filter(l => !all.has(l.from) && !all.has(l.to)));
  if (ok) { S.topoCfgOpen = false; activeView().select(null); }
}

/* ───────── aba Portas: painel e lista ───────── */
function panelHTML(ip) {
  const dp = devPorts(ip);
  if (!dp.items.length) return '';
  const cab = cablesOf(ip), eth = dp.items.filter(x => !x.sfp), sfp = dp.items.filter(x => x.sfp);
  const sq = x => { const c = cab.get(x.label), st = portState(x, c);
    return `<button type="button" class="pq ${st.cls}${c && linkMedium(c.link) === 'fibra' ? ' fib' : ''}${S.topoPortSel === x.label ? ' sel' : ''}" data-port="${esc(x.label)}" style="--act:${x.live ? actPctOf(x.live).toFixed(0) : 0}" title="${esc(portTitle(ip, x, c))}"><span>${esc(x.label)}</span></button>`; };
  const two = eth.length > 12, cols = two ? Math.ceil(eth.length / 2) : Math.max(1, eth.length);
  return `<div class="pq-wrap">
    ${eth.length ? `<div class="pq-grid${two ? ' two' : ''}" style="--c:${cols}">${eth.map(sq).join('')}</div>` : ''}
    ${sfp.length ? `<div class="pq-sub">SFP / Fibra</div><div class="pq-grid" style="--c:${eth.length ? cols : Math.max(sfp.length, 4)}">${sfp.map(sq).join('')}</div>` : ''}
    <div class="pq-leg"><span><i class="cab"></i>Com cabo</span><span><i class="free"></i>Livre</span>${dp.source === 'live' ? '<span><i class="sp-ge"></i>Link ativo</span><span><i class="cabdown"></i>Cabo sem link</span><span><i class="unm sp-ge"></i>Ativa sem cabo definido</span>' : ''}</div></div>`;
}
function refreshPanel(ip) {
  const el = gid('tdPanel'); if (!el) return;
  const dp = devPorts(ip), cab = cablesOf(ip);
  const sig = ip + '|' + S.topoPortSel + '|' + dp.source + '|' + dp.items.map(x => x.label + ':' + portState(x, cab.get(x.label)).key).join(',');
  if (el.dataset.sig !== sig) { el.dataset.sig = sig; el.innerHTML = panelHTML(ip); return; }
  el.querySelectorAll('.pq').forEach(b => {                       // só atividade e dica: não refaz os botões
    const x = dp.items.find(i => i.label === b.dataset.port); if (!x) return;
    b.style.setProperty('--act', x.live ? actPctOf(x.live).toFixed(0) : 0);
    b.title = portTitle(ip, x, cab.get(x.label));
  });
}
function listItems(ip) {
  const dp = devPorts(ip), cab = cablesOf(ip);
  return dp.items.filter(x => S.topoUi.allPorts || cab.has(x.label) || (x.live && x.live.running) || S.topoPortSel === x.label);
}
function listRowHTML(ip, x, cab) {
  const c = cab.get(x.label), p = x.live, st = portState(x, c);
  return `<button type="button" class="pr${S.topoPortSel === x.label ? ' sel' : ''}" data-port="${esc(x.label)}">
    <span class="pb ${st.cls.replace(/ (has|unm)/g, '')}">${esc(x.label)}</span>
    <span class="pr-n">${esc(p ? (p.comment || p.name) : 'Porta ' + x.label)}${p && p.comment ? `<small>${esc(p.name)}</small>` : ''}</span>
    <span class="pr-c">${c ? `<i class="fas ${linkMedium(c.link) === 'fibra' ? 'fa-bolt mt-ico fibra' : 'fa-plug mt-ico utp'}" title="${esc(MEDIUM_NAME[linkMedium(c.link)])}"></i> ${esc(devName(c.other))}${c.otherPort ? ' · ' + esc(c.otherPort) : ''}` : (p && p.neighbor ? `<em>${esc(p.neighbor.identity || p.neighbor.address || '')}</em>` : '<span class="nm-muted">—</span>')}</span>
    <span class="pr-v">${p ? (p.running ? (p.speed ? esc(fmtSpeed(p.speed)) : 'ativa') : 'sem link') : ''}</span>
    <span class="pr-t">${p ? `<span class="d">↓${fmtRate(p.rxBps)}</span> <span class="u">↑${fmtRate(p.txBps)}</span>` : ''}</span></button>`;
}
function refreshPortList(ip) {
  const el = gid('tdPorts'); if (!el) return;
  const dp = devPorts(ip), cab = cablesOf(ip), items = listItems(ip);
  const sig = ip + '|' + S.topoPortSel + '|' + !!S.topoUi.allPorts + '|' + items.map(x => x.label + ':' + (cab.get(x.label) ? cab.get(x.label).other + '/' + cab.get(x.label).otherPort : '') + ':' + portState(x, cab.get(x.label)).key).join(',');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    const unm = topoLinks().filter(l => (l.from === ip && !l.fp) || (l.to === ip && !l.tp));
    el.innerHTML = `<div class="pl-head"><h6>Portas e cabos</h6><button type="button" class="pl-all" data-act="allPorts">${S.topoUi.allPorts ? 'Só as usadas' : 'Mostrar todas (' + dp.items.length + ')'}</button></div>
      ${unm.length ? `<div class="pl-unm"><b>Ligações sem porta definida</b>${unm.map(l => { const down = l.from === ip, other = down ? l.to : l.from;
        return `<div><span>${down ? '↓' : '↑'} ${esc(devName(other))}</span><button type="button" class="nm-btn" data-act="assign" data-to="${esc(l.to)}">Definir portas</button></div>`; }).join('')}</div>` : ''}
      <div class="pr-list">${items.length ? items.map(x => listRowHTML(ip, x, cab)).join('') : '<div class="nm-muted pr-empty">Nenhuma porta com cabo definido ou com tráfego. Clique em uma porta acima para ligar um cabo.</div>'}</div>`;
    return;
  }
  el.querySelectorAll('.pr').forEach(b => {                      // só os valores ao vivo
    const x = dp.items.find(i => i.label === b.dataset.port); if (!x || !x.live) return;
    const p = x.live, v = b.querySelector('.pr-v'), t = b.querySelector('.pr-t');
    const vt = p.running ? (p.speed ? fmtSpeed(p.speed) : 'ativa') : 'sem link';
    if (v.textContent !== vt) v.textContent = vt;
    t.innerHTML = `<span class="d">↓${fmtRate(p.rxBps)}</span> <span class="u">↑${fmtRate(p.txBps)}</span>`;
  });
}

/* ───────── inspetor de porta + formulário "Ligar cabo" ───────── */
function inspectorHTML(ip) {
  const lab = S.topoPortSel, dp = devPorts(ip), cab = cablesOf(ip);
  const item = lab && dp.items.find(x => x.label === lab);
  let h = '';
  if (item) {
    const p = item.live, c = cab.get(lab);
    h += `<div class="pi-head"><b>Porta ${esc(lab)}</b>${p ? `<small>${esc(p.name)}${p.comment ? ' · ' + esc(p.comment) : ''}</small>` : ''}<span id="tdPLive" class="pi-live"></span></div>`;
    if (!S.topoForm) {
      h += c
        ? `<div class="pi-cab"><i class="fas fa-plug"></i><div><b>${esc(devName(c.other))}</b><small>${c.dir === 'down' ? '↓ equipamento abaixo' : '↑ equipamento acima'} · ${c.otherPort ? 'porta ' + esc(c.otherPort) : 'porta não definida'} · <span class="mt ${linkMedium(c.link)}">${esc(MEDIUM_NAME[linkMedium(c.link)])}</span></small></div></div>
           <div class="pi-act"><button type="button" class="nm-btn" data-act="goOther" data-ip="${esc(c.other)}"><i class="fas fa-location-arrow"></i>Ir para ele</button>
             <button type="button" class="nm-btn" data-act="editCable"><i class="fas fa-pen"></i>Alterar</button>
             <button type="button" class="nm-btn nm-btn-danger-o" data-act="unplug"><i class="fas fa-plug-circle-xmark"></i>Desconectar</button></div>`
        : `<div class="pi-cab free"><i class="fas fa-plug-circle-xmark"></i><div><b>Sem cabo definido</b><small>Diga onde esta porta está ligada para o mapa mostrar a conexão.</small></div></div>
           ${p && p.neighbor ? `<div class="pi-nb"><i class="fas fa-satellite-dish"></i><div>Vizinho detectado: <b>${esc(p.neighbor.identity || p.neighbor.address || p.neighbor.mac)}</b><small>${[p.neighbor.address, p.neighbor.platform, p.neighbor.board].filter(Boolean).map(esc).join(' · ')}</small></div>
              <button type="button" class="nm-btn" data-act="useNeighbor">Ligar a ele</button></div>` : ''}
           <div class="pi-act"><button type="button" class="nm-btn nm-btn-primary" data-act="connect"><i class="fas fa-plug"></i>Ligar cabo</button></div>`;
    }
  } else if (!S.topoForm) {
    h += dp.items.length
      ? `<div class="pi-hint"><i class="fas fa-hand-pointer"></i>Clique em uma porta para ver detalhes e ligar um cabo.</div><div class="pi-act"><button type="button" class="nm-btn" data-act="connect"><i class="fas fa-plug"></i>Ligar cabo</button></div>`
      : '';
  }
  if (S.topoForm) h += formHTML(ip);
  return `<div class="pi">${h}</div>`;
}
function renderInspector() {
  const ip = S.topoSel, box = gid('tdInsp'); if (!ip || !box) return;
  box.innerHTML = inspectorHTML(ip);
  updateFormWarn();
  refreshPortLive(ip);
}
function refreshPortLive(ip) {
  const el = gid('tdPLive'); if (!el) return;
  const item = devPorts(ip).items.find(x => x.label === S.topoPortSel), p = item && item.live;
  el.innerHTML = p ? `<span class="pl-st ${p.disabled ? 'dis' : p.running ? 'up' : ''}"><i></i>${p.disabled ? 'Desativada' : p.running ? (p.speed ? fmtSpeed(p.speed) : 'Ativa') : 'Sem link'}</span>
      <span class="d">↓ ${fmtRate(p.rxBps)}</span> <span class="u">↑ ${fmtRate(p.txBps)}</span> <span class="tot">${fmtBytesN(p.rxBytes)} / ${fmtBytesN(p.txBytes)}</span>` : '';
}
function formState(ip, over) {
  return { ip, port: S.topoPortSel || '', dir: 'down', other: '', newIp: '', newName: '', oport: '', m: '', editTo: null, ...(over || {}) };
}
function portOptions(ip, selected, own) {
  const dp = devPorts(ip), cab = cablesOf(ip);
  return dp.items.map(x => { const c = cab.get(x.label);
    return `<option value="${esc(x.label)}"${selected === x.label ? ' selected' : ''}>${esc(x.label)}${c && !(own && c.link === own) ? ' — ' + esc(devName(c.other)) + (c.otherPort ? ' · ' + esc(c.otherPort) : '') : ' — livre'}</option>`; }).join('');
}
function formHTML(ip) {
  const f = S.topoForm, dp = devPorts(ip);
  const own = f.editTo ? topoLinks().find(l => l.to === f.editTo) : null;
  const cands = candidateDevices(ip);
  const oip = f.other === '__new' ? f.newIp.trim() : f.other;
  const odp = oip ? devPorts(oip) : { items: [] };
  const myField = dp.items.length
    ? `<select id="pfPort"><option value="">— escolha a porta —</option>${portOptions(ip, f.port, own)}</select>`
    : `<input id="pfPort" value="${esc(f.port)}" placeholder="ex.: 3 ou S1" maxlength="4">`;
  const oField = odp.items.length
    ? `<select id="pfOPort"><option value="">— não definida —</option>${portOptions(oip, f.oport, own)}</select>`
    : `<input id="pfOPort" value="${esc(f.oport)}" placeholder="ex.: 1 ou S1 (opcional)" maxlength="4">`;
  return `<div class="pf" id="pf">
    <h6>${f.editTo ? 'Alterar cabo' : 'Ligar cabo'}</h6>
    <div class="pf-row"><label for="pfPort">Porta deste equipamento</label>${myField}</div>
    <div class="pf-row"><label>Esta porta liga a um equipamento…</label>
      <div class="nm-seg pf-dir"><button type="button" data-dir="down" class="${f.dir === 'down' ? 'active' : ''}">↓ abaixo</button><button type="button" data-dir="up" class="${f.dir === 'up' ? 'active' : ''}">↑ acima</button></div>
      <small class="pf-help">${f.dir === 'down' ? 'Este equipamento fica acima do outro na árvore (é o pai).' : 'Esta porta é o uplink: o outro equipamento fica acima (é o pai).'}</small></div>
    <div class="pf-row"><label for="pfDev">Equipamento do outro lado</label>
      <select id="pfDev"><option value="">— escolha —</option>${cands.map(c => `<option value="${esc(c.ip)}"${f.other === c.ip ? ' selected' : ''}>${esc(c.name)}${c.name !== c.ip && !isSwitch(c.ip) ? ' · ' + esc(c.ip) : ''}${isSwitch(c.ip) ? ' (switch)' : ''}</option>`).join('')}<option value="__new"${f.other === '__new' ? ' selected' : ''}>Outro equipamento (digitar IP)…</option></select></div>
    ${f.other === '__new' ? `<div class="pf-row two"><div><label for="pfIp">IP</label><input id="pfIp" value="${esc(f.newIp)}" placeholder="10.20.12.8" maxlength="64"></div><div><label for="pfName">Nome (opcional)</label><input id="pfName" value="${esc(f.newName)}" maxlength="60"></div></div>` : ''}
    <div class="pf-row"><label for="pfOPort">Porta do outro equipamento</label>${oField}</div>
    <div class="pf-row"><label for="pfMed">Tipo de cabo</label>
      <select id="pfMed"><option value="">Automático</option><option value="utp"${f.m === 'utp' ? ' selected' : ''}>Cabo de rede (UTP)</option><option value="fibra"${f.m === 'fibra' ? ' selected' : ''}>Fibra óptica</option></select></div>
    <div class="pf-warn" id="pfWarn"></div>
    <div class="pf-act"><button type="button" class="nm-btn nm-btn-primary" data-act="saveLink"><i class="fas fa-floppy-disk"></i>Salvar ligação</button><button type="button" class="nm-btn" data-act="cancelForm">Cancelar</button></div></div>`;
}
function formLink() {
  const f = S.topoForm, ip = f.ip;
  const oip = f.other === '__new' ? f.newIp.trim() : f.other;
  const port = portLabelOf(f.port), oport = portLabelOf(f.oport);
  return f.dir === 'down' ? { from: ip, to: oip, fp: port, tp: oport, m: f.m } : { from: oip, to: ip, fp: oport, tp: port, m: f.m };
}
function updateFormWarn() {
  const el = gid('pfWarn'); if (!el || !S.topoForm) return;
  const f = S.topoForm, msgs = [];
  const oip = f.other === '__new' ? f.newIp.trim() : f.other;
  if (oip && oip !== f.ip) {
    try {
      const base = topoLinks().filter(l => !(f.editTo && l.to === f.editTo));
      const nl = formLink();
      applyLink(base, nl).dropped.filter(l => !(l.from === nl.from && l.to === nl.to)).forEach(l => msgs.push(`Substitui a ligação ${devName(l.from)}${l.fp ? ' (porta ' + l.fp + ')' : ''} → ${devName(l.to)}${l.tp ? ' (porta ' + l.tp + ')' : ''}.`));
    } catch (e) { msgs.push('⚠ ' + e.message); }
  }
  el.innerHTML = msgs.map(m => `<div>${esc(m)}</div>`).join('');
  const med = gid('pfMed');                                       // o "Automático" mostra o que será usado
  if (med) med.options[0].textContent = 'Automático — ' + (linkMedium({ ...formLink(), m: '' }) === 'fibra' ? 'fibra (porta SFP)' : 'cabo de rede');
}
async function saveLinkFromForm() {
  const f = S.topoForm; if (!f) return;
  const oip = f.other === '__new' ? f.newIp.trim() : f.other;
  if (!f.other) return tdNote('Escolha o equipamento do outro lado do cabo.', 'err');
  if (f.other === '__new' && !/^[\w.:-]{1,64}$/.test(oip)) return tdNote('Informe um IP válido para o outro equipamento.', 'err');
  if (oip === f.ip) return tdNote('Escolha outro equipamento: este é o mesmo.', 'err');
  if (!portLabelOf(f.port)) return tdNote('Informe a porta deste equipamento onde o cabo está ligado.', 'err');
  if (f.oport && !portLabelOf(f.oport)) return tdNote('Porta do outro equipamento inválida (use 3 ou S1).', 'err');
  let res;
  try {
    const base = topoLinks().filter(l => !(f.editTo && l.to === f.editTo));
    res = applyLink(base, formLink());
  } catch (e) { return tdNote(e.message, 'err'); }
  if (f.other === '__new' && f.newName.trim()) S.topoCfg.inventory = { ...(S.topoCfg.inventory || {}), [oip]: { ...invOf(oip), name: f.newName.trim() } };
  S.topoPortSel = portLabelOf(f.port); S.topoForm = null;
  renderInspector(); refreshPanel(f.ip); refreshPortList(f.ip);
  const ok = await commitLinks(res.links);
  if (ok) tdNote('Ligação salva.', 'ok');
  renderCfg(); renderInspector(); refreshPanel(f.ip); refreshPortList(f.ip);
}
async function unplug() {
  const ip = S.topoSel, c = cablesOf(ip).get(S.topoPortSel); if (!c) return;
  if (!confirm(`Desconectar o cabo da porta ${S.topoPortSel} (${devName(c.other)})?`)) return;
  const ok = await commitLinks(topoLinks().filter(l => l !== c.link));
  if (ok) tdNote('Cabo desconectado.', 'ok');
  renderCfg(); renderInspector(); refreshPanel(ip); refreshPortList(ip);
}
async function detachDevice() {
  const ip = S.topoSel; if (!ip) return;
  if (isSwitch(ip)) return removeSwitch(ip);
  if (rackView.unitIds(ip).length > 1 || invOf(ip).conc) return removeRack(ip);
  if (rackView.unitIds(ip).length > 1) return tdNote('Este concentrador tem equipamentos no rack. Mova-os para outro rack (arraste) ou exclua-os antes de removê-lo do mapa.', 'err');
  if (!confirm(`Remover ${devName(ip)} do mapa? As ligações dele serão apagadas (o número de portas é mantido).`)) return;
  const ok = await commitLinks(topoLinks().filter(l => l.from !== ip && l.to !== ip));
  if (ok) { S.topoCfgOpen = false; activeView().select(null); }
}

/* ───────── eventos da gaveta (delegação; o HTML é refeito) ───────── */
function selectPort(label) {
  S.topoPortSel = label;
  if (S.topoForm) { S.topoForm.port = label; }
  renderInspector(); refreshPanel(S.topoSel); refreshPortList(S.topoSel);
}
function setDtab(tab) {
  if (S.topoUi.dtab === tab) return;
  S.topoUi.dtab = tab; saveTopoUi(); renderTopoDetails(true);
}
const ACTIONS = {
  goPorts: () => setDtab('ports'),
  swNew: () => { S.topoSw = true; renderSw(); },
  swCancel: () => { S.topoSw = null; renderSw(); },
  swSave: saveSwitch,
  openTraffic: () => openTrafficFor(S.topoSel),
  sshCfg: () => openTrafficFor('', { cfg: true }),
  editDev: () => { if (S.devices[S.topoSel]) openModal(S.topoSel); },
  cfgToggle: () => { S.topoCfgOpen = !S.topoCfgOpen; renderCfg(); },
  saveInv: saveInventory,
  detach: detachDevice,
  allPorts: () => { S.topoUi.allPorts = !S.topoUi.allPorts; saveTopoUi(); refreshPortList(S.topoSel); },
  connect: () => { S.topoForm = formState(S.topoSel); renderInspector(); },
  cancelForm: () => { S.topoForm = null; renderInspector(); },
  saveLink: saveLinkFromForm,
  unplug,
  goOther: a => { const v = activeView(), id = a.dataset.ip; if (v) { v.select(id); v.centerOn(id); } },
  editCable: () => {
    const c = cablesOf(S.topoSel).get(S.topoPortSel); if (!c) return;
    S.topoForm = formState(S.topoSel, { port: S.topoPortSel, dir: c.dir, other: c.other, oport: c.otherPort || '', m: c.link.m || '', editTo: c.link.to });
    renderInspector();
  },
  assign: a => {
    const l = topoLinks().find(x => x.to === a.dataset.to); if (!l) return;
    const down = l.from === S.topoSel, other = down ? l.to : l.from;
    S.topoPortSel = null;
    S.topoForm = formState(S.topoSel, { port: down ? l.fp : l.tp, dir: down ? 'down' : 'up', other, oport: down ? l.tp : l.fp, m: l.m || '', editTo: l.to });
    renderInspector();
  },
  useNeighbor: () => {
    const item = devPorts(S.topoSel).items.find(x => x.label === S.topoPortSel), n = item && item.live && item.live.neighbor; if (!n) return;
    const known = candidateDevices(S.topoSel).find(c => c.ip === n.address);
    S.topoForm = formState(S.topoSel, known ? { other: known.ip } : { other: '__new', newIp: n.address || '', newName: n.identity || '' });
    renderInspector();
  },
};
function onDetailsClick(e) {
  const dtab = e.target.closest('[data-dtab]'); if (dtab) return setDtab(dtab.dataset.dtab);
  const dir = e.target.closest('[data-dir]'); if (dir && S.topoForm) { S.topoForm.dir = dir.dataset.dir; return renderInspector(); }
  const act = e.target.closest('[data-act]'); if (act) { const fn = ACTIONS[act.dataset.act]; if (fn) fn(act); return; }
  const port = e.target.closest('[data-port]');
  if (port) { if (port.dataset.goto && S.topoUi.dtab !== port.dataset.goto) { S.topoPortSel = port.dataset.port; setDtab(port.dataset.goto); return; } selectPort(port.dataset.port); }
}
function onDetailsChange(e) {
  const t = e.target, f = S.topoForm;
  if (!f) return;
  if (t.id === 'pfPort') { f.port = t.value; if (portLabelOf(t.value)) S.topoPortSel = portLabelOf(t.value); updateFormWarn(); refreshPanel(f.ip); }
  else if (t.id === 'pfDev') { f.other = t.value; f.oport = ''; renderInspector(); }
  else if (t.id === 'pfOPort') { f.oport = t.value; updateFormWarn(); }
  else if (t.id === 'pfMed') { f.m = t.value; updateFormWarn(); }
}
function onDetailsInput(e) {
  const t = e.target, f = S.topoForm;
  if (!f) return;
  if (t.id === 'pfIp') { f.newIp = t.value; updateFormWarn(); }
  else if (t.id === 'pfName') f.newName = t.value;
  else if (t.id === 'pfPort' && t.tagName === 'INPUT') { f.port = t.value; updateFormWarn(); }
  else if (t.id === 'pfOPort' && t.tagName === 'INPUT') { f.oport = t.value; updateFormWarn(); }
}
function onDetailsKey(e) {
  if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
  if (e.target.closest('#pf')) { e.preventDefault(); saveLinkFromForm(); }
  else if (e.target.closest('.swf')) { e.preventDefault(); saveSwitch(); }
  else if (e.target.closest('.pc-form')) { e.preventDefault(); saveInventory(); }
}
function initTopoPorts() {
  const ub = gid('btnUndo'); if (ub) ub.addEventListener('click', undoTopo);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && topoVisible() && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { e.preventDefault(); undoTopo(); }
  });
  updateUndoBtn();
  const dlg = gid('rkDlg');
  if (dlg) ['click', 'change', 'keydown'].forEach(t => dlg.addEventListener(t, onRackDlgEvent));
  const p = gid('topoDetailsPanel'); if (!p) return;
  p.addEventListener('click', onDetailsClick);
  p.addEventListener('change', onDetailsChange);
  p.addEventListener('input', onDetailsInput);
  p.addEventListener('keydown', onDetailsKey);
}
