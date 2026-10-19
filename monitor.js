// Monitor de rede por varredura (ping + portas TCP + SNMP/HTTP/NetBIOS) — portado do projeto antigo.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const os = require('os');

const IS_WIN = os.platform() === 'win32';
const STATS_FILE = path.join(__dirname, 'monitor-stats.json');
const HISTORY_FILE = path.join(__dirname, 'monitor-history.json');

// ─────────────────────────────────────────────
//  PORTAS COMUNS — máxima cobertura de dispositivos LAN
//  Varredura simultânea de todas as portas; ECONNREFUSED = host alive
// ─────────────────────────────────────────────
const COMMON_PORTS = [
  // Windows — detecta QUALQUER máquina Windows na rede
  135,   // RPC Endpoint Mapper (obrigatório em todo Windows)
  445,   // SMB / CIFS (compartilhamento de arquivos Windows)
  139,   // NetBIOS Session (Windows legado)
  3389,  // RDP (Remote Desktop)
  5985,  // WinRM HTTP

  // Web (switches, APs, câmeras, NAS, impressoras, roteadores)
  80, 443, 8080, 8443, 8888, 8181, 8000, 9090,

  // SSH / Telnet (Linux, switches gerenciáveis, roteadores)
  22, 23,

  // Impressão
  9100,  // RAW / JetDirect (a maioria das impressoras de rede)
  631,   // IPP (Internet Printing Protocol)
  515,   // LPD / LPR

  // Bancos de dados (identificar servidores)
  3306,  // MySQL / MariaDB
  1433,  // MS SQL Server
  5432,  // PostgreSQL
  6379,  // Redis
  27017, // MongoDB

  // Acesso remoto / VoIP
  5900,  // VNC
  5060,  // SIP (VoIP)

  // Dispositivos de rede / IoT
  21,    // FTP (câmeras IP, dispositivos embedded)
  7547,  // TR-069 (gerenciamento de roteadores ISP)
  49152, // UPnP / dispositivos IoT

  // Virtualização / Serviços de infra
  902,   // VMware ESXi
  5985,  // Hyper-V / WinRM
  2375,  // Docker API
];

