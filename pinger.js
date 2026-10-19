// Ping contínuo dos equipamentos da topologia, em segundo plano, com histórico guardado em arquivos da pasta:
//   ping-events.jsonl  — uma linha por mudança de estado (online/offline), para sempre (só acrescenta)
//   ping-history.json  — resumo por minuto de cada IP (últimas 72 h): usado para disponibilidade e a linha do tempo
'use strict';
const fs = require('fs');
const path = require('path');

const HOST = /^\d{1,3}(\.\d{1,3}){3}$/;            // só IPv4 (ids internos como "sw-abc" não são pingados)
const KEEP_MIN = 72 * 60;                           // minutos de histórico por IP

function create({ ping, targets, dir = __dirname, intervalMs = 2000, timeoutMs = 800, concurrency = 16, failsToDown = 2 }) {
  const evFile = path.join(dir, 'ping-events.jsonl'), histFile = path.join(dir, 'ping-history.json');
  const state = {};                                 // ip -> { online, rt, since, last, fails }
  let minutes = {};                                 // ip -> [{ m, up, n, rt }]
  let events = [];                                  // últimos eventos em memória (cache do arquivo)
  let dirty = false, running = false, timer = null, saver = null;

  try { minutes = JSON.parse(fs.readFileSync(histFile, 'utf8')).minutes || {}; } catch { minutes = {}; }
  try {
    events = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).slice(-3000).map(l => JSON.parse(l));
  } catch { events = []; }
  // quem estava registrado como online/offline antes de reiniciar continua com esse "desde"
  const lastOf = {}; events.forEach(e => { lastOf[e.ip] = e; });

  const addEvent = (ip, online, rt) => {
    const e = { ts: Date.now(), ip, event: online ? 'online' : 'offline', rt: rt == null ? null : rt };
    events.push(e); if (events.length > 3000) events.shift();
    try { fs.appendFileSync(evFile, JSON.stringify(e) + '\n'); } catch { /* disco indisponível: segue só em memória */ }
  };
  const bucket = (ip, online, rt) => {
    const m = Math.floor(Date.now() / 60000), arr = minutes[ip] || (minutes[ip] = []);
    let b = arr[arr.length - 1];
    if (!b || b.m !== m) { b = { m, up: 0, n: 0, rt: 0 }; arr.push(b); while (arr.length > KEEP_MIN) arr.shift(); }
    b.n++; if (online) { b.up++; b.rt += rt || 0; }
    dirty = true;
  };

  // registra a mudança (ou a confirmação do estado anterior ao reinício, que só recupera o "desde")
  const note = (ip, up, rt, st) => {
    const prev = lastOf[ip];
    if (prev && prev.event === (up ? 'online' : 'offline')) { st.since = prev.ts; return; }
    addEvent(ip, up, rt); lastOf[ip] = events[events.length - 1];
  };
  const apply = (ip, up, rt) => {
    const st = state[ip] || (state[ip] = { online: null, rt: null, since: Date.now(), last: 0, fails: 0 });
    st.last = Date.now();
    if (up) { st.fails = 0; st.rt = rt; if (st.online !== true) { st.online = true; st.since = Date.now(); note(ip, true, rt, st); } }
    else { st.fails++; if (st.fails >= failsToDown && st.online !== false) { st.online = false; st.rt = null; st.since = Date.now(); note(ip, false, null, st); } }
    if (st.online !== null) bucket(ip, st.online, st.rt);
  };

  async function cycle() {
    if (running) return; running = true;
    try {
      const ips = [...new Set((targets() || []).filter(ip => HOST.test(ip)))];
      for (let i = 0; i < ips.length; i += concurrency) {
        await Promise.all(ips.slice(i, i + concurrency).map(async ip => {
          let r; try { r = await ping(ip, timeoutMs); } catch { r = { online: false }; }
          apply(ip, !!r.online, r.rt);
        }));
      }
    } finally { running = false; }
  }
  const loop = async () => { await cycle(); timer = setTimeout(loop, intervalMs); };
  const save = () => { if (!dirty) return; dirty = false; try { fs.writeFileSync(histFile, JSON.stringify({ minutes })); } catch { dirty = true; } };

  return {
    start() { if (!timer) { loop(); saver = setInterval(save, 30000); } },
    stop() { clearTimeout(timer); clearInterval(saver); timer = saver = null; save(); },
    save,
    states() {
      const out = {};
      Object.entries(state).forEach(([ip, s]) => { if (s.online !== null) out[ip] = { online: s.online, rt: s.rt, since: s.since, ts: s.last }; });
      return out;
    },
    // eventos, resumo dos últimos 60 min (1 célula por minuto) e disponibilidade (1 h, 24 h)
    history(ip) {
      const arr = minutes[ip] || [], now = Math.floor(Date.now() / 60000);
      const pct = mins => { let up = 0, n = 0; arr.forEach(b => { if (b.m > now - mins) { up += b.up; n += b.n; } }); return n ? Math.round(up / n * 1000) / 10 : null; };
      const strip = [];
      for (let k = 59; k >= 0; k--) { const b = arr.find(x => x.m === now - k); strip.push(b ? (b.up === b.n ? 2 : b.up === 0 ? 0 : 1) : -1); }   // 2 online, 1 parcial, 0 offline, -1 sem dado
      return { ip, events: events.filter(e => e.ip === ip).slice(-40).reverse(), strip, uptime1h: pct(60), uptime24h: pct(1440), uptime72h: pct(KEEP_MIN) };
    },
  };
}

module.exports = { create, HOST };
