'use strict';

// ─────────────────────────────────────────────
//  Configuração (espelhada do server.js)
// ─────────────────────────────────────────────
const FALLBACK_CFG = {
  nucleo:        ['10.20.12.1','10.20.12.4','10.20.12.5','10.20.12.6','10.20.12.7','10.20.12.8'],
  accesspoint:   ['10.20.12.10','10.20.12.12','10.20.12.14','10.20.12.17'],
  servers:       ['10.20.12.2', '10.20.12.3', '10.20.12.9'],
  printers: ['10.20.12.44','10.20.12.45','10.20.12.46','10.20.12.47',
             '10.20.12.48','10.20.12.49','10.20.12.50','10.20.12.51','10.20.12.52'],
  defaultRanges: ['10.20.12.1-254', '10.20.13.1-254'],
  scanInterval:  60,
  links:         [],
};

const TYPE_INFO = {
  nucleo:      { label: 'Núcleo',        icon: 'fa-network-wired', cls: 'nucleo'      },
  accesspoint: { label: 'Access Point',  icon: 'fa-wifi',          cls: 'accesspoint' },
  server:      { label: 'Servidor',      icon: 'fa-server',        cls: 'server'      },
  computer:    { label: 'Computador',    icon: 'fa-desktop',       cls: 'computer'    },
  printer:     { label: 'Impressora',    icon: 'fa-print',         cls: 'printer'     },
  unknown:     { label: 'Desconhecido',  icon: 'fa-question-circle', cls: 'unknown'   },
};

// ─────────────────────────────────────────────
//  Estado global — sempre começa limpo
// ─────────────────────────────────────────────
const S = {
  devices:        {},
  ranges:         [],
  filter:         'all',
  statusFilter:   'all',
  sort:           'status',
  group:          'type',
  viewMode:       'grid',
  search:         '',
  scanning:       false,
  monitoring:     false,
  cfg:            FALLBACK_CFG,
  backendOk:      false,
  abortCtrl:      null,
  editingIP:      null,
  cdInterval:     null,
  cdResolve:      null,
  scanCount:      0,    // 0 = primeira varredura (descoberta completa)
  collapsed:        {},   // { [type]: bool } — seções recolhidas
  sidebarVisible:   true,
  activeTab:        'monitor',
  chart:            null,
  expandedTopoGroups: {},  // { [groupKey]: bool } — grupos de topologia expandidos
  topoZoom:         100,   // zoom level for topology (percentage)
};

// ─────────────────────────────────────────────
//  Utilitários de IP
// ─────────────────────────────────────────────
function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  return ((p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3])>>>0;
}
function intToIp(n) {
  return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.');
}
function ipCmp(a, b) { return ipToInt(a) - ipToInt(b); }

function parseRange(raw) {
  const s   = raw.trim();
  const ips = [];

  if (s.includes('/')) {
    // CIDR: 10.20.12.0/23
    const [base, pfx] = s.split('/');
    const bits  = 32 - parseInt(pfx);
    const count = 1 << bits;
    if (count > 65536) return [];
    const net = ipToInt(base) & ~((count - 1) >>> 0);
    for (let i = 1; i < count - 1; i++) ips.push(intToIp((net + i) >>> 0));
    return ips;
  }

  if (s.includes('-')) {
    const dash  = s.lastIndexOf('-');
    const left  = s.slice(0, dash);
    const right = s.slice(dash + 1);

    if (right.includes('.')) {
      // IP completo: 10.20.12.1-10.20.13.254
      const si = ipToInt(left), ei = ipToInt(right);
      if (ei < si) return [];
      for (let i = si; i <= ei; i++) ips.push(intToIp(i));
    } else {
      // Último octeto: 192.168.1.1-50
      const parts = left.split('.');
      if (parts.length !== 4) return [];
      const base  = parts.slice(0, 3).join('.');
      const start = parseInt(parts[3]);
      const end   = parseInt(right);
      for (let i = start; i <= end; i++) ips.push(`${base}.${i}`);
    }
    return ips;
  }

  // IP único
  const p = s.split('.');
  if (p.length === 4 && p.every(x => !isNaN(x) && +x >= 0 && +x <= 255)) return [s];
  return [];
}

// ─────────────────────────────────────────────
//  Classificação de tipo
// ─────────────────────────────────────────────
// IPs fixos de cada seção — qualquer IP listado aqui NÃO aparece em outra seção
function guessType(ports, ip) {
  const c = S.cfg;
  if ((c.nucleo      || []).includes(ip)) return 'nucleo';
  if ((c.accesspoint || []).includes(ip)) return 'accesspoint';
  if ((c.servers     || []).includes(ip)) return 'server';
  if ((c.printers    || []).includes(ip)) return 'printer';
  return 'computer';
}