// Equipamentos conhecidos (classificação por tipo). Sobrescrevível em config.json -> "known"/"links".
const DEFAULT_KNOWN = {
  nucleo:        ['10.20.12.1','10.20.12.4','10.20.12.5','10.20.12.6','10.20.12.7','10.20.12.8'],
  accesspoint:   ['10.20.12.10','10.20.12.12','10.20.12.14','10.20.12.17'],
  servers:       ['10.20.12.2', '10.20.12.3', '10.20.12.9'],
  printers: ['10.20.12.44','10.20.12.45','10.20.12.46','10.20.12.47',
             '10.20.12.48','10.20.12.49','10.20.12.50','10.20.12.51','10.20.12.52'],
  defaultRanges: ['10.20.12.1-254', '10.20.13.1-254'],
  scanInterval:  60,
};
let cfgRef = {};
function setConfig(cfg) { cfgRef = cfg || {}; }
const KNOWN = new Proxy({}, {
  get: (_, k) => k === 'links' ? (cfgRef.links || []) : ((cfgRef.known && cfgRef.known[k]) || DEFAULT_KNOWN[k]),
  ownKeys: () => [...Object.keys(DEFAULT_KNOWN), 'links'],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function sendEvent(res, data) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}

`);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────
//  PING via comando do SO
// ─────────────────────────────────────────────
function pingHost(ip, timeoutMs) {
  return new Promise((resolve) => {
    const t0  = Date.now();
    // -a no Windows: faz resolução de nome junto com o ping (sem custo extra)
    const cmd = IS_WIN
      ? `ping -n 1 -w ${timeoutMs} -a ${ip}`
      : `ping -c 1 -W ${Math.max(1, Math.ceil(timeoutMs / 1000))} ${ip}`;

    exec(cmd, { timeout: timeoutMs + 2000 }, (err, stdout) => {
      const elapsed = Date.now() - t0;

      if (err) return resolve({ online: false, rt: null, hostname: null });

      // Independe do idioma do Windows ("Reply from"/"Resposta de", "time"/"tempo"): uma resposta de verdade
      // traz "TTL="; "host inacessível" vindo do gateway não traz.
      const ok = IS_WIN
        ? /TTL=\d+/i.test(stdout)
        : /1 (packets )?received|1 received/.test(stdout);

      if (!ok) return resolve({ online: false, rt: null, hostname: null });

      // Extrair RTT ("time=2ms", "tempo<1ms", "tempo=12ms")
      const m = stdout.match(/[=<]\s*(\d+)\s*ms/i);
      const rt = m ? parseInt(m[1]) : elapsed;

      // Extrair hostname do ping -a (Windows)
      // Ex: "Pinging HOSTNAME [10.x.x.x]..." ou "Executando Ping em HOSTNAME [10.x.x.x]..."
      let hostname = null;
      if (IS_WIN) {
        const hm = stdout.match(/([A-Za-z][A-Za-z0-9\-\.]{1,62})\s*\[[\d.]+\]/);
        if (hm) hostname = hm[1].trim();
      }

      resolve({ online: true, rt, hostname });
    });
  });
}

// ─────────────────────────────────────────────
//  Verificação de porta TCP
// ─────────────────────────────────────────────
function checkPort(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0   = Date.now();
    const sock = new net.Socket();
    let done   = false;

    const finish = (open) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ port, open, rt: Date.now() - t0 });
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', ()          => finish(true));
    sock.on('timeout', ()          => finish(false));
    sock.on('error',   (e)         => finish(e.code === 'ECONNREFUSED')); // refused = host alive
    sock.connect(port, ip);
  });
}

// ─────────────────────────────────────────────
//  DNS reverso
// ─────────────────────────────────────────────
function resolveDNS(ip) {
  return new Promise((resolve) => {
    const guard = setTimeout(() => resolve(null), 1500);
    dns.reverse(ip, (err, hosts) => {
      clearTimeout(guard);
      resolve(err ? null : (hosts[0] || null));
    });
  });
}

// ─────────────────────────────────────────────
//  NetBIOS — nome do computador Windows via nbtstat
// ─────────────────────────────────────────────
function resolveNetBIOS(ip) {
  if (!IS_WIN) return Promise.resolve(null);
  return new Promise((resolve) => {
    exec(`nbtstat -A ${ip}`, { timeout: 300 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      // Linha: "  COMPUTERNAME  <00>  UNIQUE   Registered" (EN)
      //        "  COMPUTERNAME  <00>  ÚNICO    Registrado" (PT)
      // Ignora GROUP/GRUPO (workgroup/domínio)
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_\-]{1,15})\s+<(?:00|20)>/);
        if (m && !/GROUP|GRUPO/i.test(line)) {
          return resolve(m[1].trim());
        }
      }
      resolve(null);
    });
  });
}

// ─────────────────────────────────────────────
//  SNMP sysName — funciona em impressoras, switches, APs
//  Pacote SNMP v1 GET OID 1.3.6.1.2.1.1.5.0 community "public"
// ─────────────────────────────────────────────
const SNMP_PKT = Buffer.from([
  0x30,0x29, 0x02,0x01,0x00,                          // SEQUENCE; version=0 (v1)
  0x04,0x06,0x70,0x75,0x62,0x6c,0x69,0x63,            // community="public"
  0xa0,0x1c, 0x02,0x04,0x00,0x00,0x00,0x01,           // GetRequest; request-id=1
  0x02,0x01,0x00, 0x02,0x01,0x00,                     // error-status=0; error-index=0
  0x30,0x0e, 0x30,0x0c,                               // VarBindList; VarBind
  0x06,0x08,0x2b,0x06,0x01,0x02,0x01,0x01,0x05,0x00, // OID 1.3.6.1.2.1.1.5.0
  0x05,0x00,                                          // NULL
]);

function parseSnmpSysName(buf) {
  // Percorre ASN.1 e retorna o primeiro OctetString que não seja "public"
  const strings = [];
  function decode(data) {
    let pos = 0;
    while (pos < data.length) {
      const tag = data[pos++];
      if (pos >= data.length) break;
      let len = data[pos++];
      if (len & 0x80) {
        const nb = len & 0x7F; len = 0;
        for (let k = 0; k < nb && pos < data.length; k++) len = (len << 8) | data[pos++];
      }
      const chunk = data.slice(pos, pos + len);
      pos += len;
      if (tag === 0x04) {                          // OctetString
        const s = chunk.toString('utf8').replace(/\x00/g, '').trim();
        if (s && s !== 'public' && s.length >= 2 && /^[\x20-\x7E]+$/.test(s)) strings.push(s);
      } else if (tag & 0x20 || (tag >= 0xa0 && tag <= 0xbf)) { // construído
        decode(chunk);
      }
    }
  }
  try { decode(buf); } catch {}
  return strings[0] || null;
}

function resolveSnmpName(ip, timeoutMs = 300) {
  return new Promise((resolve) => {
    let done = false;
    const sock = dgram.createSocket('udp4');
    const finish = (name) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve(name);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    sock.on('message', (msg) => { clearTimeout(timer); finish(parseSnmpSysName(msg)); });
    sock.send(SNMP_PKT, 161, ip, (err) => { if (err) { clearTimeout(timer); finish(null); } });
  });
}

// ─────────────────────────────────────────────
//  HTTP — extrai hostname do título ou header Server
//  Funciona bem em APs, impressoras, switches, NAS
// ─────────────────────────────────────────────
function resolveHttpName(ip, timeoutMs = 300) {
  return new Promise((resolve) => {
    let done = false;
    let pending = 0;
    const finish = (name) => {
      if (name && !done) { done = true; resolve(name); return; }
      if (--pending === 0 && !done) resolve(null);
    };

    const tryPort = (port) => {
      pending++;
      const mod     = (port === 443) ? https : http;
      const options = { hostname: ip, port, path: '/', method: 'GET',
                        timeout: timeoutMs, rejectUnauthorized: false };
      let called = false;
      const cb = (name) => { if (!called) { called = true; finish(name); } };

      const req = mod.request(options, (res) => {
        // Server header pode conter o nome do dispositivo (ex: "Ubiquiti/6.x", "EPSON_...")
        const srvHdr = (res.headers['server'] || '').split('/')[0].trim();
        const useSrv = srvHdr.length >= 3 &&
          !/^(Apache|nginx|Microsoft-IIS|lighttpd|openresty|mini_httpd|GoAhead)/i.test(srvHdr);

        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; if (body.length > 8192) res.destroy(); });
        res.on('end', () => {
          const tm = body.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
          let title = tm ? tm[1].replace(/&amp;/g,'&').replace(/&#?\w+;/g,'').trim() : null;
          // Descarta títulos genéricos de páginas de login
          if (title && /^(login|sign.?in|welcome|home\s*page|untitled|\s*)$/i.test(title))
            title = null;
          // Pega só a primeira parte (antes de separadores)
          if (title) title = title.split(/\s*[\-|·—•:]\s*/)[0].trim();
          cb((title && title.length >= 2) ? title : (useSrv ? srvHdr : null));
        });
      });

      req.on('error',   () => cb(null));
      req.on('timeout', () => { req.destroy(); cb(null); });
      req.end();
    };

    tryPort(80);
    tryPort(443);
    tryPort(8080);
  });
}

// ─────────────────────────────────────────────
//  Resolução de nome — todos os métodos em paralelo
//  Prioridade: NetBIOS > ping-a > SNMP > HTTP > DNS
// ─────────────────────────────────────────────
async function resolveName(ip, pingHostname) {
  // Inicia todos simultaneamente
  const nbPromise   = resolveNetBIOS(ip);
  const snmpPromise = resolveSnmpName(ip);
  const httpPromise = resolveHttpName(ip);
  const dnsPromise  = resolveDNS(ip);

  // NetBIOS tem maior prioridade — se retornar logo, sai imediatamente
  const nbName = await nbPromise;
  if (nbName) return nbName;
  if (pingHostname) return pingHostname;

  // Os demais já estão rodando desde t=0; awaita o que ainda não terminou
  const [snmpName, httpName, dnsName] = await Promise.all([snmpPromise, httpPromise, dnsPromise]);
  return snmpName || httpName || dnsName || null;
}

// ─────────────────────────────────────────────
//  Varredura completa de um host
// ─────────────────────────────────────────────
async function _scanHost(ip, timeoutMs, knownHostname) {
  const portTimeout = Math.min(timeoutMs, 800);

  const [pingResult, ...portResults] = await Promise.all([
    pingHost(ip, timeoutMs),
    ...COMMON_PORTS.map(p => checkPort(ip, p, portTimeout)),
  ]);

  const openPorts = portResults.filter(r => r.open).map(r => r.port);
  const tcpOnline = openPorts.length > 0;
  const online    = pingResult.online || tcpOnline;

  if (!online) return { ip, online: false, rt: null, ports: [], hostname: null };

  // Se já temos o nome (scan anterior), não re-resolve — economiza tempo
  const hostname = knownHostname
    ? knownHostname
    : await resolveName(ip, pingResult.hostname);

  return {
    ip,
    online:  true,
    rt:      pingResult.online ? pingResult.rt : (portResults.find(r => r.open)?.rt ?? null),
    ports:   openPorts,
    hostname,
    pingOk:  pingResult.online,
  };
}

function scanHost(ip, timeoutMs, knownHostname) {
  const HARD_LIMIT = timeoutMs + 6000;   // teto absoluto por host
  const timeout = new Promise(resolve =>
    setTimeout(() => resolve({ ip, online: false, rt: null, ports: [], hostname: null }), HARD_LIMIT)
  );
  return Promise.race([_scanHost(ip, timeoutMs, knownHostname), timeout]);
}

// ─────────────────────────────────────────────
//  Informações de rede local
// ─────────────────────────────────────────────
function getNetworkInfo() {
  const ifaces = os.networkInterfaces();
  const result = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        // Sugerir faixa a partir da máscara
        const parts    = addr.address.split('.').map(Number);
        const maskParts= addr.netmask.split('.').map(Number);
        const network  = parts.map((b, i) => b & maskParts[i]);
        // CIDR prefix
        const prefix   = maskParts.reduce((s, b) => s + b.toString(2).split('1').length - 1, 0);
        const suggested = `${network.slice(0,3).join('.')}.1-254`;

        result.push({
          name,
          address:   addr.address,
          netmask:   addr.netmask,
          prefix,
          suggested,
        });
      }
    }
  }
  return result;
}

// ─────────────────────────────────────────────
//  Tabela ARP (dispositivos recentemente vistos)
// ─────────────────────────────────────────────
function getArpTable() {
  return new Promise((resolve) => {
    exec('arp -a', { timeout: 300 }, (err, stdout) => {
      if (err) return resolve([]);
      const entries = [];
      const lines   = stdout.split(/\r?\n/);
      for (const line of lines) {
        // Windows: "  192.168.1.1          aa-bb-cc-dd-ee-ff     dynamic"
        // Linux:   "192.168.1.1              ether  aa:bb:cc:dd:ee:ff  C  eth0"
        const m = line.match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:.-]{11,17})\s+(\w+)/i);
        if (m) {
          const type = m[3].toLowerCase();
          const oct1 = parseInt(m[1].split('.')[0], 10);
          const isMulticast  = oct1 >= 224 && oct1 <= 239;
          const isBroadcast  = m[1].endsWith('.255');
          if (!/^inv/.test(type) && !isMulticast && !isBroadcast) {
            entries.push({ ip: m[1], mac: m[2].toLowerCase(), type });
          }
        }
      }
      resolve(entries);
    });
  });
}

// ─────────────────────────────────────────────
//  Estatísticas — persistidas em stats.json
// ─────────────────────────────────────────────
function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return { hourly: {}, events: [] }; }
}

function saveStats(data) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('Erro ao salvar stats:', e.message); }
}

// ─────────────────────────────────────────────
//  Histórico detalhado — history.json
//  Estrutura: { "YYYY-MM-DD": { hours: { "HH": {online,offline} }, events: [{ip,event,ts}] } }
// ─────────────────────────────────────────────
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return {}; }
}

function saveHistory(data) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error('Erro ao salvar history:', e.message); }
}


const ROUTES = new Set(['/api/network-info','/api/config','/api/arp','/api/history','/api/stats/event','/api/history/snapshot','/api/scan']);

async function handle(req, res, pathname) {
  // ── GET /api/network-info ─────────────────
  if (req.method === 'GET' && pathname === '/api/network-info') {
    return json(res, getNetworkInfo());
  }

  // ── GET /api/config ───────────────────────
  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, KNOWN);
  }

  // ── GET /api/arp ──────────────────────────
  if (req.method === 'GET' && pathname === '/api/arp') {
    const table = await getArpTable();
    return json(res, table);
  }

  // ── GET /api/history ─────────────────────
  if (req.method === 'GET' && pathname === '/api/history') {
    return json(res, loadHistory());
  }

  // ── POST /api/stats/event ─────────────────
  if (req.method === 'POST' && pathname === '/api/stats/event') {
    let body;
    try { body = await readBody(req); } catch { res.writeHead(400); return res.end(); }
    const { ip, event, ts } = body || {};
    if (!ip || !event || !ts) return json(res, { error: 'invalid' }, 400);

    const history = loadHistory();
    const d       = new Date(ts);
    const pad     = n => String(n).padStart(2, '0');
    const day     = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hour    = pad(d.getHours());

    if (!history[day])             history[day]             = { hours: {}, events: [] };
    if (!history[day].hours[hour]) history[day].hours[hour] = { online: 0, offline: 0 };

    if (event === 'online')  history[day].hours[hour].online++;
    if (event === 'offline') history[day].hours[hour].offline++;
    history[day].events.push({ ip, event, ts });

    // Remove dias mais velhos que 30 dias
    const cutoff    = new Date(Date.now() - 30 * 24 * 3600000);
    const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth() + 1)}-${pad(cutoff.getDate())}`;
    for (const k of Object.keys(history)) if (k < cutoffStr) delete history[k];

    saveHistory(history);
    return json(res, { ok: true });
  }

  // ── POST /api/history/snapshot ────────────
  // Body: { ts, online, total }  — gravado após cada scan completo
  if (req.method === 'POST' && pathname === '/api/history/snapshot') {
    let body;
    try { body = await readBody(req); } catch { res.writeHead(400); return res.end(); }
    const { ts, online, total } = body || {};
    if (ts == null || online == null) return json(res, { error: 'invalid' }, 400);

    const history = loadHistory();
    const d       = new Date(ts);
    const pad     = n => String(n).padStart(2, '0');
    const day     = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hour    = pad(d.getHours());

    if (!history[day])             history[day]             = { hours: {}, events: [] };
    if (!history[day].hours[hour]) history[day].hours[hour] = { online: 0, offline: 0 };

    // Sobrescreve com o valor mais recente da hora
    history[day].hours[hour].online_count = online;
    history[day].hours[hour].total_count  = total;

    saveHistory(history);
    return json(res, { ok: true });
  }

  // ── POST /api/scan  ───────────────────────
  // Body: { ips: string[], timeout: number, ports: number[], concurrent: number }
  // Resposta: Server-Sent Events (text/event-stream)
  if (req.method === 'POST' && pathname === '/api/scan') {
    let body;
    try { body = await readBody(req); }
    catch { res.writeHead(400); return res.end('Body inválido'); }

    const { ips = [], timeout: tms = 500, concurrent = 25, knownHostnames = {} } = body;

    if (!Array.isArray(ips) || ips.length === 0) {
      return json(res, { error: 'Lista de IPs vazia' }, 400);
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type':  'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });

    let aborted = false;
    res.on('close', () => { aborted = true; });

    let done = 0;
    const total = ips.length;

    // Pool de concorrência — transmite resultados conforme chegam, sem pausa entre lotes
    await new Promise((finish) => {
      let active = 0, idx = 0, resolved = false;
      const complete = () => { if (!resolved) { resolved = true; finish(); } };
      const pump = () => {
        if (aborted) return complete();
        while (active < concurrent && idx < ips.length) {
          const ip = ips[idx++];
          active++;
          scanHost(ip, tms, knownHostnames[ip] || null)
            .then(result  => { if (!aborted) { done++; sendEvent(res, { ...result, done, total }); } })
            .catch(()     => { if (!aborted) { done++; sendEvent(res, { ip, online: false, rt: null, ports: [], hostname: null, done, total }); } })
            .finally(()   => { active--; pump(); });
        }
        if (active === 0 && idx >= ips.length) complete();
      };
      pump();
    });

    sendEvent(res, { type: 'complete', total });
    return res.end();
  }

  // rota conhecida com método errado: responde em vez de deixar a conexão pendurada
  res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, POST' });
  res.end(JSON.stringify({ error: 'Método não permitido' }));
}

module.exports = { handle, setConfig, ROUTES, pingHost };
