// Coleta tráfego por porta de equipamentos MikroTik via SSH (RouterOS) e serve o dashboard.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const monitor = require('./monitor');
const ros = require('./routeros');
const { sanitizeTopology } = require('./topology-cfg');
const pinger = require('./pinger');
const TOPO_REV_BASE = Date.now().toString(36);
let topoRev = 0;

const CFG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');   // CONFIG_FILE: usado em testes
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
monitor.setConfig(cfg);
const state = {};
function sync() {
  // reconstrói o objeto na ordem de cfg.devices, preservando dados já coletados
  const next = {};
  cfg.devices.forEach(d => {
    next[d.host] = state[d.host] || { ok: false, error: 'aguardando', ts: 0, ports: [] };
    next[d.host].name = d.name; next[d.host].host = d.host;
  });
  Object.keys(state).forEach(h => delete state[h]);
  Object.assign(state, next);
}
sync();
const save = () => { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); sync(); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b)); } catch { r(null); } }); });

// Histórico de tráfego persistido em disco (pasta do próprio app), para o
// gráfico não voltar a zero a cada reload da página ou reinício do servidor.
const HIST_FILE = path.join(__dirname, 'history.json');
const HIST_LEN = 600; // ~10min a 1 amostra/s
let histStore = {}; // host -> { agg:[{t,rx,tx}], ports:{ name:[{t,rx,tx}] } }
try { histStore = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { histStore = {}; }

function pushHist(arr, sample) { arr.push(sample); if (arr.length > HIST_LEN) arr.shift(); }
function recordHistory(host, ports) {
  const hs = histStore[host] || (histStore[host] = { agg: [], ports: {} });
  const t = Date.now();
  // total = só portas físicas (bridge/vlan repetem o mesmo tráfego e dobrariam a soma)
  const phys = ports.filter(p => p.kind !== 'virtual');
  const sumOf = phys.length ? phys : ports;
  const rx = sumOf.reduce((s, p) => s + p.rxBps, 0), tx = sumOf.reduce((s, p) => s + p.txBps, 0);
  pushHist(hs.agg, { t, rx, tx });
  ports.forEach(p => pushHist(hs.ports[p.name] || (hs.ports[p.name] = []), { t, rx: p.rxBps, tx: p.txBps }));
}
let histDirty = false;
setInterval(() => { if (histDirty) { histDirty = false; fs.writeFile(HIST_FILE, JSON.stringify(histStore), () => {}); } }, 15000);

// Comando único de script RouterOS: para cada interface, imprime um bloco
// "monitor-traffic once" (formato "chave: valor"), tudo numa só chamada SSH.
const POLL_CMD = ':foreach i in=[/interface find] do={/interface monitor-traffic $i once without-paging}';
// Contadores acumulados (bytes totais) e estado de link (flag RUNNING), em tabela.
const STATS_CMD = '/interface print stats terse without-paging';

// Dados que quase não mudam (tipo/flags das interfaces, velocidade negociada,
// vizinhos LLDP/MNDP e info do sistema) são coletados em segundo plano a cada
// SLOW_MS, em sequência (um canal SSH por vez), sem atrasar o ciclo de 1s.
const IFACE_CMD = '/interface print terse without-paging';
const ETH_CMD = ':foreach i in=[/interface ethernet find] do={/interface ethernet monitor $i once without-paging}';
const NEIGH_CMD = '/ip neighbor print terse without-paging';
const SYS_CMD = '/system resource print without-paging';
const SLOW_MS = 30000;
const slow = {}; // host -> { ts, busy, ifaces, eth, neigh, meta }

// Mantém uma conexão SSH aberta por equipamento em vez de reconectar a cada
// ciclo — reconectar levava ~1-1.5s por porta (handshake); reaproveitar a
// sessão deixa o ciclo em ~200ms, viabilizando atualização por segundo.
const conns = new Map(); // host -> { client, ready, closed }

function connect(dev) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const entry = { client, ready: false };
    client.on('ready', () => { entry.ready = true; conns.set(dev.host, entry); resolve(entry); })
      .on('error', err => { conns.delete(dev.host); reject(err); })
      .on('close', () => { conns.delete(dev.host); })
      .connect({ host: dev.host, port: dev.port || 22, username: dev.user, password: dev.password, readyTimeout: 8000, keepaliveInterval: 10000 });
  });
}

function exec(client, cmd) {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', d => out += d);
      stream.stderr.on('data', d => out += d);
      stream.on('close', () => resolve(out));
    });
  });
}

async function getConn(dev) {
  const existing = conns.get(dev.host);
  if (existing && existing.ready) return existing.client;
  const entry = await connect(dev);
  return entry.client;
}

// Blocos "chave: valor" separados por linha em branco (um por interface).
const UNIT = { bps: 1, kbps: 1e3, Mbps: 1e6, Gbps: 1e9 };
function toBps(v) {
  if (!v) return 0;
  const m = v.replace(/\.\.\.$/, '').match(/^([\d.]+)\s*(bps|kbps|Mbps|Gbps)$/);
  return m ? Math.round(parseFloat(m[1]) * UNIT[m[2]]) : 0;
}
function toNum(v) { return v ? parseInt(v.replace(/[\s,]/g, ''), 10) || 0 : 0; }

