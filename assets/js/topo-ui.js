/* Topologia: modelo de dados, barra lateral (modo, busca, destaque, filtros com contagem,
   rótulos), visão em árvore e de infraestrutura, linha do tempo e painel de detalhes.
   Depende de app.js (S, TYPE_INFO, ipCmp, esc, fmtRT, fmtClock, svcChips, openModal),
   de icons.js (NetIcons) e de topology.js (TopoView, InfraView). */
'use strict';

let topoView = null, infraView = null, rackView = null;
if (!TYPE_INFO.switch) TYPE_INFO.switch = { ...(TYPE_INFO.nucleo || TYPE_INFO.unknown), label: 'Switch' };
const COMP_THRESH = 8;          // acima disso, computadores ficam recolhidos num grupo
S.traffic = {};
S.ping = {};                    // ip -> { online, rt, since } (ping contínuo do servidor)
S.pingHist = {};                // ip -> { t, data } (histórico em arquivo: eventos, últimos 60 min, disponibilidade)                 // host -> equipamento de /api/traffic (SSH RouterOS): portas, velocidades, vizinhos
S.topoSel = null;
S.topoEvents = [];

const TOPO_UI_KEY = 'nm_topo_ui';
S.topoUi = { mode: 'tree', dtab: 'ports', allPorts: false, sbOpen: null, sbOpenN: false, spot: false, search: '', fStatus: [], fType: [], cpuMem: true, tlOpen: null, orient: 'LR',
             labels: { ip: true, traffic: true, rt: true, links: true }, collapsed: {} };
function loadTopoUi() {
  try {
    const u = JSON.parse(localStorage.getItem(TOPO_UI_KEY) || '{}');
    ['mode', 'rackSide', 'rackTab', 'sbOpen', 'sbOpenN', 'spot', 'cpuMem', 'tlOpen', 'orient', 'allPorts'].forEach(k => { if (u[k] !== undefined) S.topoUi[k] = u[k]; });
    if (['summary', 'ports', 'traffic'].includes(u.dtab)) S.topoUi.dtab = u.dtab;
    ['fStatus', 'fType'].forEach(k => { if (Array.isArray(u[k])) S.topoUi[k] = u[k]; });
    if (u.labels) Object.assign(S.topoUi.labels, u.labels);
    if (u.collapsed) S.topoUi.collapsed = u.collapsed;
  } catch { /* usa padrões */ }
}
function saveTopoUi() { try { localStorage.setItem(TOPO_UI_KEY, JSON.stringify(S.topoUi)); } catch { /* sem armazenamento */ } }

/* ───────── utilitários ───────── */
const fmtRate = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' Gbps' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' Mbps' : b >= 1e3 ? Math.round(b / 1e3) + ' kbps' : Math.round(b) + ' bps';
const fmtSpeed = m => m >= 1000 ? (m / 1000) + ' Gbps' : m + ' Mbps';
const topoVisible = () => { const t = document.getElementById('tabTopology'); return !!t && !t.classList.contains('d-none'); };
const activeView = () => (S.topoUi.mode === 'infra' ? infraView : S.topoUi.mode === 'rack' ? rackView : topoView);
window.topoResize = () => { const v = activeView(); if (v) v.resize(); };

function physPortsOf(t) {
  const ph = (t.ports || []).filter(p => p.kind !== 'virtual');
  return ph.length ? ph : (t.ports || []);
}
function trafficRates(t) {
  const ph = physPortsOf(t);
  return { rx: ph.reduce((s, p) => s + p.rxBps, 0), tx: ph.reduce((s, p) => s + p.txBps, 0) };
}
const topoName = d => invOf(d.ip).name || d.name || d.hostname || d.ip;   // nome definido à mão tem prioridade
const SPEED_CLS = [[10, 's10'], [100, 'fe'], [1000, 'ge'], [2500, 'g25'], [5000, 'g5'], [10000, 'g10'], [25000, 'g25g'], [40000, 'g40'], [1e9, 'g100']];
function portSpeedCls(p) {
  if (p.disabled) return 'dis';
  if (!p.running) return 'off';
  if (!p.speed) return 'up';
  for (const [mx, cls] of SPEED_CLS) if (p.speed <= mx) return cls;
  return 'g100';
}
const portNumOf = name => { const m = String(name).match(/(\d+)\s*$/); return m ? +m[1] : 0; };
const portBadgeText = name => (/sfp|qsfp/i.test(name) ? 'S' : '') + (String(name).match(/(\d+)\s*$/) || ['', '?'])[1];
function byPortName(a, b) {
  const ka = /sfp|qsfp/i.test(a.name) ? 1 : 0, kb = /sfp|qsfp/i.test(b.name) ? 1 : 0;
  return ka - kb || portNumOf(a.name) - portNumOf(b.name) || a.name.localeCompare(b.name);
}
function memUsedPct(m) {
  const num = s => { const x = String(s || '').match(/([\d.]+)\s*([KMGT]?)i?B/i); return x ? parseFloat(x[1]) * ({ K: 1, M: 1024, G: 1048576, T: 1073741824, '': 1 / 1024 }[x[2].toUpperCase()]) : null; };
  const f = num(m.memFree), t = num(m.memTotal);
  return f != null && t ? Math.max(0, Math.min(100, Math.round((1 - f / t) * 100))) : null;
}