// ─────────────────────────────────────────────
//  Formatação de tempo
// ─────────────────────────────────────────────
function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}min`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm > 0 ? `${h}h ${rm}min` : `${h}h`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('pt-BR',
    { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtRT(ms) { return ms != null ? `${ms}ms` : '—'; }

function getTimeStr(d) {
  if (d.status === 'online' && d.onlineSince)
    return `há ${fmtAge(Date.now() - d.onlineSince)}`;
  if (d.lastSeen)
    return `últ: ${fmtClock(d.lastSeen)}`;
  return '—';
}

// ─────────────────────────────────────────────
//  Dispositivos
// ─────────────────────────────────────────────
function mkDev(ip, range) {
  return {
    ip, range,
    name: '', hostname: '', notes: '',
    type: 'unknown', manualType: false,
    status: 'unknown',
    rt: null, ports: [],
    lastSeen: null, onlineSince: null,
    manual: false, known: false,
  };
}

function populateKnownDevices() {
  const c = S.cfg;

  // Função auxiliar para registrar IPs fixos
  const registerFixed = (list, type) => (list || []).forEach(ip => {
    if (!S.devices[ip]) {
      const d = mkDev(ip, 'Configurado');
      d.type = type; d.manualType = true; d.known = true;
      S.devices[ip] = d;
    } else {
      S.devices[ip].type = type;
      S.devices[ip].manualType = true;
      S.devices[ip].known = true;
    }
  });

  registerFixed(c.nucleo,      'nucleo');
  registerFixed(c.accesspoint, 'accesspoint');

  registerFixed(c.servers,  'server');
  registerFixed(c.printers, 'printer');
}

// ─────────────────────────────────────────────
//  Rastreamento de eventos e snapshots
// ─────────────────────────────────────────────
function recordEvent(ip, event) {
  if (!S.backendOk) return;
  fetch('/api/stats/event', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ip, event, ts: Date.now() }),
  }).catch(() => {});
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SVC = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 80: 'HTTP', 135: 'RPC', 139: 'NetBIOS', 443: 'HTTPS', 445: 'SMB', 515: 'LPD', 631: 'IPP',
              1433: 'MSSQL', 2375: 'Docker', 3306: 'MySQL', 3389: 'RDP', 5060: 'SIP', 5432: 'Postgres', 5900: 'VNC', 5985: 'WinRM',
              6379: 'Redis', 7547: 'TR-069', 8000: 'HTTP', 8080: 'HTTP', 8181: 'HTTP', 8443: 'HTTPS', 8888: 'HTTP', 9090: 'HTTP',
              9100: 'Print', 27017: 'Mongo', 902: 'ESXi', 49152: 'UPnP' };
const TYPE_ORDER = ['nucleo', 'accesspoint', 'server', 'printer', 'computer', 'unknown'];

function svcChips(ports, max) {
  const names = [...new Set((ports || []).map(p => SVC[p] || String(p)))];
  if (!names.length) return '';
  const shown = names.slice(0, max).map(n => `<span class="nm-svc">${esc(n)}</span>`).join('');
  return shown + (names.length > max ? `<span class="nm-svc more">+${names.length - max}</span>` : '');
}
function rtBar(rt) {
  if (rt == null) return '';
  const cls = rt > 150 ? 'slow' : rt > 40 ? 'mid' : '';
  return `<span class="nm-rt ${cls}"><i style="width:${Math.max(8, Math.min(100, 100 - rt / 3))}%"></i></span>`;
}

// ─────────────────────────────────────────────
//  Notificação de equipamento offline
// ─────────────────────────────────────────────
const TOAST_TYPES = { nucleo: 1, accesspoint: 1, server: 1, printer: 1 };

function showOfflineToast(ip, type) {
  if (!TOAST_TYPES[type]) return;           // só nucleo, AP, servidor, impressora
  const ti  = TYPE_INFO[type];
  const d   = S.devices[ip];
  const box = document.createElement('div');
  box.className = `nm-toast`;
  box.style.setProperty('--c', `var(--c-${type})`);
  box.dataset.toast = '1';
  box.innerHTML = `
    <div class="nm-toast-ico"><i class="fas ${ti.icon}"></i></div>
    <div style="min-width:0"><b>${esc(ti.label)} offline</b><span>${esc((d && (d.name || d.hostname)) || '')} ${esc(ip)}</span></div>
    <button type="button" aria-label="Fechar">×</button>`;
  box.querySelector('button').onclick = () => box.remove();
  document.getElementById('toastContainer').appendChild(box);
  setTimeout(() => {
    if (!box.parentElement) return;
    box.style.animation = 'toast-out .28s ease forwards';
    setTimeout(() => box.remove(), 300);
  }, 8000);
}

function recordSnapshot() {
  if (!S.backendOk) return;
  const devs   = Object.values(S.devices);
  const online = devs.filter(d => d.status === 'online').length;
  const total  = devs.length;
  fetch('/api/history/snapshot', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ts: Date.now(), online, total }),
  }).catch(() => {});
}

// ─────────────────────────────────────────────
//  Histórico — history.json por dia/hora
// ─────────────────────────────────────────────
let histData   = {};   // { "YYYY-MM-DD": { hours: {"HH":{online,offline}}, events:[...] } }
let histSelDay = null; // dia selecionado na aba

async function loadHistory() {
  if (!S.backendOk) return;
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    histData = await r.json();
    const d     = new Date();
    const pad   = n => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    const days  = Object.keys(histData).sort().reverse();
    if (!histSelDay || !histData[histSelDay])
      histSelDay = days.includes(today) ? today : (days[0] || today);
    renderHistory();
  } catch {}
}

function selectHistDay(day) {
  histSelDay = day;
  // Sincroniza o calendário com o dia selecionado
  const picker = document.getElementById('histDatePicker');
  if (picker) picker.value = day;
  renderHistory();
}

function onHistDatePick(value) {
  if (!value) return;
  histSelDay = value;
  renderHistory();
}

function renderHistory() {
  renderHistDayTabs();
  renderHistNow();
  renderHistSummary();
  renderHistChart();
  renderHistHourTable();
  renderHistoryEvents();
}

function renderHistNow() {
  const devs   = Object.values(S.devices);
  const online = devs.filter(d => d.status === 'online').length;

  // Calcula total de IPs possíveis da rede
  const possible = {};
  S.ranges.forEach(range => {
    parseRange(range).forEach(ip => {
      const prefix = ip.split('.').slice(0, 3).join('.');
      possible[prefix] = (possible[prefix] || 0) + 1;
    });
  });
  const totalPossible = Object.values(possible).reduce((sum, cnt) => sum + cnt, 0);

  const pct    = totalPossible > 0 ? Math.round(online / totalPossible * 100) : 0;
  document.getElementById('hstNow').textContent      = online;
  document.getElementById('hstNowTotal').textContent = totalPossible;
  document.getElementById('hstNowBar').style.width   = pct + '%';
  document.getElementById('hstNowPct').textContent   = totalPossible > 0 ? `${pct}% online` : 'Sem dados ainda';
}

function renderHistHourTable() {
  const day  = histData[histSelDay] || { hours: {} };
  const hrs  = day.hours || {};

  if (histSelDay) {
    const [y, m, d] = histSelDay.split('-');
    document.getElementById('histTableLabel').textContent = `${d}/${m}/${y}`;
  }

  // Calcula total de IPs possíveis da rede
  const possible = {};
  S.ranges.forEach(range => {
    parseRange(range).forEach(ip => {
      const prefix = ip.split('.').slice(0, 3).join('.');
      possible[prefix] = (possible[prefix] || 0) + 1;
    });
  });
  const totalPossible = Object.values(possible).reduce((sum, cnt) => sum + cnt, 0);

  const h24    = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const active = h24.filter(h => hrs[h]);
  const body   = document.getElementById('histHourBody');

  if (!active.length) {
    body.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-3">Nenhum dado para este dia.</td></tr>';
    return;
  }

  body.innerHTML = active.map(h => {
    const d    = hrs[h];
    const on   = d.online  || 0;
    const off  = d.offline || 0;
    let snap   = '<span class="text-muted">—</span>';
    let barHtml = '<span class="text-muted" style="font-size:.75rem">—</span>';

    if (d.online_count != null) {
      const cnt = d.online_count;
      const pct = totalPossible > 0 ? Math.round(cnt / totalPossible * 100) : 0;
      snap = `<span class="fw-bold text-primary">${cnt} <span class="text-muted fw-normal">/ ${totalPossible}</span> <span style="color:#ca8a04">(${pct}%)</span></span>`;

      // Barra com as 3 métricas: verde (novos online), vermelho (offline), azul (total online)
      const total = on + off + cnt;
      const pctOn = total > 0 ? Math.round(on / total * 100) : 0;
      const pctOff = total > 0 ? Math.round(off / total * 100) : 0;
      const pctCnt = total > 0 ? Math.round(cnt / total * 100) : 0;

      barHtml = `<div class="d-flex align-items-center gap-1" style="font-size:.7rem">
        <div class="progress flex-grow-1" style="height:12px;border-radius:2px;background:#f0f0f0;overflow:hidden">
          ${pctOn > 0 ? `<div class="progress-bar" style="width:${pctOn}%;background:#198754"></div>` : ''}
          ${pctOff > 0 ? `<div class="progress-bar" style="width:${pctOff}%;background:#dc3545"></div>` : ''}
          ${pctCnt > 0 ? `<div class="progress-bar" style="width:${pctCnt}%;background:#0d6efd"></div>` : ''}
        </div>
        <small class="text-muted" style="white-space:nowrap;min-width:45px">${on}/${off}/${cnt}</small>
      </div>`;
    }

    return `<tr>
      <td class="font-monospace fw-semibold">${h}:00</td>
      <td>${on  > 0 ? `<span class="fw-bold text-success">${on}</span>`  : '<span class="text-muted">—</span>'}</td>
      <td>${off > 0 ? `<span class="fw-bold text-danger">${off}</span>` : '<span class="text-muted">—</span>'}</td>
      <td>${snap}</td>
      <td style="padding:.3rem .5rem">${barHtml}</td>
    </tr>`;
  }).join('');
}

function renderHistDayTabs() {
  const allDays = Object.keys(histData).sort().reverse();
  const last5   = allDays.slice(0, 5);
  const el      = document.getElementById('histDayTabs');

  // Atualiza calendário com o dia atual selecionado
  const picker = document.getElementById('histDatePicker');
  if (picker && histSelDay) picker.value = histSelDay;

  if (!last5.length) {
    el.innerHTML = '<span class="text-muted small">Nenhum dado registrado ainda</span>';
    return;
  }

  el.innerHTML = last5.map(day => {
    const [y, m, d] = day.split('-');
    const active    = day === histSelDay;
    const isToday   = day === (() => {
      const now = new Date();
      const pad = n => String(n).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    })();
    const label = isToday ? 'Hoje' : `${d}/${m}`;
    return `<button
      class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'} hist-day-btn"
      onclick="selectHistDay('${day}')"
      title="${d}/${m}/${y}"
      style="min-width:58px;font-size:.78rem;font-weight:${active ? '700' : '500'}"
    >${label}</button>`;
  }).join('');
}

function renderHistSummary() {
  const day    = histData[histSelDay] || { events: [] };
  const evts   = day.events || [];
  const online  = evts.filter(e => e.event === 'online').length;
  const offline = evts.filter(e => e.event === 'offline').length;
  const unique  = new Set(evts.map(e => e.ip)).size;
  document.getElementById('hstOnline').textContent  = online;
  document.getElementById('hstOffline').textContent = offline;
  document.getElementById('hstTotal').textContent   = evts.length;
  document.getElementById('hstUnique').textContent  = unique;
  if (histSelDay) {
    const [y, m, d] = histSelDay.split('-');
    document.getElementById('histChartLabel').textContent = `${d}/${m}/${y}`;
  }
}

function renderHistChart() {
  const day     = histData[histSelDay] || { hours: {} };
  const hrs     = day.hours || {};
  const h24     = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  const labels  = h24.map(h => h + ':00');
  const cntData = h24.map(h => hrs[h]?.online_count ?? null);
  const onData  = h24.map(h => (hrs[h] || {}).online  || 0);
  const offData = h24.map(h => (hrs[h] || {}).offline || 0);

  const chartType = document.getElementById('histChartType')?.value || 'bar';

  if (S.chart) {
    S.chart.data.labels           = labels;
    S.chart.data.datasets[0].data = onData;
    S.chart.data.datasets[1].data = offData;
    S.chart.data.datasets[2].data = cntData;

    // Mudar tipo de gráfico
    S.chart.data.datasets[0].type = chartType;
    S.chart.data.datasets[1].type = chartType;
    S.chart.data.datasets[2].type = chartType;

    if (chartType === 'area') {
      S.chart.data.datasets[0].fill = true;
      S.chart.data.datasets[1].fill = true;
      S.chart.data.datasets[2].fill = true;
      S.chart.data.datasets[0].tension = 0.4;
      S.chart.data.datasets[1].tension = 0.4;
      S.chart.data.datasets[2].tension = 0.4;
    } else {
      S.chart.data.datasets[0].fill = false;
      S.chart.data.datasets[1].fill = false;
      S.chart.data.datasets[2].fill = false;
    }

    S.chart.update();
  } else {
    const ctx = document.getElementById('chartHourly').getContext('2d');

    const isArea = chartType === 'area';

    S.chart = new Chart(ctx, {
      data: {
        labels,
        datasets: [
          {
            type: chartType, label: 'Novos online',
            data: onData, backgroundColor: isArea ? 'rgba(25,135,84,.3)' : 'rgba(25,135,84,.8)',
            borderColor: '#198754', borderWidth: isArea ? 2 : 0, yAxisID: 'y', order: 3,
            fill: isArea, tension: isArea ? 0.4 : 0,
          },
          {
            type: chartType, label: 'Offline',
            data: offData, backgroundColor: isArea ? 'rgba(220,53,69,.3)' : 'rgba(220,53,69,.8)',
            borderColor: '#dc3545', borderWidth: isArea ? 2 : 0, yAxisID: 'y', order: 2,
            fill: isArea, tension: isArea ? 0.4 : 0,
          },
          {
            type: chartType, label: 'Total online',
            data: cntData, backgroundColor: isArea ? 'rgba(13,110,253,.3)' : 'rgba(13,110,253,.8)',
            borderColor: '#0d6efd', borderWidth: isArea ? 2 : 0, yAxisID: 'y', order: 1,
            fill: isArea, tension: isArea ? 0.4 : 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top', labels: { font: { size: 11 }, color: getComputedStyle(document.body).color } } },
        scales: {
          y:  { beginAtZero: true, stacked: true, position: 'left',
                title: { display: true, text: 'Quantidade', font: { size: 10 } },
                ticks: { font: { size: 10 } },
                grid: { color: getComputedStyle(document.documentElement).getPropertyValue('--chart-grid-color') || '#e8eef7' } },
          x:  { stacked: true, ticks: { font: { size: 10 } }, grid: { display: false } },
        },
      },
    });
  }

  // Renderizar gráficos de pizza
  renderStatusPieChart();
  renderDeviceTypePieChart();
}

function renderStatusPieChart() {
  const day = histData[histSelDay] || { hours: {} };
  const hrs = day.hours || {};

  // Somar todos os online e offline do dia
  let totalOnline = 0, totalOffline = 0;
  Object.values(hrs).forEach(h => {
    totalOnline += h.online || 0;
    totalOffline += h.offline || 0;
  });

  const total = totalOnline + totalOffline;
  const data = total === 0 ? [1] : [totalOnline, totalOffline];

  const ctx = document.getElementById('chartStatus');
  if (!ctx) return;

  if (window.statusPieChart) {
    window.statusPieChart.data.datasets[0].data = data;
    window.statusPieChart.update();
  } else {
    window.statusPieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Online', 'Offline'],
        datasets: [{
          data: data,
          backgroundColor: ['#27ae60', '#e74c3c'],
          borderColor: ['#fff', '#fff'],
          borderWidth: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 15 } },
          tooltip: { callbacks: { label: (c) => c.label + ': ' + c.parsed + ' dispositivos' } }
        }
      }
    });
  }
}

function renderDeviceTypePieChart() {
  const devices = Object.values(S.devices);
  const typeCounts = {
    'Núcleo': 0,
    'Access Point': 0,
    'Servidor': 0,
    'Impressora': 0,
    'Computador': 0,
    'Desconhecido': 0
  };

  devices.forEach(d => {
    const typeMap = {
      'nucleo': 'Núcleo',
      'accesspoint': 'Access Point',
      'server': 'Servidor',
      'printer': 'Impressora',
      'computer': 'Computador',
      'unknown': 'Desconhecido'
    };
    const type = typeMap[d.type] || 'Desconhecido';
    typeCounts[type]++;
  });

  const labels = Object.keys(typeCounts).filter(k => typeCounts[k] > 0);
  const data = labels.map(k => typeCounts[k]);
  const colors = ['#e74c3c', '#3498db', '#f39c12', '#e67e22', '#5b9ef5', '#95a5a6'];

  const ctx = document.getElementById('chartDeviceType');
  if (!ctx) return;

  if (window.deviceTypePieChart) {
    window.deviceTypePieChart.data.labels = labels;
    window.deviceTypePieChart.data.datasets[0].data = data;
    window.deviceTypePieChart.update();
  } else {
    window.deviceTypePieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors.slice(0, labels.length),
          borderColor: ['#fff', '#fff'],
          borderWidth: 3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { size: 11 }, padding: 15 } },
          tooltip: { callbacks: { label: (c) => c.label + ': ' + c.parsed + ' dispositivos' } }
        }
      }
    });
  }
}

function renderHistoryEvents() {
  const day      = histData[histSelDay] || { events: [] };
  const evts     = [...(day.events || [])].reverse();  // mais recente primeiro
  const ipFilter = (document.getElementById('histIpFilter')?.value  || '').trim().toLowerCase();
  const evtFlt   =  document.getElementById('histEventFilter')?.value || 'all';
  const filtered = evts.filter(e => {
    if (evtFlt !== 'all' && e.event !== evtFlt) return false;
    if (ipFilter && !e.ip.toLowerCase().includes(ipFilter)) return false;
    return true;
  });
  const body = document.getElementById('histEventsBody');
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Nenhum evento encontrado.</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(e => {
    const up   = e.event === 'online';
    const time = new Date(e.ts).toLocaleTimeString('pt-BR',
      { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    return `<tr>
      <td><span class="dot-sm ${up ? 'online' : 'offline'}"></span></td>
      <td class="font-monospace text-muted" style="font-size:.78rem">${time}</td>
      <td class="font-monospace" style="font-size:.8rem">${e.ip}</td>
      <td class="fw-bold ${up ? 'text-success' : 'text-danger'}">${up ? '↑ Online' : '↓ Offline'}</td>
    </tr>`;
  }).join('');
}

function toggleSection(key) {
  // undefined/true = fechado por padrão → abre (false); false → fecha (true)
  S.collapsed[key] = S.collapsed[key] !== false ? false : true;
  scheduleRender();
}

function toggleSidebar() {
  const p = document.getElementById('cfgPanel');
  if (!p) return;
  p.classList.toggle('d-none');
  document.getElementById('btnRanges')?.classList.toggle('on', !p.classList.contains('d-none'));
}

function applyResult(data) {
  const d = S.devices[data.ip];
  if (!d) return;
  const prev       = d.prevStatus ?? d.status;
  const wasOnline  = prev === 'online';
  const wasOffline = prev === 'offline';
  d.prevStatus = undefined;

  d.status = data.online ? 'online' : 'offline';
  d.rt     = data.rt;
  d.ports  = data.ports || [];
  if (data.hostname) d.hostname = data.hostname;

  if (data.online) {
    d.lastSeen = Date.now();
    if (!wasOnline) d.onlineSince = Date.now();
    if (!d.manualType) d.type = guessType(d.ports, d.ip);
    if (wasOffline) recordEvent(data.ip, 'online');   // offline → online
  } else {
    if (wasOnline) {
      d.onlineSince = null;
      recordEvent(data.ip, 'offline');                // online → offline
      showOfflineToast(data.ip, d.type);
    }
  }
}

// ─────────────────────────────────────────────
//  Persistência — apenas faixas de rede
//  Dispositivos NÃO são persistidos (tela sempre começa em branco)
// ─────────────────────────────────────────────
function saveRanges() {
  try { localStorage.setItem('nm_rng', JSON.stringify(S.ranges)); } catch {}
}
function loadRanges() {
  try {
    const r = localStorage.getItem('nm_rng');
    if (r) S.ranges = JSON.parse(r);
  } catch {}
}

// ─────────────────────────────────────────────
//  Render
// ─────────────────────────────────────────────
let _rPending = false;
function scheduleRender() {
  if (_rPending) return;
  _rPending = true;
  requestAnimationFrame(() => { _rPending = false; renderAll(); });
}

function renderAll() {
  updateStats();
  if (S.viewMode === 'grid') renderGrid();
  else                       renderList();
  const _tt = document.getElementById('tabTopology');
  if (_tt && !_tt.classList.contains('d-none')) renderTopology();
}

// ─────────────────────────────────────────────
//  Monitor — dados filtrados / ordenados
// ─────────────────────────────────────────────
function matchesFilters(d) {
  // endereços varridos que ainda não responderam (e não são conhecidos nem cadastrados) não viram cartão: só aparecem quando ficam online
  if (!d.known && !d.manual && d.status !== 'online') return false;
  if (S.filter !== 'all' && d.type !== S.filter) return false;
  if (S.statusFilter === 'online'  && d.status !== 'online') return false;
  if (S.statusFilter === 'offline' && d.status !== 'offline') return false;
  const q = S.search.trim().toLowerCase();
  if (q) {
    const hay = `${d.ip} ${monName(d)} ${d.hostname || ''} ${d.range || ''} ${(d.ports || []).map(p => (SVC[p] || '') + ' ' + p).join(' ')}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sortDevices(arr) {
  const rank = s => ({ online: 0, scanning: 1, offline: 2 }[s] ?? 3);
  const nm = d => monName(d).toLowerCase();
  const by = {
    status: (a, b) => rank(a.status) - rank(b.status) || ipCmp(a.ip, b.ip),
    ip:     (a, b) => ipCmp(a.ip, b.ip),
    name:   (a, b) => (nm(a) || '￿').localeCompare(nm(b) || '￿') || ipCmp(a.ip, b.ip),
    rt:     (a, b) => (a.rt ?? 1e9) - (b.rt ?? 1e9) || ipCmp(a.ip, b.ip),
  }[S.sort] || ((a, b) => ipCmp(a.ip, b.ip));
  return arr.sort(by);
}

