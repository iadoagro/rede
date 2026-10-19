// Parsers da saída textual do RouterOS (CLI via SSH). Sem dependências.
// Tudo é tolerante: formato inesperado => resultado vazio, nunca exceção.
'use strict';

// Pares chave=valor de uma linha "terse" (valores com espaço vêm entre aspas).
function parseKv(text) {
  const out = {};
  const re = /([\w.-]+)=("([^"]*)"|\S*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

// Linhas " 0  RS name=ether1 type=ether ..." => [{ idx, flags, kv }]
function parseTerseLines(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(?:([A-Z]+)\s+)?(\S.*)$/);
    if (!m) continue;
    rows.push({ idx: +m[1], flags: m[2] || '', kv: parseKv(m[3]) });
  }
  return rows;
}

// Blocos "chave: valor" (um por interface) separados por linha em branco
// ou pela repetição da chave inicial.
function parseBlocks(text, startKey) {
  const rows = [];
  let cur = {};
  const flush = () => { if (cur[startKey] !== undefined) rows.push(cur); cur = {}; };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) { flush(); continue; }
    const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === startKey && cur[startKey] !== undefined) flush();
    cur[m[1]] = m[2].trim();
  }
  flush();
  return rows;
}

// /interface print terse => Map(nome -> { type, running, disabled, comment, mac })
function parseInterfaces(text) {
  const out = new Map();
  for (const r of parseTerseLines(text)) {
    const name = r.kv.name;
    if (!name) continue;
    out.set(name, {
      type: r.kv.type || '',
      running: r.flags.includes('R'),
      disabled: r.flags.includes('X'),
      comment: r.kv.comment || '',
      mac: r.kv['mac-address'] || '',
    });
  }
  return out;
}

// /ip neighbor print terse => Map(interface -> [ { address, mac, identity, platform, board, version } ])
// "interface=ether2,bridge1": o vizinho vale para cada interface listada.
function parseNeighbors(text) {
  const out = new Map();
  for (const r of parseTerseLines(text)) {
    const n = {
      address: r.kv.address || r.kv.address4 || '',
      mac: r.kv['mac-address'] || '',
      identity: r.kv.identity || '',
      platform: r.kv.platform || '',
      board: r.kv.board || '',
      version: r.kv.version || '',
    };
    if (!n.address && !n.identity && !n.mac) continue;
    for (const ifc of String(r.kv.interface || '').split(',')) {
      const k = ifc.trim();
      if (!k) continue;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(n);
    }
  }
  return out;
}

// "1Gbps" / "100Mbps" / "2.5Gbps" / "10Gbps" => Mbps (número) ou null
function rateToMbps(rate) {
  const m = String(rate || '').trim().match(/^([\d.]+)\s*([GMK]?)(?:bps|b\/s)?$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const mult = { G: 1000, M: 1, K: 0.001, '': 1e-6 }[m[2].toUpperCase()];
  return Number.isFinite(v) ? Math.round(v * mult * 1000) / 1000 : null;
}

// /interface ethernet monitor ... once => Map(nome -> { status, mbps })
function parseEthernetMonitor(text) {
  const out = new Map();
  for (const r of parseBlocks(text, 'name')) {
    out.set(r.name, { status: r.status || '', mbps: rateToMbps(r.rate) });
  }
  return out;
}

// /system resource print => { board, version, uptime, cpuLoad, memFree, memTotal, arch }
function parseSystemResource(text) {
  const kv = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  if (!Object.keys(kv).length) return null;
  const load = parseInt(kv['cpu-load'], 10);
  return {
    board: kv['board-name'] || '',
    version: kv.version || '',
    uptime: kv.uptime || '',
    cpuLoad: Number.isFinite(load) ? load : null,
    memFree: kv['free-memory'] || '',
    memTotal: kv['total-memory'] || '',
    arch: kv['architecture-name'] || '',
  };
}

// Interfaces que não são portas físicas (bridge, vlan, túneis...).
const VIRTUAL_NAME = /^(bridge|vlan|lo\b|loopback|wlan|wifi|pppoe|l2tp|ovpn|sstp|pptp|gre|eoip|ipip|vrrp|bond|wireguard|wg|veth|lte|zerotier|ether-vlan)/i;
function portKind(name, info) {
  if (info) {
    if (info.type && info.type !== 'ether') return 'virtual';
    return /sfp|qsfp/i.test(name) ? 'sfp' : 'ether';
  }
  if (VIRTUAL_NAME.test(name)) return 'virtual';
  return /sfp|qsfp/i.test(name) ? 'sfp' : 'ether';
}

module.exports = {
  parseKv, parseTerseLines, parseBlocks, parseInterfaces, parseNeighbors,
  parseEthernetMonitor, parseSystemResource, rateToMbps, portKind,
};