// estado exibido: se o SSH/RouterOS responde, o equipamento está de fato online
// o ping contínuo do servidor manda: switch cadastrado usa o IP informado; concentrador usa o próprio IP
const pingKey = id => (isSwitch(id) ? (invOf(id).ip || '') : id);
const pingOf = id => { const k = pingKey(id); return k ? S.ping[k] : null; };
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60); if (m < 60) return m + ' min';
  const h = Math.floor(m / 60); if (h < 48) return h + ' h ' + (m % 60) + ' min';
  return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
}
function topoStatus(d) {
  const t = S.traffic[d.ip];
  if (t && t.ok) return 'online';
  const p = pingOf(d.ip);
  if (p) return p.online ? 'online' : 'offline';
  if (isSwitch(d.ip)) return 'unknown';
  return ['online', 'offline', 'scanning'].includes(d.status) ? d.status : 'unknown';
}
function topoSub(d) {
  const st = topoStatus(d), L = S.topoUi.labels, p = pingOf(d.ip), pre = d.type === 'switch' ? 'Switch · ' : '';
  if (d.type === 'switch' && !pingKey(d.ip)) return 'Switch';
  const since = p ? ' · há ' + fmtDur(Date.now() - p.since) : '';
  if (st === 'online') { const rt = p && p.rt != null ? p.rt : d.rt; return pre + (L.rt && rt != null ? `Online · ${rt} ms` : 'Online') + since; }
  if (st === 'offline') return pre + 'Offline' + since;
  if (st === 'scanning') return 'Verificando…';
  return pre ? 'Switch' : '—';
}
function topoSub2(ip) {
  const t = S.traffic[ip];
  if (!S.topoUi.labels.traffic || !t || !t.ok) return '';
  const r = trafficRates(t);
  return `<span class="d">↓ ${fmtRate(r.rx)}</span> <span class="u">↑ ${fmtRate(r.tx)}</span>`;
}
function topoKind(d, isRoot) {
  switch (d.type) {
    case 'switch':      return 'switch';
    case 'nucleo':      return isRoot ? 'router' : 'switch';
    case 'accesspoint': return 'ap';
    case 'server':      return 'server';
    case 'printer':     return 'printer';
    case 'computer':    return 'computer';
    default:            return 'device';
  }
}

// Portas de uma ligação: a definida à mão (cabo) tem prioridade; senão a descoberta pelos
// vizinhos LLDP/MNDP do RouterOS. Devolve também o rótulo ("3", "S1") de cada lado.
function topoLinkInfo(l) {
  const pt = S.traffic[l.from], ct = S.traffic[l.to];
  const norm = s => String(s || '').trim().toLowerCase();
  const namesOf = (ip, t) => { const d = S.devices[ip] || {}; return [invOf(ip).name, d.name, d.hostname, t && t.name].map(norm).filter(Boolean); };
  const match = (p, ip, names) => !!p.neighbor && (p.neighbor.address === ip || (!!p.neighbor.identity && names.includes(norm(p.neighbor.identity))));
  const byLabel = (ip, label) => { const x = label && livePortsLabeled(ip).find(x => x.label === label); return x ? x.p : null; };
  const labelOf = (ip, port) => { const x = port && livePortsLabeled(ip).find(x => x.p === port); return x ? x.label : ''; };
  let pPort = byLabel(l.from, l.fp), cPort = byLabel(l.to, l.tp);
  if (!l.fp && pt && pt.ok) pPort = pt.ports.find(p => p.kind !== 'virtual' && match(p, l.to, namesOf(l.to, ct))) || null;
  if (!l.tp && ct && ct.ok) cPort = ct.ports.find(p => p.kind !== 'virtual' && match(p, l.from, namesOf(l.from, pt))) || null;
  return { pPort, cPort, pLabel: l.fp || labelOf(l.from, pPort), cLabel: l.tp || labelOf(l.to, cPort),
           speed: (pPort && pPort.speed) || (cPort && cPort.speed) || 0 };
}
function topoLinkLabel(li, l) {
  const { pPort, cPort, pLabel, cLabel } = li;
  if (!S.topoUi.labels.links) return '';
  const md = linkMedium(l), chip = md === 'fibra' || l.m || pLabel || cLabel ? `<span class="mt ${md}">${MEDIUM_SHORT[md]}</span> ` : '';
  const nm = (label, port) => port ? port.name : (label || '?');
  let live = '';
  if (pPort) live = `<span class="d">↓ ${fmtRate(pPort.txBps)}</span> <span class="u">↑ ${fmtRate(pPort.rxBps)}</span>`;
  else if (cPort) live = `<span class="d">↓ ${fmtRate(cPort.rxBps)}</span> <span class="u">↑ ${fmtRate(cPort.txBps)}</span>`;
  if (!pLabel && !cLabel) return chip + live;
  if (live) live = '<br>' + live;
  return `${chip}<b>${esc(nm(pLabel, pPort))} ⇌ ${esc(nm(cLabel, cPort))}</b>${li.speed ? ' · ' + fmtSpeed(li.speed) : ''}${live}`;
}
// tráfego do link por direção: dl = do pai para o filho (download do filho), ul = do filho para o pai
function topoLinkRates(li) {
  const p = li.pPort, c = li.cPort;
  const dl = p ? p.txBps : c ? c.rxBps : null, ul = p ? p.rxBps : c ? c.txBps : null;
  return { dl, ul, cap: (li.speed || 1000) * 1e6 };
}
const topoLinkFlow = (li, childOffline) => { const p = li.pPort || li.cPort; return !childOffline && !!p && (p.rxBps + p.txBps) > 10e3; };
function topoBadge(label, port) {
  if (!label && !port) return null;
  const text = label || '?';
  return { name: port ? port.name : text, text, cls: port ? portSpeedCls(port) : 'cab',
           title: port ? `${port.name}${port.speed ? ' · ' + fmtSpeed(port.speed) : ''} — ↓ ${fmtRate(port.rxBps)}  ↑ ${fmtRate(port.txBps)}` : `Porta ${text} (cabo definido)` };
}

