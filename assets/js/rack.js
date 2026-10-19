/* Visão "Racks": gabinetes 19" de rede. Cada concentrador MikroTik tem exatamente um rack, com ele fixo no
   topo; dentro ficam os equipamentos que pertencem a ele (switches, patch panels, servidores, nobreaks...),
   cada um ocupando 1 a 4 U, com orelhas e parafusos e jacks RJ45/SFP com LED (a quantidade desenhada é a
   configurada). Os cabos ficam por cima da placa frontal, indo de porta a porta: azul = cabo de rede (UTP),
   laranja = fibra óptica. O rack do topo da árvore é o "Core"; os que ficam abaixo são "Distribuição".
   Os equipamentos podem ser arrastados: dentro do rack (muda a posição) ou para outro rack (muda a que
   rack pertencem). Nunca há equipamento fora de um rack com concentrador.
   Mesma interface das outras visões (setData, select, setMatch, setSpotlight, centerOn, setInset...).
   Modelo: o de topology.js + node.{sw, etype, tlabel, u, rack, pos, rk:[[porta, sfp, led, meio, título]]}
   e model.extras (equipamentos de rack sem ligação). opts.onMove(id, rackId, índice) / opts.onAdd(rackId). */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NS = 'http://www.w3.org/2000/svg';
  const MIN_U = 8;                                   // altura mínima do rack mostrado (unidades)
  const MEDIUM = { utp: 'UTP', fibra: 'Fibra' };
  const RTYPE_NAME = { internet: 'Internet', principal: 'Principal', secundario: 'Secundário' };
  const ROLE_NAME = { internet: 'Internet', nucleo: 'Núcleo', concentrador: 'Concentrador', core: 'Core', distribuicao: 'Distribuição', secondary: 'Secundário' };

  class RackView {
    constructor(root, opts) {
      this.root = root; this.opts = opts || {};
      this.sel = null; this.matchSet = null; this.hitSet = null; this.spot = false; this.k = 1; this.inset = { right: 0 };
      this.model = { nodes: [], links: [], extras: [] }; this.racks = [];
      this.byId = new Map(); this.parent = new Map(); this.kids = new Map(); this.linkOf = new Map();
      this.html = ''; this._drag = null; this._suppress = false; this.side = 'front'; this.tab = 'macro';
      root.classList.add('rk-root');
      this.body = document.createElement('div'); this.body.className = 'rk-body';
      root.appendChild(this.body);
      root.addEventListener('change', e => { const li = e.target.closest('.rk-loc-in'); if (li && this.opts.onLoc) this.opts.onLoc(li.dataset.rack, li.dataset.f, li.value.trim()); });
      root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.closest('.rk-loc-in')) e.target.blur(); });
      root.addEventListener('change', e => { const s = e.target.closest('.rk-role-sel'); if (s && this.opts.onRtype) this.opts.onRtype(s.dataset.rack, s.value); });
      root.addEventListener('click', e => {
        if (this._suppress) return;
        if (e.target.closest('.rk-role-sel, .rk-loc-in')) return;
        const tb = e.target.closest('.rk-tab');
        if (tb) { if (tb.dataset.act === 'addrack') { if (this.opts.onAddRack) this.opts.onAddRack(); } else this.setTab(tb.dataset.tab); return; }
        const del = e.target.closest('.rk-del');
        if (del) { if (this.opts.onRackDel) this.opts.onRackDel(del.dataset.rack); return; }
        const card = e.target.closest('.rm-card');
        if (card && !e.target.closest('.rm-handle')) { this.setTab(card.dataset.rack); return; }
        const add = e.target.closest('.rk-add');
        if (add) { if (this.opts.onAdd) this.opts.onAdd(add.dataset.rack || null); return; }
        const cb = e.target.closest('.rk-cable');
        if (cb) { this.select(cb.dataset.id); return; }
        const n = e.target.closest('.rk-hit');
        if (n) this.select(n.dataset.id); else if (this.sel) this.select(null);
      });
      root.addEventListener('dblclick', e => {
        const me = e.target.closest('.rm-edge');
        if (me) { if (this.opts.onUnlink && me.dataset.child) this.opts.onUnlink(me.dataset.child); return; }
        const cb = e.target.closest('.rk-cable');
        if (cb) { if (this.opts.onUnlink && cb.dataset.child) this.opts.onUnlink(cb.dataset.child); return; }
        const n = e.target.closest('.rk-hit'); if (n && this.opts.onOpen) this.opts.onOpen(n.dataset.id); });
      root.addEventListener('pointerdown', e => this._dragStart(e));
      if (window.ResizeObserver) {                    // qualquer mudança de tamanho de um rack (barra lateral, gaveta, janela) refaz os cabos para acertarem a porta exata
        this._fro = new ResizeObserver(() => { cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this._cables()); });
      }
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this._cables());
      if (window.ResizeObserver) {                    // a largura muda a posição dos jacks: redesenha os cabos
        let t = null, last = '';
        new ResizeObserver(() => { const k = root.clientWidth + 'x' + root.clientHeight; if (!root.clientWidth || k === last) return; last = k; clearTimeout(t); t = setTimeout(() => this._cables(), 60); }).observe(root);
      }
    }

    /* ───── interação pública ───── */
    select(id, silent) {
      this.sel = id || null; this._apply();
      if (!silent && this.opts.onSelect) this.opts.onSelect(this.sel);
    }
    setSpotlight(on) { this.spot = !!on; this._apply(); }
    setMatch(set, hits) { this.matchSet = set || null; this.hitSet = hits || null; this._apply(); }
    zoomBy(f) { this.k = Math.max(0.5, Math.min(1.6, this.k * f)); this.body.style.zoom = this.k; if (this.opts.onZoom) this.opts.onZoom(this.k); }
    fit() { this.k = 1; this.body.style.zoom = 1; if (this.opts.onZoom) this.opts.onZoom(1); }
    resize() { /* o conteúdo rola; nada a reajustar */ }
    setInset(right) { right = Math.max(0, right | 0); if (this.inset.right !== right) { this.inset.right = right; this.root.style.setProperty('--rk-inset', right + 'px'); } }
    centerOn(id) {
      const rk = this.rackOf(id);
      if (rk && this.tab !== rk) this.setTab(rk);
      const el = this.body.querySelector(`.rk-unit[data-id="${CSS.escape(id)}"]`) || this.body.querySelector(`.rk-hit[data-id="${CSS.escape(id)}"]`);
      if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
    destroy() { this.root.classList.remove('rk-root'); this.root.innerHTML = ''; }
    setTab(t, silent) {                               // 'macro' ou o id de um rack
      this.tab = t || 'macro'; this.html = '';
      if (this.model) this.setData(this.model);
      this.root.scrollTop = 0;
      if (!silent && this.opts.onTab) this.opts.onTab(this.tab);
    }
    setSide(side) {                                   // 'front' (frente, com os cabos) ou 'rear' (fundo)
      side = side === 'rear' ? 'rear' : 'front';
      if (side === this.side) return;
      this.side = side; this.html = '';
      if (this.model) this.setData(this.model);
    }
    // título do hack: "Hack <nº> - <setor> · Principal|Secundário" (sem número, usa o nome do equipamento)
    _title(n, r, withType) {
      if (!n) return '';
      const base = n.hnum ? `Hack ${n.hnum}${n.setor ? ' - ' + n.setor : ''}` : n.label;
      return withType && n.hnum ? `${base} · ${RTYPE_NAME[r.role] || ''}` : base;
    }
    rackList() { return this.racks.map(r => ({ id: r.id, name: this._title(this.byId.get(r.id), r, false) || r.id })); }
    unitIds(rackId) { const r = this.racks.find(x => x.id === rackId); return r ? r.units.map(u => u.id) : []; }
    rackOf(id) { const r = this.racks.find(x => x.units.some(u => u.id === id)); return r ? r.id : null; }

    /* ───── dados ───── */
    setData(model) {
      this.model = model || { nodes: [], links: [] };
      const { nodes, links } = this.model, extras = this.model.extras || [];
      this.byId = new Map([...nodes, ...extras].map(n => [n.id, n]));
      this.parent = new Map(); this.kids = new Map(); this.linkOf = new Map();
      links.forEach(l => {
        if (!this.byId.has(l.from) || !this.byId.has(l.to) || l.from === l.to || this.parent.has(l.to)) return;
        for (let a = l.from; a; a = this.parent.get(a)) if (a === l.to) return;
        this.parent.set(l.to, l.from); this.linkOf.set(l.to, l);
        if (!this.kids.has(l.from)) this.kids.set(l.from, []);
        this.kids.get(l.from).push(l.to);
      });
      this.racks = this._racks();
      const html = this._page();
      if (html !== this.html) {
        this.html = html; this.body.innerHTML = html; this._cables();
        if (this._fro) { this._fro.disconnect(); this.body.querySelectorAll('.rk-frame').forEach(f => this._fro.observe(f)); }
      }
      this._apply();
    }

    // um rack por concentrador (equipamento que não é "de rack"); equipamento de rack sempre cai em algum rack
    _racks() {
      const nodes = this.model.nodes, extras = this.model.extras || [], all = [...nodes, ...extras];
      const kidsOf = id => this.kids.get(id) || [];
      const rootIds = [], seenRoot = new Set();
      const visit = id => { if (!seenRoot.has(id)) { seenRoot.add(id); rootIds.push(id); } descend(id); };
      const descend = id => kidsOf(id).forEach(c => (this.byId.get(c).sw ? descend(c) : visit(c)));
      if (this.model.fallback) nodes.filter(n => n.type === 'nucleo' && !n.sw).forEach(n => { if (!seenRoot.has(n.id)) { seenRoot.add(n.id); rootIds.push(n.id); } });      // sem ligações cadastradas: um rack por concentrador (núcleo) encontrado
      else {
        nodes.filter(n => !this.parent.has(n.id) && !n.sw && n.kind !== 'internet' && n.kind !== 'group').forEach(n => visit(n.id));
        nodes.filter(n => !this.parent.has(n.id) && n.sw).forEach(n => descend(n.id));
      }
      const rackIds = new Set(rootIds), placed = new Set();
      // quem fica no rack: o definido à mão (rack); senão o concentrador acima na árvore de cabos
      const owner = id => { const n = this.byId.get(id); if (n.rack && rackIds.has(n.rack)) return n.rack;
        for (let a = this.parent.get(id); a; a = this.parent.get(a)) { const an = this.byId.get(a); if (!an.sw) return a; if (an.rack && rackIds.has(an.rack)) return an.rack; }
        return rootIds[0] || ''; };
      const racks = rootIds.map(id => ({ id, units: [{ id, depth: 0 }] }));
      racks.forEach(r => placed.add(r.id));
      all.filter(n => n.sw).forEach(n => { const r = racks.find(x => x.id === owner(n.id)); if (r && !placed.has(n.id)) { r.units.push({ id: n.id, depth: 1 }); placed.add(n.id); } });
      racks.forEach(r => {                           // concentrador fixo no topo; o resto na ordem escolhida (pos), senão na de cadastro
        const rest = r.units.slice(1).map((u, i) => ({ u, k: (this.byId.get(u.id).pos || 1e6) + i / 1000 })).sort((a, b) => a.k - b.k).map(x => x.u);
        r.units = [r.units[0], ...rest];
        let d = 0; for (let a = this.parent.get(r.id); a; a = this.parent.get(a)) if (!this.byId.get(a).sw && this.byId.get(a).kind !== 'internet') d++;
        void d; r.role = this.byId.get(r.id).rtype || 'secundario';
      });
      return racks;
    }

    _jacks(n) {
      const ps = n.rk || [];
      if (!ps.length) return '';
      const jack = p => `<i class="jk${p[1] ? ' sfp' : ''}${p[3] ? (p[3] === 'fibra' ? ' cf' : ' cu') : ''}" title="${esc(p[4])}" data-d="${esc(n.id)}" data-p="${esc(p[0])}"><b class="led ${esc(p[2])}"></b></i>`;
      const group = list => {
        const cols = []; for (let i = 0; i < list.length; i += 2) cols.push(list.slice(i, i + 2));
        const per = cols.length <= 8 ? cols.length : 4, gs = []; for (let i = 0; i < cols.length; i += per) gs.push(cols.slice(i, i + per));   // até 16 portas: um bloco só; mais: blocos de 8
        return gs.map(g => `<span class="jg">${g.map(c => `<span class="jc">${c.map(jack).join('')}</span>`).join('')}</span>`).join('');
      };
      const eth = ps.filter(p => !p[1]), sfp = ps.filter(p => p[1]);
      return (eth.length ? `<span class="rk-jacks">${group(eth)}</span>` : '') + (sfp.length ? `<span class="rk-jacks sfps">${group(sfp)}</span>` : '');
    }

    // fundo do equipamento: entrada de energia, ventilação, console, tomadas do nobreak, blocos do patch panel
    _rear(n, kind) {
      const t = n.sw ? (n.etype || 'switch') : 'conc', u = Math.max(1, n.u || 1);
      const psu = '<span class="rk-psu" title="Entrada de energia"><i></i><i></i><i></i></span>';
      let body;
      if (t === 'patch') body = `<span class="rk-110" title="Blocos de punção (cabeamento horizontal)">${Array.from({ length: Math.min((n.rk || []).length || 24, 48) }, (_, i) => `<i class="c${i % 4}"></i>`).join('')}</span>`;
      else if (t === 'ups') body = `<span class="rk-outs" title="Tomadas">${'<i></i>'.repeat(6)}</span>${psu}`;
      else if (t === 'organizer') body = '<span class="rk-brush"></span>';
      else if (t === 'blank') body = '';
      else if (t === 'server') body = `<span class="rk-vent"></span><span class="rk-psus">${psu}${psu}</span>`;
      else body = `<span class="rk-fan"><i></i><i></i></span><span class="rk-console" title="Console / gerência"></span>${psu}`;
      const sub = n.sw ? (n.tlabel || 'Switch') : 'Concentrador MikroTik';
      return `<div class="rk-unit rk-hit rear ${kind === 'conc' ? 'rk-conc' : 'rk-sw'} t-${t} st-${esc(n.status || 'unknown')}" data-id="${esc(n.id)}" style="--u:${u}" title="${esc(n.label)} (fundo)${kind === 'conc' ? '' : ' — arraste para mover'}">
          <span class="rk-ear l"><i class="scr"></i><i class="scr"></i></span>
          <span class="rk-plate"><span class="rk-brand"><i class="rk-led"></i><span><b>${esc(n.label)}</b><small>${esc(sub)} · fundo</small></span></span>${body}</span>
          <span class="rk-ear r"><i class="scr"></i><i class="scr"></i></span></div>`;
    }

    // papel do equipamento: o escolhido; senão, o MikroTik é concentrador no rack principal e core nos secundários
    _role(n, kind) {
      if (n.role) return n.role;
      if (kind !== 'conc') return '';
      const rt = n.rtype || 'secundario';
      return rt === 'principal' ? 'concentrador' : rt === 'secundario' ? 'core' : '';
    }

    _face(n, kind) {
      if (this.side === 'rear') return this._rear(n, kind);
      const t = n.sw ? (n.etype || 'switch') : 'conc', u = Math.max(1, n.u || 1);
      let decor = '';
      if (t === 'ups') decor = '<span class="rk-lcd"><b>100%</b><small>ONLINE</small></span><span class="rk-vent"></span>';
      else if (t === 'organizer') decor = '<span class="rk-brush"></span>';
      else if (t === 'blank') decor = '<span class="rk-slots"></span>';
      const typeLbl = (window.TYPE_INFO && window.TYPE_INFO.nucleo && window.TYPE_INFO.nucleo.label) || 'Núcleo';
      const sub = n.sw ? (n.tlabel || 'Switch') : (n.model && n.model !== typeLbl ? n.model : 'MikroTik');   // o tipo do Monitor ("Núcleo") não é mostrado: o papel é uma coisa só
      const ip = n.ip ? ' · ' + n.ip : '';
      return `<div class="rk-unit rk-hit ${kind === 'conc' ? 'rk-conc' : 'rk-sw'} t-${t} st-${esc(n.status || 'unknown')}" data-id="${esc(n.id)}" style="--u:${u}" title="${esc(n.label)}${kind === 'conc' ? '' : ' — arraste para mover'}">
          <span class="rk-ear l"><i class="scr"></i><i class="scr"></i></span>
          <span class="rk-plate">
            <span class="rk-brand"><i class="rk-led"></i><span><b>${esc(n.label)}</b><small>${esc(sub + ip)}</small></span></span>
            ${this._role(n, kind) ? `<em class="rk-role ${this._role(n, kind)}">${kind === 'conc' && this._role(n, kind) === 'core' ? 'Core do hack' : ROLE_NAME[this._role(n, kind)]}</em>` : ''}
            ${decor}${this._jacks(n)}
            ${kind === 'conc' && n.portsTotal ? `<span class="rk-meta">${n.portsUsed || 0}/${n.portsTotal}</span>` : ''}
          </span>
          <span class="rk-ear r"><i class="scr"></i><i class="scr"></i></span>
        </div>`;
    }

    // página: abas (Macro + um rack por aba) e o conteúdo da aba atual
    _page() {
      if (!this.racks.length) return this._html();
      if (this.tab !== 'macro' && !this.racks.some(r => r.id === this.tab)) this.tab = 'macro';
      const tabs = `<div class="rk-tabs" role="tablist"><button type="button" class="rk-tab${this.tab === 'macro' ? ' on' : ''}" data-tab="macro"><i class="fas fa-diagram-project"></i> Macro</button>${this.racks.map(r => {
        const n = this.byId.get(r.id); return `<button type="button" class="rk-tab${this.tab === r.id ? ' on' : ''}" data-tab="${esc(r.id)}" title="${esc(this._title(n, r, true))}"><i class="rk-dot ${r.role}"></i>${esc(n.hnum ? 'Hack ' + n.hnum : n.label)}</button>`; }).join('')}<button type="button" class="rk-tab add" data-act="addrack" title="Adicionar um rack (concentrador MikroTik)"><i class="fas fa-plus"></i> Adicionar rack</button></div>`;
      if (this.tab === 'macro') return tabs + this._macro();
      return tabs + this._html(this.racks.filter(r => r.id === this.tab));
    }

    // macro: os racks como cartões ligados entre si; arraste a alça de um até outro para ligá-los
    _macro() {
      const CW = 300, GAPX = 60, GAPY = 96, PAD = 30, ROW = 22;
      const rackOfNode = id => this.rackOf(id);
      const kids = new Map(), rpar = new Map();
      this.racks.forEach(r => { const p = this.parent.get(r.id), pr = p && rackOfNode(p); if (pr && pr !== r.id) { rpar.set(r.id, pr); if (!kids.has(pr)) kids.set(pr, []); kids.get(pr).push(r.id); } });
      const roots = this.racks.filter(r => !rpar.has(r.id)).map(r => r.id);
      const hOf = id => { const nn = this.byId.get(id); return 74 + (nn.andar || nn.setor ? 18 : 0) + Math.min(this.racks.find(r => r.id === id).units.length, 9) * ROW + 12; };
      const pos = new Map(); let slot = 0;
      const place = (id, d) => {
        const ch = kids.get(id) || [];
        if (!ch.length) { pos.set(id, { d, s: slot }); return slot++; }
        const ss = ch.map(c => place(c, d + 1)); const s = (ss[0] + ss[ss.length - 1]) / 2; pos.set(id, { d, s }); return s;
      };
      roots.forEach(r => { place(r, 0); slot += 0.3; });
      const maxD = Math.max(0, ...[...pos.values()].map(p => p.d)), levelH = [];
      for (let d = 0; d <= maxD; d++) levelH[d] = Math.max(...[...pos].filter(([, p]) => p.d === d).map(([id]) => hOf(id)));
      const levelY = []; levelH.reduce((y, h, d) => { levelY[d] = y; return y + h + GAPY; }, PAD);
      const box = id => { const p = pos.get(id); return { x: PAD + p.s * (CW + GAPX), y: levelY[p.d], w: CW, h: hOf(id) }; };
      const W = PAD * 2 + (slot) * (CW + GAPX), H = (levelY[maxD] || 0) + (levelH[maxD] || 0) + PAD + 20;
      let edges = '', chips = '';
      this.racks.forEach(r => {
        const pr = rpar.get(r.id); if (!pr) return;
        const A = box(pr), B = box(r.id), l = this.linkOf.get(r.id), md = (l && l.medium) || 'utp';
        const ax = A.x + A.w / 2, ay = A.y + A.h, bx = B.x + B.w / 2, by = B.y, my = (ay + by) / 2;
        const ports = l && (l.pBadge || l.cBadge) ? ` · ${l.pBadge ? l.pBadge.text : '?'} ⇌ ${l.cBadge ? l.cBadge.text : '?'}` : '';
        const nm = id => (this.byId.get(id) || {}).label || id;
        edges += `<g class="rm-edge ${md}" data-child="${esc(r.id)}"><title>${esc(nm(pr))} ⇌ ${esc(nm(r.id))} · ${md === 'fibra' ? 'fibra óptica' : 'cabo de rede (UTP)'} — clique duplo para remover</title><path class="o" d="M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}"/><path class="c" d="M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}"/></g>`;
        chips += `<span class="rm-chip mt ${md}" style="left:${(ax + bx) / 2}px;top:${my}px">${MEDIUM[md]}${esc(ports)}</span>`;
      });
      const cards = this.racks.map(r => {
        const b = box(r.id), n = this.byId.get(r.id), us = r.units.map(u => this.byId.get(u.id));
        const used = us.reduce((a, x) => a + Math.max(1, x.u || 1), 0);
        const li = us.slice(0, 9).map((x, i) => `<li class="${i === 0 ? 'c' : ''}"><i class="rm-t t-${x.sw ? (x.etype || 'switch') : 'conc'}"></i><span>${esc(x.label)}</span><small>${esc(x.sw ? (x.tlabel || 'Switch') : 'MikroTik')}</small></li>`).join('') + (us.length > 9 ? `<li class="more">+ ${us.length - 9} equipamentos</li>` : '');
        return `<div class="rm-card ${r.role}" data-rack="${esc(r.id)}" style="left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px" title="Abrir o rack ${esc(n.label)}">
          <div class="rm-h"><span class="rk-role ${r.role}">${RTYPE_NAME[r.role]}</span><b>${esc(this._title(n, r, false))}</b><small>${esc(r.id)}</small><i class="rk-led ${n.status === 'online' ? 'on' : n.status === 'offline' ? 'off' : ''}"></i></div>
          ${n.andar || n.setor ? `<div class="rm-loc"><i class="fas fa-location-dot"></i> ${[n.andar && 'Andar ' + esc(n.andar), n.setor && esc(n.setor)].filter(Boolean).join(' · ')}</div>` : ''}
          <ul class="rm-u">${li}</ul>
          <div class="rm-f">${r.units.length - 1} equipamento(s) · ${used}/${Math.max(MIN_U, used + 2)} U</div>
          <span class="rm-handle" title="Arraste até outro rack para ligá-los"><i class="fas fa-link"></i></span></div>`;
      }).join('');
      return `<div class="rm-scroll"><div class="rm" style="width:${W}px;height:${H}px"><svg class="rm-svg" width="${W}" height="${H}">${edges}</svg>${chips}${cards}</div>
        <p class="rm-hint"><i class="fas fa-circle-info"></i> Clique num rack para abri-lo · arraste a alça <i class="fas fa-link"></i> de um rack até outro para ligá-los · clique duplo numa ligação remove.</p></div>`;
    }

    // ligar racks no macro: arrastar da alça até outro cartão
    _macroLink(e, h) {
      const card = h.closest('.rm-card'), from = card.dataset.rack, c = { on: false, hot: null, target: null };
      const r0 = h.getBoundingClientRect(); c.x = r0.left + r0.width / 2; c.y = r0.top + r0.height / 2;
      const move = ev => {
        if (!c.on) { if (Math.hypot(ev.clientX - c.x, ev.clientY - c.y) < 5) return; c.on = true; this._cableOverlay(c); this.root.classList.add('rk-cabling'); }
        c.path.setAttribute('d', `M${c.x},${c.y} L${ev.clientX},${ev.clientY}`);
        const t = document.elementFromPoint(ev.clientX, ev.clientY), tc = t && t.closest && t.closest('.rm-card');
        const ok = tc && tc !== card ? tc : null;
        if (c.hot && c.hot !== ok) c.hot.classList.remove('drop-ok');
        if (ok) ok.classList.add('drop-ok');
        c.hot = ok; c.target = ok ? ok.dataset.rack : null;
      };
      const up = ev => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        if (!c.on) return;
        if (c.svg) c.svg.remove(); if (c.hot) c.hot.classList.remove('drop-ok'); this.root.classList.remove('rk-cabling');
        this._suppress = true; setTimeout(() => { this._suppress = false; }, 0);
        if (ev.type !== 'pointercancel' && c.target && this.opts.onRackLink) this.opts.onRackLink(from, c.target);
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    }

    _html(list) {
      if (!this.racks.length) return '<div class="rk-empty-all"><i class="fas fa-server"></i>Nenhum concentrador (MikroTik) para mostrar racks. Cadastre as ligações na aba Topologia ou aguarde o scan.</div>';
      const sig = JSON.stringify(this.model.links.map(l => [l.from, l.to, l.medium, l.pBadge && l.pBadge.text, l.cBadge && l.cBadge.text]));
      return `<div class="rk-grid${list ? ' one' : ''}">${(list || this.racks).map(r => {
        const n = this.byId.get(r.id), l = this.linkOf.get(r.id), par = this.parent.get(r.id), pn = par && this.byId.get(par);
        const hs = r.units.map(u => Math.max(1, (this.byId.get(u.id).u || 1)));
        const used = hs.reduce((a, b) => a + b, 0), total = Math.max(MIN_U, used + 2);
        let at = 0;
        const rowsHtml = r.units.map((u, k) => {
          const un = this.byId.get(u.id);
          const nums = Array.from({ length: hs[k] }, (_, i) => `<b>${total - at - i}</b>`).join(''); at += hs[k];
          return `<div class="rk-slot" style="--h:${hs[k]}"><span class="rk-rail">${nums}</span>${this._face(un, k === 0 ? 'conc' : 'sw')}<span class="rk-rail r">${nums.replace(/<b>\d+<\/b>/g, '<b></b>')}</span><span class="rk-gut"></span></div>`;
        }).join('');
        const free = total - used;
        const emptyRows = Array.from({ length: free }, (_, i) => `<div class="rk-slot" style="--h:1"><span class="rk-rail"><b>${free - i}</b></span><span class="rk-void"></span><span class="rk-rail r"><b></b></span><span class="rk-gut"></span></div>`).join('');
        const nSw = r.units.length - 1;
        return `<section class="rk" data-rack="${esc(r.id)}">
          <header class="rk-head rk-hit" data-id="${esc(r.id)}"><span class="rk-hico"><i class="fas fa-server"></i></span>
            <div><b>${esc(this._title(n, r, true))}</b><small>1 concentrador${nSw ? ' + ' + nSw + (nSw === 1 ? ' equipamento' : ' equipamentos') : ''} · ${used}/${total} U</small></div>
            ${l && pn ? `<span class="rk-up" title="Ligado a ${esc(pn.label)}"><em class="mt ${l.medium || 'utp'}">${MEDIUM[l.medium] || 'UTP'}</em> ↑ ${esc(pn.label)}</span>` : '<span class="rk-up root">topo da rede</span>'}
            <span class="rk-loc"><input class="rk-loc-in num" data-rack="${esc(r.id)}" data-f="hnum" maxlength="12" placeholder="Nº" title="Número do hack" value="${esc(n.hnum)}"><input class="rk-loc-in" data-rack="${esc(r.id)}" data-f="andar" maxlength="30" placeholder="Andar" title="Andar do rack" value="${esc(n.andar)}"><input class="rk-loc-in wide" data-rack="${esc(r.id)}" data-f="setor" maxlength="60" placeholder="Setor" title="Setor do rack" value="${esc(n.setor)}"></span>
            <select class="rk-role-sel ${r.role}" data-rack="${esc(r.id)}" title="Tipo deste rack">${Object.entries(RTYPE_NAME).map(([k, l]) => `<option value="${k}"${k === r.role ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <button type="button" class="rk-add" data-rack="${esc(r.id)}" title="Adicionar equipamento neste rack"><i class="fas fa-plus"></i></button>
            <button type="button" class="rk-del" data-rack="${esc(r.id)}" title="Remover este rack"><i class="fas fa-trash"></i></button></header>
          <div class="rk-top"></div>
          <div class="rk-frame">${rowsHtml}${emptyRows}</div>
          <footer class="rk-base"><i></i><i></i></footer></section>`;
      }).join('')}</div><!--${this.side}${sig.replace(/--/g, '- -')}-->`;
    }

    /* ───── cabos na frente: de porta a porta, por cima da placa frontal ───── */
    _cables() {
      if (this.side === 'rear') return;               // os cabos de rede ficam na frente
      this.body.querySelectorAll('.rk').forEach(sec => {
        const rack = this.racks.find(r => r.id === sec.dataset.rack), frame = sec.querySelector('.rk-frame');
        if (!rack || !frame) return;
        const old = frame.querySelector('svg.rk-cables'); if (old) old.remove();
        const ids = new Set(rack.units.map(u => u.id));
        const fr = frame.getBoundingClientRect(), kz = this.k || 1;
        const box = el => { const r = el.getBoundingClientRect(); return { x: (r.left - fr.left) / kz, y: (r.top - fr.top) / kz, w: r.width / kz, h: r.height / kz }; };   // medido, sem arredondar
        const off = el => { const b = box(el); return { x: b.x, y: b.y }; };
        const unitEl = id => frame.querySelector(`.rk-unit[data-id="${CSS.escape(id)}"]`);
        const pt = (id, label, side) => {              // ponto de ligação: centro do jack (topo/base) ou a orelha direita do equipamento
          const j = label && frame.querySelector(`.jk[data-d="${CSS.escape(id)}"][data-p="${CSS.escape(label)}"]`);
          if (j) { const b = box(j); return { x: b.x + b.w / 2, y: b.y + b.h / 2, jack: true, w: b.w, h: b.h }; }   // exatamente o centro da porta
          const u = unitEl(id); if (!u) return null;
          const b = box(u); return { x: b.x + b.w - 7, y: b.y + b.h / 2, ear: !!label || true };
        };
        const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'rk-cables');
        let k = 0;
        this.model.links.forEach(l => {
          const inF = ids.has(l.from), inT = ids.has(l.to);
          if (!inF && !inT) return;
          const fp = l.pBadge ? l.pBadge.text : '', tp = l.cBadge ? l.cBadge.text : '', md = l.medium || 'utp';
          const nm = id => (this.byId.get(id) || {}).label || id;
          const miss = (id, p) => (p ? `a porta ${p} não existe em ${nm(id)} (confira o número de portas)` : `porta não definida em ${nm(id)}`);
          const title0 = `${nm(l.from)}${fp ? ' (porta ' + fp + ')' : ''} ⇌ ${nm(l.to)}${tp ? ' (porta ' + tp + ')' : ''} · ${md === 'fibra' ? 'fibra óptica' : 'cabo de rede (UTP)'}`;
          let d, ends, label = null;
          if (inF && inT) {
            const ua = unitEl(l.from), ub = unitEl(l.to); if (!ua || !ub) return;
            const upper = off(ua).y <= off(ub).y;
            const A = pt(l.from, fp, upper ? 'b' : 't'), B = pt(l.to, tp, upper ? 't' : 'b'); if (!A || !B) return;
            const dy = B.y - A.y, s = dy >= 0 ? 1 : -1, c = Math.max(26, Math.abs(dy) * 0.45);
            const bow = Math.abs(A.x - B.x) < 40 ? 22 + 9 * (k % 3) : 0;
            d = `M${A.x},${A.y} C${A.x + bow},${A.y + s * c} ${B.x + bow},${B.y - s * c} ${B.x},${B.y}`; ends = [A, B];
          } else {                                    // a outra ponta está em outro rack: sai pela lateral
            const here = inF ? l.from : l.to, other = inF ? l.to : l.from, lab = inF ? fp : tp;
            const A = pt(here, lab, inF ? 'b' : 't'); if (!A) return;
            const W = frame.clientWidth, dir = inF ? 1 : -1, E = { x: W - 10 - 6 * (k % 3), y: A.y + dir * (34 + 13 * (k % 3)) };
            d = `M${A.x},${A.y} C${A.x},${A.y + dir * 26} ${E.x},${E.y - dir * 22} ${E.x},${E.y}`; ends = [A, E];
            label = { x: E.x - 4, y: E.y + dir * 10, t: (inF ? '↓ ' : '↑ ') + nm(other) };
          }
          k++;
          const warns = []; if (inF && ends[0] && ends[0].ear) warns.push(miss(l.from, fp)); if (inT && ends[inF ? 1 : 0] && ends[inF ? 1 : 0].ear && (inF && inT)) warns.push(miss(l.to, tp)); if (!inF && ends[0].ear) warns.push(miss(l.to, tp));
          const title = title0 + (warns.length ? ' — ⚠ ' + warns.join('; ') : '');
          const g = document.createElementNS(NS, 'g'); g.setAttribute('class', `rk-cable ${md}`); g.dataset.id = inT ? l.to : l.from; g.dataset.child = l.to;
          const mk = (tag, a) => { const e = document.createElementNS(NS, tag); Object.entries(a).forEach(([n2, v]) => e.setAttribute(n2, v)); return e; };
          const ttl = document.createElementNS(NS, 'title'); ttl.textContent = title; g.appendChild(ttl);
          g.append(mk('path', { d, class: 'o' }), mk('path', { d, class: 'c' }));
          ends.forEach(p => g.appendChild(p.ear ? mk('circle', { cx: p.x, cy: p.y, r: 5, class: 'p warn' }) : p.jack ? mk('rect', { x: p.x - 3, y: p.y - 3, width: 6, height: 6, rx: 1, class: 'p j' }) : mk('circle', { cx: p.x, cy: p.y, r: 3.2, class: 'p' })));
          if (label) { const t = mk('text', { x: label.x, y: label.y, class: 'lb', 'text-anchor': 'end' }); t.textContent = label.t; g.appendChild(t); }
          svg.appendChild(g);
        });
        frame.appendChild(svg);
      });
    }

    /* ───── arrastar equipamentos (posição no rack ou outro rack) ───── */
    // ligar cabo: arrastar de uma porta até outra
    _cableStart(e, j) {
      const c = { dev: j.dataset.d, port: j.dataset.p, el: j, on: false, target: null, svg: null, path: null };
      const r0 = j.getBoundingClientRect(); c.x = r0.left + r0.width / 2; c.y = r0.top + r0.height / 2;
      const move = ev => {
        if (!c.on) { if (Math.hypot(ev.clientX - c.x, ev.clientY - c.y) < 5) return; c.on = true; this._cableOverlay(c); j.classList.add('drag-src'); this.root.classList.add('rk-cabling'); }
        c.path.setAttribute('d', `M${c.x},${c.y} L${ev.clientX},${ev.clientY}`);
        const t = document.elementFromPoint(ev.clientX, ev.clientY), tj = t && t.closest && t.closest('.jk');
        const ok = tj && tj !== j && tj.dataset.d !== c.dev ? tj : null;
        if (c.hot && c.hot !== ok) c.hot.classList.remove('drop-ok');
        if (ok) ok.classList.add('drop-ok');
        c.hot = ok; c.target = ok ? { dev: ok.dataset.d, port: ok.dataset.p } : null;
      };
      const up = ev => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        if (!c.on) return;
        if (c.svg) c.svg.remove(); if (c.hot) c.hot.classList.remove('drop-ok'); j.classList.remove('drag-src'); this.root.classList.remove('rk-cabling');
        this._suppress = true; setTimeout(() => { this._suppress = false; }, 0);
        if (ev.type !== 'pointercancel' && c.target && this.opts.onLink) this.opts.onLink(c.dev, c.port, c.target.dev, c.target.port);
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    }
    _cableOverlay(c) {
      const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'rk-live');
      const p = document.createElementNS(NS, 'path'); p.setAttribute('class', 'rk-live-p'); svg.appendChild(p);
      document.body.appendChild(svg); c.svg = svg; c.path = p;
    }

    _dragStart(e) {
      if (e.button !== 0) return;
      const mh = e.target.closest('.rm-handle');
      if (mh) { e.preventDefault(); this._macroLink(e, mh); return; }
      const jk = e.target.closest('.jk');
      if (jk && this.side === 'front') { this._cableStart(e, jk); return; }
      const u = e.target.closest('.rk-unit.rk-sw'); if (!u) return;
      const d = this._drag = { id: u.dataset.id, el: u, x: e.clientX, y: e.clientY, on: false, target: null };
      const move = ev => this._dragMove(ev);
      const up = ev => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); this._dragEnd(ev.type === 'pointercancel'); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
      void d;
    }
    _dragMove(e) {
      const d = this._drag; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.on) { if (Math.hypot(dx, dy) < 6) return; d.on = true; d.el.classList.add('dragging'); this.root.classList.add('rk-dragging'); }
      d.el.style.transform = `translate(${dx / this.k}px,${dy / this.k}px)`;
      const hit = document.elementFromPoint(e.clientX, e.clientY), sec = hit && hit.closest('.rk');
      let ind = this.body.querySelector('.rk-drop');
      if (!sec) { d.target = null; if (ind) ind.remove(); return; }
      const frame = sec.querySelector('.rk-frame'), units = [...sec.querySelectorAll('.rk-unit')].filter(x => x !== d.el);
      const idx = Math.max(1, units.filter(x => { const r = x.getBoundingClientRect(); return r.top + r.height / 2 < e.clientY; }).length);
      d.target = { rack: sec.dataset.rack, idx };
      if (!ind) { ind = document.createElement('div'); ind.className = 'rk-drop'; }
      if (ind.parentNode !== frame) frame.appendChild(ind);
      const ref = units[idx] || units[units.length - 1], rel = el => { let y = 0; for (let n = el; n && n !== frame; n = n.offsetParent) y += n.offsetTop; return y; };
      ind.style.top = (units[idx] ? rel(ref) - 2 : rel(ref) + ref.offsetHeight + 2) + 'px';
    }
    _dragEnd(cancelled) {
      const d = this._drag; this._drag = null;
      if (!d || !d.on) return;
      d.el.classList.remove('dragging'); d.el.style.transform = ''; this.root.classList.remove('rk-dragging');
      const ind = this.body.querySelector('.rk-drop'); if (ind) ind.remove();
      this._suppress = true; setTimeout(() => { this._suppress = false; }, 0);
      if (!cancelled && d.target && this.opts.onMove) this.opts.onMove(d.id, d.target.rack, d.target.idx);
    }

    /* ───── seleção / filtro / destaque ───── */
    _related() {
      const s = new Set([this.sel]);
      for (let a = this.parent.get(this.sel); a; a = this.parent.get(a)) s.add(a);
      const down = id => (this.kids.get(id) || []).forEach(k => { s.add(k); down(k); });
      down(this.sel);
      return s;
    }
    _apply() {
      const rel = this.spot && this.sel ? this._related() : null;
      this.body.querySelectorAll('.rk-hit').forEach(el => {
        const id = el.dataset.id;
        el.classList.toggle('sel', id === this.sel);
        el.classList.toggle('dim', !!((this.matchSet && !this.matchSet.has(id)) || (rel && !rel.has(id))));
        el.classList.toggle('hit', !!(this.hitSet && this.hitSet.has(id)));
      });
    }
  }

  window.RackView = RackView;
})();