// Tabela de "/interface print stats terse": " # F NAME  RX-BYTE  TX-BYTE  RX-PACKET",
// com nomes contendo espaços e números com espaço como separador de milhar —
// por isso as colunas numéricas (2+ espaços entre si) são isoladas primeiro.
function parseStats(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\d+\s/.test(line)) continue; // pula cabeçalho/legenda
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 4) continue;
    const head = cols[0].match(/^(\d+)\s*([A-Z]*)\s+(.*)$/);
    if (!head) continue;
    out.set(head[3].trim(), {
      running: head[2].includes('R'),
      rxBytes: toNum(cols[1]),
      txBytes: toNum(cols[2]),
    });
  }
  return out;
}

function parse(text) {
  const rows = [];
  let cur = {};
  const flush = () => { if (cur.name) rows.push(cur); cur = {}; };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (m) {
      if (m[1] === 'name' && cur.name) flush();
      cur[m[1]] = m[2].trim();
    }
  }
  flush();
  return rows.map(r => ({
    name: r.name,
    rxBps: toBps(r['rx-bits-per-second']),
    txBps: toBps(r['tx-bits-per-second']),
    rxPps: toNum(r['rx-packets-per-second']),
    txPps: toNum(r['tx-packets-per-second']),
  }));
}

async function refreshSlow(dev, client) {
  const c = slow[dev.host] || (slow[dev.host] = { ts: 0, busy: false });
  if (c.busy || Date.now() - c.ts < SLOW_MS) return;
  c.busy = true;
  try {
    const run = async cmd => { try { return await exec(client, cmd); } catch { return ''; } };
    c.ifaces = ros.parseInterfaces(await run(IFACE_CMD));
    c.eth = ros.parseEthernetMonitor(await run(ETH_CMD));
    c.neigh = ros.parseNeighbors(await run(NEIGH_CMD));
    c.meta = ros.parseSystemResource(await run(SYS_CMD));
    c.ts = Date.now();
  } catch { /* mantém o que já havia */ } finally { c.busy = false; }
}

async function poll(dev) {
  const s = state[dev.host];
  try {
    const client = await getConn(dev);
    refreshSlow(dev, client); // segundo plano; usa o cache do ciclo anterior
    const [out, statsOut] = await Promise.all([exec(client, POLL_CMD), exec(client, STATS_CMD)]);
    const stats = parseStats(statsOut);
    const sl = slow[dev.host] || {};
    const ports = parse(out).map((p, i) => {
      const st = stats.get(p.name);
      const running = st ? st.running : (p.rxBps > 0 || p.txBps > 0);
      const info = sl.ifaces && sl.ifaces.size ? sl.ifaces.get(p.name) : null;
      const eth = sl.eth && sl.eth.get(p.name);
      const nb = sl.neigh && sl.neigh.get(p.name);
      return {
        ...p, port: i + 1, running, rxBytes: st ? st.rxBytes : 0, txBytes: st ? st.txBytes : 0,
        kind: ros.portKind(p.name, info),            // 'ether' | 'sfp' | 'virtual'
        disabled: !!(info && info.disabled),
        comment: info ? info.comment : '',
        speed: running && eth && eth.mbps ? eth.mbps : null, // Mbps negociados (null = desconhecido)
        neighbor: nb && nb[0] ? nb[0] : null,         // vizinho descoberto (LLDP/MNDP/CDP)
        neighbors: nb ? nb.length : 0,
      };
    });
    if (!ports.length) throw new Error('resposta sem dados: ' + out.slice(0, 120).replace(/\s+/g, ' '));
    Object.assign(s, { ok: true, error: null, ts: Date.now(), ports, meta: sl.meta || null });
    recordHistory(dev.host, ports);
    histDirty = true;
  } catch (e) {
    conns.delete(dev.host); // força reconexão no próximo ciclo
    Object.assign(s, { ok: false, error: e.message, ts: Date.now() });
  }
}

const poll_all = () => Promise.all(cfg.devices.map(poll));
async function loop() {
  await poll_all();
  setTimeout(loop, cfg.intervalMs);
}
loop();

// ping contínuo de todo equipamento da topologia (IPv4): racks, switches com IP, equipamentos do cadastro
const pingSvc = pinger.create({
  ping: monitor.pingHost,
  dir: process.env.PING_DIR || __dirname,
  targets: () => {
    const ips = new Set((cfg.devices || []).map(d => d.host));
    (cfg.links || []).forEach(l => { ips.add(l[0]); ips.add(l[1]); });
    Object.entries(cfg.inventory || {}).forEach(([k, v]) => { if (v.sw) { if (v.ip) ips.add(v.ip); } else if (v.conc || v.ports || v.sfp || v.rtype) ips.add(k); });
    return [...ips];
  },
});
pingSvc.start();

