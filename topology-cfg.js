// Validação da topologia editada na interface: ligações (cabos porta a porta) e inventário de portas.
'use strict';

const HOST = /^[\w.:-]{1,64}$/;
const PORT = /^S?\d{1,3}$/i;
const ETYPES = ['switch', 'patch', 'router', 'server', 'ups', 'organizer', 'blank', 'other'];   // tipos de equipamento de rack
const ROLES = ['internet', 'nucleo', 'concentrador', 'core', 'distribuicao', 'secondary'];   // papel (rack ou switch)
const RTYPES = ['internet', 'principal', 'secundario'];   // tipo do rack (hack)
const MEDIA = ['utp', 'fibra'];             // '' = automático (porta SFP => fibra, senão cabo de rede)

function cleanPort(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!PORT.test(s)) {                       // aceita nome de interface (ether5, sfp-sfpplus1) e converte em rótulo
    const m = s.match(/^[a-z][\w-]*?(\d{1,3})$/i);
    if (!m) throw new Error('Porta inválida: ' + s);
    return (/sfp/i.test(s) ? 'S' : '') + String(+m[1]);
  }
  return s.toUpperCase().replace(/^S0+(?=\d)/, 'S').replace(/^0+(?=\d)/, '');
}

function cleanMedium(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s === 'auto') return '';
  if (!MEDIA.includes(s)) throw new Error('Tipo de cabo inválido: ' + s);
  return s;
}

// body: { links: [[from, to, fromPort, toPort, medium], ...], inventory: { id: { name, ports, sfp, sw } } }
// sw = switch "virtual" (sem IP/SSH) cadastrado à mão abaixo de um concentrador
// devolve { links, inventory } normalizados ou lança Error com a mensagem para o usuário.
function sanitizeTopology(body) {
  if (!body || typeof body !== 'object') throw new Error('JSON inválido');
  const rawLinks = Array.isArray(body.links) ? body.links : [];
  if (rawLinks.length > 1000) throw new Error('Ligações demais');

  const links = [], parent = new Map();
  for (const l of rawLinks) {
    if (!Array.isArray(l) || l.length < 2) throw new Error('Ligação inválida');
    const from = String(l[0] == null ? '' : l[0]).trim(), to = String(l[1] == null ? '' : l[1]).trim();
    if (!HOST.test(from) || !HOST.test(to)) throw new Error('IP inválido: ' + (HOST.test(from) ? to : from));
    if (from === to) throw new Error('Um equipamento não pode ligar nele mesmo: ' + from);
    if (parent.has(to)) continue;                                  // cada equipamento tem um único pai
    for (let a = from; a; a = parent.get(a)) if (a === to) throw new Error(`Ligação ${from} → ${to} cria um laço`);
    parent.set(to, from);
    links.push([from, to, cleanPort(l[2]), cleanPort(l[3]), cleanMedium(l[4])]);
  }

  // um cabo ocupa a porta dos dois lados: não pode haver duas ligações na mesma porta
  const used = new Set();
  for (const [from, to, fp, tp] of links) {
    for (const [ip, port] of [[from, fp], [to, tp]]) {
      if (!port) continue;
      const k = ip + '|' + port;
      if (used.has(k)) throw new Error(`A porta ${port} de ${ip} está em mais de uma ligação`);
      used.add(k);
    }
  }

  const inventory = {}; let nSw = 0;
  const rawInv = body.inventory && typeof body.inventory === 'object' && !Array.isArray(body.inventory) ? body.inventory : {};
  for (const [ip, v] of Object.entries(rawInv)) {
    if (!HOST.test(ip)) throw new Error('IP inválido no inventário: ' + ip);
    const o = v && typeof v === 'object' ? v : {};
    const ports = Math.round(Number(o.ports) || 0), sfp = Math.round(Number(o.sfp) || 0);
    if (ports < 0 || ports > 96) throw new Error('Portas RJ45 deve ficar entre 0 e 96');
    if (sfp < 0 || sfp > 32) throw new Error('Portas SFP deve ficar entre 0 e 32');
    const name = String(o.name == null ? '' : o.name).trim().slice(0, 60);
    const role = ROLES.includes(o.role) ? o.role : '';
    const ipv = o.sw === true && o.ip != null && HOST.test(String(o.ip).trim()) ? String(o.ip).trim() : '';
    const hnum = o.sw !== true ? String(o.hnum == null ? '' : o.hnum).trim().slice(0, 12) : '';
    const andar = o.sw !== true ? String(o.andar == null ? '' : o.andar).trim().slice(0, 30) : '';
    const setor = o.sw !== true ? String(o.setor == null ? '' : o.setor).trim().slice(0, 60) : '';
    const rtype = o.sw !== true && RTYPES.includes(o.rtype) ? o.rtype : '';
    const sw = o.sw === true, conc = !sw && o.conc === true;      // conc = concentrador (rack) criado à mão
    const pos = sw ? Math.max(0, Math.min(9999, Math.round(Number(o.pos) || 0))) : 0;
    const etype = sw && ETYPES.includes(o.etype) && o.etype !== 'switch' ? o.etype : '';
    const u = sw ? Math.max(1, Math.min(4, Math.round(Number(o.u) || 1))) : 1;
    const rack = sw && o.rack != null && HOST.test(String(o.rack).trim()) ? String(o.rack).trim() : '';
    if (sw && ++nSw > 300) throw new Error('Switches demais');
    if (name || ports || sfp || sw || conc || role || rtype || andar || setor || hnum || ipv) inventory[ip] = { ...(name ? { name } : {}), ports, sfp, ...(sw ? { sw: true } : {}), ...(conc ? { conc: true } : {}), ...(role ? { role } : {}), ...(rtype ? { rtype } : {}), ...(ipv ? { ip: ipv } : {}), ...(hnum ? { hnum } : {}), ...(andar ? { andar } : {}), ...(setor ? { setor } : {}), ...(etype ? { etype } : {}), ...(sw && u > 1 ? { u } : {}), ...(rack ? { rack } : {}), ...(pos ? { pos } : {}) };
  }
  return { links, inventory };
}

module.exports = { sanitizeTopology };
