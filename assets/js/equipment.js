/* Aba "Equipamento": lista tudo que a varredura encontrou (menos computadores comuns) e deixa
   o usuário escolher quais aparecem na Topologia — a lista fica em S.topoInclude (persistida no
   navegador) e é lida por buildTopoModel() em topo-ui.js quando não há ligações configuradas.
   Depende de app.js (S, TYPE_INFO, esc, ipCmp) e, para refletir a Topologia na hora, de topo-ui.js. */
'use strict';

const EQ_INCLUDE_KEY = 'nm_topo_include';
S.topoInclude = null;       // Set<ip> — null = ainda não carregado
S._topoIncludeCustom = false;   // true assim que o usuário mexe num interruptor (a partir daí, a lista é só dele)

// Enquanto o usuário não escolheu nada, segue automaticamente os equipamentos com acesso SSH
// (os cadastrados em "Equipamentos", na aba Tráfego) — evita a topologia ficar vazia por padrão
// e também corrige sozinho caso a 1ª leitura aconteça antes do /api/traffic responder.
function loadTopoInclude() {
  try {
    const raw = localStorage.getItem(EQ_INCLUDE_KEY);
    if (raw !== null) { S.topoInclude = new Set(JSON.parse(raw)); S._topoIncludeCustom = true; return; }
  } catch { /* usa a semente automática abaixo */ }
  S.topoInclude = new Set(Object.keys(S.traffic || {}));
  S._topoIncludeCustom = false;
}
function topoIncludeSet() {
  if (!S.topoInclude) loadTopoInclude();
  if (!S._topoIncludeCustom) {
    const live = Object.keys(S.traffic || {});
    if (live.length !== S.topoInclude.size || live.some(ip => !S.topoInclude.has(ip))) S.topoInclude = new Set(live);
  }
  return S.topoInclude;
}
function saveTopoInclude() {
  S._topoIncludeCustom = true;
  try { localStorage.setItem(EQ_INCLUDE_KEY, JSON.stringify([...S.topoInclude])); } catch { /* sem armazenamento */ }
}

const eqVisible = () => { const t = document.getElementById('tabEquipment'); return !!t && !t.classList.contains('d-none'); };

const STATUS_LABEL = { online: 'Online', offline: 'Offline' };

let _eqSig = '';
function renderEquipment() {
  const body = document.getElementById('eqBody'), empty = document.getElementById('eqEmpty'); if (!body) return;
  const inc = topoIncludeSet();
  // só o que a varredura realmente confirmou (conhecido, cadastrado à mão, ou já respondeu) —
  // os milhares de IPs só "descobertos" (nunca respondidos) ficam de fora, senão a lista vira
  // uma parede de "Desconhecido" repetido
  const list = Object.values(S.devices).filter(d => d.type !== 'computer' && (d.known || d.manual || d.status === 'online' || d.status === 'offline')).sort((a, b) => ipCmp(a.ip, b.ip));
  if (empty) empty.classList.toggle('d-none', !!list.length);
  const sig = list.map(d => `${d.ip}:${d.status}:${d.type}:${d.name || ''}:${inc.has(d.ip) ? 1 : 0}`).join('|');
  if (sig === _eqSig) return;
  _eqSig = sig;
  body.innerHTML = list.map(d => {
    const ti = TYPE_INFO[d.type] || TYPE_INFO.unknown, on = inc.has(d.ip), st = STATUS_LABEL[d.status] || '—';
    return `<tr data-ip="${esc(d.ip)}">
      <td><label class="sw" title="Mostrar na Topologia"><input type="checkbox" class="eq-tog"${on ? ' checked' : ''}><i></i></label></td>
      <td><i class="fas ${ti.icon}" style="margin-right:8px;color:var(--text-muted)"></i><b>${esc(d.name || d.hostname || d.ip)}</b></td>
      <td class="nm-mono">${esc(d.ip)}</td>
      <td>${esc(ti.label)}</td>
      <td><span class="nm-dot ${d.status === 'online' ? 'on' : d.status === 'offline' ? 'off' : ''}"></span>${esc(st)}</td>
    </tr>`;
  }).join('');
}

document.addEventListener('change', e => {
  const t = e.target;
  if (!t.matches || !t.matches('.eq-tog')) return;
  const ip = t.closest('tr').dataset.ip, inc = topoIncludeSet();
  if (t.checked) inc.add(ip); else inc.delete(ip);
  saveTopoInclude();
  _eqSig = '';
  if (window.renderTopology) renderTopology();
});

window.renderEquipment = renderEquipment;