http.createServer(async (req, res) => {
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const pathname = req.url.split('?')[0];
  if (monitor.ROUTES.has(pathname)) return monitor.handle(req, res, pathname);
  const MIMES = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html' };
  if (req.method === 'GET' && /^\/(assets|pages)\//.test(pathname) && MIMES[path.extname(pathname)]) {
    const file = path.resolve(__dirname, pathname.slice(1));
    if (!file.startsWith(path.resolve(__dirname) + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    return fs.readFile(file, (e, d) => {
      res.writeHead(e ? 404 : 200, { 'Content-Type': MIMES[path.extname(pathname)] + '; charset=utf-8' });
      res.end(e ? 'Not found' : d);
    });
  }
  if (req.url === '/api/devices' && req.method === 'GET')
    return json(200, cfg.devices.map(d => ({ name: d.name, host: d.host, user: d.user, hasPassword: !!d.password && d.password !== 'PREENCHA' })));
  if (req.url === '/api/devices' && req.method === 'POST') {
    const list = await body(req);
    if (!Array.isArray(list)) return json(400, { error: 'JSON inválido' });
    const old = Object.fromEntries(cfg.devices.map(d => [d.host, d]));
    const out = [];
    for (const d of list) {
      const host = String(d.host || '').trim();
      if (!/^[\w.-]+$/.test(host)) return json(400, { error: 'IP inválido: ' + host });
      // senha vazia = manter a senha já salva
      const password = d.password ? String(d.password) : (old[host] ? old[host].password : '');
      const prev = old[host];
      out.push({ name: String(d.name || host).trim(), host, user: String(d.user || 'admin').trim(), password, ...(prev && prev.port ? { port: prev.port } : {}) });
    }
    // equipamentos removidos ou com host trocado: fecha a conexão antiga
    const newHosts = new Set(out.map(d => d.host));
    for (const [h, entry] of conns) if (!newHosts.has(h)) { entry.client.end(); conns.delete(h); }
    cfg.devices = out; save(); poll_all();
    return json(200, { ok: true });
  }
  if (req.url === '/api/devices/reorder' && req.method === 'POST') {
    const payload = await body(req);
    const order = payload && Array.isArray(payload.order) ? payload.order : null;
    if (!order) return json(400, { error: 'JSON inválido' });
    const byHost = Object.fromEntries(cfg.devices.map(d => [d.host, d]));
    const reordered = order.map(h => byHost[h]).filter(Boolean);
    // qualquer equipamento não listado (ex.: cadastrado por outra aba) vai ao final, na ordem original
    cfg.devices.forEach(d => { if (!order.includes(d.host)) reordered.push(d); });
    cfg.devices = reordered; save();
    return json(200, { ok: true });
  }
  // topologia editável: ligações porta a porta (cabos) e inventário de portas por equipamento
  // rev: protege contra páginas antigas/abertas em outra janela regravarem a topologia com dados defasados
  if (pathname === '/api/topology' && req.method === 'GET')
    return json(200, { links: cfg.links || [], inventory: cfg.inventory || {}, rev: TOPO_REV_BASE + '.' + topoRev });
  if (pathname === '/api/topology' && req.method === 'POST') {
    let clean, b;
    try { b = await body(req); clean = sanitizeTopology(b); } catch (e) { return json(400, { error: e.message }); }
    if (!b || b.rev !== TOPO_REV_BASE + '.' + topoRev) return json(409, { error: 'A configuração mudou em outra janela ou esta página está desatualizada. Recarregue a página (F5) para não perder alterações.' });
    cfg.links = clean.links; cfg.inventory = clean.inventory; save(); topoRev++;
    return json(200, { ok: true, rev: TOPO_REV_BASE + '.' + topoRev });
  }
  if (req.url.startsWith('/api/traffic')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ intervalMs: cfg.intervalMs, links: cfg.links || [], devices: Object.values(state) }));
  }
  if (pathname === '/api/ping' && req.method === 'GET') return json(200, { ts: Date.now(), states: pingSvc.states() });
  if (pathname === '/api/ping/history' && req.method === 'GET') {
    const ip = new URL(req.url, 'http://x').searchParams.get('ip') || '';
    return json(200, pingSvc.history(ip));
  }
  if (req.url.startsWith('/api/hist-ports')) {
    const host = new URL(req.url, 'http://x').searchParams.get('host');
    return json(200, histStore[host] || { agg: [], ports: {} });
  }
  const page = pathname === '/traffic.html' ? 'traffic.html' : 'index.html';
  fs.readFile(path.join(__dirname, page), (e, d) => {
    res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(e ? 'erro' : d);
  });
}).listen(cfg.port, '127.0.0.1', () => console.log('Dashboard: http://localhost:' + cfg.port));

process.on('SIGINT', () => {
  try { pingSvc.stop(); } catch {}
  try { fs.writeFileSync(HIST_FILE, JSON.stringify(histStore)); } catch {}
  for (const [, e] of conns) e.client.end();
  process.exit(0);
});