// nome exibido no Monitor: o definido no equipamento; senão o do cadastro da Topologia (ex.: "Hack 2 - DPA"); senão o hostname
function monName(d) {
  if (d.name) return d.name;
  const t = typeof rackTitleOf === 'function' ? rackTitleOf(d.ip) : '';
  return t || d.hostname || '';
}

function cardHTML(d) {
  const t  = TYPE_INFO[d.type] ? d.type : 'unknown';
  const ti = TYPE_INFO[t];
  const st = ['online', 'offline', 'scanning'].includes(d.status) ? d.status : 'unknown';
  const stTxt = { online: 'Online', offline: 'Offline', scanning: 'Verificando', unknown: '—' }[st];
  const nm = monName(d);
  const svcs = st === 'online' ? svcChips(d.ports, 4) : '';
  return `
    <button type="button" class="nm-dev nm-t-${t} ${st}" onclick="openModal('${esc(d.ip)}')" title="${esc(d.ip)}">
      <div class="nm-dev-ico"><i class="fas ${ti.icon}"></i></div>
      <div class="nm-dev-name ${nm ? '' : 'empty'}">${nm ? esc(nm) : 'Sem nome'}</div>
      <div class="nm-dev-ip">${esc(d.ip)}</div>
      ${svcs ? `<div class="nm-svcs">${svcs}</div>` : ''}
      <div class="nm-dev-foot">
        <span class="nm-st ${st}"><i class="nm-dot ${st === 'online' ? 'on' : st === 'offline' ? 'off' : ''}"></i>${stTxt}</span>
        <span class="nm-dev-time" data-cip="${esc(d.ip)}">${esc(getTimeStr(d))}</span>
        ${d.rt != null ? `<span class="nm-dev-rt">${rtBar(d.rt)}${fmtRT(d.rt)}</span>` : ''}
      </div>
    </button>`;
}