// Monta {nodes, links} para as visões a partir da varredura (S.devices), das ligações
// configuradas (config.json -> links) e do tráfego SSH (S.traffic).
function buildTopoModel() {
  const nodes = [], links = [];
  const pairs = topoLinks(), L = S.topoUi.labels, cpuMem = S.topoUi.cpuMem;

  const mk = (d, root) => {
    const t = S.traffic[d.ip], m = (t && t.meta) || {};
    const ti = TYPE_INFO[d.type] || TYPE_INFO.unknown, nm = topoName(d);
    return { id: d.ip, label: nm, ip: L.ip ? (isSwitch(d.ip) ? (invOf(d.ip).ip || '') : (nm !== d.ip ? d.ip : '')) : '', sub: topoSub(d), sub2: topoSub2(d.ip), status: topoStatus(d),
             kind: topoKind(d, root), type: d.type || 'unknown', sw: isSwitch(d.ip),
             cpu: cpuMem && m.cpuLoad != null ? m.cpuLoad : null, mem: cpuMem ? memUsedPct(m) : null,
             model: m.board ? m.board + (m.version ? ' · RouterOS ' + m.version : '') : ti.label,
             portsTotal: devPorts(d.ip).items.length, portsUsed: cablesOf(d.ip).size, pm: portMatrix(d.ip),
             role: invOf(d.ip).role || '', rtype: isSwitch(d.ip) ? '' : (invOf(d.ip).rtype || ''), rackName: isSwitch(d.ip) ? '' : (invOf(d.ip).rackName || ''), hnum: isSwitch(d.ip) ? '' : (invOf(d.ip).hnum || ''), andar: isSwitch(d.ip) ? '' : (invOf(d.ip).andar || ''), setor: isSwitch(d.ip) ? '' : (invOf(d.ip).setor || ''), etype: isSwitch(d.ip) ? (invOf(d.ip).etype || 'switch') : 'conc', tlabel: isSwitch(d.ip) ? RK_TYPES[invOf(d.ip).etype || 'switch'].label : '',
             u: isSwitch(d.ip) ? (invOf(d.ip).u || 1) : 1, pos: isSwitch(d.ip) ? (invOf(d.ip).pos || 0) : 0, rack: isSwitch(d.ip) ? (invOf(d.ip).rack || '') : '', rk: rackPorts(d.ip) };
  };

  if (pairs.length) {
    const ips = [...new Set([...pairs.flatMap(l => [l.from, l.to]), ...rackIps()])];
    const hasParent = new Set(pairs.map(l => l.to));
    ips.forEach(ip => nodes.push(mk(S.devices[ip] || { ip, name: '', hostname: '', type: isSwitch(ip) ? 'switch' : 'nucleo', status: 'unknown' }, !hasParent.has(ip))));
    pairs.forEach(l => {
      const li = topoLinkInfo(l);
      const child = S.devices[l.to] || { ip: l.to, status: 'unknown' };
      const off = topoStatus(child) === 'offline';
      links.push({ from: l.from, to: l.to, label: topoLinkLabel(li, l), medium: linkMedium(l), state: off ? 'down' : 'up', flow: topoLinkFlow(li, off), ...topoLinkRates(li),
                   pBadge: topoBadge(li.pLabel, li.pPort), cBadge: topoBadge(li.cLabel, li.cPort) });
    });
    // equipamentos de rack sem ligação (patch panel, nobreak...): só aparecem na visão Racks
    const inNodes = new Set(nodes.map(n => n.id));
    const extras = Object.keys(S.topoCfg.inventory || {}).filter(id => isSwitch(id) && !inNodes.has(id))
      .map(id => mk({ ip: id, name: '', hostname: '', type: 'switch', status: 'unknown' }, false));
    return { nodes, links, extras };
  }

  // sem ligações configuradas: Internet -> núcleo -> demais, por tipo
  // só os equipamentos marcados para aparecer na Topologia na aba "Equipamento" (escolha do usuário)
  const inc = topoIncludeSet();
  const devs = Object.values(S.devices).filter(d => inc.has(d.ip));
  inc.forEach(ip => { if (!devs.some(d => d.ip === ip)) devs.push({ ip, name: '', hostname: '', type: 'nucleo', status: 'unknown', known: true }); });
  const nucleos   = devs.filter(d => d.type === 'nucleo').sort((a, b) => ipCmp(a.ip, b.ip));
  const mid       = devs.filter(d => ['server', 'accesspoint', 'printer'].includes(d.type)).sort((a, b) => ipCmp(a.ip, b.ip));
  const computers = devs.filter(d => d.type === 'computer').sort((a, b) => ipCmp(a.ip, b.ip));
  const unknown   = devs.filter(d => !d.type || d.type === 'unknown').sort((a, b) => ipCmp(a.ip, b.ip));
  const concIps = rackIps();
  nodes.push({ id: 'internet', label: 'Internet', ip: '', sub: '', sub2: '', status: 'online', kind: 'internet', type: 'internet' });
  const link = (from, to, child) => links.push({ from, to, label: '', state: child && topoStatus(child) === 'offline' ? 'down' : 'up' });
  nucleos.forEach((d, i) => { nodes.push(mk(d, i === 0)); link('internet', d.ip, d); });
  const hub = nucleos.length ? nucleos[0].ip : 'internet';
  [...mid, ...unknown].forEach(d => { nodes.push(mk(d)); link(hub, d.ip, d); });
  if (computers.length > COMP_THRESH) {
    const onl = computers.filter(d => d.status === 'online').length;
    nodes.push({ id: 'comp-group', label: 'Computadores', ip: '', sub: `${onl}/${computers.length} online`, sub2: '', status: onl ? 'online' : 'offline', kind: 'group', type: 'group', collapsed: true });
    link(hub, 'comp-group');
    computers.forEach(d => { nodes.push(mk(d)); link('comp-group', d.ip, d); });
  } else {
    computers.forEach(d => { nodes.push(mk(d)); link(hub, d.ip, d); });
  }
  concIps.filter(ip => !nodes.some(n => n.id === ip)).forEach(ip => nodes.push(mk({ ip, name: '', hostname: '', type: 'nucleo', status: 'unknown' }, true)));
  return { nodes, links, fallback: true };
}

