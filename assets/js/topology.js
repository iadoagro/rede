/* Visões de rede (estilo UniFi), sem dependências:
     TopoView  — árvore de equipamentos: ícone + nome + estado, curvas suaves, botões de
                 recolher/expandir nos ramos, rótulos nos links, halo na seleção.
     InfraView — diagrama de infraestrutura: cartões de equipamento (CPU/memória) com
                 "selos" de porta (uplink/downlink) e linhas porta a porta.
   Ambas: pan (arrastar), zoom (roda), ajuste à tela, "seleção em destaque" (spotlight),
   filtro/busca (esmaece o que não combina) e centralizar em um nó.

   Modelo (setData):
     nodes: [{ id, label, ip, sub, sub2(HTML), status:'online'|'offline'|'scanning'|'unknown',
               kind, collapsed?, cpu?, mem?, model? }]
     links: [{ from, to, label(HTML), state:'up'|'down'|'idle', flow?:bool,
               pBadge?:{name,text,cls,title}, cBadge?:{...} }]      // from = pai, to = filho
*/
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const PAD = 70;

  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
             y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
  };

  // árvore a partir dos links (ignora duplicados e ciclos)
  function buildTree(nodes, links) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const kids = new Map(), parent = new Map(), linkOf = new Map();
    links.forEach(l => {
      if (!byId.has(l.from) || !byId.has(l.to) || l.from === l.to || parent.has(l.to)) return;
      for (let a = l.from; a; a = parent.get(a)) if (a === l.to) return;
      parent.set(l.to, l.from); linkOf.set(l.to, l);
      if (!kids.has(l.from)) kids.set(l.from, []);
      kids.get(l.from).push(l.to);
    });
    const roots = nodes.filter(n => !parent.has(n.id)).map(n => n.id);
    return { byId, kids, parent, linkOf, roots };
  }

  /* ═════════════ base: palco com pan/zoom, seleção, esmaecimento ═════════════ */
  class CanvasBase {
    constructor(root, opts) {
      this.root = root; this.opts = opts || {};
      this.k = 1; this.tx = 0; this.ty = 0; this.autoFit = true;
      this.sel = null; this.bounds = null; this.inset = { right: 0 };   // área coberta pela gaveta de detalhes
      this.matchSet = null; this.hitSet = null; this.spot = false;
      this.model = { nodes: [], links: [] }; this.sig = '';
      this.nodeEls = new Map(); this.edgeEls = []; this.centers = new Map();
      this.kids = new Map(); this.parent = new Map(); this.linkOf = new Map(); this.byId = new Map();
      root.classList.add('tp'); root.innerHTML = '';
      this.stage = h('div', 'tp-stage');
      this.svg = sv('svg', { class: 'tp-edges' });
      this.layer = h('div', 'tp-layer');
      this.stage.append(this.svg, this.layer);
      root.appendChild(this.stage);
      this._bind();
    }

    /* ───── interação pública ───── */
    select(id, silent) {
      this.sel = id || null;
      this.nodeEls.forEach((e, nid) => e.root.classList.toggle('sel', nid === this.sel));
      this._applyDim();
      if (!silent && this.opts.onSelect) this.opts.onSelect(this.sel);
    }
    setSpotlight(on) { this.spot = !!on; this._applyDim(); }
    setMatch(set, hits) { this.matchSet = set || null; this.hitSet = hits || null; this._applyDim(); }
    zoomBy(f) { const r = this.root.getBoundingClientRect(); this._zoomAt(f, r.width / 2, r.height / 2); }
    _uw(r) { const w = r.width - this.inset.right; return w >= 240 ? w : r.width; }   // largura útil (sem a gaveta)
    _anim() { this.stage.classList.add('anim'); clearTimeout(this._at); this._at = setTimeout(() => this.stage.classList.remove('anim'), 420); }
    fit() {
      const r = this.root.getBoundingClientRect(), b = this.bounds;
      this.autoFit = true;
      if (!b || !r.width || !r.height) return;
      const uw = this._uw(r), bw = b.maxX - b.minX, bh = b.maxY - b.minY, m = 36;
      const k = Math.max(0.2, Math.min((uw - 2 * m) / bw, (r.height - 2 * m) / bh, 1.15));
      this.k = k;
      this.tx = (uw - bw * k) / 2 - b.minX * k;
      this.ty = (r.height - bh * k) / 2 - b.minY * k;
      this._apply();
    }
    centerOn(id) {
      const c = this.centers.get(id), r = this.root.getBoundingClientRect();
      if (!c || !r.width) return;
      this.autoFit = false;
      this.tx = this._uw(r) / 2 - c.x * this.k; this.ty = r.height / 2 - c.y * this.k;
      this._anim(); this._apply();
    }
    // garante que o nó fique à vista (fora da gaveta), movendo o mínimo possível
    ensureVisible(id) {
      const c = this.centers.get(id), r = this.root.getBoundingClientRect();
      if (!c || !r.width) return;
      const uw = this._uw(r), m = 90;
      const x = c.x * this.k + this.tx, y = c.y * this.k + this.ty;
      let dx = 0, dy = 0;
      if (x > uw - m) dx = uw - m - x; else if (x < m) dx = m - x;
      if (y > r.height - m) dy = r.height - m - y; else if (y < m) dy = m - y;
      if (dx || dy) { this.tx += dx; this.ty += dy; this._anim(); this._apply(); }
    }
    // a gaveta de detalhes cobre a direita do mapa: reajusta (ou só revela o nó selecionado)
    setInset(right) {
      right = Math.max(0, right | 0);
      if (this.inset.right === right) return;
      this.inset.right = right;
      this._anim();
      if (this.autoFit) this.fit(); else if (this.sel) this.ensureVisible(this.sel);
    }
    resize() { if (this.autoFit) this.fit(); }
    destroy() { this.root.classList.remove('tp'); this.root.innerHTML = ''; this._unbind && this._unbind(); }

    // a estrutura (layout) só é refeita quando muda; os dados das ligações (rótulo, estado, fluxo, selos) vêm sempre do modelo atual
    _syncLinks() {
      this.model.links.forEach(l => { const cur = this.linkOf.get(l.to); if (cur && cur.from === l.from) this.linkOf.set(l.to, l); });
    }

    /* ───── esmaecer (filtro/busca/spotlight) ───── */
    _related() {
      const s = new Set([this.sel]);
      for (let a = this.parent.get(this.sel); a; a = this.parent.get(a)) s.add(a);
      const down = id => (this.kids.get(id) || []).forEach(k => { s.add(k); down(k); });
      down(this.sel);
      return s;
    }
    // tráfego do link: duas linhas animadas paralelas (download = anda do pai para o filho; upload = volta), cor pela utilização do link,
    // espessura e velocidade pela taxa. Sem tráfego (ou sem dados de SSH) a linha base fica só com o tipo do cabo.
    _flowEdge(e, l, vert) {
      const live = l.state !== 'down' && (l.dl != null || l.ul != null), cap = l.cap || 1e9;
      const one = (el, rate, rev, off) => {
        if (!el) return;
        const on = live && (rate || 0) > 2e3;
        el.setAttribute('class', 'tp-flowline' + (on ? ' on' : '') + (rev ? ' rev' : ''));
        if (!on) { el.style.transform = ''; return; }
        const k = Math.log10(rate / 1e3 + 1), pct = Math.min(100, rate / cap * 100);
        el.style.stroke = `hsl(${(150 - 150 * Math.sqrt(pct / 100)).toFixed(0)},85%,48%)`;      // verde (pouco) -> vermelho (link cheio)
        el.style.strokeWidth = (1.6 + Math.min(3.2, k * 0.55)).toFixed(1);
        el.style.animationDuration = (1.8 - Math.min(1.2, k * 0.2)).toFixed(2) + 's';
        el.style.transform = vert ? `translate(${off}px,0)` : `translate(0,${off}px)`;
      };
      one(e.flow, l.dl, false, -3.5); one(e.flow2, l.ul, true, 3.5);
      e.path.classList.toggle('idle', live && !((l.dl || 0) > 2e3 || (l.ul || 0) > 2e3));
    }

    _applyDim() {
      const rel = this.spot && this.sel ? this._related() : null;
      const dim = id => (this.matchSet && !this.matchSet.has(id)) || (rel && !rel.has(id));
      this.nodeEls.forEach((e, id) => {
        e.root.classList.toggle('dim', !!dim(id));
        e.root.classList.toggle('hit', !!(this.hitSet && this.hitSet.has(id)));
      });
      this.edgeEls.forEach(e => {
        const d = !!(dim(e.from) || dim(e.to));
        e.path.classList.toggle('dim', d);
        if (e.flow) e.flow.classList.toggle('dim', d);
        if (e.flow2) e.flow2.classList.toggle('dim', d);
        if (e.lab) e.lab.classList.toggle('dim', d);
      });
    }

    /* ───── pan / zoom / cliques ───── */
    _apply() {
      this.stage.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.k})`;
      if (this.opts.onZoom) this.opts.onZoom(this.k);
    }
    _zoomAt(f, cx, cy) {
      const k2 = Math.max(0.2, Math.min(2.5, this.k * f));
      this.tx = cx - (cx - this.tx) * (k2 / this.k);
      this.ty = cy - (cy - this.ty) * (k2 / this.k);
      this.k = k2; this.autoFit = false; this._apply();
    }
    _bind() {
      const r = this.root; let drag = null, moved = false;
      const down = e => {
        if (e.button !== 0 || e.target.closest('.tp-tog')) return;
        drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty }; moved = false;
      };
      const move = e => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        if (!moved) { moved = true; r.classList.add('panning'); try { r.setPointerCapture(e.pointerId); } catch (_) {} }
        this.tx = drag.tx + dx; this.ty = drag.ty + dy; this.autoFit = false; this._apply();
      };
      const up = e => { if (drag && moved) { try { r.releasePointerCapture(e.pointerId); } catch (_) {} } drag = null; r.classList.remove('panning'); setTimeout(() => { moved = false; }, 0); };
      const wheel = e => {
        e.preventDefault();
        const b = r.getBoundingClientRect();
        this._zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - b.left, e.clientY - b.top);
      };
      const click = e => {
        const t = e.target.closest('.tp-tog'); if (t && this.toggle) { this.toggle(t.dataset.id); return; }
        const n = e.target.closest('.tp-hit');
        if (n) { this.select(n.dataset.id); return; }
        if (!moved && this.sel) this.select(null);
      };
      const dbl = e => { const n = e.target.closest('.tp-hit'); if (n && this.opts.onOpen) this.opts.onOpen(n.dataset.id); };
      r.addEventListener('pointerdown', down); r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up); r.addEventListener('pointercancel', up);
      r.addEventListener('wheel', wheel, { passive: false });
      r.addEventListener('click', click); r.addEventListener('dblclick', dbl);
      this._unbind = () => {
        r.removeEventListener('pointerdown', down); r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up); r.removeEventListener('pointercancel', up);
        r.removeEventListener('wheel', wheel); r.removeEventListener('click', click); r.removeEventListener('dblclick', dbl);
      };
    }
  }

  /* ═════════════ TopoView: árvore de ícones ═════════════ */
  const DENS = {
    normal:  { icon: 64, w: 172, textH: 84, trunk: 42, LR: { depth: 310, slot: 158 }, TB: { depth: 236, slot: 200 } },
    compact: { icon: 44, w: 112, textH: 38, trunk: 30, LR: { depth: 230, slot: 64 },  TB: { depth: 140, slot: 118 } },
  };

  class TopoView extends CanvasBase {
    constructor(root, opts) {
      super(root, opts);
      this.orient = this.opts.orient === 'TB' ? 'TB' : 'LR';
      this.collapsed = new Set(); this.touched = new Set();
    }

    setData(model) {
      this.model = model || { nodes: [], links: [] };
      this.model.nodes.forEach(n => { if (n.collapsed && !this.touched.has(n.id)) this.collapsed.add(n.id); });
      const sig = this.orient + '|' + this.model.nodes.map(n => n.id + ':' + (n.kind || '')).join(',') + '|' +
        this.model.links.map(l => l.from + '>' + l.to).join(',') + '|' + [...this.collapsed].sort().join(',');
      if (sig !== this.sig) { this.sig = sig; this._rebuild(); } else { this._patch(); }
    }
    setOrient(o) { o = o === 'TB' ? 'TB' : 'LR'; if (o === this.orient) return; this.orient = o; this.autoFit = true; this.sig = ''; this.setData(this.model); }
    toggle(id) { this.touched.add(id); this.collapsed.has(id) ? this.collapsed.delete(id) : this.collapsed.add(id); this.sig = ''; this.setData(this.model); }
    // abre os ramos recolhidos que escondem os nós indicados (ex.: resultados da busca)
    reveal(ids) {
      let changed = false;
      ids.forEach(id => { for (let a = this.parent.get(id); a; a = this.parent.get(a)) if (this.collapsed.has(a)) { this.collapsed.delete(a); this.touched.add(a); changed = true; } });
      if (changed) { this.sig = ''; this.setData(this.model); }
    }
    expandAll() { this.model.nodes.forEach(n => this.touched.add(n.id)); this.collapsed.clear(); this.sig = ''; this.setData(this.model); }

    _rebuild() {
      const { nodes, links } = this.model;
      const T = buildTree(nodes, links);
      Object.assign(this, { byId: T.byId, kids: T.kids, parent: T.parent, linkOf: T.linkOf });
      const total = id => (T.kids.get(id) || []).reduce((s, k) => s + 1 + total(k), 0);

      // visíveis = alcançáveis sem passar por ramo recolhido
      const pos = new Map(); let slot = 0;
      const visible = [];
      const walk = id => { visible.push(id); if (!this.collapsed.has(id)) (T.kids.get(id) || []).forEach(walk); };
      T.roots.forEach(walk);
      const D = DENS[visible.length > 16 ? 'compact' : 'normal'], geo = D[this.orient];
      this.D = D; this.root.classList.toggle('compact', D === DENS.compact);

      const place = (id, depth) => {
        const ch = this.collapsed.has(id) ? [] : (T.kids.get(id) || []);
        if (!ch.length) { pos.set(id, { d: depth, s: slot }); return slot++; }
        const ss = ch.map(c => place(c, depth + 1));
        const s = (ss[0] + ss[ss.length - 1]) / 2;
        pos.set(id, { d: depth, s }); return s;
      };
      T.roots.forEach(r => { place(r, 0); slot += 0.35; });

      const P = id => {
        const p = pos.get(id);
        return this.orient === 'LR' ? { x: PAD + p.d * geo.depth, y: PAD + p.s * geo.slot } : { x: PAD + p.s * geo.slot, y: PAD + p.d * geo.depth };
      };
      const ICON = D.icon;

      this.layer.innerHTML = ''; this.svg.innerHTML = '';
      this.nodeEls = new Map(); this.edgeEls = []; this.centers = new Map();
      let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
      const grow = (x0, y0, x1, y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };

      pos.forEach((_, id) => {
        const n = T.byId.get(id), c = P(id);
        this.centers.set(id, c);
        const root = h('div', '');
        root.dataset.id = id;
        root.style.width = D.w + 'px';
        root.style.left = (c.x - D.w / 2) + 'px'; root.style.top = (c.y - ICON / 2) + 'px';
        root.innerHTML = `<div class="tp-ico"><span class="tp-halo"></span>${window.NetIcons ? window.NetIcons.svg(n.kind || 'device', { size: ICON }) : ''}<i class="tp-dot"></i></div>
          <div class="tp-name"></div><div class="tp-ip"></div><div class="tp-sub"></div><div class="tp-sub2"></div>`;
        this.layer.appendChild(root);
        this.nodeEls.set(id, { root, name: root.querySelector('.tp-name'), ip: root.querySelector('.tp-ip'), sub: root.querySelector('.tp-sub'), sub2: root.querySelector('.tp-sub2') });
        grow(c.x - D.w / 2, c.y - ICON / 2 - 8, c.x + D.w / 2, c.y + ICON / 2 + D.textH);
      });

      // ramos: pai -> junção (botão recolher) -> curva até cada filho
      const edges = [];
      pos.forEach((_, id) => {
        const ch = T.kids.get(id) || [];
        if (!ch.length) return;
        const c = P(id), collapsed = this.collapsed.has(id);
        const A = this.orient === 'LR' ? { x: c.x + ICON / 2 + 4, y: c.y } : { x: c.x, y: c.y + ICON / 2 + D.textH - 6 };
        const J = this.orient === 'LR' ? { x: A.x + D.trunk, y: c.y } : { x: c.x, y: A.y + D.trunk * 0.6 };
        edges.push({ d: `M${A.x},${A.y} L${J.x},${J.y}`, cls: 'trunk' });
        const tog = h('button', 'tp-tog' + (collapsed ? ' closed' : ''), collapsed ? '+' + total(id) : '−');
        tog.type = 'button'; tog.dataset.id = id; tog.title = collapsed ? 'Expandir ramo' : 'Recolher ramo';
        tog.style.left = J.x + 'px'; tog.style.top = J.y + 'px';
        this.layer.appendChild(tog);
        if (collapsed) return;
        ch.forEach(cid => {
          const cc = P(cid);
          const E = this.orient === 'LR' ? { x: cc.x - ICON / 2 - 10, y: cc.y } : { x: cc.x, y: cc.y - ICON / 2 - 12 };
          const c1 = this.orient === 'LR' ? { x: J.x + (E.x - J.x) / 2, y: J.y } : { x: J.x, y: J.y + (E.y - J.y) / 2 };
          const c2 = this.orient === 'LR' ? { x: J.x + (E.x - J.x) / 2, y: E.y } : { x: E.x, y: J.y + (E.y - J.y) / 2 };
          const lp = this.orient === 'LR' ? bez(J, c1, c2, E, 0.5) : { x: E.x, y: E.y - 4 };   // TB: rótulo logo acima do filho
          edges.push({ d: `M${J.x},${J.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${E.x},${E.y}`, cls: 'edge', from: id, to: cid, lp });
        });
      });
      edges.forEach(e => {
        const p = sv('path', { d: e.d, class: 'tp-edge ' + e.cls });
        this.svg.appendChild(p);
        if (e.to) {
          const fl = sv('path', { d: e.d, class: 'tp-flowline' });          // pontilhado animado = download (pai -> filho)
          const fl2 = sv('path', { d: e.d, class: 'tp-flowline rev' });     // upload (filho -> pai)
          this.svg.append(fl, fl2);
          const lab = h('div', 'tp-elab ' + this.orient); lab.style.left = e.lp.x + 'px'; lab.style.top = e.lp.y + 'px';
          this.layer.appendChild(lab);
          this.edgeEls.push({ from: e.from, to: e.to, path: p, flow: fl, flow2: fl2, lab });
        }
      });
      this.svg.setAttribute('width', Math.max(0, maxX + 40)); this.svg.setAttribute('height', Math.max(0, maxY + 40));
      this.bounds = isFinite(minX) && maxX > 0 ? { minX, minY, maxX, maxY } : null;

      this._patch();
      this.select(this.sel && this.nodeEls.has(this.sel) ? this.sel : null, true);
      if (this.autoFit) this.fit(); else this._apply();
    }

    // atualiza só textos/estados (sem refazer o layout)
    _patch() {
      this._syncLinks();
      this.model.nodes.forEach(n => {
        const e = this.nodeEls.get(n.id); if (!e) return;
        e.root.className = `tp-node tp-hit st-${n.status || 'unknown'}${n.id === this.sel ? ' sel' : ''}`;
        e.name.textContent = n.label || n.id;
        e.ip.textContent = n.ip || '';
        e.sub.textContent = n.sub || '';
        e.sub2.innerHTML = n.sub2 || '';
        e.root.title = `${n.label || n.id}${n.sub ? ' — ' + n.sub : ''}`;
      });
      this.edgeEls.forEach(e => {
        const { to, path, lab } = e, l = this.linkOf.get(to); if (!l) return;
        path.setAttribute('class', `tp-edge edge ${l.state || 'up'} ${l.medium || 'utp'}`);
        this._flowEdge(e, l, this.orient === 'TB');
        lab.innerHTML = l.label || '';
        lab.style.display = l.label ? '' : 'none';
      });
      this._applyDim();
    }
  }

  /* ═════════════ InfraView: cartões + selos de porta ═════════════ */
  const CARD_W = 252, CARD_H = 96, BADGE_W = 52, BADGE_H = 26, BADGE_GAP = 16, SLOT_W = 300, DEPTH = 240;

  class InfraView extends CanvasBase {
    constructor(root, opts) { super(root, opts); root.classList.add('infra'); this.badgeEls = []; }

    setData(model) {
      this.model = model || { nodes: [], links: [] };
      const sig = this.model.nodes.map(n => n.id + ':' + (n.kind || '')).join(',') + '|' +
        this.model.links.map(l => `${l.from}>${l.to}:${l.pBadge ? l.pBadge.name : ''}/${l.cBadge ? l.cBadge.name : ''}`).join(',');
      if (sig !== this.sig) { this.sig = sig; this._rebuild(); } else { this._patch(); }
    }

    _rebuild() {
      const { nodes, links } = this.model;
      const T = buildTree(nodes, links);
      Object.assign(this, { byId: T.byId, kids: T.kids, parent: T.parent, linkOf: T.linkOf });

      const pos = new Map(); let slot = 0;
      const place = (id, d) => {
        const ch = T.kids.get(id) || [];
        if (!ch.length) { pos.set(id, { d, s: slot }); return slot++; }
        const ss = ch.map(c => place(c, d + 1));
        const s = (ss[0] + ss[ss.length - 1]) / 2;
        pos.set(id, { d, s }); return s;
      };
      T.roots.forEach(r => { place(r, 0); slot += 0.3; });
      const C = id => { const p = pos.get(id); return { x: PAD + p.s * SLOT_W + CARD_W / 2, y: PAD + p.d * DEPTH + CARD_H / 2 }; };

      this.layer.innerHTML = ''; this.svg.innerHTML = '';
      this.nodeEls = new Map(); this.edgeEls = []; this.badgeEls = []; this.centers = new Map();
      let minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
      const grow = (x0, y0, x1, y1) => { minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1); };

      pos.forEach((_, id) => {
        const n = T.byId.get(id), c = C(id);
        this.centers.set(id, c);
        const el = h('div', '');
        el.dataset.id = id;
        el.style.left = (c.x - CARD_W / 2) + 'px'; el.style.top = (c.y - CARD_H / 2) + 'px';
        el.innerHTML = `<div class="if-main"><span class="if-ico">${window.NetIcons ? window.NetIcons.svg(n.kind || 'device', { size: 40 }) : ''}<i class="tp-dot"></i></span>
          <span class="if-txt"><b></b><small></small></span><span class="if-st"></span></div><div class="if-pm"></div>`;
        this.layer.appendChild(el);
        this.nodeEls.set(id, { root: el, name: el.querySelector('b'), sub: el.querySelector('small'), st: el.querySelector('.if-st'), pm: el.querySelector('.if-pm') });
        grow(c.x - CARD_W / 2, c.y - CARD_H / 2 - BADGE_H - 24, c.x + CARD_W / 2, c.y + CARD_H / 2 + BADGE_H + 24);
      });

      // selos de porta: saída (pai, embaixo do cartão) e entrada (filho, em cima)
      const badge = (up, x, y, key) => {
        const el = h('div', 'ifb ' + (up ? 'up' : 'dn'));
        el.style.left = x + 'px'; el.style.top = y + 'px';
        el.innerHTML = '<i></i><b></b>';
        this.layer.appendChild(el);
        this.badgeEls.push({ el, key });
      };
      pos.forEach((_, id) => {
        const ch = T.kids.get(id) || [];
        const withP = ch.filter(cid => T.linkOf.get(cid).pBadge);
        const pc = C(id);
        const down = new Map();
        withP.forEach((cid, i) => {
          const bx = pc.x + (i - (withP.length - 1) / 2) * (BADGE_W + BADGE_GAP);
          const by = pc.y + CARD_H / 2 + 16 + BADGE_H / 2;
          badge(false, bx, by, cid + '|p');
          down.set(cid, { x: bx, y: by + BADGE_H / 2 });
        });
        ch.forEach(cid => {
          const l = T.linkOf.get(cid), cc = C(cid);
          const A = down.get(cid) || { x: pc.x, y: pc.y + CARD_H / 2 };
          let E = { x: cc.x, y: cc.y - CARD_H / 2 };
          if (l.cBadge) {
            const by = cc.y - CARD_H / 2 - 16 - BADGE_H / 2;
            badge(true, cc.x, by, cid + '|c');
            E = { x: cc.x, y: by - BADGE_H / 2 };
          }
          const my = (A.y + E.y) / 2, d = `M${A.x},${A.y} C${A.x},${my} ${E.x},${my} ${E.x},${E.y}`;
          const p = sv('path', { d, class: 'tp-edge edge' });
          const fl = sv('path', { d, class: 'tp-flowline' });
          const fl2 = sv('path', { d, class: 'tp-flowline rev' });
          this.svg.append(p, fl, fl2);
          this.edgeEls.push({ from: id, to: cid, path: p, flow: fl, flow2: fl2, lab: null });
        });
      });

      this.svg.setAttribute('width', Math.max(0, maxX + 40)); this.svg.setAttribute('height', Math.max(0, maxY + 40));
      this.bounds = isFinite(minX) && maxX > 0 ? { minX, minY, maxX, maxY } : null;
      this._patch();
      this.select(this.sel && this.nodeEls.has(this.sel) ? this.sel : null, true);
      if (this.autoFit) this.fit(); else this._apply();
    }

    _patch() {
      this._syncLinks();
      const ICO_CPU = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" stroke="currentColor" stroke-width="1.3"/></svg>';
      const ICO_PLUG = '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M5 1.5v3M11 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0zM8 12v2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      const ICO_MEM = '<svg viewBox="0 0 16 16" width="12" height="12"><rect x="1.5" y="5" width="13" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 11v2M7 11v2M10 11v2M13 11v2" stroke="currentColor" stroke-width="1.3"/></svg>';
      this.model.nodes.forEach(n => {
        const e = this.nodeEls.get(n.id); if (!e) return;
        e.root.className = `if-card tp-hit st-${n.status || 'unknown'}${n.id === this.sel ? ' sel' : ''}`;
        e.name.textContent = n.label || n.id;
        e.sub.textContent = [n.model || n.sub, n.ip].filter(Boolean).join(' · ');
        const stats = [];
        if (n.cpu != null) stats.push(`<span title="CPU">${ICO_CPU}${n.cpu}%</span>`);
        if (n.mem != null) stats.push(`<span title="Memória">${ICO_MEM}${n.mem}%</span>`);
        if (n.portsTotal) stats.push(`<span title="Portas com cabo definido / total">${ICO_PLUG}${n.portsUsed || 0}/${n.portsTotal}</span>`);
        e.st.innerHTML = stats.length ? stats.join('') : `<em>${esc(n.sub || '')}</em>`;
        const pm = n.pm || '';
        if (e.pm.dataset.h !== pm) { e.pm.dataset.h = pm; e.pm.innerHTML = pm; }
        e.pm.style.display = pm ? '' : 'none';
        e.root.title = `${n.label || n.id}${n.sub ? ' — ' + n.sub : ''}`;
      });
      this.edgeEls.forEach(e => {
        const { to, path } = e, l = this.linkOf.get(to); if (!l) return;
        path.setAttribute('class', `tp-edge edge ${l.state || 'up'} ${l.medium || 'utp'}`);
        this._flowEdge(e, l, true);
      });
      this.badgeEls.forEach(({ el, key }) => {
        const [cid, side] = key.split('|'), l = this.linkOf.get(cid); if (!l) return;
        const b = side === 'p' ? l.pBadge : l.cBadge; if (!b) return;
        el.firstChild.className = 'sp-' + (b.cls || 'up');
        el.classList.toggle('fib', l.medium === 'fibra');
        el.lastChild.textContent = b.text;
        el.title = b.title || '';
      });
      this._applyDim();
    }

    _applyDim() {
      super._applyDim();
      const rel = this.spot && this.sel ? this._related() : null;
      const dim = id => (this.matchSet && !this.matchSet.has(id)) || (rel && !rel.has(id));
      this.badgeEls.forEach(({ el, key }) => {
        const cid = key.split('|')[0], p = this.parent.get(cid);
        el.classList.toggle('dim', !!(dim(cid) || (p && dim(p))));
      });
    }
  }

  window.TopoView = TopoView;
  window.InfraView = InfraView;
})();