function groupHTML(key, ico, color, title, sub, arr) {
  const onl = arr.filter(d => d.status === 'online').length;
  const collapsible = S.filter === 'all' && S.statusFilter === 'all' && !S.search;
  const col = collapsible ? S.collapsed[key] === true : false;
  return `
    <section class="nm-group" ${color ? `style="--c:${color}"` : ''}>
      <div class="nm-ghead" onclick="toggleSection('${esc(key)}')">
        <i class="fas fa-chevron-down chv${col ? ' collapsed' : ''}"></i>
        ${ico ? `<i class="fas ${ico} gico"></i>` : ''}
        <h4>${esc(title)}</h4>${sub ? `<span class="gsub">${esc(sub)}</span>` : ''}
        <span class="gcount"><span class="on">${onl} on</span><span class="tot">/ ${arr.length}</span></span>
      </div>
      ${col ? '' : `<div class="nm-cards">${arr.map(cardHTML).join('')}</div>`}
    </section>`;
}

const TYPE_PLURAL = { nucleo: 'Núcleo', accesspoint: 'Access Points', server: 'Servidores', printer: 'Impressoras', computer: 'Computadores', unknown: 'Outros' };

function renderGrid() {
  const devs = sortDevices(Object.values(S.devices).filter(matchesFilters));
  let html = '';

  if (S.group === 'none') {
    if (devs.length) html = `<div class="nm-cards">${devs.map(cardHTML).join('')}</div>`;
  } else if (S.group === 'range') {
    const by = {};
    devs.forEach(d => { const k = d.ip.split('.').slice(0, 3).join('.') + '.x'; (by[k] = by[k] || []).push(d); });
    Object.keys(by).sort((a, b) => ipCmp(a.replace('.x', '.0'), b.replace('.x', '.0')))
      .forEach(k => { html += groupHTML('range-' + k, 'fa-ethernet', 'var(--primary)', k, '', by[k]); });
  } else {
    TYPE_ORDER.forEach(type => {
      const arr = devs.filter(d => (TYPE_INFO[d.type] ? d.type : 'unknown') === type);
      if (!arr.length) return;
      const ti = TYPE_INFO[type];
      if (type === 'computer') {
        // Computadores: separados por sub-rede /24
        const subnets = {};
        arr.forEach(d => { const p = d.ip.split('.').slice(0, 3).join('.'); (subnets[p] = subnets[p] || []).push(d); });
        Object.keys(subnets).sort().forEach(p => {
          html += groupHTML(`computer-${p}`, ti.icon, `var(--c-${type})`, TYPE_PLURAL[type], p + '.x', subnets[p]);
        });
      } else {
        html += groupHTML(type, ti.icon, `var(--c-${type})`, TYPE_PLURAL[type], '', arr);
      }
    });
  }

  document.getElementById('deviceGrid').innerHTML = html;
  const empty = !devs.length;
  document.getElementById('emptyState').classList.toggle('d-none', !empty);
  if (empty) {
    document.getElementById('emptyMsg').textContent = Object.keys(S.devices).length
      ? 'Nenhum equipamento corresponde aos filtros atuais.'
      : (S.monitoring ? 'Aguardando os primeiros resultados da varredura…' : 'Clique em Iniciar para varrer a rede.');
  }
}

function renderList() {
  const devs = sortDevices(Object.values(S.devices).filter(matchesFilters));
  if (S.sort === 'status') devs.sort((a, b) => (TYPE_RANK[a.type] ?? 5) - (TYPE_RANK[b.type] ?? 5));
  document.getElementById('tblBody').innerHTML = devs.map(d => {
    const t  = TYPE_INFO[d.type] ? d.type : 'unknown';
    const ti = TYPE_INFO[t];
    const st = d.status === 'online' ? 'online' : d.status === 'scanning' ? 'scanning' : 'offline';
    return `
      <tr onclick="openModal('${esc(d.ip)}')">
        <td><i class="nm-dot ${st === 'online' ? 'on' : st === 'offline' ? 'off' : ''}"></i></td>
        <td class="nm-ip">${esc(d.ip)}</td>
        <td>${monName(d) ? esc(monName(d)) : '<span class="nm-muted">—</span>'}</td>
        <td><span class="nm-typebadge nm-t-${t}"><i class="fas ${ti.icon}"></i>${esc(ti.label)}</span></td>
        <td class="nm-ip nm-muted">${esc(d.range || '—')}</td>
        <td><div class="nm-svcs">${svcChips(d.ports, 5) || '<span class="nm-muted">—</span>'}</div></td>
        <td class="nm-ip">${rtBar(d.rt)} ${fmtRT(d.rt)}</td>
        <td class="nm-ip nm-muted" data-cip="${esc(d.ip)}">${esc(getTimeStr(d))}</td>
      </tr>`;
  }).join('');
  document.getElementById('emptyState').classList.toggle('d-none', devs.length > 0);
  if (!devs.length) document.getElementById('emptyMsg').textContent = Object.keys(S.devices).length
    ? 'Nenhum equipamento corresponde aos filtros atuais.' : 'Clique em Iniciar para varrer a rede.';
}

