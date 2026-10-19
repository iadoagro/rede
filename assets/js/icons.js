/* Ícones de equipamentos (SVG inline, sem dependências) — usados na Topologia e no Tráfego.
   Cores vêm de variáveis CSS (--ni-*) para funcionar nos temas claro e escuro. */
(function () {
  const B = 'var(--ni-body,#f2f4f9)', E = 'var(--ni-edge,#c3cbdb)', D = 'var(--ni-dark,#4b566b)';
  const A = 'var(--ni-accent,#4f46e5)', L = 'var(--ni-led,#2fb344)', S = 'var(--ni-screen,#9db8f5)';

  const PARTS = {
    router: `
      <path d="M19 22 L13 7 M45 22 L51 7" stroke="${D}" stroke-width="2.8" stroke-linecap="round"/>
      <rect x="2" y="21" width="60" height="30" rx="6" fill="${B}" stroke="${E}" stroke-width="1.8"/>
      <circle cx="15" cy="32" r="4.2" fill="${D}"/>
      <g fill="${D}"><rect x="27" y="28" width="6.5" height="6.5" rx="1.2"/><rect x="36" y="28" width="6.5" height="6.5" rx="1.2"/><rect x="45" y="28" width="6.5" height="6.5" rx="1.2"/></g>
      <rect x="2.9" y="42" width="58.2" height="8.1" rx="0" fill="${E}" opacity=".55"/>
      <circle cx="54" cy="46" r="2" fill="${L}"/>`,
    switch: `
      <rect x="2" y="17" width="60" height="30" rx="5.5" fill="${B}" stroke="${E}" stroke-width="1.8"/>
      <g fill="${D}">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<rect x="${8 + i * 6.4}" y="24" width="4.6" height="4.6" rx="1"/>`).join('')}</g>
      <g fill="${D}" opacity=".55">${[0, 1, 2, 3, 4, 5, 6, 7].map(i => `<rect x="${8 + i * 6.4}" y="33" width="4.6" height="4.6" rx="1"/>`).join('')}</g>
      <circle cx="56" cy="22" r="1.7" fill="${L}"/>`,
    ap: `
      <circle cx="32" cy="32" r="23" fill="${B}" stroke="${E}" stroke-width="1.6"/>
      <circle cx="32" cy="32" r="15" fill="none" stroke="${E}" stroke-width="1.6"/>
      <circle cx="32" cy="32" r="5" fill="${A}" opacity=".85"/>`,
    server: `
      <rect x="13" y="7" width="38" height="50" rx="5" fill="${D}"/>
      <g fill="#2a3244">${[0, 1, 2, 3].map(i => `<rect x="17" y="${12 + i * 9}" width="24" height="6.4" rx="1.4"/>`).join('')}</g>
      <g fill="${L}">${[0, 1, 2, 3].map(i => `<circle cx="46" cy="${15.2 + i * 9}" r="1.7"/>`).join('')}</g>`,
    printer: `
      <rect x="18" y="8" width="28" height="15" rx="2.5" fill="#fff" stroke="${E}" stroke-width="1.6"/>
      <rect x="7" y="22" width="50" height="23" rx="5" fill="${B}" stroke="${E}" stroke-width="1.6"/>
      <rect x="16" y="38" width="32" height="17" rx="2.5" fill="#fff" stroke="${E}" stroke-width="1.6"/>
      <g stroke="${E}" stroke-width="1.4" stroke-linecap="round"><path d="M21 44h22M21 49h15"/></g>
      <circle cx="49" cy="29" r="2" fill="${L}"/>`,
    computer: `
      <rect x="7" y="9" width="50" height="34" rx="4" fill="${D}"/>
      <rect x="10.5" y="12.5" width="43" height="27" rx="1.8" fill="${S}"/>
      <path d="M28 43h8v8h-8z" fill="${E}"/>
      <rect x="19" y="50" width="26" height="4.5" rx="2.2" fill="${E}"/>`,
    internet: `
      <circle cx="32" cy="32" r="23" fill="#d7e8ff" stroke="#4a90e2" stroke-width="2"/>
      <ellipse cx="32" cy="32" rx="10.5" ry="23" fill="none" stroke="#4a90e2" stroke-width="1.7"/>
      <path d="M9 32h46M12 21.5h40M12 42.5h40" fill="none" stroke="#4a90e2" stroke-width="1.6"/>`,
    camera: `
      <path d="M11 41a21 21 0 0 1 42 0z" fill="${B}" stroke="${E}" stroke-width="1.6"/>
      <rect x="9" y="40" width="46" height="7" rx="3.5" fill="${E}"/>
      <circle cx="32" cy="32" r="7" fill="${D}"/><circle cx="32" cy="32" r="2.8" fill="${A}"/>`,
    phone: `
      <rect x="19" y="6" width="26" height="52" rx="6" fill="${D}"/>
      <rect x="22" y="12" width="20" height="34" rx="2" fill="${S}"/>
      <circle cx="32" cy="52" r="2.2" fill="${E}"/>`,
    group: `
      <g><rect x="4" y="15" width="30" height="21" rx="3" fill="${D}"/><rect x="6.5" y="17.5" width="25" height="15.5" rx="1.2" fill="${S}"/></g>
      <g><rect x="30" y="15" width="30" height="21" rx="3" fill="${D}"/><rect x="32.5" y="17.5" width="25" height="15.5" rx="1.2" fill="${S}"/></g>
      <g><rect x="17" y="30" width="30" height="21" rx="3" fill="${D}" stroke="${B}" stroke-width="2"/><rect x="19.5" y="32.5" width="25" height="15.5" rx="1.2" fill="${S}"/></g>`,
    device: `
      <rect x="10" y="10" width="44" height="44" rx="10" fill="${B}" stroke="${E}" stroke-width="1.6"/>
      <text x="32" y="40" text-anchor="middle" font-size="26" font-weight="700" fill="${E}" font-family="Inter,Arial,sans-serif">?</text>`,
  };

  function svg(kind, opts) {
    const o = opts || {};
    const size = o.size || 32;
    const body = PARTS[kind] || PARTS.device;
    return `<svg class="ni ni-${kind in PARTS ? kind : 'device'}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  // Palpite do tipo de ícone a partir do que o vizinho (LLDP/MNDP/CDP) anuncia.
  function guessKind(n) {
    const t = `${n.platform || ''} ${n.board || ''} ${n.identity || ''}`.toLowerCase();
    if (/ubiquiti|unifi|uap|\bu6\b|\bu7\b|cap\b|wap\b|\bap\b|access.?point|wifi|wi-fi|hap/.test(t)) return 'ap';
    if (/printer|impressora|epson|brother|canon|kyocera|laserjet|ricoh|xerox/.test(t)) return 'printer';
    if (/synology|qnap|nas\b|proxmox|esxi|vmware|server|servidor/.test(t)) return 'server';
    if (/cam\b|camera|câmera|hikvision|dahua|axis|ipcam/.test(t)) return 'camera';
    if (/phone|telefone|yealink|grandstream|fanvil/.test(t)) return 'phone';
    if (/crs|css\d|switch|sw-|\bsw\b/.test(t)) return 'switch';
    if (/mikrotik|routeros|ccr|rb\d|hex|router|roteador/.test(t)) return 'router';
    return 'device';
  }

  window.NetIcons = { svg, guessKind, kinds: Object.keys(PARTS) };
})();