/* ───────── busca / filtros / destaque ───────── */
function topoMatch(model) {
  const u = S.topoUi, q = u.search.trim().toLowerCase();
  if (!q && !u.fStatus.length && !u.fType.length) return { set: null, hits: null };
  const set = new Set(), hits = new Set();
  model.nodes.forEach(n => {
    if (n.kind === 'internet' || n.kind === 'group') { set.add(n.id); return; }
    let ok = true;
    if (q) { ok = `${n.label} ${n.ip} ${n.id} ${n.model || ''}`.toLowerCase().includes(q); if (ok) hits.add(n.id); }
    if (ok && u.fStatus.length) ok = u.fStatus.includes(n.status);
    if (ok && u.fType.length) ok = u.fType.includes(n.type);
    if (ok) set.add(n.id);
  });
  return { set, hits: q ? hits : null };
}

let _sbSig = '';
function renderTopoSidebar(model) {
  const u = S.topoUi, real = model.nodes.filter(n => n.kind !== 'internet' && n.kind !== 'group');
  const cnt = k => real.filter(n => n.status === k).length;
  const types = ['nucleo', 'switch', 'accesspoint', 'server', 'printer', 'computer', 'unknown'].map(t => [t, real.filter(n => n.type === t).length]).filter(x => x[1]);
  const sig = JSON.stringify([cnt('online'), cnt('offline'), types, u.fStatus, u.fType, u.labels, S.topoUi.mode, model.nodes.map(n => n.id + n.status + n.kind + n.label + (S.traffic[n.id] && S.traffic[n.id].ok ? 1 : 0)).join(), S._cfgRev]);
  if (sig === _sbSig) return;
  _sbSig = sig;
  const chk = (attr, val, label, n, on) => `<label class="ck"><input type="checkbox" ${attr}="${val}"${on ? ' checked' : ''}><i></i><span>${label}${n != null ? ` <em>(${n})</em>` : ''}</span></label>`;
  document.getElementById('fltStatus').innerHTML =
    chk('data-fs', 'online', 'Online', cnt('online'), u.fStatus.includes('online')) + chk('data-fs', 'offline', 'Offline', cnt('offline'), u.fStatus.includes('offline'));
  document.getElementById('fltType').innerHTML = types.map(([t, n]) =>
    chk('data-ft', t, esc((TYPE_INFO[t] || TYPE_INFO.unknown).label), n, u.fType.includes(t))).join('') || '<span class="nm-muted">—</span>';
  document.getElementById('fltLabels').innerHTML =
    chk('data-lb', 'ip', 'Endereço IP', null, u.labels.ip) + chk('data-lb', 'traffic', 'Tráfego', null, u.labels.traffic) +
    chk('data-lb', 'rt', 'Tempo de resposta', null, u.labels.rt) + chk('data-lb', 'links', 'Porta e velocidade nos links', null, u.labels.links);

  // lista de equipamentos (visão de infraestrutura): ícone, nome e matriz de portas
  document.getElementById('infraList').innerHTML = real.map(n => `
    <button type="button" class="il-row st-${n.status}${S.topoSel === n.id ? ' sel' : ''}" data-id="${esc(n.id)}">
      <span class="il-ico">${NetIcons.svg(n.kind, { size: 26 })}</span>
      <span class="il-txt"><b>${esc(n.label)}</b><small>${esc(n.model || '')}</small></span>
      ${portMatrix(n.id)}
    </button>`).join('') || '<span class="nm-muted" style="padding:8px 12px;display:block">Nenhum equipamento</span>';
}
/* ───────── linha do tempo (últimas 24 h) ───────── */
async function loadTopoEvents() {
  try {
    const r = await fetch('/api/history', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const hist = await r.json(), since = Date.now() - 24 * 3600e3, out = [];
    Object.values(hist).forEach(day => (day.events || []).forEach(e => { if (e.ts >= since) out.push(e); }));
    S.topoEvents = out.sort((a, b) => b.ts - a.ts);
  } catch { /* sem histórico */ }
  renderTimeline();
}
function renderTimeline() {
  const el = document.getElementById('tlPanel');
  if (!el || el.classList.contains('d-none')) return;
  const ids = new Set(((S._topoModel && S._topoModel.nodes) || []).map(n => n.id));
  const evs = S.topoEvents.filter(e => ids.has(e.ip)).slice(0, 60);
  el.innerHTML = `<div class="tl-head">Últimas 24 h <b>(${evs.length} ${evs.length === 1 ? 'evento' : 'eventos'})</b></div>
    <div class="tl-live"><span>AO VIVO</span></div>
    <ol class="tl-list">${evs.map(e => {
      const d = S.devices[e.ip] || {}, off = e.event === 'offline';
      return `<li class="${off ? 'off' : 'on'}" data-id="${esc(e.ip)}" tabindex="0"><time>${esc(fmtClock(e.ts).slice(0, 5))}</time>
        <i class="fas ${off ? 'fa-triangle-exclamation' : 'fa-circle-check'}"></i>
        <div><b>${esc(topoName({ ip: e.ip, name: d.name, hostname: d.hostname }))}</b> ${off ? 'ficou offline' : 'voltou a responder'}<small>${esc(e.ip)}</small></div></li>`;
    }).join('') || '<li class="empty">Nenhum evento nas últimas 24 h.</li>'}</ol>`;
}

/* ───────── render principal ───────── */
let _topoT = 0, _topoTimer = null;
function renderTopology() {
  topoDefaults();
  const container = document.getElementById('topoContainer');
  const view = activeView();
  if (!container || !view) return;
  const now = Date.now();                       // evita refazer o mapa a cada resultado da varredura
  if (now - _topoT < 250) {
    if (!_topoTimer) _topoTimer = setTimeout(() => { _topoTimer = null; renderTopology(); }, 260);
    return;
  }
  _topoT = now;
  const model = buildTopoModel();
  S._topoModel = model;
  const waiting = !topoLinks().length && S.scanCount === 0 && view !== rackView;
  const m = topoMatch(model);
  view.setData(waiting ? { nodes: [], links: [] } : model);
  if (view === topoView && m.hits && m.hits.size) topoView.reveal([...m.hits]);
  view.setMatch(m.set, m.hits);
  view.setSpotlight(S.topoUi.spot);

  const host = view.root;
  let ov = host.querySelector('.td-empty');
  if (waiting && !ov) {
    ov = document.createElement('div');
    ov.className = 'td-empty';
    ov.style.cssText = 'position:absolute;inset:0;display:grid;place-content:center';
    ov.innerHTML = '<i class="fas fa-network-wired"></i><strong>Aguardando o primeiro scan…</strong><br><small>Inicie a varredura na aba Monitor</small>';
    host.appendChild(ov);
  } else if (!waiting && ov) ov.remove();

  renderTopoSidebar(model);
  if (S.topoUi.mode === 'infra') renderTimeline();
  if (S.topoSel) renderTopoDetails();
}

// ping contínuo (feito pelo servidor, com histórico em arquivo): online/offline em tempo real
let _pingBusy = false;
async function pollPing() {
  if (_pingBusy) return;
  _pingBusy = true;
  try {
    const r = await fetch('/api/ping', { signal: AbortSignal.timeout(3000) });
    if (r.ok) { const j = await r.json(); S.ping = j.states || {}; }
  } catch { /* servidor fora: mantém o último estado */ }
  finally { _pingBusy = false; }
  if (topoVisible()) renderTopology();
}

// tráfego/portas dos equipamentos com acesso SSH (alimenta rótulos, selos de porta e detalhes)
let _trafBusy = false;
async function pollTraffic() {
  if (_trafBusy) return;
  _trafBusy = true;
  try {
    const r = await fetch('/api/traffic', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json(), m = {};
      (j.devices || []).forEach(d => { m[d.host] = d; });
      S.traffic = m;
      pushTrafHist(j.devices);
    }
  } catch { /* sem SSH/servidor: o mapa segue só com a varredura */ }
  finally { _trafBusy = false; }
  if (topoVisible()) renderTopology();
}

// Topologia -> aba Tráfego, já no equipamento escolhido
function openTrafficFor(ip, opts) {
  const pane = document.getElementById('tabTraffic');
  if (pane && pane.classList.contains('d-none')) window.switchTab('traffic');
  const f = document.getElementById('trafficFrame');
  const go = () => { try { f.contentWindow.selectDevice(ip, 'ports'); if (opts && opts.cfg) f.contentWindow.document.getElementById('cfgbtn').click(); } catch (_) {} };
  if (f.contentWindow && f.contentWindow.selectDevice) go();
  else f.addEventListener('load', go, { once: true });
}

/* ───────── inicialização ───────── */
function setTopoMode(mode) {
  S.topoUi.mode = mode === 'infra' || mode === 'rack' ? mode : 'tree'; saveTopoUi();
  const infra = S.topoUi.mode === 'infra', rack = S.topoUi.mode === 'rack', tree = !infra && !rack;
  document.getElementById('topoContainer').classList.toggle('d-none', !tree);
  document.getElementById('infraContainer').classList.toggle('d-none', !infra);
  document.getElementById('rackContainer').classList.toggle('d-none', !rack);
  document.getElementById('sbTree').classList.toggle('d-none', !tree);
  document.getElementById('sbInfra').classList.toggle('d-none', tree);
  document.querySelectorAll('.only-tree').forEach(e => e.classList.toggle('d-none', !tree));
  document.querySelectorAll('.only-infra').forEach(e => e.classList.toggle('d-none', !infra));
  document.querySelectorAll('.only-rack').forEach(e => e.classList.toggle('d-none', !rack));
  syncTimeline();
  document.querySelectorAll('#topoMode button').forEach(b => b.classList.toggle('active', b.dataset.m === S.topoUi.mode));
  const lg = document.getElementById('topoLegend');
  if (lg) lg.classList.toggle('infra', infra);
  _sbSig = '';
  const v = activeView();
  if (v) v.select(S.topoSel, true);
  _topoT = 0; renderTopology();
  setTimeout(() => { const a = activeView(); if (a) a.resize(); }, 70);
  if (infra) loadTopoEvents();
}

function syncTimeline() {
  const infra = S.topoUi.mode === 'infra', open = !!S.topoUi.tlOpen;
  document.getElementById('tlPanel').classList.toggle('d-none', !(infra && open));
  document.getElementById('btnTimeline').classList.toggle('on', infra && open);
}

// sem preferência salva: barra lateral e linha do tempo abertas só se couberem (decidido com a aba visível)
function topoDefaults() {
  const lw = (document.getElementById('topoLayout') || {}).clientWidth;
  if (!lw) return;
  let changed = false;
  if (S.topoUi.sbOpen === null) { S.topoUi.sbOpen = true; changed = true; }
  if (S.topoUi.tlOpen === null) { S.topoUi.tlOpen = lw >= 1500; changed = true; }
  if (changed) { syncSidebarOpen(); syncTimeline(); }
}

// largura estreita (lado a lado / janela pequena): a barra lateral vira uma gaveta sobre o mapa,
// com preferência própria (fechada por padrão) para não cobrir o mapa
const topoNarrow = () => { const l = document.getElementById('topoLayout'); return !!l && l.clientWidth > 0 && l.clientWidth < 1060; };
const sidebarIsOpen = () => !!(topoNarrow() ? S.topoUi.sbOpenN : S.topoUi.sbOpen);   // null (ainda não decidido) = fechada
function setSidebarOpen(on) { if (topoNarrow()) S.topoUi.sbOpenN = on; else S.topoUi.sbOpen = on; saveTopoUi(); syncSidebarOpen(); }
function syncSidebarOpen() {
  const lay = document.getElementById('topoLayout'), open = sidebarIsOpen();
  if (lay) lay.classList.toggle('sb-closed', !open);
  const b = document.getElementById('btnSideOpen');
  if (b) b.classList.toggle('on', open);
  setTimeout(() => { const a = activeView(); if (a) a.resize(); }, 90);
}

function initTopology() {
  const cTree = document.getElementById('topoContainer'), cInfra = document.getElementById('infraContainer');
  if (!cTree || !cInfra || !window.TopoView || !window.RackView) return;
  loadTopoUi();

  const common = {
    onSelect: id => { S.topoSel = id; _sbSig = ''; renderTopoDetails(); renderTopoSidebarSel(); },
    onOpen:   id => {
      if (S.devices[id]) openModal(id);
      else if (isSwitch(id) || rackIps().includes(id)) { S.topoSel = id; S.topoCfgOpen = true; if (S.topoUi.dtab !== 'ports') setDtab('ports'); else renderTopoDetails(true); }   // sem cadastro no Monitor: edita na gaveta
    },
    onAdd:    id => openRackAdd(id),
    onMove:   (id, rack, idx) => moveRackItem(id, rack, idx),
    onLink:   (a, ap, b, bp) => linkJacks(a, ap, b, bp),
    onTab:    t => { S.topoUi.rackTab = t; saveTopoUi(); },
    onAddRack: () => openRackNew(),
    onRackLink: (a, b) => openRackLink(a, b),
    onRackDel: id => removeRack(id),
    onRtype: (id, r) => setRtype(id, r),
    onLoc: (id, f, v) => setLoc(id, f, v),
    onUnlink: id => unlinkChild(id),
    onItemDel: id => removeSwitch(id),
    onZoom:   k  => { const el = document.getElementById('topoZoomLevel'); if (el) el.textContent = Math.round(k * 100) + '%'; },
  };
  topoView = new TopoView(cTree, { ...common, orient: S.topoUi.orient });
  infraView = new InfraView(cInfra, common);
  rackView = new RackView(document.getElementById('rackContainer'), common);
  rackView.setSide(S.topoUi.rackSide);
  rackView.tab = S.topoUi.rackTab || 'macro';
  const syncSide = () => document.querySelectorAll('#rackSide button').forEach(b => b.classList.toggle('active', b.dataset.s === (S.topoUi.rackSide === 'rear' ? 'rear' : 'front')));
  syncSide();
  document.getElementById('rackSide').addEventListener('click', e => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    S.topoUi.rackSide = b.dataset.s; saveTopoUi(); syncSide(); rackView.setSide(b.dataset.s);
  });
  initTopoPorts();
  loadTopoCfg().then(() => { _sbSig = ''; _topoT = 0; renderTopology(); });

  const $ = id => document.getElementById(id);
  $('swSpot').checked = !!S.topoUi.spot;
  $('swCpuMem').checked = !!S.topoUi.cpuMem;
  $('topoSearch').value = S.topoUi.search;
  const syncOrient = () => document.querySelectorAll('#topoOrient button').forEach(b => b.classList.toggle('active', b.dataset.o === topoView.orient));
  syncOrient();

  const redo = () => { _topoT = 0; renderTopology(); };
  $('btnTopoZoomOut').addEventListener('click', () => activeView().zoomBy(1 / 1.2));
  $('btnTopoZoomIn').addEventListener('click',  () => activeView().zoomBy(1.2));
  $('btnTopoZoomReset').addEventListener('click', () => activeView().fit());
  $('btnTopoExpand').addEventListener('click', () => topoView.expandAll());
  $('topoOrient').addEventListener('click', e => {
    const b = e.target.closest('button[data-o]'); if (!b) return;
    topoView.setOrient(b.dataset.o); syncOrient();
    S.topoUi.orient = topoView.orient; saveTopoUi();
  });
  $('topoMode').addEventListener('click', e => { const b = e.target.closest('button[data-m]'); if (b) setTopoMode(b.dataset.m); });
  $('btnSideOpen').addEventListener('click', () => setSidebarOpen(!sidebarIsOpen()));
  $('btnSideClose').addEventListener('click', () => setSidebarOpen(false));
  // gaveta (modo estreito): tocar no mapa fecha a barra lateral
  document.querySelector('.topo-canvas').addEventListener('pointerdown', () => { if (topoNarrow() && sidebarIsOpen()) { S.topoUi.sbOpenN = false; syncSidebarOpen(); } });
  $('btnTimeline').addEventListener('click', () => {
    S.topoUi.tlOpen = !S.topoUi.tlOpen; saveTopoUi(); syncTimeline();
    if (S.topoUi.tlOpen) loadTopoEvents();
    setTimeout(() => { const a = activeView(); if (a) a.resize(); }, 70);
  });
  $('swSpot').addEventListener('change', e => { S.topoUi.spot = e.target.checked; saveTopoUi(); redo(); });
  $('swCpuMem').addEventListener('change', e => { S.topoUi.cpuMem = e.target.checked; saveTopoUi(); redo(); });
  let st = null;
  $('topoSearch').addEventListener('input', e => { S.topoUi.search = e.target.value; clearTimeout(st); st = setTimeout(() => { saveTopoUi(); redo(); }, 120); });
  $('btnRackAdd').addEventListener('click', () => openRackAdd(null));
  $('btnAddDev').addEventListener('click', () => openTrafficFor('', { cfg: true }));
  $('btnDetailsClose').addEventListener('click', () => activeView().select(null));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.topoSel && topoVisible() && e.target.tagName !== 'INPUT') activeView().select(null); });

  // filtros e rótulos (delegação: o HTML é refeito quando as contagens mudam)
  $('topoSide').addEventListener('change', e => {
    const t = e.target, tog = (arr, v, on) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i, 1); };
    if (t.dataset.fs) tog(S.topoUi.fStatus, t.dataset.fs, t.checked);
    else if (t.dataset.ft) tog(S.topoUi.fType, t.dataset.ft, t.checked);
    else if (t.dataset.lb) S.topoUi.labels[t.dataset.lb] = t.checked;
    else return;
    saveTopoUi(); _sbSig = ''; redo();
  });
  $('topoSide').addEventListener('click', e => {
    const g = e.target.closest('.tsb-grp > h6');
    if (g) { g.parentNode.classList.toggle('shut'); return; }
    const r = e.target.closest('.il-row');
    if (r) { const id = r.dataset.id, v = activeView(); v.select(id); v.centerOn(id); }
  });
  $('tlPanel').addEventListener('click', e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const v = activeView(); v.select(li.dataset.id); v.centerOn(li.dataset.id);
  });

  // refaz o ajuste quando o painel muda de tamanho (aba oculta -> visível, lado a lado, janela)
  if (window.ResizeObserver) {
    [['topoContainer', () => topoView], ['infraContainer', () => infraView], ['rackContainer', () => rackView]].forEach(([id, get]) => {
      const el = document.getElementById(id); let rt = null, last = '';
      new ResizeObserver(() => {
        const key = el.clientWidth + 'x' + el.clientHeight;
        if (!el.clientWidth || key === last) return;
        last = key; clearTimeout(rt); rt = setTimeout(() => get().resize(), 120);
      }).observe(el);
    });
  }
  // a largura do painel mudou (ex.: ativou "lado a lado"): reavalia gaveta x coluna
  if (window.ResizeObserver) {
    let lw = 0;
    new ResizeObserver(() => { const w = document.getElementById('topoLayout').clientWidth; if (w && (w < 1060) !== (lw && lw < 1060)) { lw = w; topoDefaults(); syncSidebarOpen(); } lw = w || lw; }).observe(document.getElementById('topoLayout'));
  }
  // também mantém o /api/traffic vivo quando só a aba "Equipamento" está aberta: ela usa S.traffic
  // para saber, por padrão, quais equipamentos já têm acesso SSH (antes de o usuário escolher à mão)
  setInterval(() => { if (topoVisible() || eqVisible()) pollTraffic(); }, 2000);
  pollPing(); setInterval(() => { if (topoVisible()) pollPing(); }, 2000);
  setInterval(() => { if (topoVisible() && S.topoUi.mode === 'infra' && S.topoUi.tlOpen) loadTopoEvents(); }, 30000);
  syncSidebarOpen();
  setTopoMode(S.topoUi.mode);
}

// realça a linha selecionada na lista de equipamentos sem refazer tudo
function renderTopoSidebarSel() {
  document.querySelectorAll('#infraList .il-row').forEach(r => r.classList.toggle('sel', r.dataset.id === S.topoSel));
}