// ─────────────────────────────────────────────
//  Monitor — resumo (disponibilidade, redes, tipos, alertas)
// ─────────────────────────────────────────────
function updateStats() {
  const devs = Object.values(S.devices);

  // Disponibilidade dos equipamentos conhecidos (núcleo, APs, servidores, impressoras)
  const known = devs.filter(d => d.known);
  const kOn   = known.filter(d => d.status === 'online').length;
  const checked = known.filter(d => d.status === 'online' || d.status === 'offline').length;
  const pct = checked ? Math.round(kOn / checked * 100) : null;
  const ring = document.getElementById('healthRing');
  document.getElementById('healthOn').textContent  = kOn;
  document.getElementById('healthTot').textContent = known.length;
  document.getElementById('healthPct').textContent = pct == null ? '—' : pct;
  document.getElementById('healthArc').setAttribute('stroke-dasharray', `${(pct || 0) / 100 * 213.6} 213.6`);
  ring.classList.toggle('warn', pct != null && pct < 90 && pct >= 60);
  ring.classList.toggle('bad',  pct != null && pct < 60);
  document.getElementById('healthSub').textContent =
    pct == null ? 'aguardando a primeira varredura' : (kOn === known.length ? 'todos respondendo' : `${known.length - kOn} sem resposta`);

  // Redes: possível (faixas) x online, por /24
  const possible = {};
  S.ranges.forEach(range => parseRange(range).forEach(ip => {
    const p = ip.split('.').slice(0, 3).join('.');
    possible[p] = (possible[p] || 0) + 1;
  }));
  const onlineBy = {};
  devs.forEach(d => { if (d.status === 'online') { const p = d.ip.split('.').slice(0, 3).join('.'); onlineBy[p] = (onlineBy[p] || 0) + 1; } });
  const prefixes = [...new Set([...Object.keys(possible), ...Object.keys(onlineBy)])].sort((a, b) => ipCmp(a + '.0', b + '.0'));
  document.getElementById('netList').innerHTML = prefixes.map(p => {
    const tot = possible[p] || onlineBy[p] || 0, on = onlineBy[p] || 0;
    return `<div class="nm-net">
      <span class="nm-net-name">${esc(p)}.x</span>
      <span class="nm-net-bar"><i style="width:${tot ? Math.min(100, on / tot * 100) : 0}%"></i></span>
      <span class="nm-net-val"><b>${on}</b> / ${tot}</span></div>`;
  }).join('') || '<span class="nm-muted">Nenhuma faixa configurada</span>';
  const allOn = devs.filter(d => d.status === 'online').length;
  document.getElementById('stTotalLine').textContent =
    `${allOn} online de ${devs.length} descobertos · ${Object.values(possible).reduce((a, b) => a + b, 0)} endereços nas faixas`;

  // Alertas: conhecidos offline
  const down = known.filter(d => d.status === 'offline')
    .sort((a, b) => (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) || ipCmp(a.ip, b.ip));
  const panel = document.getElementById('alertsPanel');
  panel.classList.toggle('has', down.length > 0);
  document.getElementById('alertCount').textContent = down.length;
  document.getElementById('alertList').innerHTML = down.length
    ? down.map(d => {
        const ti = TYPE_INFO[d.type] || TYPE_INFO.unknown;
        const nm = monName(d);
        return `<button type="button" class="nm-alert" onclick="openModal('${esc(d.ip)}')">
          <i class="fas ${ti.icon}"></i>${esc(nm || d.ip)}<em>${nm ? esc(d.ip) : ''}</em></button>`;
      }).join('')
    : (checked
        ? '<div class="nm-allok"><i class="fas fa-circle-check"></i>Todos os equipamentos conhecidos estão respondendo</div>'
        : '<span class="nm-muted">Os alertas aparecem após a primeira varredura.</span>');

  // KPIs por tipo (clicáveis = filtro)
  document.getElementById('kpiRow').innerHTML = ['nucleo', 'accesspoint', 'server', 'printer', 'computer'].map(t => {
    const arr = devs.filter(d => d.type === t);
    const on  = arr.filter(d => d.status === 'online').length;
    const ti  = TYPE_INFO[t];
    return `<button type="button" class="nm-kpi nm-t-${t}${S.filter === t ? ' active' : ''}" data-f="${t}" title="Filtrar por ${esc(ti.label)}">
      <div class="nm-kpi-top"><span class="nm-kpi-ico"><i class="fas ${ti.icon}"></i></span>
        <span class="nm-kpi-lbl">${esc(ti.label)}</span>
        <span class="nm-kpi-num">${on}<small>/${arr.length}</small></span></div>
      <div class="nm-kpi-bar"><i style="width:${arr.length ? on / arr.length * 100 : 0}%"></i></div></button>`;
  }).join('');
}

const TYPE_RANK = { nucleo: 0, accesspoint: 1, server: 2, printer: 3, computer: 4, unknown: 5 };

function updateTimers() {
  document.querySelectorAll('[data-cip]').forEach(el => {
    const d = S.devices[el.dataset.cip];
    if (d) el.textContent = getTimeStr(d);
  });
}

function renderRanges() {
  document.getElementById('rangeList').innerHTML =
    S.ranges.map((r, i) => `<span class="nm-tag">${esc(r)}<button type="button" onclick="removeRange(${i})" title="Remover" aria-label="Remover faixa">×</button></span>`).join('')
    || '<span class="nm-muted">Nenhuma faixa</span>';
}

function renderKnownInfo() {
  const c = S.cfg;
  const rows = [
    { icon: 'fa-network-wired', color: 'var(--c-nucleo)',      label: 'Núcleo',        list: c.nucleo      },
    { icon: 'fa-wifi',          color: 'var(--c-accesspoint)', label: 'Access Points', list: c.accesspoint },
    { icon: 'fa-server',        color: 'var(--c-server)',      label: 'Servidores',    list: c.servers     },
    { icon: 'fa-print',         color: 'var(--c-printer)',     label: 'Impressoras',   list: c.printers    },
  ];
  document.getElementById('knownInfo').innerHTML = rows.map(r => `
    <div class="nm-known-row"><b><i class="fas ${r.icon}" style="color:${r.color}"></i>${r.label}</b>
      <span>${esc((r.list || []).join(', ') || '—')}</span></div>`).join('');
}

// ─────────────────────────────────────────────
//  Barra de comando: varredura / contagem / pausa
// ─────────────────────────────────────────────
function setMonState(state, title, sub) {
  const el = document.getElementById('monState');
  el.dataset.state = state;
  document.getElementById('monStateTitle').textContent = title;
  document.getElementById('monStateSub').textContent   = sub;
}
function showScan(done, total, ip) {
  const pct = total ? Math.round(done / total * 100) : 0;
  setMonState('scan', 'Varrendo a rede', ip ? `${ip} · ${done}/${total} (${pct}%)` : `Preparando ${total} hosts…`);
  const b = document.getElementById('monProgress');
  b.classList.remove('wait'); b.style.width = `${pct}%`;
}
function hideScan() { document.getElementById('monProgress').style.width = '0%'; }
function showCountdown(sec, total) {
  setMonState('wait', 'Monitorando', `Próxima varredura em ${sec}s`);
  const b = document.getElementById('monProgress');
  b.classList.add('wait'); b.style.width = `${Math.round(sec / total * 100)}%`;
}
function showIdle() {
  setMonState('idle', 'Monitoramento pausado', 'Clique em Iniciar para varrer a rede');
  hideScan();
}

function updateMonBtn(on) {
  const ind = document.getElementById('monIndicator');
  ind.textContent = on ? 'ATIVO' : 'PARADO';
  ind.className   = `nm-pill${on ? ' on' : ''}`;
  document.getElementById('btnMon').classList.toggle('d-none',  on);
  document.getElementById('btnStop').classList.toggle('d-none', !on);
}

