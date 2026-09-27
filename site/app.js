/* ============================================================================
   Masdar development pipeline — static single-page app.
   Reads data/latest.json and data/changes.json (written daily by
   scripts/build_data.py) and renders six views with hash routing.
   No build step, no framework: plain DOM + template strings.
   ========================================================================== */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const S = {
    data: null,
    changes: null,
    route: { view: 'overview', id: null },
    f: { groups: new Set(), tech: '', country: '', region: '', type: '', q: '' },
    table: { sort: { key: 'ac_mw', dir: -1 }, cols: null, dd: false },
    map: { sel: null, inst: null, mini: null },
    status: { tab: 'board' },
    project: { tab: 'summary' },
    quality: { level: 'all' },
    overview: { geo: 'country' },
  };

  const DEFAULT_COLS = ['name', 'stage_group', 'substage', 'technology', 'country', 'ac_mw', 'dc_mw',
    'bess_design_mwh', 'value_usdm', 'masdar_share_pct', 'epc_status'];

  const VIEWS = [
    { id: 'overview', label: 'Overview', icon: 'grid' },
    { id: 'projects', label: 'Projects', icon: 'list' },
    { id: 'map', label: 'Map', icon: 'map' },
    { id: 'status', label: 'Status & financing', icon: 'coins' },
    { id: 'changes', label: 'Daily changes', icon: 'clock' },
    { id: 'quality', label: 'Data quality', icon: 'check' },
  ];

  const ICONS = {
    grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    list: '<path d="M5 4h9M5 8h9M5 12h9"/><circle cx="2.2" cy="4" r=".6"/><circle cx="2.2" cy="8" r=".6"/><circle cx="2.2" cy="12" r=".6"/>',
    map: '<path d="M1.5 3.5l4-1.5 5 2 4-1.5v10l-4 1.5-5-2-4 1.5z"/><path d="M5.5 2v10M10.5 4v10"/>',
    coins: '<ellipse cx="8" cy="4" rx="5.5" ry="2"/><path d="M2.5 4v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4"/><path d="M2.5 8v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V8"/>',
    clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.5 1.5"/>',
    check: '<path d="M8 1.5l5.5 2v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z"/><path d="M5.5 8l1.8 1.8L10.8 6"/>',
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    download: '<path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/>',
    back: '<path d="M10 3L5 8l5 5"/>',
    cols: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11M10 2.5v11"/>',
  };
  const icon = (n, s = 16) => `<svg class="ico" width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = (v, d = 0) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const mw = (v) => (v == null ? '<span class="empty">—</span>' : nf(v, v % 1 ? 1 : 0));
  const gw = (v) => nf((v || 0) / 1000, 1);
  const usd = (v) => (v == null ? '<span class="empty">—</span>' : v >= 1000 ? `$${nf(v / 1000, 2)}bn` : `$${nf(v, v < 10 ? 1 : 0)}m`);
  const rng = (r, unit = '%') => (!r ? '<span class="empty">—</span>' : r[0] === r[1] ? `${nf(r[0], r[0] % 1 ? 1 : 0)}${unit}` : `${nf(r[0])}–${nf(r[1])}${unit}`);
  const mid = (r) => (r ? (r[0] + r[1]) / 2 : null);
  const txt = (v) => (v == null || v === '' ? '<span class="empty">—</span>' : esc(v));
  const fmtDate = (iso, time) => {
    if (!iso) return '—';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso);
    if (isNaN(d)) return esc(iso);
    const o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' };
    if (time) Object.assign(o, { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toLocaleString('en-GB', o) + (time ? ' GST' : '');
  };
  const plural = (n, w) => `${n} ${n === 1 ? w : w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's'}`;

  // ---------------------------------------------------------------------------
  // Stage groups
  // ---------------------------------------------------------------------------
  const groups = () => Object.entries(S.data.stage_groups).map(([id, g]) => ({ id, ...g })).sort((a, b) => a.order - b.order);
  const usedGroups = () => groups().filter((g) => g.id !== 'unmapped' || S.data.projects.some((p) => p.n.stage_group === 'unmapped'));
  const G = (id) => S.data.stage_groups[id] || S.data.stage_groups.unmapped;
  const stageChip = (id, long) => `<span class="chip stage" style="--c:${G(id).color}"><span class="dot"></span>${esc(long ? G(id).long : G(id).label)}</span>`;
  const epcChip = (s, bare) => {
    const cls = { 'Selected': 'ok', 'Shortlisted / in discussion': 'info', 'Tendering': 'warn', 'Not defined': 'neutral' }[s] || 'neutral';
    return `<span class="chip ${cls}">${bare ? '' : 'EPC · '}${esc(s)}</span>`;
  };
  const colLabel = (key) => (S.data.columns.find((c) => c.key === key) || { label: key }).label;

  // ---------------------------------------------------------------------------
  // Fields available in the projects table (harmonised + every raw CSV column)
  // ---------------------------------------------------------------------------
  function fieldDefs() {
    const n = (k) => (p) => p.n[k];
    const defs = [
      { key: 'name', label: 'Project', group: 'Harmonised', get: (p) => p.name.toLowerCase(),
        html: (p) => `<div class="td-name">${esc(p.name)}</div><div class="td-sub">${esc(p.n.manager || '')}</div>` },
      { key: 'stage_group', label: 'Stage', group: 'Harmonised', get: (p) => G(p.n.stage_group).order, html: (p) => stageChip(p.n.stage_group) },
      { key: 'stage', label: 'Stage (source)', group: 'Harmonised', get: n('stage'), html: (p) => txt(p.n.stage) },
      { key: 'substage', label: 'Sub-stage', group: 'Harmonised', get: n('substage'), html: (p) => txt(p.n.substage) },
      { key: 'technology', label: 'Technology', group: 'Harmonised', get: n('technology'), html: (p) => txt(p.n.technology) },
      { key: 'transaction_type', label: 'Type', group: 'Harmonised', get: n('transaction_type'), html: (p) => txt(p.n.transaction_type) },
      { key: 'country', label: 'Country', group: 'Harmonised', get: n('country'), html: (p) => `${txt(p.n.country)}<div class="td-sub">${esc(p.n.region || '')}</div>` },
      { key: 'region', label: 'Region', group: 'Harmonised', get: n('region'), html: (p) => txt(p.n.region) },
      { key: 'ac_mw', label: 'AC MW', group: 'Harmonised', num: true, get: n('ac_mw'), html: (p) => mw(p.n.ac_mw) },
      { key: 'dc_mw', label: 'DC MWp', group: 'Harmonised', num: true, get: n('dc_mw'), html: (p) => mw(p.n.dc_mw) },
      { key: 'bess_design_mwh', label: 'BESS MWh', group: 'Harmonised', num: true, get: n('bess_design_mwh'), html: (p) => mw(p.n.bess_design_mwh) },
      { key: 'bess_guaranteed_mwh', label: 'BESS guar. MWh', group: 'Harmonised', num: true, get: n('bess_guaranteed_mwh'), html: (p) => mw(p.n.bess_guaranteed_mwh) },
      { key: 'value_usdm', label: 'Value', group: 'Harmonised', num: true, get: n('value_usdm'), html: (p) => usd(p.n.value_usdm) },
      { key: 'masdar_share_pct', label: 'Masdar %', group: 'Harmonised', num: true, get: (p) => mid(p.n.masdar_share_pct), html: (p) => rng(p.n.masdar_share_pct) },
      { key: 'masdar_net_mw', label: 'Masdar net MW', group: 'Harmonised', num: true, get: netMW, html: (p) => mw(netMW(p)) },
      { key: 'debt_pct', label: 'Debt / equity', group: 'Harmonised', num: true, get: (p) => mid(p.n.debt_pct), html: splitBar },
      { key: 'lenders', label: 'Lenders', group: 'Harmonised', get: n('lenders'), html: (p) => txt(p.n.lenders), wide: true },
      { key: 'epc_status', label: 'EPC status', group: 'Harmonised', get: n('epc_status'), html: (p) => epcChip(p.n.epc_status, true) },
      { key: 'epc', label: 'EPC contractor', group: 'Harmonised', get: n('epc'), html: (p) => txt(p.n.epc), wide: true },
      { key: 'offtake_kind', label: 'Offtaker type', group: 'Harmonised', get: n('offtake_kind'), html: (p) => txt(p.n.offtake_kind) },
      { key: 'offtaker', label: 'Offtaker', group: 'Harmonised', get: n('offtaker'), html: (p) => txt(p.n.offtaker) },
      { key: 'offtake_years', label: 'PPA years', group: 'Harmonised', num: true, get: n('offtake_years'), html: (p) => mw(p.n.offtake_years) },
      { key: 'tariff_usc_kwh', label: 'Tariff USc/kWh (est.)', group: 'Harmonised', num: true, get: n('tariff_usc_kwh'), html: (p) => (p.n.tariff_usc_kwh == null ? '<span class="empty">—</span>' : nf(p.n.tariff_usc_kwh, 2)) },
      { key: 'life_years', label: 'Life (years)', group: 'Harmonised', num: true, get: n('life_years'), html: (p) => mw(p.n.life_years) },
      { key: 'budget_usdm', label: 'Approved budget', group: 'Harmonised', num: true, get: n('budget_usdm'), html: (p) => usd(p.n.budget_usdm) },
      { key: 'partners', label: 'Partners', group: 'Harmonised', get: (p) => p.n.partners.join(', '), html: (p) => txt(p.n.partners.join(', ')), wide: true },
      { key: 'flags', label: 'Data notes', group: 'Harmonised', num: true, get: (p) => p.flags.filter((f) => f.level !== 'info').length,
        html: (p) => { const k = p.flags.filter((f) => f.level !== 'info').length; return k ? `<span class="chip warn">${k}</span>` : '<span class="empty">0</span>'; } },
    ];
    for (const c of S.data.columns) {
      defs.push({ key: 'raw:' + c.key, label: c.label, group: 'CSV · ' + c.group, raw: true, get: (p) => p.raw[c.key] || '',
        html: (p) => txt(p.raw[c.key]), wide: (p) => (p.raw[c.key] || '').length > 40 });
    }
    return defs;
  }
  let FIELDS = [];
  const F = (k) => FIELDS.find((f) => f.key === k);

  function netMW(p) {
    const s = mid(p.n.masdar_share_pct);
    return s == null || p.n.ac_mw == null ? null : (p.n.ac_mw * s) / 100;
  }
  function splitBar(p) {
    const d = p.n.debt_pct;
    if (!d) return '<span class="empty">—</span>';
    return `<div class="split" title="Debt ${rng(d)} · Equity ${rng(p.n.equity_pct)}"><div class="d" style="width:${d[0]}%"></div><div class="rng" style="width:${d[1] - d[0]}%"></div><div class="e" style="flex:1"></div></div>
      <div class="split-lbl">Debt ${rng(d)} · Equity ${rng(p.n.equity_pct)}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------
  function filtered() {
    const f = S.f;
    const q = f.q.trim().toLowerCase();
    return S.data.projects.filter((p) => {
      if (f.groups.size && !f.groups.has(p.n.stage_group)) return false;
      if (f.tech && p.n.technology !== f.tech) return false;
      if (f.country && p.n.country !== f.country) return false;
      if (f.region && p.n.region !== f.region) return false;
      if (f.type && p.n.transaction_type !== f.type) return false;
      if (q) {
        const hay = (p.name + ' ' + Object.values(p.raw).join(' ') + ' ' + [p.n.country, p.n.technology, p.n.region].join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  const anyFilter = () => S.f.groups.size || S.f.tech || S.f.country || S.f.region || S.f.type || S.f.q;
  const distinct = (k) => [...new Set(S.data.projects.map((p) => p.n[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  function filterBar(list) {
    const all = S.data.projects;
    const sel = (key, label) => {
      const vals = distinct(key);
      return `<select class="fsel ${S.f[key === 'technology' ? 'tech' : key === 'transaction_type' ? 'type' : key] ? 'on' : ''}" data-filter="${key}" aria-label="${label}">
        <option value="">${label}: all</option>${vals.map((v) => `<option ${S.f[key === 'technology' ? 'tech' : key === 'transaction_type' ? 'type' : key] === v ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
    };
    return `<div class="filters">
      <span class="lbl">Stage</span>
      ${usedGroups().map((g) => `<button class="fchip ${S.f.groups.has(g.id) ? 'on' : ''}" style="--c:${g.color}" data-action="group" data-id="${g.id}">
        <span class="dot"></span>${esc(g.label)} <span class="n">${all.filter((p) => p.n.stage_group === g.id).length}</span></button>`).join('')}
      ${sel('technology', 'Technology')}${sel('country', 'Country')}${sel('region', 'Region')}${sel('transaction_type', 'Type')}
      ${anyFilter() ? '<button class="fclear" data-action="clear">Clear filters</button>' : ''}
      <span class="fcount">${list.length} of ${all.length} projects</span>
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Aggregation helpers
  // ---------------------------------------------------------------------------
  const sum = (list, fn) => list.reduce((a, p) => a + (fn(p) || 0), 0);
  function byKey(list, keyFn) {
    const m = new Map();
    for (const p of list) {
      const k = keyFn(p) || '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return [...m.entries()].map(([k, ps]) => ({ k, ps, mw: sum(ps, (p) => p.n.ac_mw) })).sort((a, b) => b.mw - a.mw);
  }
  function stackedBars(rows, action) {
    const max = Math.max(1, ...rows.map((r) => r.mw));
    return `<div class="hbars">${rows.map((r) => {
      const segs = usedGroups().map((g) => {
        const v = sum(r.ps.filter((p) => p.n.stage_group === g.id), (p) => p.n.ac_mw);
        return v ? `<i style="width:${(v / max) * 100}%;background:${g.color}" title="${esc(g.label)}: ${nf(v)} MW"></i>` : '';
      }).join('');
      return `<button class="hbar" data-action="${action}" data-id="${esc(r.k)}" title="Filter on ${esc(r.k)}">
        <span class="nm">${esc(r.k)}</span><span class="track">${segs}</span>
        <span class="val num">${gw(r.mw)} GW<small>${r.ps.length}</small></span></button>`;
    }).join('')}</div>
    <div class="legend">${usedGroups().map((g) => `<span style="--c:${g.color}"><i></i>${esc(g.label)}</span>`).join('')}<span class="muted">· number = projects</span></div>`;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  function viewOverview() {
    const list = filtered();
    const ac = sum(list, (p) => p.n.ac_mw);
    const dc = sum(list, (p) => p.n.dc_mw);
    const bess = sum(list, (p) => p.n.bess_design_mwh);
    const net = sum(list, netMW);
    const withShare = list.filter((p) => netMW(p) != null);
    const valued = list.filter((p) => p.n.value_usdm != null);
    const value = sum(valued, (p) => p.n.value_usdm);
    const countries = new Set(list.map((p) => p.n.country)).size;
    const last = S.changes && S.changes.changes[0];

    const steps = usedGroups().map((g) => {
      const ps = list.filter((p) => p.n.stage_group === g.id);
      const subs = byKey(ps, (p) => p.n.substage || 'Not specified').sort((a, b) => b.ps.length - a.ps.length);
      return `<button class="fstep" style="--c:${g.color}" data-action="group" data-id="${g.id}" title="Filter on ${esc(g.label)}">
        <div class="t">${esc(g.long)}</div>
        <div class="g num">${gw(sum(ps, (p) => p.n.ac_mw))} <small>GW AC</small></div>
        <div class="s">${plural(ps.length, 'project')} · ${usd(sum(ps, (p) => p.n.value_usdm)) }</div>
        <div class="sub">${subs.map((s) => `<div><span>${esc(s.k)}</span><b class="num">${s.ps.length}</b></div>`).join('') || '<div class="muted">—</div>'}</div>
      </button>`;
    }).join('');

    const flagged = S.data.projects.filter((p) => p.flags.some((f) => f.level !== 'info'));
    const geoRows = byKey(list, (p) => p.n[S.overview.geo]).slice(0, 14);

    return `
    <div class="page-h">
      <div class="eyebrow">Business development</div>
      <h1>Development pipeline</h1>
      <p>Projects in origination, development, bid and financing, from the BPD project summary. Snapshot of ${fmtDate(S.data.snapshot_date)}; refreshed every morning.</p>
    </div>
    ${filterBar(list)}
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="kpi"><div class="l">Projects</div><div class="v num">${list.length}</div><div class="d">${plural(countries, 'country')}</div></div>
      <div class="kpi t-cyan"><div class="l">Capacity AC</div><div class="v num">${gw(ac)}<small>GW</small></div><div class="d">${nf(dc / 1000, 1)} GWp DC</div></div>
      <div class="kpi t-teal"><div class="l">Masdar net capacity</div><div class="v num">${gw(net)}<small>GW</small></div><div class="d">Share-weighted · ${withShare.length}/${list.length} with a stated share</div></div>
      <div class="kpi t-violet"><div class="l">Storage (BESS)</div><div class="v num">${nf(bess / 1000, 1)}<small>GWh</small></div><div class="d">${plural(list.filter((p) => p.n.bess_design_mwh).length, 'project')} with storage</div></div>
      <div class="kpi t-amber"><div class="l">Project value</div><div class="v num">${value >= 1000 ? nf(value / 1000, 1) + '<small>$bn</small>' : nf(value) + '<small>$m</small>'}</div><div class="d">${valued.length}/${list.length} projects reporting a value</div></div>
    </div>

    <div class="card mb">
      <div class="card-h"><div><h2>Pipeline by stage</h2><div class="hint">Stage harmonised from the source “stage” field; sub-stage breakdown below each total. Click a stage to filter.</div></div></div>
      <div class="funnel" style="grid-template-columns:repeat(${usedGroups().length},1fr)">${steps}</div>
    </div>

    <div class="grid g2 mb">
      <div class="card">
        <div class="card-h"><div><h2>Capacity by technology</h2><div class="hint">GW AC, coloured by stage. Click to filter.</div></div></div>
        ${list.length ? stackedBars(byKey(list, (p) => p.n.technology), 'tech') : emptyState()}
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Capacity by ${S.overview.geo}</h2><div class="hint">GW AC, coloured by stage. Region is kept as typed in the source (some rows carry a city).</div></div>
          <div class="tools"><div class="seg">${['country', 'region'].map((g) => `<button class="${S.overview.geo === g ? 'on' : ''}" data-action="geo" data-id="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join('')}</div></div></div>
        ${list.length ? stackedBars(geoRows, S.overview.geo) : emptyState()}
      </div>
    </div>

    <div class="grid g3">
      <div class="card">
        <div class="card-h"><div><h2>Deal structure</h2><div class="hint">GW AC by transaction type and offtaker.</div></div></div>
        ${list.length ? plainBars([...byKey(list, (p) => p.n.transaction_type).map((r) => ({ ...r, k: r.k })), ...byKey(list, (p) => p.n.offtake_kind).map((r) => ({ ...r, k: 'Offtake · ' + r.k }))]) : emptyState()}
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Latest changes</h2><div class="hint">${last ? `${fmtDate(last.prev_date)} → ${fmtDate(last.date)}` : 'Compared day over day'}</div></div>
          <div class="tools"><a class="link" href="#/changes">All changes</a></div></div>
        ${last ? changeSummary(last) : `<div class="footnote">History starts on ${fmtDate(S.changes && S.changes.first_snapshot)}. Differences will appear here as soon as the source data changes.</div>`}
      </div>
      <div class="card">
        <div class="card-h"><div><h2>Data quality</h2><div class="hint">Issues found while harmonising the source file.</div></div>
          <div class="tools"><a class="link" href="#/quality">Review</a></div></div>
        <div class="kvs">
          <div class="kv"><span>Projects with items to fix or check</span><b class="num">${flagged.length} / ${S.data.projects.length}</b></div>
          <div class="kv"><span>Placed at country centre (no GPS)</span><b class="num">${S.data.projects.filter((p) => p.n.approx_location).length}</b></div>
          <div class="kv"><span>Template text left in fields</span><b class="num">${S.data.projects.filter((p) => p.flags.some((f) => /Template/.test(f.message))).length} projects</b></div>
          <div class="kv"><span>Numbers corrected vs. source</span><b class="num">${countFlags(/Source numeric/)}</b></div>
        </div>
      </div>
    </div>`;
  }

  function plainBars(rows) {
    const max = Math.max(1, ...rows.map((r) => r.mw));
    return `<div class="hbars">${rows.map((r) => `<div class="hbar"><span class="nm" title="${esc(r.k)}">${esc(r.k)}</span>
      <span class="track"><i style="width:${(r.mw / max) * 100}%;background:var(--m-blue-600)"></i></span>
      <span class="val num">${gw(r.mw)} GW<small>${r.ps.length}</small></span></div>`).join('')}</div>`;
  }
  const countFlags = (re) => S.data.projects.reduce((a, p) => a + p.flags.filter((f) => re.test(f.message)).length, 0);
  const emptyState = () => '<div class="empty-state"><b>No project matches</b>Change or clear the filters.</div>';

  function changeSummary(c) {
    const moves = c.changed.filter((x) => x.stage_move);
    const items = [];
    if (c.added.length) items.push(`<div class="kv"><span>New projects</span><b>${c.added.map(esc).join(', ')}</b></div>`);
    if (c.removed.length) items.push(`<div class="kv"><span>Removed</span><b>${c.removed.map(esc).join(', ')}</b></div>`);
    for (const m of moves) items.push(`<div class="kv"><span>${esc(m.name)}</span><b>${stageChip(m.stage_move[0])}<span class="arrow">→</span>${stageChip(m.stage_move[1])}</b></div>`);
    const other = c.changed.length - moves.length;
    if (other) items.push(`<div class="kv"><span>Other projects updated</span><b class="num">${other}</b></div>`);
    return `<div class="kvs">${items.join('') || '<div class="footnote">No change.</div>'}</div>`;
  }

  // --- Projects table --------------------------------------------------------
  function viewProjects() {
    const list = filtered();
    const cols = S.table.cols.map(F).filter(Boolean);
    const { key, dir } = S.table.sort;
    const sf = F(key) || F('ac_mw');
    const sorted = [...list].sort((a, b) => {
      const va = sf.get(a), vb = sf.get(b);
      if (va == null || va === '') return 1;
      if (vb == null || vb === '') return -1;
      return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true })) * dir;
    });
    const totals = { ac_mw: sum(list, (p) => p.n.ac_mw), dc_mw: sum(list, (p) => p.n.dc_mw), bess_design_mwh: sum(list, (p) => p.n.bess_design_mwh),
      bess_guaranteed_mwh: sum(list, (p) => p.n.bess_guaranteed_mwh), value_usdm: sum(list, (p) => p.n.value_usdm), masdar_net_mw: sum(list, netMW) };

    return `
    <div class="page-h"><div class="eyebrow">Business development</div><h1>Projects</h1>
      <p>Every project in the source file. Use <b>Columns</b> to show any of the ${S.data.columns.length} CSV fields next to the harmonised values. Click a row for the full record.</p></div>
    ${filterBar(list)}
    <div class="card pad-0">
      <div class="card-h" style="padding:14px 16px 0;margin-bottom:10px">
        <div><h2>${plural(list.length, 'project')}</h2><div class="hint">${cols.length} columns shown · sorted by ${esc(sf.label)} ${dir > 0 ? 'ascending' : 'descending'}</div></div>
        <div class="tools">
          <div class="dd">
            <button class="btn ghost sm" data-action="dd">${icon('cols', 14)} Columns</button>
            ${S.table.dd ? columnMenu() : ''}
          </div>
          <button class="btn ghost sm" data-action="export">${icon('download', 14)} Export view</button>
          <a class="btn ghost sm" href="${esc(S.data.snapshot_file)}" download>${icon('download', 14)} Source CSV</a>
        </div>
      </div>
      <div class="tbl-scroll first-col">
        <table>
          <thead><tr>${cols.map((c) => `<th class="sortable ${c.num ? 'r' : ''} ${c.key === key ? 'sorted' : ''}" data-action="sort" data-id="${esc(c.key)}">${esc(c.label)}<span class="caret">${c.key === key ? (dir > 0 ? '▲' : '▼') : '▾'}</span></th>`).join('')}</tr></thead>
          <tbody>${sorted.map((p) => `<tr class="rowlink" data-href="#/project/${esc(p.id)}">${cols.map((c) => {
            const wide = typeof c.wide === 'function' ? c.wide(p) : c.wide;
            return `<td class="${c.num ? 'r num' : ''} ${wide ? 'wrap-text' : ''}">${c.html(p)}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
          ${list.length ? `<tfoot><tr>${cols.map((c, i) => `<td class="${c.num ? 'r num' : ''}" style="font-weight:800;border-top:1.5px solid var(--line)">${i === 0 ? 'Total' : c.key in totals ? (c.key === 'value_usdm' ? usd(totals[c.key]) : nf(totals[c.key])) : ''}</td>`).join('')}</tr></tfoot>` : ''}
        </table>
        ${list.length ? '' : emptyState()}
      </div>
    </div>`;
  }

  function columnMenu() {
    const byGroup = {};
    for (const f of FIELDS) (byGroup[f.group] = byGroup[f.group] || []).push(f);
    return `<div class="dd-menu" data-stop>
      <div class="bar"><button class="btn sm" data-action="cols-all">All CSV fields</button><button class="btn ghost sm" data-action="cols-reset">Default</button></div>
      ${Object.entries(byGroup).map(([g, fs]) => `<div class="grp">${esc(g)}<button data-action="cols-group" data-id="${esc(g)}">toggle</button></div>
        ${fs.map((f) => `<label><input type="checkbox" data-col="${esc(f.key)}" ${S.table.cols.includes(f.key) ? 'checked' : ''} ${f.key === 'name' ? 'disabled' : ''}> ${esc(f.label)}</label>`).join('')}`).join('')}
    </div>`;
  }

  function exportCSV() {
    const list = filtered();
    const cols = S.data.columns.map((c) => c.key);
    const extra = ['stage_group', 'technology', 'country', 'ac_mw', 'dc_mw', 'value_usdm', 'masdar_share_pct', 'lat', 'lon', 'approx_location'];
    const q = (v) => `"${String(v == null ? '' : Array.isArray(v) ? v.join('-') : v).replace(/"/g, '""')}"`;
    const lines = [[...cols, ...extra.map((k) => 'harmonised_' + k)].map(q).join(',')];
    for (const p of list) lines.push([...cols.map((k) => p.raw[k]), ...extra.map((k) => p.n[k])].map(q).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dev-pipeline-${S.data.snapshot_date}${anyFilter() ? '-filtered' : ''}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // --- Map -------------------------------------------------------------------
  function viewMap() {
    const list = filtered().filter((p) => p.n.lat != null);
    const missing = filtered().length - list.length;
    const sel = list.find((p) => p.id === S.map.sel);
    return `
    <div class="page-h"><div class="eyebrow">Business development</div><h1>Pipeline map</h1>
      <p>Solid markers use the project coordinates; dashed markers have no GPS in the source and sit at the country centre. Marker size follows AC capacity.</p></div>
    ${filterBar(filtered())}
    <div class="map-shell">
      <div class="map-canvas"><div id="map" style="position:absolute;inset:0"></div>
        <div class="map-legend">${usedGroups().map((g) => `<div class="li"><span class="lg-dot" style="--c:${g.color}"></span>${esc(g.label)}</div>`).join('')}
          <div class="li"><span class="lg-dot approx"></span>Approximate location</div></div>
      </div>
      <div class="map-side">
        <div class="ms-head"><div class="ms-title">${plural(list.length, 'project')}${missing ? ` · ${missing} not placed` : ''}</div></div>
        <div class="ms-body">${[...list].sort((a, b) => (b.n.ac_mw || 0) - (a.n.ac_mw || 0)).map((p) => `
          <button class="ms-item ${p.id === S.map.sel ? 'on' : ''}" data-action="map-sel" data-id="${esc(p.id)}">
            <span class="sw ${p.n.approx_location ? 'approx' : ''}" style="--c:${G(p.n.stage_group).color}"></span>
            <span style="min-width:0"><div class="nm">${esc(p.name)}</div><div class="sub">${esc(p.n.country)} · ${esc(p.n.technology)}</div></span>
            <span class="val num">${mw(p.n.ac_mw)}<div class="sub">MW</div></span>
          </button>`).join('')}</div>
        ${sel ? `<div class="ms-detail">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap">${stageChip(sel.n.stage_group)}${sel.n.substage ? `<span class="chip neutral">${esc(sel.n.substage)}</span>` : ''}</div>
          <div class="kvs">
            <div class="kv"><span>Capacity</span><b>${mw(sel.n.ac_mw)} MW AC${sel.n.dc_mw ? ` · ${mw(sel.n.dc_mw)} MWp` : ''}</b></div>
            <div class="kv"><span>Offtaker</span><b>${txt(sel.n.offtaker || sel.n.offtake_kind)}</b></div>
            <div class="kv"><span>Masdar share</span><b>${rng(sel.n.masdar_share_pct)}</b></div>
            <div class="kv"><span>Value</span><b>${usd(sel.n.value_usdm)}</b></div>
            <div class="kv"><span>Location</span><b>${sel.n.approx_location ? 'Country centre (no GPS)' : `${nf(sel.n.lat, 3)}, ${nf(sel.n.lon, 3)}`}</b></div>
          </div>
          <a class="btn block" href="#/project/${esc(sel.id)}">Open project</a></div>` : ''}
      </div>
    </div>`;
  }

  function tileLayer() {
    const dark = document.documentElement.getAttribute('data-theme') === 'low-carbon';
    const base = dark ? 'World_Dark_Gray_Base' : 'World_Light_Gray_Base';
    return L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${base}/MapServer/tile/{z}/{y}/{x}`, {
      attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16,
    });
  }

  // Spread projects that share a country centre so their markers don't stack.
  function positions(list) {
    const out = new Map();
    const byCountry = {};
    for (const p of list) {
      if (p.n.lat == null) continue;
      if (p.n.approx_location) (byCountry[p.n.country] = byCountry[p.n.country] || []).push(p);
      else out.set(p.id, [p.n.lat, p.n.lon]);
    }
    for (const ps of Object.values(byCountry)) {
      ps.forEach((p, i) => {
        const r = ps.length > 1 ? 0.9 : 0;
        const a = (i / ps.length) * Math.PI * 2;
        out.set(p.id, [p.n.lat + r * Math.sin(a), p.n.lon + r * Math.cos(a)]);
      });
    }
    return out;
  }

  function markerIcon(p, selected) {
    const d = Math.round(10 + Math.sqrt(p.n.ac_mw || 50) * 0.36);
    return L.divIcon({
      className: 'mk-wrap', iconSize: [0, 0],
      html: `<div class="mk ${p.n.approx_location ? 'approx' : ''} ${selected ? 'sel' : ''}" style="--c:${G(p.n.stage_group).color}"><div class="core" style="width:${d}px;height:${d}px"></div></div>`,
    });
  }

  function mountMap() {
    if (typeof L === 'undefined') { document.getElementById('map').innerHTML = '<div class="empty-state"><b>Map library unavailable</b>Check the network connection.</div>'; return; }
    const list = filtered().filter((p) => p.n.lat != null);
    const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([30, 55], 3);
    tileLayer().addTo(map);
    const pos = positions(list);
    const pts = [];
    for (const p of [...list].sort((a, b) => (b.n.ac_mw || 0) - (a.n.ac_mw || 0))) {
      const ll = pos.get(p.id);
      pts.push(ll);
      L.marker(ll, { icon: markerIcon(p, p.id === S.map.sel), zIndexOffset: p.id === S.map.sel ? 1000 : 0 })
        .bindTooltip(`${esc(p.name)} · ${mw(p.n.ac_mw)} MW`, { className: 'mk-tip', direction: 'top', offset: [0, -8] })
        .on('click', () => { S.map.sel = p.id; S.map.keepView = true; renderContent(); })
        .addTo(map);
    }
    if (S.map.focus && pos.get(S.map.sel)) map.setView(pos.get(S.map.sel), Math.max(5, S.map.view ? S.map.view.z : 5));
    else if (S.map.keepView && S.map.view) map.setView(S.map.view.c, S.map.view.z);
    else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.1), { maxZoom: 6 });
    S.map.keepView = false;
    S.map.focus = false;
    map.on('moveend', () => { S.map.view = { c: map.getCenter(), z: map.getZoom() }; });
    S.map.inst = map;
    const selItem = document.querySelector('.ms-item.on');
    if (selItem) selItem.scrollIntoView({ block: 'nearest' });
  }

  // --- Status & financing ----------------------------------------------------
  function viewStatus() {
    const list = filtered();
    const epcCounts = byKey(list, (p) => p.n.epc_status);
    const tabs = [['board', 'Board by stage'], ['table', 'Financing table']];
    const withDebt = list.filter((p) => p.n.debt_pct);
    const avgDebt = withDebt.length ? sum(withDebt, (p) => mid(p.n.debt_pct)) / withDebt.length : null;
    const budgets = list.filter((p) => p.n.budget_note || p.n.budget_usdm != null).length;
    return `
    <div class="page-h"><div class="eyebrow">Business development</div><h1>Status &amp; financing</h1>
      <p>Where each project stands: stage and sub-stage, EPC procurement, funding structure, shareholding and approved development budget.</p></div>
    ${filterBar(list)}
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      ${['Selected', 'Shortlisted / in discussion', 'Tendering', 'Not defined'].map((s, i) => {
        const r = epcCounts.find((x) => x.k === s);
        return `<div class="kpi ${['t-teal', 't-cyan', 't-amber', ''][i]}"><div class="l">EPC · ${esc(s)}</div><div class="v num">${r ? r.ps.length : 0}</div><div class="d">${r ? gw(r.mw) : '0.0'} GW AC</div></div>`;
      }).join('')}
      <div class="kpi t-violet"><div class="l">Average gearing</div><div class="v num">${avgDebt == null ? '—' : nf(avgDebt)}<small>% debt</small></div><div class="d">${withDebt.length}/${list.length} with a stated split · ${budgets} with budget info</div></div>
    </div>
    <div class="tabs">${tabs.map(([id, l]) => `<button class="${S.status.tab === id ? 'on' : ''}" data-action="status-tab" data-id="${id}">${l}</button>`).join('')}</div>
    ${list.length ? (S.status.tab === 'board' ? statusBoard(list) : financingTable(list)) : emptyState()}`;
  }

  function statusBoard(list) {
    return `<div class="board" style="grid-template-columns:repeat(${usedGroups().length},minmax(250px,1fr))">${usedGroups().map((g) => {
      const ps = list.filter((p) => p.n.stage_group === g.id).sort((a, b) => (b.n.ac_mw || 0) - (a.n.ac_mw || 0));
      return `<div class="col" style="--c:${g.color}">
        <div class="col-h"><span class="dot"></span><b>${esc(g.long)}</b><span>${ps.length} · ${gw(sum(ps, (p) => p.n.ac_mw))} GW</span></div>
        ${ps.map((p) => `<a class="bcard" href="#/project/${esc(p.id)}" style="--c:${g.color}">
          <div class="nm">${esc(p.name)}</div>
          <div class="meta">${esc(p.n.country)} · ${esc(p.n.technology)} · ${mw(p.n.ac_mw)} MW · ${esc(p.n.stage)}</div>
          <div class="row">${p.n.substage ? `<span class="chip neutral">${esc(p.n.substage)}</span>` : ''}${epcChip(p.n.epc_status)}</div>
          <div class="fin">${splitBar(p)}</div>
          <div class="kvs" style="margin-top:6px">
            <div class="kv"><span>Masdar</span><b>${rng(p.n.masdar_share_pct)}</b></div>
            ${p.n.epc ? `<div class="kv stack"><span>EPC</span><b>${esc(p.n.epc)}</b></div>` : ''}
            ${p.n.budget_note || p.n.budget_usdm != null ? `<div class="kv stack"><span>Budget</span><b>${p.n.budget_usdm != null ? usd(p.n.budget_usdm) + ' · ' : ''}${txt(p.n.budget_note)}</b></div>` : ''}
          </div>
        </a>`).join('') || '<div class="footnote" style="padding:8px">No project</div>'}
      </div>`;
    }).join('')}</div>`;
  }

  function financingTable(list) {
    const rows = [...list].sort((a, b) => G(a.n.stage_group).order - G(b.n.stage_group).order || (b.n.ac_mw || 0) - (a.n.ac_mw || 0));
    return `<div class="card pad-0"><div class="tbl-scroll first-col"><table>
      <thead><tr><th>Project</th><th>Stage</th><th>EPC</th><th>Debt / equity</th><th>Lenders</th><th>Shareholders</th><th class="r">Masdar</th><th>Approved budget</th><th class="r">Value</th><th>Tariff (source)</th><th class="r">USc/kWh est.</th></tr></thead>
      <tbody>${rows.map((p) => `<tr class="rowlink" data-href="#/project/${esc(p.id)}">
        <td><div class="td-name">${esc(p.name)}</div><div class="td-sub">${esc(p.n.country)} · ${mw(p.n.ac_mw)} MW</div></td>
        <td>${stageChip(p.n.stage_group)}<div class="td-sub">${esc(p.n.substage || p.n.stage)}</div></td>
        <td class="wrap-text">${epcChip(p.n.epc_status)}<div class="td-sub">${esc(p.n.epc || '')}</div></td>
        <td>${splitBar(p)}</td>
        <td class="wrap-text">${txt(p.n.lenders)}</td>
        <td class="wrap-text">${txt(p.raw.shareholders)}</td>
        <td class="r num">${rng(p.n.masdar_share_pct)}</td>
        <td class="wrap-text">${p.n.budget_usdm != null ? `<b>${usd(p.n.budget_usdm)}</b> · ` : ''}${txt(p.n.budget_note)}</td>
        <td class="r num">${usd(p.n.value_usdm)}</td>
        <td>${txt(p.raw.tariff_per_kwh)}</td>
        <td class="r num">${p.n.tariff_usc_kwh == null ? '<span class="empty">—</span>' : nf(p.n.tariff_usc_kwh, 2)}</td>
      </tr>`).join('')}</tbody></table></div></div>
      <p class="footnote" style="margin-top:10px">Tariff units are not consistent in the source. The estimate reads values below 0.2 as USD/kWh and values between 1 and 20 as US cents/kWh; anything else is left blank.</p>`;
  }

  // --- Changes ---------------------------------------------------------------
  function viewChanges() {
    const ch = S.changes || { changes: [], snapshots: 0 };
    const fieldLine = (f) => `<div class="c">${esc(colLabel(f.col))}</div><div>${f.from ? `<del>${esc(f.from)}</del>` : '<span class="muted">empty</span>'}<span class="arrow">→</span>${f.to ? `<ins>${esc(f.to)}</ins>` : '<span class="muted">empty</span>'}</div>`;
    return `
    <div class="page-h"><div class="eyebrow">History</div><h1>Daily changes</h1>
      <p>Each morning the source file is compared with the previous snapshot. A new snapshot is archived only when the data changes. ${plural(ch.snapshots, 'snapshot')} archived since ${fmtDate(ch.first_snapshot)}.</p></div>
    ${ch.changes.length ? `<div class="timeline">${ch.changes.map((c) => `
      <div class="tl-day"><h2>${fmtDate(c.date)} <span class="chip neutral">vs ${fmtDate(c.prev_date)}</span>
        ${c.added.length ? `<span class="chip ok">+${c.added.length} new</span>` : ''}${c.removed.length ? `<span class="chip bad">−${c.removed.length} removed</span>` : ''}
        ${c.changed.length ? `<span class="chip brand">${c.changed.length} updated</span>` : ''}
        <a class="link" style="font-size:11.5px;margin-left:auto" href="data/history/${esc(c.date)}.csv" download>Snapshot CSV</a></h2>
        <div class="card">
          ${c.added.map((n) => `<div class="chg"><div class="nm"><span class="chip ok">New</span>${projLink(n)}</div></div>`).join('')}
          ${c.removed.map((n) => `<div class="chg"><div class="nm"><span class="chip bad">Removed</span>${esc(n)}</div></div>`).join('')}
          ${c.changed.map((x) => `<div class="chg"><div class="nm">${projLink(x.name, x.id)}${x.stage_move ? `${stageChip(x.stage_move[0])}<span class="arrow">→</span>${stageChip(x.stage_move[1])}` : ''}</div>
            <div class="fdiff">${x.fields.map(fieldLine).join('')}</div></div>`).join('')}
        </div></div>`).join('')}</div>`
    : `<div class="card"><div class="empty-state"><b>No change recorded yet</b>History starts on ${fmtDate(ch.first_snapshot)}. The comparison appears after the first day the source data changes.</div></div>`}`;
  }
  function projLink(name, id) {
    const p = S.data.projects.find((x) => x.id === id || x.name === name);
    return p ? `<a class="link" href="#/project/${esc(p.id)}">${esc(name)}</a>` : esc(name);
  }

  // --- Data quality ----------------------------------------------------------
  function viewQuality() {
    const lv = S.quality.level;
    const all = S.data.projects.flatMap((p) => p.flags.map((f) => ({ ...f, p })));
    const counts = { bad: 0, warn: 0, info: 0 };
    all.forEach((f) => counts[f.level]++);
    const shown = S.data.projects.map((p) => ({ p, fl: p.flags.filter((f) => lv === 'all' || f.level === lv) })).filter((x) => x.fl.length)
      .sort((a, b) => b.fl.filter((f) => f.level !== 'info').length - a.fl.filter((f) => f.level !== 'info').length);
    const levels = [['all', 'All', all.length], ['bad', 'To fix', counts.bad], ['warn', 'To check', counts.warn], ['info', 'Info', counts.info]];
    return `
    <div class="page-h"><div class="eyebrow">Source file</div><h1>Data quality</h1>
      <p>What the harmonisation step found in the BPD project summary. <b>To fix</b> and <b>To check</b> items should be corrected at the source by the project teams; <b>Info</b> items are handled automatically. Spelling variants are harmonised through <code>config/mappings.json</code>.</p></div>
    <div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <div class="kpi"><div class="l">Projects with notes</div><div class="v num">${new Set(all.map((f) => f.p.id)).size}<small>/ ${S.data.projects.length}</small></div></div>
      <div class="kpi" style="--accent:var(--m-red)"><div class="l">To fix</div><div class="v num">${counts.bad}</div></div>
      <div class="kpi t-amber"><div class="l">To check</div><div class="v num">${counts.warn}</div></div>
      <div class="kpi t-cyan"><div class="l">Info</div><div class="v num">${counts.info}</div></div>
    </div>
    <div class="tabs">${levels.map(([id, l, n]) => `<button class="${lv === id ? 'on' : ''}" data-action="q-level" data-id="${id}">${l}<span class="n">${n}</span></button>`).join('')}</div>
    <div class="grid g2">${shown.map(({ p, fl }) => `<div class="card">
      <div class="card-h"><div><h2><a class="link" href="#/project/${esc(p.id)}">${esc(p.name)}</a></h2><div class="hint">${esc(p.n.country)} · ${esc(p.n.manager || 'No manager')}</div></div>
        <div class="tools">${stageChip(p.n.stage_group)}</div></div>
      ${flagList(fl)}</div>`).join('') || '<div class="card"><div class="empty-state"><b>Nothing here</b></div></div>'}</div>`;
  }
  const flagList = (fl) => fl.map((f) => `<div class="flag"><span class="ic ${f.level}"></span><span class="f">${esc(colLabel(f.field))}</span><span>${esc(f.message)}</span></div>`).join('');

  // --- Project page ----------------------------------------------------------
  function viewProject(id) {
    const p = S.data.projects.find((x) => x.id === id);
    if (!p) return `<div class="card"><div class="empty-state"><b>Project not found</b>It may have been renamed or removed from the source. <a class="link" href="#/projects">Back to projects</a></div></div>`;
    const n = p.n;
    const hist = (S.changes ? S.changes.changes : []).map((c) => ({ c, x: c.changed.find((x) => x.id === p.id), added: c.added.includes(p.name) })).filter((h) => h.x || h.added);
    const tabs = [['summary', 'Summary'], ['fields', 'All CSV fields', S.data.columns.length], ['history', 'History', hist.length], ['quality', 'Data quality', p.flags.length]];
    const t = S.project.tab;
    return `
    <div class="asset-head">
      <a class="back" href="#/projects">${icon('back', 12)} All projects</a>
      <div class="ah-top">
        <div><h1>${esc(p.name)}</h1><div class="ah-loc">${esc(n.country)} · ${esc(n.region)} · ${esc(n.transaction_type)}${n.manager ? ' · PM ' + esc(n.manager) : ''}</div></div>
        <div class="ah-mode"><span class="chip" style="--c:${G(n.stage_group).color}"><span class="dot"></span>${esc(G(n.stage_group).long)}</span>
          <div class="sub">${esc(n.stage)}${n.substage ? ' · ' + esc(n.substage) : ''}</div></div>
      </div>
      <div class="idgrid">
        <div><div class="l">Technology</div><div class="v">${esc(n.technology)}</div></div>
        <div><div class="l">Capacity</div><div class="v num">${mw(n.ac_mw)} MW AC${n.dc_mw ? `<br>${mw(n.dc_mw)} MWp DC` : ''}</div></div>
        <div><div class="l">Storage</div><div class="v num">${n.bess_design_mwh ? `${mw(n.bess_design_mwh)} MWh` : '—'}</div></div>
        <div><div class="l">Project value</div><div class="v num">${n.value_usdm == null ? esc(p.raw.project_value_usdm || '—') : usd(n.value_usdm)}</div></div>
        <div><div class="l">Masdar share</div><div class="v num">${rng(n.masdar_share_pct)}</div></div>
        <div><div class="l">Offtaker</div><div class="v">${txt(n.offtaker || n.offtake_kind)}</div></div>
      </div>
    </div>
    <div class="tabs">${tabs.map(([tid, l, k]) => `<button class="${t === tid ? 'on' : ''}" data-action="p-tab" data-id="${tid}">${l}${k != null ? `<span class="n">${k}</span>` : ''}</button>`).join('')}</div>
    ${t === 'summary' ? projectSummary(p) : t === 'fields' ? projectFields(p) : t === 'history' ? projectHistory(p, hist) : `<div class="card">${p.flags.length ? flagList(p.flags) : '<div class="empty-state"><b>No data note</b></div>'}</div>`}`;
  }

  function projectSummary(p) {
    const n = p.n;
    const kv = (l, v) => `<div class="kv"><span>${l}</span><b>${v}</b></div>`;
    return `<div class="grid g3 mb">
      <div class="card"><h2 style="margin-bottom:8px">Status</h2><div class="kvs">
        ${kv('Stage', stageChip(n.stage_group, true))}${kv('Stage (source)', txt(n.stage))}${kv('Sub-stage', txt(n.substage))}
        ${kv('EPC', epcChip(n.epc_status))}${kv('EPC contractor', txt(n.epc))}${kv('Project manager', txt(n.manager))}</div></div>
      <div class="card"><h2 style="margin-bottom:8px">Financing</h2><div class="kvs">
        ${kv('Funding plan', txt(p.raw.funding_plan))}</div><div style="margin:8px 0 6px">${splitBar(p)}</div><div class="kvs">
        ${kv('Lenders', txt(n.lenders))}${kv('Shareholders', txt(p.raw.shareholders))}${kv('Masdar share', rng(n.masdar_share_pct))}
        ${kv('Masdar net capacity', netMW(p) == null ? '—' : mw(netMW(p)) + ' MW')}
        ${kv('Approved budget', n.budget_usdm != null ? usd(n.budget_usdm) : txt(p.raw.approved_budget))}${kv('Budget note', txt(n.budget_note))}
        ${kv('Project value', n.value_usdm != null ? usd(n.value_usdm) : txt(p.raw.project_value_usdm))}</div></div>
      <div class="card"><h2 style="margin-bottom:8px">Commercial &amp; technical</h2><div class="kvs">
        ${kv('Offtake', txt(p.raw.offtake_type))}${kv('Offtake term', txt(p.raw.offtake_term_years))}
        ${kv('Tariff (source)', txt(p.raw.tariff_per_kwh))}${kv('Tariff est.', n.tariff_usc_kwh == null ? '—' : nf(n.tariff_usc_kwh, 2) + ' USc/kWh')}
        ${kv('Project life', txt(p.raw.project_life_years))}${kv('AC / DC', `${mw(n.ac_mw)} MW / ${mw(n.dc_mw)} MWp`)}
        ${kv('BESS design / guaranteed', `${mw(n.bess_design_mwh)} / ${mw(n.bess_guaranteed_mwh)} MWh`)}</div></div>
    </div>
    <div class="card pad-0"><div style="position:relative;height:320px"><div id="minimap" style="position:absolute;inset:0"></div></div>
      <div class="footnote" style="padding:10px 16px">${n.lat == null ? 'No location available.' : n.approx_location ? 'No coordinates in the source — shown at the centre of ' + esc(n.country) + '.' : `Coordinates ${nf(n.lat, 5)}, ${nf(n.lon, 5)}`}</div></div>`;
  }

  function projectFields(p) {
    const cleaned = {
      stage: p.n.stage, substage: p.n.substage, technology: p.n.technology, transaction_type: p.n.transaction_type, country: p.n.country, region: p.n.region,
      capacity_ac_mw: p.n.ac_mw, capacity_dc_mw: p.n.dc_mw, bess_design_mwh: p.n.bess_design_mwh, bess_guaranteed_mwh: p.n.bess_guaranteed_mwh,
      project_value_usdm: p.n.value_usdm, tariff_per_kwh: p.n.tariff_usc_kwh != null ? p.n.tariff_usc_kwh + ' USc/kWh (est.)' : null,
      offtake_term_years: p.n.offtake_years, project_life_years: p.n.life_years, epc_contractor: p.n.epc, approved_budget_note: p.n.budget_note,
      latitude: p.n.approx_location ? p.n.lat + ' (country centre)' : null, longitude: p.n.approx_location ? p.n.lon + ' (country centre)' : null,
    };
    let lastGroup = null;
    const order = [...new Set(S.data.columns.map((c) => c.group))];
    const cols = [...S.data.columns].sort((x, y) => order.indexOf(x.group) - order.indexOf(y.group));
    const rows = cols.map((c) => {
      let head = '';
      if (c.group !== lastGroup) { head = `<tr class="grp"><td colspan="3">${esc(c.group)}</td></tr>`; lastGroup = c.group; }
      const cv = cleaned[c.key];
      const same = cv == null || String(cv) === p.raw[c.key] || Number(cv) === Number(p.raw[c.key]);
      return `${head}<tr><td>${esc(c.label)}<div class="td-sub">${esc(c.key)}</div></td><td>${txt(p.raw[c.key])}</td><td class="${same ? '' : 'diffv'}">${same ? '<span class="empty">same</span>' : esc(cv)}</td></tr>`;
    }).join('');
    return `<div class="card pad-0"><div class="tbl-scroll" style="max-height:none"><table class="fields">
      <thead><tr><th>Field</th><th>Source value (CSV)</th><th>Harmonised</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  function projectHistory(p, hist) {
    if (!hist.length) return `<div class="card"><div class="empty-state"><b>No change recorded</b>Since ${fmtDate(S.changes && S.changes.first_snapshot)}.</div></div>`;
    return `<div class="timeline">${hist.map(({ c, x, added }) => `<div class="tl-day"><h2>${fmtDate(c.date)}</h2><div class="card">
      ${added ? '<span class="chip ok">Added to the pipeline</span>' : ''}
      ${x ? `${x.stage_move ? `<div style="margin-bottom:8px">${stageChip(x.stage_move[0])}<span class="arrow">→</span>${stageChip(x.stage_move[1])}</div>` : ''}
        <div class="fdiff">${x.fields.map((f) => `<div class="c">${esc(colLabel(f.col))}</div><div>${f.from ? `<del>${esc(f.from)}</del>` : '<span class="muted">empty</span>'}<span class="arrow">→</span>${f.to ? `<ins>${esc(f.to)}</ins>` : '<span class="muted">empty</span>'}</div>`).join('')}</div>` : ''}
    </div></div>`).join('')}</div>`;
  }

  function mountMiniMap(id) {
    const p = S.data.projects.find((x) => x.id === id);
    const el = document.getElementById('minimap');
    if (!el || !p || p.n.lat == null || typeof L === 'undefined') return;
    const m = L.map(el, { scrollWheelZoom: false, attributionControl: true }).setView([p.n.lat, p.n.lon], p.n.approx_location ? 5 : 8);
    tileLayer().addTo(m);
    L.marker([p.n.lat, p.n.lon], { icon: markerIcon(p, true) }).addTo(m);
    S.map.mini = m;
  }

  // ---------------------------------------------------------------------------
  // Shell + rendering
  // ---------------------------------------------------------------------------
  function renderShell() {
    const d = S.data;
    const flagged = d.projects.filter((p) => p.flags.some((f) => f.level === 'bad' || f.level === 'warn')).length;
    const lastChange = S.changes && S.changes.changes[0];
    const stale = Date.now() - new Date(d.last_checked).getTime() > 36 * 3600 * 1000;
    const theme = document.documentElement.getAttribute('data-theme');
    document.getElementById('root').innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="sb-brand"><img class="sb-logo" src="assets/masdar-logo.png" alt="Masdar"><div class="sb-mark"><img src="assets/masdar-logo.png" alt=""></div>
          <div class="t2">Development pipeline</div></div>
        <nav class="sb-nav"><div class="sb-grp">Pipeline</div>
          ${VIEWS.map((v) => `${v.id === 'changes' ? '<div class="sb-grp">Tracking</div>' : ''}<a class="sb-link" data-view="${v.id}" href="#/${v.id}">${icon(v.icon)}<span class="lbl">${v.label}</span>
            ${v.id === 'projects' ? `<span class="tail">${d.projects.length}</span>` : ''}
            ${v.id === 'quality' && flagged ? `<span class="tail alert">${flagged}</span>` : ''}
            ${v.id === 'changes' && lastChange ? `<span class="tail">${fmtDate(lastChange.date).replace(/ \d{4}$/, '')}</span>` : ''}</a>`).join('')}
        </nav>
        <div class="sb-foot">Source <b>BPD project summary</b><br>Snapshot <b>${fmtDate(d.snapshot_date)}</b><br>Last checked ${fmtDate(d.last_checked, true)}</div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="crumb" id="crumb"></div>
          <div class="tb-spacer"></div>
          ${stale ? `<span class="badge-stale" title="The daily refresh has not run since ${fmtDate(d.last_checked, true)}">Not refreshed since ${fmtDate(d.last_checked)}</span>` : ''}
          <label class="tb-search">${icon('search', 14)}<input id="q" type="search" placeholder="Search projects, partners, EPC…" value="${esc(S.f.q)}" aria-label="Search"></label>
          <div class="seg" role="group" aria-label="Theme">
            <button data-action="theme" data-id="light" class="${theme === 'light' ? 'on' : ''}">Light</button>
            <button data-action="theme" data-id="low-carbon" class="${theme === 'low-carbon' ? 'on' : ''}">Low-carbon</button>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;
  }

  function renderContent(keepScroll) {
    const content = document.getElementById('content');
    const scroll = content.scrollTop;
    if (S.map.inst) { S.map.inst.remove(); S.map.inst = null; }
    if (S.map.mini) { S.map.mini.remove(); S.map.mini = null; }
    const { view, id } = S.route;
    const html = {
      overview: viewOverview, projects: viewProjects, map: viewMap, status: viewStatus, changes: viewChanges, quality: viewQuality,
    }[view];
    content.innerHTML = `<div class="wrap">${view === 'project' ? viewProject(id) : (html || viewOverview)()}</div>`;
    content.scrollTop = keepScroll ? scroll : 0;
    if (view === 'map') mountMap();
    if (view === 'project' && S.project.tab === 'summary') mountMiniMap(id);

    document.querySelectorAll('.sb-link').forEach((a) => a.classList.toggle('on', a.dataset.view === (view === 'project' ? 'projects' : view)));
    const v = VIEWS.find((x) => x.id === view);
    const p = view === 'project' && S.data.projects.find((x) => x.id === id);
    document.getElementById('crumb').innerHTML = p
      ? `<a href="#/projects">Projects</a><span class="sep">/</span><b>${esc(p.name)}</b>`
      : `<span>Development pipeline</span><span class="sep">/</span><b>${esc(v ? v.label : 'Overview')}</b>`;
    document.title = `${p ? p.name : v ? v.label : 'Overview'} — Masdar development pipeline`;
  }

  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const view = parts[0] || 'overview';
    const next = view === 'project' ? { view, id: decodeURIComponent(parts[1] || '') } : { view: VIEWS.some((v) => v.id === view) ? view : 'overview', id: null };
    if (next.view === 'project' && (S.route.view !== 'project' || S.route.id !== next.id)) S.project.tab = 'summary';
    S.route = next;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  function saveCols() { try { localStorage.setItem('mdp-cols', JSON.stringify(S.table.cols)); } catch (e) { /* storage unavailable */ } }

  function onClick(e) {
    const dd = S.table.dd && !e.target.closest('.dd');
    const el = e.target.closest('[data-action]');
    if (dd && !el) { S.table.dd = false; renderContent(true); return; }
    if (!el) {
      const row = e.target.closest('tr[data-href]');
      if (row && !e.target.closest('a')) location.hash = row.dataset.href;
      return;
    }
    const a = el.dataset.action, id = el.dataset.id;
    switch (a) {
      case 'group': S.f.groups.has(id) ? S.f.groups.delete(id) : S.f.groups.add(id); break;
      case 'tech': S.f.tech = S.f.tech === id ? '' : id; break;
      case 'country': S.f.country = S.f.country === id ? '' : id; break;
      case 'region': S.f.region = S.f.region === id ? '' : id; break;
      case 'clear': S.f = { groups: new Set(), tech: '', country: '', region: '', type: '', q: '' }; document.getElementById('q').value = ''; break;
      case 'geo': S.overview.geo = id; break;
      case 'sort': S.table.sort = S.table.sort.key === id ? { key: id, dir: -S.table.sort.dir } : { key: id, dir: F(id).num ? -1 : 1 }; break;
      case 'dd': S.table.dd = !S.table.dd; break;
      case 'cols-all': S.table.cols = ['name', 'stage_group', ...S.data.columns.map((c) => 'raw:' + c.key).filter((k) => k !== 'raw:project_name')]; saveCols(); break;
      case 'cols-reset': S.table.cols = [...DEFAULT_COLS]; saveCols(); break;
      case 'cols-group': {
        const keys = FIELDS.filter((f) => f.group === id && f.key !== 'name').map((f) => f.key);
        const allOn = keys.every((k) => S.table.cols.includes(k));
        S.table.cols = allOn ? S.table.cols.filter((k) => !keys.includes(k)) : [...S.table.cols, ...keys.filter((k) => !S.table.cols.includes(k))];
        saveCols(); break;
      }
      case 'export': exportCSV(); return;
      case 'map-sel': S.map.sel = S.map.sel === id ? null : id; S.map.focus = !!S.map.sel; S.map.keepView = !S.map.sel; break;
      case 'status-tab': S.status.tab = id; break;
      case 'p-tab': S.project.tab = id; break;
      case 'q-level': S.quality.level = id; break;
      case 'theme':
        document.documentElement.setAttribute('data-theme', id);
        try { localStorage.setItem('mdp-theme', id); } catch (err) { /* storage unavailable */ }
        document.querySelectorAll('[data-action="theme"]').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
        break;
      default: return;
    }
    renderContent(true);
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.filter) {
      const k = { technology: 'tech', transaction_type: 'type' }[t.dataset.filter] || t.dataset.filter;
      S.f[k] = t.value;
      renderContent(true);
    } else if (t.dataset.col) {
      const k = t.dataset.col;
      S.table.cols = t.checked ? [...S.table.cols, k] : S.table.cols.filter((c) => c !== k);
      saveCols();
      renderContent(true);
    }
  }

  let qTimer;
  function onInput(e) {
    if (e.target.id !== 'q') return;
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      S.f.q = e.target.value;
      if (S.route.view === 'project' || S.route.view === 'changes' || S.route.view === 'quality') location.hash = '#/projects';
      else renderContent(true);
    }, 160);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    try {
      const bust = '?v=' + Date.now(); // data is small; always fetch the latest refresh
      const [latest, changes] = await Promise.all([
        fetch('data/latest.json' + bust).then((r) => { if (!r.ok) throw new Error('latest.json: HTTP ' + r.status); return r.json(); }),
        fetch('data/changes.json' + bust).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      S.data = latest;
      S.changes = changes;
    } catch (err) {
      document.getElementById('root').innerHTML = `<div class="error-box card"><h2>Data could not be loaded</h2><p class="hint" style="margin-top:8px">${esc(err.message)}. If you opened index.html directly from disk, serve the folder instead (for example <code>python3 -m http.server</code> inside <code>site/</code>).</p></div>`;
      return;
    }
    FIELDS = fieldDefs();
    let cols = null;
    try { cols = JSON.parse(localStorage.getItem('mdp-cols') || 'null'); } catch (e) { /* ignore */ }
    S.table.cols = Array.isArray(cols) && cols.every((k) => F(k)) ? cols : [...DEFAULT_COLS];

    renderShell();
    parseRoute();
    renderContent();
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('input', onInput);
    window.addEventListener('hashchange', () => { parseRoute(); S.table.dd = false; renderContent(); });
  }

  boot();
})();