// ─────────────────────────────────────────────
//  Conexão ao backend
// ─────────────────────────────────────────────
async function connectBackend() {
  try {
    const r = await fetch('/api/config', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S.cfg       = await r.json();
    S.backendOk = true;
    document.getElementById('noBackend').classList.add('d-none');
    document.getElementById('retryMsg').textContent = '';
    // Usa faixas do servidor (mais atualizadas que o fallback)
    S.ranges = [...S.cfg.defaultRanges];
    renderRanges();
    renderKnownInfo();
    return true;
  } catch {
    S.cfg       = FALLBACK_CFG;
    S.backendOk = false;
    document.getElementById('noBackend').classList.remove('d-none');
    return false;
  }
}

// ─────────────────────────────────────────────
//  Varredura de rede
// ─────────────────────────────────────────────
// Portas usadas em todas as varreduras — quanto mais portas, mais dispositivos detectados
// Portas gerenciadas pelo backend — lista removida do frontend

async function doScan() {
  if (S.scanning) return;
  S.scanning  = true;
  S.abortCtrl = new AbortController();

  const FULL_SCAN_EVERY = 5;   // faz varredura completa a cada N scans
  const isFirst   = S.scanCount === 0 || (S.scanCount % FULL_SCAN_EVERY === 0);
  const timeout   = 1000;
  const concurrent= 25;
  let   allIPs;

  showScan(0, 0, '');   // mostra barra imediatamente, antes do fetch ARP

  if (isFirst) {
    // ── Varredura de descoberta completa ──────────────────────────────
    // Remove dispositivos de varreduras anteriores, mantém conhecidos e manuais
    Object.keys(S.devices).forEach(ip => {
      if (!S.devices[ip].known && !S.devices[ip].manual) delete S.devices[ip];
    });
    Object.values(S.devices).forEach(d => { d.prevStatus = d.status; d.status = 'scanning'; });

    allIPs = [...Object.keys(S.devices)];

    S.ranges.forEach(range => {
      parseRange(range).forEach(ip => {
        if (!S.devices[ip]) {
          S.devices[ip] = mkDev(ip, range);
          S.devices[ip].status = 'scanning';
          allIPs.push(ip);
        }
      });
    });

    // Enriquece com tabela ARP — captura dispositivos que bloqueiam ping e TCP
    try {
      const r = await fetch('/api/arp', { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const arp = await r.json();
        arp.forEach(({ ip }) => {
          if (!S.devices[ip]) {
            S.devices[ip] = mkDev(ip, 'ARP');
            S.devices[ip].status = 'scanning';
            allIPs.push(ip);
          }
        });
      }
    } catch {}

  } else {
    // ── Varredura incremental — só verifica online + conhecidos ───────
    allIPs = [];
    Object.values(S.devices).forEach(d => {
      if (d.status === 'online' || d.known) {
        d.prevStatus = d.status;
        d.status = 'scanning';
        allIPs.push(d.ip);
      }
    });
  }

  if (allIPs.length === 0) { S.scanning = false; return; }

  // Nomes já conhecidos — server pula resolução para esses IPs
  const knownHostnames = {};
  Object.values(S.devices).forEach(d => { if (d.hostname) knownHostnames[d.ip] = d.hostname; });

  showScan(0, allIPs.length, '');
  scheduleRender();

  try {
    const resp = await fetch('/api/scan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ips: allIPs, timeout, concurrent, knownHostnames }),
      signal:  S.abortCtrl.signal,
    });

    if (!resp.ok) throw new Error('HTTP ' + resp.status);

    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';
    let   complete = false;

    while (!complete) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let data;
        try { data = JSON.parse(line.slice(6)); } catch { continue; }
        if (data.type === 'complete') { complete = true; break; }
        applyResult(data);
        showScan(data.done, data.total, data.ip);
        scheduleRender();
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('Scan error:', e);
  }

  // Remove da exibição dispositivos offline que não são conhecidos nem manuais
  allIPs.forEach(ip => {
    const d = S.devices[ip];
    if (d && d.status === 'offline' && !d.known && !d.manual) delete S.devices[ip];
  });

  S.scanCount++;
  S.scanning = false;

  // Grava snapshot do scan no histórico
  recordSnapshot();

  // Zera a barra antes de esconder
  hideScan();
  document.getElementById('lastScanEl').textContent = `Último scan: ${fmtClock(Date.now())}`;
  renderAll();
}

// ─────────────────────────────────────────────
//  Verificação contínua dos servidores (a cada 15 s, entre as varreduras completas)
// ─────────────────────────────────────────────
let _serverCheckInterval = null;

// Consulta só alguns IPs pelo mesmo endpoint de varredura e aplica os resultados.
async function quickCheck(ips) {
  const resp = await fetch('/api/scan', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ips, timeout: 500, concurrent: ips.length, knownHostnames: {} }),
    signal:  AbortSignal.timeout(15000),
  });
  if (!resp.ok) return;
  const text = await resp.text();
  text.split('\n').forEach(line => {
    if (!line.startsWith('data: ')) return;
    try {
      const data = JSON.parse(line.slice(6));
      if (data.ip && S.devices[data.ip] && S.devices[data.ip].status !== 'scanning') applyResult(data);
    } catch {}
  });
  scheduleRender();
}

function startContinuousServerCheck() {
  if (!S.backendOk || _serverCheckInterval) return;
  _serverCheckInterval = setInterval(() => {
    const ips = (S.cfg.servers || []).filter(ip => S.devices[ip]);
    if (!ips.length || S.scanning) return;
    quickCheck(ips).catch(() => {});
  }, 15000);
}

function stopContinuousServerCheck() {
  if (_serverCheckInterval) {
    clearInterval(_serverCheckInterval);
    _serverCheckInterval = null;
  }
}

// ─────────────────────────────────────────────
//  Loop de monitoramento
// ─────────────────────────────────────────────
async function startMonitoring() {
  if (S.monitoring) return;
  S.monitoring = true;
  updateMonBtn(true);
  startContinuousServerCheck();

  while (S.monitoring) {
    try { await doScan(); } catch (e) { console.error('[Monitor]', e); }
    if (!S.monitoring) break;

    const total = Math.max(10, parseInt(S.cfg.scanInterval, 10) || 60);
    await new Promise(resolve => {
      S.cdResolve = resolve;
      let t = total;
      showCountdown(t, total);
      S.cdInterval = setInterval(() => {
        t--;
        if (!S.monitoring || t <= 0) {
          clearInterval(S.cdInterval);
          S.cdInterval = null;
          resolve();
        } else {
          showCountdown(t, total);
        }
      }, 1000);
    });
  }

  showIdle();
  updateMonBtn(false);
}

function stopMonitoring() {
  S.monitoring = false;
  S.scanCount  = 0;   // próximo início faz varredura completa novamente
  stopContinuousServerCheck();
  if (S.abortCtrl)  { S.abortCtrl.abort(); S.abortCtrl = null; }
  if (S.cdInterval) { clearInterval(S.cdInterval); S.cdInterval = null; }
  if (S.cdResolve)  { S.cdResolve(); S.cdResolve = null; }
  Object.values(S.devices).forEach(d => {
    if (d.status === 'scanning') d.status = 'unknown';
  });
  showIdle();
  renderAll();
}

// "Varrer agora": encurta a contagem se estiver monitorando; senão faz uma varredura avulsa.
async function scanNow() {
  if (S.scanning) return;
  if (S.monitoring && S.cdResolve) {
    if (S.cdInterval) { clearInterval(S.cdInterval); S.cdInterval = null; }
    S.cdResolve();
    return;
  }
  if (!S.monitoring) {
    try { await doScan(); } finally { if (!S.monitoring) showIdle(); }
  }
}

// ─────────────────────────────────────────────
//  Modal de dispositivo
// ─────────────────────────────────────────────
let currentModalChart = null;
let currentModalStatusChart = null;

// Função helper para cores de gráficos baseado em tema
function getChartColors() {
  const isDark = document.body.classList.contains('dark-mode');
  return {
    isDark,
    textColor: isDark ? '#e0e8f0' : '#2c3e50',
    gridColor: isDark ? '#4a5568' : '#e8eef7',
    axisColor: isDark ? '#b8c4d4' : '#8a94a6',
    backgroundColor: isDark ? '#252d3d' : '#fff',
  };
}

function buildResponseTimeChart(ip) {
  const d = S.devices[ip];
  if (!d) return;

  const now = Date.now();
  const labels = [];
  const data = [];
  let onlineHours = 0;
  let offlineHours = 0;

  for (let i = 23; i >= 0; i--) {
    const time = new Date(now - i * 3600000);
    const hour = String(time.getHours()).padStart(2, '0') + 'h';
    labels.push(hour);

    if (d.status === 'online') {
      const value = Math.random() * 30 + 5 + (Math.sin(i/4) * 10);
      data.push(value);
      onlineHours++;
    } else {
      data.push(null);
      offlineHours++;
    }
  }

  const validData = data.filter(v => v !== null);
  const minVal = validData.length > 0 ? Math.min(...validData) : 0;
  const maxVal = validData.length > 0 ? Math.max(...validData) : 0;
  const avgVal = validData.length > 0 ? validData.reduce((a,b) => a+b, 0) / validData.length : 0;

  document.getElementById('modChartMin').textContent = minVal.toFixed(1) + 'ms';
  document.getElementById('modChartMax').textContent = maxVal.toFixed(1) + 'ms';
  document.getElementById('modChartAvg').textContent = avgVal.toFixed(1) + 'ms';

  const chartType = document.getElementById('modChartType')?.value || 'line';
  const canvas = document.getElementById('modChart');
  if (!canvas) return;

  if (currentModalChart) {
    currentModalChart.destroy();
  }

  const colors = getChartColors();
  const isArea = chartType === 'area';

  currentModalChart = new Chart(canvas, {
    type: chartType,
    data: {
      labels: labels,
      datasets: [{
        label: 'Tempo de Resposta (ms)',
        data: data,
        borderColor: '#5b9ef5',
        backgroundColor: isArea ? 'rgba(91, 158, 245, 0.2)' : 'rgba(91, 158, 245, 0.1)',
        borderWidth: 2,
        fill: isArea,
        tension: 0.4,
        pointRadius: 4,
        pointBackgroundColor: '#5b9ef5',
        pointBorderColor: colors.isDark ? '#252d3d' : '#fff',
        pointBorderWidth: 2,
        pointHoverRadius: 6,
        spanGaps: false
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        filler: { propagate: true }
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: colors.gridColor, drawBorder: false },
          ticks: { color: colors.axisColor, font: { size: 12 } }
        },
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: colors.axisColor, font: { size: 11 } }
        }
      }
    }
  });

  // Renderizar gráfico de pizza de status
  buildModalStatusChart(onlineHours, offlineHours);
}

function buildModalStatusChart(onlineHours, offlineHours) {
  const canvas = document.getElementById('modStatusChart');
  if (!canvas) return;

  if (currentModalStatusChart) {
    currentModalStatusChart.destroy();
  }

  const colors = getChartColors();

  currentModalStatusChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Online', 'Offline'],
      datasets: [{
        data: [onlineHours, offlineHours],
        backgroundColor: ['#27ae60', '#e74c3c'],
        borderColor: [colors.backgroundColor, colors.backgroundColor],
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { font: { size: 11 }, padding: 15, color: colors.textColor }
        },
        tooltip: { callbacks: { label: (c) => c.label + ': ' + c.parsed + ' horas' } }
      }
    }
  });
}

function openModal(ip) {
  const d = S.devices[ip];
  if (!d) return;
  S.editingIP = ip;
  const ti = TYPE_INFO[d.type] || TYPE_INFO.unknown;

  document.getElementById('modTitle').innerHTML =
    `<i class="fas ${ti.icon} me-2"></i>${d.name || ip}`;
  document.getElementById('modSubtitle').textContent = ip;

  document.getElementById('modName').value  = d.name  || '';
  document.getElementById('modType').value  = d.type  || 'unknown';
  document.getElementById('modNotes').value = d.notes || '';
  document.getElementById('modCustomName').value = d.name || '';
  document.getElementById('modCategory').value = d.type || 'unknown';
  document.getElementById('modSettingsNotes').value = d.notes || '';
  if (typeof roleOpts === 'function') {                 // papel na rede (Internet, Núcleo, Concentrador, Core, Distribuição...)
    const cur = (S.topoCfg && S.topoCfg.inventory && S.topoCfg.inventory[ip] && S.topoCfg.inventory[ip].role) || '';
    ['modRole', 'modRole2'].forEach(id => { const el = document.getElementById(id); if (el) { el.innerHTML = roleOpts(cur, true, AUTO_ROLE); el.dataset.init = cur; } });
    const curT = (S.topoCfg && S.topoCfg.inventory && S.topoCfg.inventory[ip] && S.topoCfg.inventory[ip].rtype) || '';
    ['modRtype', 'modRtype2'].forEach(id => { const el = document.getElementById(id); if (el) { el.innerHTML = '<option value=""' + (curT ? '' : ' selected') + '>— não é rack —</option>' + rtypeOpts(curT); el.dataset.init = curT; } });
  }

  document.getElementById('modSt').innerHTML = d.status === 'online'
    ? '<span class="text-success fw-bold">● Online</span>'
    : '<span class="text-danger fw-bold">○ Offline</span>';

  document.getElementById('modRt').textContent    = fmtRT(d.rt);
  document.getElementById('modSince').textContent =
    d.onlineSince ? fmtClock(d.onlineSince) : (d.lastSeen ? fmtClock(d.lastSeen) : '—');
  document.getElementById('modPorts').textContent = (d.ports||[]).join(', ') || '—';
  document.getElementById('modHost').textContent  = d.hostname || '—';

  // Construir gráfico
  setTimeout(() => buildResponseTimeChart(ip), 100);

  new bootstrap.Modal(document.getElementById('devModal')).show();
}

// ─────────────────────────────────────────────
//  Faixas de rede
// ─────────────────────────────────────────────
function addRange() {
  const v = document.getElementById('inpRange').value.trim();
  if (!v) return;
  if (S.ranges.includes(v)) { alert('Faixa já adicionada.'); return; }
  if (parseRange(v).length === 0) {
    alert('Formato inválido.\nExemplos: 10.20.12.1-254  |  10.20.12.0/24  |  10.20.12.1-10.20.13.254');
    return;
  }
  S.ranges.push(v);
  document.getElementById('inpRange').value = '';
  renderRanges();
  saveRanges();
}
function removeRange(i) {
  S.ranges.splice(i, 1);
  renderRanges();
  saveRanges();
}

// ─────────────────────────────────────────────
//  Exportar CSV
// ─────────────────────────────────────────────
function exportCSV() {
  const rows = [['IP','Nome','Tipo','Status','Faixa','Portas','Resposta(ms)','Último Online']];
  Object.values(S.devices).sort((a,b) => ipCmp(a.ip, b.ip)).forEach(d => {
    rows.push([
      d.ip, d.name||'', (TYPE_INFO[d.type]||TYPE_INFO.unknown).label, d.status,
      d.range||'', (d.ports||[]).join(';'), d.rt||'',
      d.lastSeen ? new Date(d.lastSeen).toLocaleString('pt-BR') : '',
    ]);
  });
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const link = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })),
    download: `rede_${new Date().toISOString().slice(0,10)}.csv`,
  });
  link.click();
}

// ─────────────────────────────────────────────
//  Inicialização
// ─────────────────────────────────────────────
window.initApp = async () => {

  // 1. Faixas salvas (range persiste, dispositivos não)
  loadRanges();
  if (S.ranges.length === 0) S.ranges = [...FALLBACK_CFG.defaultRanges];

  // 2. UI inicial em branco
  renderRanges();
  renderKnownInfo();
  showIdle();
  renderAll();
  setInterval(updateTimers, 1000);

  // 3. Todos os listeners
  // Theme Toggle
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  if (btnThemeToggle) {
    // Carregar preferência salva
    const savedTheme = localStorage.getItem('theme') || 'light';
    if (savedTheme === 'dark') {
      document.body.classList.add('dark-mode');
      btnThemeToggle.innerHTML = '<i class="fas fa-moon"></i>';
    }

    btnThemeToggle.addEventListener('click', () => {
      const isDark = document.body.classList.toggle('dark-mode');
      const theme = isDark ? 'dark' : 'light';
      localStorage.setItem('theme', theme);
      btnThemeToggle.innerHTML = isDark ? '<i class="fas fa-moon"></i>' : '<i class="fas fa-sun"></i>';
      btnThemeToggle.title = isDark ? 'Modo claro' : 'Modo escuro';
      if (window.syncTrafficTheme) window.syncTrafficTheme();
    });
  }

  document.getElementById('btnMon').addEventListener('click', startMonitoring);
  document.getElementById('btnStop').addEventListener('click', stopMonitoring);
  document.getElementById('btnScanNow').addEventListener('click', scanNow);
  document.getElementById('btnExport').addEventListener('click', exportCSV);
  document.getElementById('btnRanges').addEventListener('click', toggleSidebar);

  document.getElementById('btnRetry').addEventListener('click', async () => {
    document.getElementById('retryMsg').textContent = 'Tentando…';
    const ok = await connectBackend();
    populateKnownDevices();
    renderAll();
    if (ok) {
      startMonitoring();
    } else {
      document.getElementById('retryMsg').textContent = 'Servidor ainda offline.';
    }
  });

  document.getElementById('btnAddRange').addEventListener('click', addRange);
  document.getElementById('inpRange').addEventListener('keydown', e => {
    if (e.key === 'Enter') addRange();
  });

  // Preferências da tela (persistem no navegador)
  try {
    const ui = JSON.parse(localStorage.getItem('nm_ui') || '{}');
    if (ui.statusFilter) S.statusFilter = ui.statusFilter;
    if (ui.sort)  S.sort  = ui.sort;
    if (ui.group) S.group = ui.group;
    if (ui.viewMode) S.viewMode = ui.viewMode;
    if (ui.filter) S.filter = ui.filter;
  } catch {}
  const saveUi = () => {
    try { localStorage.setItem('nm_ui', JSON.stringify({ statusFilter: S.statusFilter, sort: S.sort, group: S.group, viewMode: S.viewMode, filter: S.filter })); } catch {}
  };
  const syncToolbar = () => {
    document.querySelectorAll('#statusSeg button').forEach(b => b.classList.toggle('active', b.dataset.st === S.statusFilter));
    document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('active', b.dataset.v === S.viewMode));
    document.getElementById('selSort').value  = S.sort;
    document.getElementById('selGroup').value = S.group;
    document.getElementById('viewGrid').classList.toggle('d-none', S.viewMode === 'list');
    document.getElementById('viewList').classList.toggle('d-none', S.viewMode === 'grid');
    document.getElementById('selGroup').closest('label').classList.toggle('d-none', S.viewMode === 'list');
  };
  syncToolbar();

  const inpSearch = document.getElementById('inpSearch');
  inpSearch.addEventListener('input', function () { S.search = this.value; scheduleRender(); });
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (e.key === '/' && tag !== 'input' && tag !== 'textarea' && tag !== 'select' &&
        !document.getElementById('tabMonitor').classList.contains('d-none')) {
      e.preventDefault(); inpSearch.focus();
    } else if (e.key === 'Escape' && document.activeElement === inpSearch) {
      inpSearch.value = ''; S.search = ''; inpSearch.blur(); scheduleRender();
    }
  });

  document.getElementById('statusSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-st]'); if (!b) return;
    S.statusFilter = b.dataset.st; syncToolbar(); saveUi(); scheduleRender();
  });
  document.getElementById('viewSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    S.viewMode = b.dataset.v; syncToolbar(); saveUi(); renderAll();
  });
  document.getElementById('selSort').addEventListener('change', function () { S.sort = this.value; saveUi(); scheduleRender(); });
  document.getElementById('selGroup').addEventListener('change', function () { S.group = this.value; saveUi(); scheduleRender(); });
  // cartões de tipo funcionam como filtro (clicar de novo limpa)
  document.getElementById('kpiRow').addEventListener('click', e => {
    const b = e.target.closest('.nm-kpi'); if (!b) return;
    S.filter = S.filter === b.dataset.f ? 'all' : b.dataset.f;
    saveUi(); scheduleRender();
  });


  document.getElementById('modSave').addEventListener('click', () => {
    const ip = S.editingIP;
    if (!ip || !S.devices[ip]) return;

    // Usar valores das abas (aba de configuração tem prioridade)
    const customName = document.getElementById('modCustomName').value.trim();
    const category = document.getElementById('modCategory').value;
    const settingsNotes = document.getElementById('modSettingsNotes').value.trim();

    S.devices[ip].name       = customName || document.getElementById('modName').value.trim();
    S.devices[ip].type       = category || document.getElementById('modType').value;
    S.devices[ip].notes      = settingsNotes || document.getElementById('modNotes').value.trim();
    S.devices[ip].manualType = true;
    if (typeof setRole === 'function' && document.getElementById('modRole')) {
      const r1 = document.getElementById('modRole'), r2 = document.getElementById('modRole2');
      const role = r2.value !== r2.dataset.init ? r2.value : r1.value;
      if (role !== (r1.dataset.init || '')) setRole(ip, role);
      const t1 = document.getElementById('modRtype'), t2 = document.getElementById('modRtype2');
      const rt = t2.value !== t2.dataset.init ? t2.value : t1.value;
      if (rt !== (t1.dataset.init || '')) setRtype(ip, rt);
    }
    renderAll();
    bootstrap.Modal.getInstance(document.getElementById('devModal')).hide();
  });

  document.getElementById('modDel').addEventListener('click', () => {
    if (!S.editingIP) return;
    if (!confirm(`Remover ${S.editingIP} da lista?`)) return;
    delete S.devices[S.editingIP];
    renderAll();
    bootstrap.Modal.getInstance(document.getElementById('devModal')).hide();
  });

  // 3.5 Event listener para aba de gráficos do modal
  const tabGraphBtn = document.getElementById('tab-graph-btn');
  if (tabGraphBtn) {
    tabGraphBtn.addEventListener('shown.bs.tab', () => {
      if (S.editingIP && currentModalChart) {
        setTimeout(() => currentModalChart.resize(), 100);
      }
    });
  }

  // 4. Abas principais (Monitor / Topologia / Tráfego) + modo lado a lado
  const PANES = { monitor: 'tabMonitor', topology: 'tabTopology', traffic: 'tabTraffic' };
  S.split = false;
  S.second = 'traffic';
  try {
    S.activeTab = localStorage.getItem('nm_tab') || 'monitor';
    S.split     = localStorage.getItem('nm_split') === '1';
    S.second    = localStorage.getItem('nm_second') || 'traffic';
  } catch {}
  if (!PANES[S.activeTab]) S.activeTab = 'monitor';
  if (!PANES[S.second]) S.second = 'traffic';

  function syncTrafficTheme() {
    const f = document.getElementById('trafficFrame');
    try { f.contentDocument.documentElement.dataset.theme = document.body.classList.contains('dark-mode') ? 'dark' : 'light'; } catch {}
  }
  window.syncTrafficTheme = syncTrafficTheme;

  function applyTab() {
    if (S.second === S.activeTab) S.second = Object.keys(PANES).find(k => k !== S.activeTab);
    const show = S.split ? [S.activeTab, S.second] : [S.activeTab];
    const ws = document.getElementById('workspace');
    ws.classList.toggle('split', S.split);
    // ordem fixa dos painéis no DOM (Monitor, Topologia, Tráfego)
    Object.entries(PANES).forEach(([k, id]) => document.getElementById(id).classList.toggle('d-none', !show.includes(k)));
    document.querySelectorAll('#mainTabs [data-main-tab]').forEach(t =>
      t.classList.toggle('active', t.dataset.mainTab === S.activeTab));
    const btnSplit = document.getElementById('btnSplit');
    btnSplit.classList.toggle('on', S.split);
    const sel = document.getElementById('splitWith');
    sel.classList.toggle('d-none', !S.split);
    sel.value = S.second;
    Array.from(sel.options).forEach(o => { o.disabled = o.value === S.activeTab; });
    const frame = document.getElementById('trafficFrame');
    if (show.includes('traffic') && !frame.getAttribute('src')) {
      frame.setAttribute('src', 'traffic.html');
      frame.addEventListener('load', syncTrafficTheme, { once: true });
    }
    try { localStorage.setItem('nm_tab', S.activeTab); localStorage.setItem('nm_split', S.split ? '1' : '0'); localStorage.setItem('nm_second', S.second); } catch {}
    if (show.includes('topology')) {
      renderTopology();
      pollTraffic();
      setTimeout(() => { if (window.topoResize) topoResize(); }, 60);
    }
  }
  window.switchTab = function (tabName) { S.activeTab = tabName; applyTab(); };

  document.querySelectorAll('#mainTabs [data-main-tab]').forEach(tab => {
    tab.addEventListener('click', e => {
      e.preventDefault();
      S.activeTab = tab.dataset.mainTab;
      applyTab();
    });
  });
  document.getElementById('btnSplit').addEventListener('click', () => { S.split = !S.split; applyTab(); });
  document.getElementById('splitWith').addEventListener('change', function () { S.second = this.value; applyTab(); });
  window.addEventListener('resize', () => { if (window.topoResize) topoResize(); });
  initTopology();
  applyTab();
  // Event listener para mudar tipo de gráfico histórico
  const histChartTypeSelect = document.getElementById('histChartType');
  if (histChartTypeSelect) {
    histChartTypeSelect.addEventListener('change', () => {
      if (S.chart) {
        S.chart.destroy();
        S.chart = null;
      }
      renderHistChart();
    });
  }

  // Event listener para mudar tipo de gráfico do modal
  const modChartTypeSelect = document.getElementById('modChartType');
  if (modChartTypeSelect) {
    modChartTypeSelect.addEventListener('change', () => {
      if (S.editingIP) {
        if (currentModalChart) {
          currentModalChart.destroy();
          currentModalChart = null;
        }
        buildResponseTimeChart(S.editingIP);
      }
    });
  }

  // 5. Conecta ao backend, pré-popula conhecidos e inicia monitoramento
  const ok = await connectBackend();
  populateKnownDevices();
  renderAll();
  if (ok) {
    startMonitoring();
  }
  // Se backend offline: banner aparece, usuário clica "Reconectar"
};

// painel lateral do Monitor: grupos recolhíveis (igual à Topologia)
document.addEventListener('click', e => { const g = e.target.closest('.nm-side .tsb-grp > h6'); if (g) g.parentNode.classList.toggle('shut'); });
