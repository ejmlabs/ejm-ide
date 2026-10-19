/* ejmlabs interactive product demos.
   Finds [data-ejm-demo="cli|ide|harness"] elements and mounts a scripted simulation into each.
   Everything runs in the visitor's browser. The only requests are this site's own files:
   ../ui/app.css and demos/*.json, resolved relative to this script. No network calls to anyone else.
   Options: ?demo-speed=N (timing multiplier, "max" for instant), ?demo-reduced-motion=1.
   See DEMOS.md. Dependency free, no eval, no inline handlers. */
(() => {
  'use strict';
  const script = document.currentScript;
  if (!script || !script.src) return;
  const BASE = new URL('.', script.src);
  const params = new URLSearchParams(location.search);
  const rawSpeed = params.get('demo-speed');
  const SPEED = rawSpeed === null ? 1 : (rawSpeed === 'max' || parseFloat(rawSpeed) === 0) ? 1000 : Math.min(1000, Math.max(0.1, parseFloat(rawSpeed) || 1));
  const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
  const reduced = () => params.get('demo-reduced-motion') === '1' || mqReduce.matches;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
  const CANCEL = Symbol('cancel');

  /* ---------- small helpers ---------- */
  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  };
  const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const pad = (n, w) => String(n).padStart(w, ' ');
  const jsonCache = new Map();
  const getJson = (url) => { if (!jsonCache.has(url)) jsonCache.set(url, fetch(url, { credentials: 'omit', cache: 'no-cache' }).then(r => { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); })); return jsonCache.get(url); };

  let uiCss;
  const loadUi = () => uiCss || (uiCss = new Promise((resolve) => {
    const href = new URL('../ui/app.css', BASE).href;
    if (document.querySelector('link[rel=stylesheet][href="' + href + '"]')) return resolve();
    const l = h('link', { rel: 'stylesheet', href });
    l.addEventListener('load', resolve); l.addEventListener('error', resolve);
    // Placed before the page's own style sheets, so the demo's layout rules in site.css win ties with ui/app.css.
    document.head.insertBefore(l, document.head.querySelector('link[rel=stylesheet]'));
    setTimeout(resolve, 4000);
  }));

  const pageTheme = () => {
    const t = document.documentElement.dataset.theme;
    if (t === 'dark' || t === 'light') return t;
    const cs = getComputedStyle(document.documentElement).colorScheme || '';
    const dark = /dark/.test(cs), light = /light/.test(cs);
    if (dark !== light) return dark ? 'dark' : 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  /* ---------- syntax colors and diffs ---------- */
  const KW = {
    rust: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while',
    ts: 'as async await break case catch class const continue default else enum export extends finally for from function if implements import in instanceof interface let new of return static switch throw try type typeof var while',
    python: 'and as async await class def elif else except finally for from if import in is lambda not or pass raise return try while with yield'
  };
  const KWSET = Object.fromEntries(Object.entries(KW).map(([k, v]) => [k, new Set(v.split(' '))]));
  const COMMENT = { rust: '\\/\\/.*', ts: '\\/\\/.*', python: '#.*' };
  const TYPEWORD = /^([iu](8|16|32|64|128|size)|f32|f64|bool|str|string|number|boolean|void|unknown|any|Self)$/;
  const span = (cls, text) => h('span', { class: 'ejm-syn-' + cls, text });
  function tokenLine(line, lang) {
    const out = [];
    if (lang === 'md') {
      const m = /^(#{1,6} .*|\s*[-*] )(.*)$/.exec(line);
      let rest = line;
      if (m) { if (m[1].startsWith('#')) return [span('keyword', line)]; out.push(span('delimiter', m[1])); rest = m[2]; }
      let last = 0;
      for (const t of rest.matchAll(/`[^`]*`/g)) { if (t.index > last) out.push(rest.slice(last, t.index)); out.push(span('string', t[0])); last = t.index + t[0].length; }
      if (last < rest.length) out.push(rest.slice(last));
      return out;
    }
    const re = new RegExp('(' + COMMENT[lang] + ')|(#\\[[^\\]]*\\])|("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)|(\\b\\d[\\d_.]*\\b)|([A-Za-z_][A-Za-z0-9_]*)(!?)', 'g');
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(line.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1]) out.push(span('comment', m[1]));
      else if (m[2]) out.push(span('macro', m[2]));
      else if (m[3]) out.push(span('string', m[3]));
      else if (m[4]) out.push(span('number', m[4]));
      else {
        const w = m[5], bang = m[6], next = line.slice(last).trimStart()[0];
        if (bang) out.push(span('macro', w + bang));
        else if (KWSET[lang].has(w)) out.push(span('keyword', w));
        else if (/^(true|false|None|null|undefined|True|False)$/.test(w) || (w.length > 1 && /^[A-Z][A-Z0-9_]+$/.test(w))) out.push(span('constant', w));
        else if (TYPEWORD.test(w) || /^[A-Z]/.test(w)) out.push(span('type', w));
        else if (next === '(') out.push(span('function', w));
        else out.push(w);
      }
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
  }
  const splitLines = (text) => { const l = text.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

  function applyEdits(text, edits) {
    let t = text;
    for (const e of edits) {
      const i = t.indexOf(e.find);
      if (i < 0) return { ok: false, error: 'no match for the old text; it may already be applied', text };
      if (t.indexOf(e.find, i + 1) >= 0) return { ok: false, error: 'the old text matches more than once', text };
      t = t.slice(0, i) + e.replace + t.slice(i + e.find.length);
    }
    return { ok: true, text: t };
  }
  /* Unified diff of edits against text, with two lines of context. Returns null when an edit does not match. */
  function buildDiff(text, edits, path) {
    const lines = ['--- a/' + path, '+++ b/' + path];
    let t = text, delta = 0;
    for (const e of edits) {
      const i = t.indexOf(e.find);
      if (i < 0 || t.indexOf(e.find, i + 1) >= 0) return null;
      const start = t.lastIndexOf('\n', i - 1) + 1, end = i + e.find.length;
      let stop = t.indexOf('\n', end); if (stop < 0) stop = t.length;
      const oldB = t.slice(start, stop).split('\n'), newB = (t.slice(start, i) + e.replace + t.slice(end, stop)).split('\n');
      const all = splitLines(t), a = t.slice(0, start).split('\n').length - 1;
      let p = 0; while (p < oldB.length && p < newB.length && oldB[p] === newB[p]) p++;
      let s = 0; while (s < oldB.length - p && s < newB.length - p && oldB[oldB.length - 1 - s] === newB[newB.length - 1 - s]) s++;
      const rem = oldB.slice(p, oldB.length - s), add = newB.slice(p, newB.length - s);
      const c0 = Math.max(0, a + p - 2), before = all.slice(c0, a + p), after = all.slice(a + oldB.length - s, a + oldB.length - s + 2);
      lines.push('@@ -' + (c0 + 1) + ',' + (before.length + rem.length + after.length) + ' +' + (c0 + 1 + delta) + ',' + (before.length + add.length + after.length) + ' @@');
      before.forEach(l => lines.push(' ' + l)); rem.forEach(l => lines.push('-' + l)); add.forEach(l => lines.push('+' + l)); after.forEach(l => lines.push(' ' + l));
      delta += add.length - rem.length;
      t = t.slice(0, i) + e.replace + t.slice(end);
    }
    return lines;
  }
  const diffKind = (l) => l.startsWith('@@') ? 'hunk' : (l.startsWith('+++') || l.startsWith('---')) ? 'file' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';

  /* ---------- the frame: window, title bar, caption, live region, scheduler ---------- */
  let frameCount = 0;
  function makeFrame(host, kind, cfg, build) {
    const n = ++frameCount;
    const d = host.dataset;
    const label = d.demoLabel || cfg.label;
    const seed = parseInt(d.demoSeed || cfg.seed || '1', 10) || 1;
    let paused = false, visible = d.demoStart === 'eager', themeOv = null;
    const tokens = new Set(), waiters = [], cleanups = [];
    let cur = rng(seed);

    const gate = () => !paused && visible;
    const flush = () => { if (gate()) waiters.splice(0).forEach(f => f()); };
    const live = h('div', { class: 'ejm-demo__live ejm-ui-sr', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': label + ' announcements' });
    const body = h('div', { class: 'ejm-demo__body' });
    const pauseBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Pause', 'aria-label': 'Pause the demo' });
    const resetBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Reset', 'aria-label': 'Reset the demo' });
    const win = h('div', { class: 'ejm-demo__window ejm-ui', role: 'region', 'aria-label': label + ', simulated', tabindex: '-1' },
      h('div', { class: 'ejm-demo__bar' },
        h('span', { class: 'ejm-demo__name', text: cfg.name }),
        h('span', { class: 'ejm-demo__badge', text: 'Simulated' }),
        h('span', { class: 'ejm-demo__actions' }, pauseBtn, resetBtn)),
      body,
      h('div', { class: 'ejm-demo__caption' },
        h('p', { class: 'ejm-demo__try', text: d.demoCaption || cfg.caption }),
        h('p', { class: 'ejm-demo__note', text: cfg.note })),
      live);
    const endId = 'ejm-demo-end-' + n;
    const skip = h('a', { class: 'ejm-demo__skip', href: '#' + endId, text: 'Skip past this demo' });
    const end = h('span', { class: 'ejm-demo__end', id: endId, tabindex: '-1' });

    win.dataset.reduced = String(reduced());
    const applyTheme = () => { win.dataset.theme = d.demoTheme || themeOv || pageTheme(); };
    const onTheme = () => { themeOv = null; applyTheme(); };
    document.addEventListener('ejm-themechange', onTheme);
    new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
    applyTheme();

    const api = {
      body, win, kind, reduced, isMac: IS_MAC, mod: MOD,
      rand: () => cur(),
      active: () => gate(),
      say(text) { live.append(h('p', { text })); while (live.children.length > 20) live.firstChild.remove(); },
      token() { const t = { dead: false, subs: new Set() }; tokens.add(t); return t; },
      cancel(t) { t.dead = true; t.subs.forEach(f => f()); t.subs.clear(); tokens.delete(t); },
      sleep(ms, t) {
        return new Promise((res, rej) => {
          if (t.dead) return rej(CANCEL);
          let timer;
          const fail = () => { clearTimeout(timer); rej(CANCEL); };
          t.subs.add(fail);
          const fire = () => { if (t.dead) return; if (!gate()) { waiters.push(fire); return; } t.subs.delete(fail); res(); };
          timer = setTimeout(fire, reduced() ? 0 : Math.max(0, ms / SPEED));
        });
      },
      cleanup(fn) { cleanups.push(fn); },
      setTheme(t) { themeOv = t; applyTheme(); },
      get theme() { return win.dataset.theme; }
    };
    const mount = () => {
      [...tokens].forEach(t => api.cancel(t));
      cleanups.splice(0).forEach(f => f());
      waiters.length = 0;
      cur = rng(seed);
      body.replaceChildren();
      build(api);
    };
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      pauseBtn.setAttribute('aria-label', paused ? 'Resume the demo' : 'Pause the demo');
      win.dataset.paused = paused ? 'true' : 'false';
      api.say(paused ? 'Demo paused.' : 'Demo resumed.');
      flush();
    });
    resetBtn.addEventListener('click', () => { paused = false; pauseBtn.textContent = 'Pause'; pauseBtn.setAttribute('aria-label', 'Pause the demo'); win.dataset.paused = 'false'; mount(); api.say('Demo reset.'); });
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented && document.activeElement !== win) { e.preventDefault(); win.focus(); }
    });
    host.replaceChildren(skip, win, end);
    mount();
    const setVisible = (v) => { visible = v; flush(); };
    if (d.demoStart === 'eager') flush();
    else if ('IntersectionObserver' in window) new IntersectionObserver((es) => setVisible(es[es.length - 1].isIntersecting), { threshold: 0.05 }).observe(host);
    else setVisible(true);
    return api;
  }

  /* ---------- ejm-cli ---------- */
  const G_UNI = { prompt: '›', run: '●', done: '✓', fail: '✗', tool: '▸', up: '↑', sep: '·', dots: '…', tl: '╭', tr: '╮', bl: '╰', br: '╯', v: '│', hz: '─', spin: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'] };
  const G_ASC = { prompt: '>', run: '*', done: '+', fail: 'x', tool: '>', up: '^', sep: '-', dots: '...', tl: '+', tr: '+', bl: '+', br: '+', v: '|', hz: '-', spin: ['*'] };

  function buildCli(api, { data: D, project }) {
    const fs = Object.fromEntries(project.files.map(f => [f.path, f.text]));
    const s = { blocks: [], title: D.app.title, sid: D.app.sessionId, write: false, plain: false, run: 'idle', agents: 0, models: 0, tools: 0, overlay: null, sel: 0, queue: [], pending: null, hist: [], hi: -1, follow: true, above: 0, spin: 0, tok: null, pendingSay: null };
    const G = () => (s.plain ? G_ASC : G_UNI);
    const line = (cls, ...kids) => h('span', { class: 'ejm-term__line ' + cls }, ...kids);
    const rl = (t, r) => h('span', { class: r ? 't-' + r : null, text: t });

    /* header */
    const head1 = line('ejm-demo__nowrap'), head2 = line('ejm-demo__nowrap');
    const paintHead = () => {
      const g = G();
      head1.replaceChildren(rl('ejm-cli ', 'accent t-bold'), D.app.provider, rl('  ' + g.sep + '  ' + s.title, 'dim'));
      head2.replaceChildren(rl('grants: read' + (s.write ? ' + write' : ''), s.write ? 'warn' : 'dim'), rl('  ' + g.sep + '  ' + D.app.cwd + '  ' + g.sep + '  ' + s.sid, 'dim'));
    };

    /* transcript */
    const scroll = h('div', { class: 'ejm-demo__scroll', role: 'region', 'aria-label': 'Transcript', tabindex: '0' });
    const roleOf = (l) => l.startsWith('@@') ? 'special' : (l.startsWith('+++') || l.startsWith('---')) ? 'dim' : l[0] === '+' ? 'ok' : l[0] === '-' ? 'err' : null;
    function parseText(text) {
      const out = []; let fence = null;
      for (const t of text.split('\n')) {
        if (t.startsWith('```')) { fence = fence === null ? t.slice(3) : null; out.push({ t, r: 'dim' }); }
        else if (fence !== null) out.push({ t, r: fence === 'diff' ? roleOf(t) : 'dim' });
        else if (t.startsWith('# ')) out.push({ t, r: 'accent t-bold' });
        else out.push({ t, r: null });
      }
      return out;
    }
    const titleOf = (b) => b.kind === 'you' ? rl('you', 'accent') : b.kind === 'assistant' ? rl('ejm-cli', 'bold') : b.kind === 'tool' ? rl(G().tool + ' ' + b.title, 'dim') : b.kind === 'notice' ? rl('! ' + b.title, 'warn') : rl(G().fail + ' ' + b.title, 'err');
    function paintBlock(b) {
      b.el.replaceChildren(line('ejm-demo__wrap', titleOf(b)), ...b.lines.map(l => line('ejm-demo__wrap', rl(l.t, l.r || (b.kind === 'tool' ? 'dim' : b.kind === 'error' ? 'err' : null)))), line('', ''));
    }
    function addBlock(kind, title, lines) {
      const b = { kind, title, lines: lines.map(t => typeof t === 'string' ? { t, r: null } : t), el: h('div', { class: 'ejm-demo__block' }) };
      s.blocks.push(b); paintBlock(b); scroll.append(b.el); stick(); empty.hidden = true;
      return b;
    }
    const stick = () => { if (s.follow) scroll.scrollTop = scroll.scrollHeight; };
    const empty = h('div', { class: 'ejm-demo__empty' });
    const paintEmpty = () => {
      empty.replaceChildren(line('', ''), line('ejm-demo__wrap', rl('  ' + D.empty.title, 'accent t-bold')), line('', ''), ...D.empty.help.flatMap(t => [line('ejm-demo__wrap', rl(t, 'dim')), line('', '')]));
      empty.hidden = s.blocks.length > 0;
    };
    scroll.append(empty);
    const renderAll = () => {
      scroll.replaceChildren(empty);
      s.blocks.forEach(b => { b.el = h('div', { class: 'ejm-demo__block' }); paintBlock(b); scroll.append(b.el); });
      paintEmpty(); stick();
    };
    scroll.addEventListener('scroll', () => {
      const dist = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop;
      s.follow = dist < 8; s.above = s.follow ? 0 : Math.round(dist / 20); paintStatus();
    });

    /* async helpers */
    const tick = () => api.sleep(api.rand() * 250 + 350, s.tok);
    async function pushLines(b, texts, gap) {
      for (const l of texts) { b.lines.push(typeof l === 'string' ? { t: l, r: null } : l); paintBlock(b); stick(); await api.sleep(gap, s.tok); }
    }
    async function stream(b, lines) {
      for (const l of lines) {
        const row = { t: '', r: l.r }; b.lines.push(row);
        if (api.reduced()) { row.t = l.t; paintBlock(b); stick(); continue; }
        for (let i = 0; i < l.t.length;) {
          const n = 2 + Math.floor(api.rand() * 4); row.t += l.t.slice(i, i + n); i += n;
          paintBlock(b); stick(); await api.sleep(22, s.tok);
        }
        paintBlock(b); stick(); await api.sleep(60, s.tok);
      }
    }
    const readOut = (path, r) => { const all = splitLines(fs[path] || ''); const to = Math.min(all.length, (r && r.to) || all.length); return all.slice(0, Math.min(to, 40)).map((l, i) => pad(i + 1, 3) + '  ' + l); };
    const searchOut = (q) => { const o = []; for (const [p, t] of Object.entries(fs)) splitLines(t).forEach((l, i) => { if (l.includes(q)) o.push(p + ':' + (i + 1) + ':' + l.trim()); }); return o.slice(0, 8).length ? o.slice(0, 8) : ['no matches']; };
    const listOut = () => { const set = new Set(); Object.keys(fs).forEach(p => set.add(p.includes('/') ? p.split('/')[0] + '/' : p)); return [...set].sort(); };

    async function toolStep(st) {
      s.tools = 1; paintStatus();
      const b = addBlock('tool', st.tool + ' ' + st.args, []);
      await tick();
      const out = st.read ? readOut(st.read.path, st.read) : st.search ? searchOut(st.search) : listOut();
      await pushLines(b, out, 30);
      s.tools = 0; paintStatus();
      api.say('Tool ' + st.tool + ' ' + st.args + ' finished, ' + out.length + ' lines.');
    }
    async function sayStep(text) {
      s.models = 1; paintStatus();
      const b = addBlock('assistant', '', []);
      await stream(b, parseText(text));
      s.models = 0; paintStatus();
      api.say('ejm-cli: ' + text.replace(/\n/g, ' ').slice(0, 160));
    }
    async function patchStep(st, opts) {
      const p = st.patch, g = G();
      if (opts.intro) {
        const diff = buildDiff(fs[p.path], p.edits, p.path);
        s.models = 1; paintStatus();
        const b = addBlock('assistant', '', []);
        await stream(b, parseText(st.intro));
        if (diff) await pushLines(b, [{ t: '```diff', r: 'dim' }, ...diff.map(l => ({ t: l, r: roleOf(l) })), { t: '```', r: 'dim' }], 35);
        s.models = 0; paintStatus();
        api.say('ejm-cli proposes a patch to ' + p.path + '.');
      }
      let result = 'applied';
      for (const e of p.edits) {
        s.tools = 1; paintStatus();
        const b = addBlock('tool', 'patch_file ' + p.path, []);
        await tick();
        if (!s.write) {
          await pushLines(b, [{ t: g.fail + ' blocked: write access is not granted', r: 'err' }], 30);
          s.tools = 0; result = 'blocked'; break;
        }
        const r = applyEdits(fs[p.path], [e]);
        if (r.ok) { fs[p.path] = r.text; await pushLines(b, [{ t: g.done + ' replaced 1 match in ' + p.path, r: 'ok' }], 30); }
        else { await pushLines(b, [{ t: g.fail + ' ' + r.error, r: 'err' }], 30); result = 'failed'; s.tools = 0; break; }
        s.tools = 0;
      }
      paintStatus();
      if (result === 'blocked') {
        s.pending = st;
        addBlock('notice', 'notice', [D.blockedNotice]);
        api.say('Patch blocked because write access is off. Turn on Grant write to apply it.');
        if (opts.intro) await sayStep(st.blocked);
      } else {
        if (s.pending === st) s.pending = null;
        api.say('Patch ' + (result === 'applied' ? 'applied to ' + p.path : 'failed') + '.');
        if (result === 'applied') await sayStep(st.applied);
      }
    }

    function matchPrompt(text) {
      const w = text.toLowerCase();
      for (const m of D.match) if (m.words.some(x => w.includes(x))) return m.id;
      return null;
    }
    async function runSteps(fn) {
      s.tok = api.token(); const tok = s.tok;
      s.run = 'running'; s.agents = 1; paintAll();
      api.say('Run started.');
      try { await fn(); api.say('Run finished.'); }
      catch (e) {
        if (e !== CANCEL) throw e;
        addBlock('notice', 'notice', ['Run stopped. The session is still open.']);
        api.say('Run stopped.');
      }
      api.cancel(tok);
      s.run = 'idle'; s.agents = 0; s.models = 0; s.tools = 0; s.tok = null; paintAll();
      if (s.queue.length) submit(s.queue.shift(), true);
    }
    function runTurn(text) {
      if (s.title === D.app.title) { s.title = text.length > 36 ? text.slice(0, 35) + G().dots : text; }
      addBlock('you', 'you', [text]);
      const id = matchPrompt(text);
      return runSteps(async () => {
        if (!id) {
          s.models = 1; paintStatus(); await tick(); s.models = 0;
          addBlock('notice', 'demo notice', [D.fallback]);
          api.say('Demo notice: ' + D.fallback);
          return;
        }
        for (const st of D.scenarios[id].steps) {
          if (st.say) await sayStep(st.say);
          else if (st.tool) await toolStep(st);
          else if (st.patch) {
            if (!buildDiff(fs[st.patch.path], st.patch.edits, st.patch.path)) { addBlock('error', 'patch_file ' + st.patch.path, ['no match for the old text; it may already be applied in this session.']); continue; }
            await patchStep(st, { intro: true });
          }
        }
      });
    }
    function setWrite(v) {
      if (s.write === v) return;
      s.write = v; paintHead(); writeSw.checked = v;
      api.say(v ? 'Write access granted. The grants line now shows write.' : 'Write access off.');
      if (v && s.pending && s.run === 'idle') {
        const st = s.pending;
        runSteps(async () => { await sayStep(D.afterGrant.say); await patchStep(st, { intro: false }); });
      }
    }
    function stop() {
      if (s.run === 'idle') {
        addBlock('notice', 'notice', ['Ctrl+C exits the real app. The demo stays open; use Reset to start over.']);
        return;
      }
      if (s.run === 'stopping') return;
      s.run = 'stopping'; paintAll();
      api.cancel(s.tok);
    }
    function command(text) {
      const [cmd, ...rest] = text.split(/\s+/);
      if (cmd === '/help') openOverlay('help');
      else if (cmd === '/sessions') openOverlay('sessions');
      else if (cmd === '/stop') stop();
      else if (cmd === '/new') {
        if (s.run !== 'idle') { api.cancel(s.tok); }
        s.blocks = []; s.queue = []; s.pending = null; s.title = rest.join(' ') || D.app.title;
        s.sid = 's_' + Math.floor(api.rand() * 0xffffff).toString(16).padStart(6, '0');
        renderAll(); paintAll(); api.say('New session.');
      } else if (cmd === '/quit') addBlock('notice', 'notice', ['The demo cannot quit. Use Reset to start over.']);
      else if (['/resume', '/queue', '/steer'].includes(cmd)) addBlock('notice', 'notice', [cmd + ' exists in ejm-cli but is not part of this demo.']);
      else addBlock('error', 'unknown command', ['Unknown command ' + cmd + '. Use /help for the list.']);
    }
    function submit(text, fromQueue) {
      text = text.trim(); if (!text) return;
      if (!fromQueue) { s.hist.push(text); s.hi = -1; }
      if (text.startsWith('/')) return command(text);
      if (s.run !== 'idle') { s.queue.push(text); addBlock('notice', 'queued message', [text]); paintAll(); return; }
      return runTurn(text);
    }

    /* status line, composer, hints */
    const status = line('ejm-demo__nowrap');
    const paintStatus = () => {
      const g = G(); status.replaceChildren();
      const parts = [rl(' ' + s.agents + ' agents', 'dim'), rl(' ' + g.sep + ' models ' + s.models + '+0q', 'dim'), rl(' ' + g.sep + ' tools ' + s.tools + '+0q', 'dim')];
      let st;
      if (s.above > 0) st = rl(' ' + g.sep + ' ' + g.up + ' ' + s.above + ' lines above latest ' + g.sep + ' End to follow', 'dim');
      else if (s.run === 'running') st = rl(' ' + g.sep + ' ' + (api.reduced() || s.plain ? g.run : g.spin[s.spin % g.spin.length]) + ' Streaming' + g.dots, 'accent');
      else if (s.run === 'stopping') st = rl(' ' + g.sep + ' ' + g.run + ' Stopping' + g.dots, 'accent');
      else st = rl(' ' + g.sep + ' Ready', 'dim');
      status.append(...parts, st); status.dataset.parts = parts.length; fit(status, parts.length);
    };
    function fit(el, count) {
      const kids = [...el.children]; kids.forEach(k => { k.hidden = false; });
      for (let i = count - 1; i >= 0 && el.scrollWidth > el.clientWidth; i--) kids[i].hidden = true;
    }
    const hintPairs = [['Enter', 'send'], ['Ctrl+C', 'stop/quit'], ['Alt+Enter', 'new line'], ['Ctrl+S', 'sessions'], ['/help', 'commands']];
    const hints = line('ejm-demo__nowrap t-dim');
    const paintHints = () => { hints.replaceChildren(...hintPairs.map(([k, a], i) => h('span', { text: (i ? ' ' + G().sep + ' ' : ' ') + k + ' ' + a }))); fit(hints, hintPairs.length); };

    const boxEdge = (l, r, titleFn) => h('div', { class: 'ejm-demo__edge' }, h('span', { 'data-g': l }), h('span', { class: 'ejm-demo__title', 'data-title': titleFn ? '1' : null }), h('span', { class: 'ejm-demo__fill', 'aria-hidden': 'true', 'data-fill': '1' }), h('span', { 'data-g': r }));
    const ta = h('textarea', { class: 'ejm-demo__input', rows: '1', 'aria-label': 'Message', 'aria-describedby': '', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
    const gl = h('span', { class: 'ejm-demo__gutter', 'aria-hidden': 'true' }), gr = h('span', { class: 'ejm-demo__gutter', 'aria-hidden': 'true' });
    const topEdge = boxEdge('tl', 'tr', true), botEdge = boxEdge('bl', 'br');
    const composer = h('div', { class: 'ejm-demo__composer' }, topEdge, h('div', { class: 'ejm-demo__row' }, gl, ta, gr), botEdge);
    function paintComposer() {
      const g = G();
      topEdge.querySelector('[data-title]').textContent = ' message' + (s.run === 'idle' ? '' : ' ' + g.sep + ' Enter queues') + ' ';
      composer.querySelectorAll('[data-g]').forEach(e => { e.textContent = g[e.dataset.g]; });
      composer.querySelectorAll('[data-fill]').forEach(e => { e.textContent = g.hz.repeat(300); });
      ta.placeholder = 'Describe a task' + g.dots;
      const rows = Math.max(1, Math.round(ta.clientHeight / 20) || 1);
      gl.textContent = Array.from({ length: rows }, (_, i) => g.v + (i ? '  ' : ' ' + g.prompt)).join('\n');
      gr.textContent = Array.from({ length: rows }, () => g.v).join('\n');
    }
    const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, Math.max(20, ta.scrollHeight)) + 'px'; paintComposer(); };
    ta.addEventListener('input', autosize);
    const send = () => { const v = ta.value; ta.value = ''; autosize(); submit(v); };
    const insertNl = () => { ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end'); autosize(); };
    ta.addEventListener('keydown', (e) => {
      const k = e.key;
      if (e.isComposing) return;
      if (k === 'Enter' && e.altKey) { e.preventDefault(); insertNl(); }
      else if (k === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send(); }
      else if (e.ctrlKey && !e.metaKey && k === 'j') { e.preventDefault(); insertNl(); }
      else if (k === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0 && s.hist.length) { e.preventDefault(); s.hi = s.hi < 0 ? s.hist.length - 1 : Math.max(0, s.hi - 1); ta.value = s.hist[s.hi]; autosize(); }
      else if (k === 'ArrowDown' && s.hi >= 0 && ta.selectionStart === ta.value.length) { e.preventDefault(); s.hi++; if (s.hi >= s.hist.length) { s.hi = -1; ta.value = ''; } else ta.value = s.hist[s.hi]; autosize(); }
      else if (k === 'End' && !ta.value) { e.preventDefault(); s.follow = true; stick(); }
    });

    /* overlay: sessions and help */
    const overlay = h('div', { class: 'ejm-demo__overlay', hidden: true, tabindex: '-1' });
    const boxRow = (cell, cls) => h('div', { class: 'ejm-demo__edge ejm-demo__edge--row' }, h('span', { 'data-g': 'v' }), h('span', { class: 'ejm-demo__cell ' + (cls || '') }, cell), h('span', { 'data-g': 'v' }));
    function sessionRows() {
      return [{ id: s.sid, state: s.run === 'idle' ? 'idle' : 'running', title: s.title, cur: true }, ...D.sessions];
    }
    function paintOverlay() {
      const o = s.overlay; if (!o) return;
      const g = G(); overlay.replaceChildren();
      const title = o.type === 'sessions' ? ' sessions ' + g.sep + ' ' + (s.plain ? 'Up/Down' : '↑/↓') + ' choose ' + g.sep + ' Enter open ' + g.sep + ' Esc close ' : ' ejm-cli ' + g.sep + ' help ' + g.sep + ' Esc close ';
      overlay.append(h('div', { class: 'ejm-demo__edge' }, h('span', { 'data-g': 'tl' }), h('span', { class: 'ejm-demo__title', text: title }), h('span', { class: 'ejm-demo__fill', 'aria-hidden': 'true', 'data-fill': '1' }), h('span', { 'data-g': 'tr' })));
      if (o.type === 'sessions') {
        overlay.setAttribute('role', 'listbox'); overlay.setAttribute('aria-label', 'Sessions, sample data');
        sessionRows().forEach((r, i) => {
          const row = boxRow(' ' + r.id + '  [' + r.state + ']  ' + r.title, i === o.sel ? 't-rev' : '');
          const cell = row.querySelector('.ejm-demo__cell'); cell.id = 'ejm-cli-sess-' + i; cell.setAttribute('role', 'option'); cell.setAttribute('aria-selected', i === o.sel ? 'true' : 'false');
          row.addEventListener('click', () => { o.sel = i; chooseSession(); });
          overlay.append(row);
        });
        overlay.setAttribute('aria-activedescendant', 'ejm-cli-sess-' + o.sel);
      } else {
        overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', 'Help'); overlay.removeAttribute('aria-activedescendant');
        const rows = [];
        for (const [sec, items] of Object.entries(D.help)) {
          if (sec === 'footer') continue;
          rows.push(h('span', { class: 't-accent', text: ' ' + sec }));
          items.forEach(([k, t]) => rows.push(h('span', {}, h('span', { class: 't-dim', text: ' ' + k.padEnd(17) }), t)));
          rows.push(' ');
        }
        rows.push(h('span', { class: 't-dim', text: ' ' + D.help.footer }));
        rows.forEach(r => overlay.append(boxRow(r, 'ejm-demo__wrap')));
      }
      overlay.append(h('div', { class: 'ejm-demo__edge' }, h('span', { 'data-g': 'bl' }), h('span', { class: 'ejm-demo__fill', 'aria-hidden': 'true', 'data-fill': '1' }), h('span', { 'data-g': 'br' })));
      overlay.querySelectorAll('[data-g]').forEach(e => { e.textContent = g[e.dataset.g]; });
      overlay.querySelectorAll('[data-fill]').forEach(e => { e.textContent = g.hz.repeat(300); });
    }
    function openOverlay(type) { s.overlay = { type, sel: 0 }; overlay.hidden = false; paintOverlay(); overlay.focus(); api.say(type === 'help' ? 'Help opened. Escape closes it.' : 'Sessions opened. Use the arrow keys, Enter to open, Escape to close.'); }
    function closeOverlay() { s.overlay = null; overlay.hidden = true; ta.focus({ preventScroll: true }); }
    function chooseSession() {
      const r = sessionRows()[s.overlay.sel];
      if (!r.cur) {
        if (s.run !== 'idle') api.cancel(s.tok);
        s.title = r.title; s.sid = 's_' + r.id.slice(0, 6); s.blocks = []; s.queue = []; s.pending = null;
        r.transcript.forEach(t => s.blocks.push({ kind: t.kind, title: t.kind, lines: [{ t: t.text, r: null }], el: null }));
        renderAll(); paintAll(); api.say('Opened sample session: ' + r.title);
      }
      closeOverlay();
    }
    overlay.addEventListener('keydown', (e) => {
      const o = s.overlay; if (!o) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
      else if (o.type === 'sessions' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); const n = sessionRows().length; o.sel = (o.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; paintOverlay(); }
      else if (o.type === 'sessions' && e.key === 'Enter') { e.preventDefault(); chooseSession(); }
      else if (e.key === 'Enter') { e.preventDefault(); closeOverlay(); }
    });

    /* terminal and surroundings */
    const term = h('div', { class: 'ejm-term ejm-demo__term' }, head1, head2, scroll, status, composer, hints, overlay);
    const chipBtns = D.chips.map(c => h('button', { class: 'ejm-ui-chip', type: 'button', text: c.label, onclick: () => { submit(c.prompt); if (matchMedia('(pointer: fine)').matches) ta.focus({ preventScroll: true }); } }));
    const writeSw = h('input', { type: 'checkbox', role: 'switch', onchange: (e) => setWrite(e.target.checked) });
    const plainSw = h('input', { type: 'checkbox', role: 'switch', onchange: (e) => { s.plain = e.target.checked; term.classList.toggle('is-plain', s.plain); renderAll(); paintAll(); paintOverlay(); api.say(s.plain ? 'Plain mode on: ASCII glyphs, no color.' : 'Plain mode off.'); } });
    const sw = (input, text, hint) => h('label', { class: 'ejm-ui-switch', title: hint }, input, h('span', { class: 'ejm-ui-switch__track' }), text);
    const stopBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Stop (Ctrl+C)', onclick: stop });
    const controls = h('div', { class: 'ejm-demo__controls' },
      sw(writeSw, 'Grant write', 'Stands in for starting ejm-cli with --allow-write'),
      sw(plainSw, 'Plain', 'Like --plain and NO_COLOR: ASCII glyphs, no color'),
      stopBtn,
      h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Sessions (Ctrl+S)', onclick: () => openOverlay('sessions') }),
      h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Help', onclick: () => openOverlay('help') }));
    const grantNote = h('p', { class: 'ejm-demo__hint', text: 'Grant write stands in for starting ejm-cli with --allow-write. The real app fixes grants at launch. Plain stands in for --plain and NO_COLOR.' });
    api.body.append(h('div', { class: 'ejm-demo__cli' }, h('div', { class: 'ejm-demo__try-row' }, h('span', { class: 'ejm-ui-label', text: 'Try a prompt' }), ...chipBtns), term, controls, grantNote));

    function paintAll() {
      paintHead(); paintStatus(); paintHints(); paintComposer(); paintEmpty();
      stopBtn.disabled = s.run === 'idle';
      overlay.querySelectorAll('[data-g]').forEach(e => { e.textContent = G()[e.dataset.g]; });
    }
    const keys = (e) => {
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.metaKey && k === 's') { e.preventDefault(); openOverlay('sessions'); }
      else if (e.ctrlKey && !e.metaKey && k === 'c') {
        const sel = e.target === ta ? ta.selectionStart !== ta.selectionEnd : String(getSelection()).length > 0;
        if (!sel) { e.preventDefault(); stop(); }
      } else if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); scroll.scrollBy({ top: (e.key === 'PageUp' ? -1 : 1) * scroll.clientHeight * 0.8 }); }
    };
    term.addEventListener('keydown', (e) => { if (!overlay.contains(e.target)) keys(e); else if (e.ctrlKey && e.key.toLowerCase() === 's') e.preventDefault(); });
    controls.addEventListener('keydown', keys);
    const ro = new ResizeObserver(() => { fit(status, +status.dataset.parts || 3); fit(hints, hintPairs.length); paintComposer(); });
    ro.observe(term); api.cleanup(() => ro.disconnect());
    const spinner = setInterval(() => { if (s.run === 'running' && api.active() && !api.reduced() && !s.plain) { s.spin++; paintStatus(); } }, 80);
    api.cleanup(() => clearInterval(spinner));
    paintAll(); autosize();
  }

  /* ---------- ejm-ide ---------- */
  function buildIde(api, { data: D, project }) {
    const fs = Object.fromEntries(project.files.map(f => [f.path, f.text]));
    const langOf = Object.fromEntries(project.files.map(f => [f.path, f.lang]));
    const s = { open: [...D.openFiles], active: D.openFiles[0] || null, changed: {}, model: 0, running: false, tok: null, chats: 0, title: 'New chat', flash: null, folders: { src: true, web: true } };
    const base = (p) => p.split('/').pop();
    const snd = IS_MAC ? 'Cmd' : 'Ctrl';

    /* chat */
    const log = h('div', { class: 'ejm-demo__chatlog', role: 'log', 'aria-live': 'off', 'aria-label': 'Chat with ' + D.agent, tabindex: '0' });
    const emptyChat = h('div', { class: 'ejm-ui-empty' }, h('p', { class: 'ejm-ui-empty__title', text: 'Ask ' + D.agent + ' about harbor' }), h('p', { class: 'ejm-ui-empty__text', text: 'Pick a prompt, or type your own. Replies are scripted.' }));
    log.append(emptyChat);
    const stickLog = () => { log.scrollTop = log.scrollHeight; };
    function userMsg(text) { emptyChat.hidden = true; log.append(h('div', { class: 'ejm-ui-msg ejm-ui-msg--user' }, h('span', { class: 'ejm-ui-msg__who', text: 'you' }), h('p', { text }))); stickLog(); }
    function agentMsg() { emptyChat.hidden = true; const p = h('p'); log.append(h('div', { class: 'ejm-ui-msg ejm-ui-msg--assistant' }, h('span', { class: 'ejm-ui-msg__who', text: D.agent }), h('div', { class: 'ejm-ui-msg__body' }, p))); stickLog(); return p; }
    async function sayStep(text) {
      const p = agentMsg();
      if (api.reduced()) p.textContent = text;
      else for (let i = 0; i < text.length;) { const n = 2 + Math.floor(api.rand() * 5); p.textContent += text.slice(i, i + n); i += n; stickLog(); await api.sleep(20, s.tok); }
      stickLog(); api.say(D.agent + ': ' + text.slice(0, 160));
    }
    function toolEl(name, arg, state, word) {
      const st = h('span', { class: 'ejm-ui-tool__state', text: word });
      const el = h('div', { class: 'ejm-ui-tool', 'data-state': state }, h('div', { class: 'ejm-ui-tool__head' }, st, h('span', { text: name }), h('span', { class: 'ejm-ui-caption', text: arg })));
      emptyChat.hidden = true; log.append(el); stickLog();
      return { el, st, set(state2, word2) { if (state2) el.dataset.state = state2; else delete el.dataset.state; st.textContent = word2; } };
    }
    async function toolStep(st) {
      const t = toolEl(st.tool, st.args, 'running', 'running');
      await api.sleep(api.rand() * 250 + 350, s.tok);
      let out;
      if (st.read) out = splitLines(fs[st.read.path]).length + ' lines';
      else if (st.search) { const o = []; for (const [p, tx] of Object.entries(fs)) splitLines(tx).forEach((l, i) => { if (l.includes(st.search)) o.push(p + ':' + (i + 1) + ': ' + l.trim()); }); t.el.append(h('pre', { class: 'ejm-ui-code ejm-demo__out', 'aria-label': 'Search results', text: o.join('\n') || 'no matches' })); out = o.length + ' matches'; }
      else out = Object.keys(fs).length + ' files';
      t.el.querySelector('.ejm-ui-caption').textContent = st.args + ' · ' + out;
      t.set('ok', 'ok'); stickLog();
      api.say('Tool ' + st.tool + ' ' + st.args + ' ok, ' + out + '.');
    }
    async function writeStep(st) {
      const w = st.write;
      await sayStep(st.intro);
      const diff = buildDiff(fs[w.path], w.edits, w.path);
      const t = toolEl('write_file', w.path, null, 'proposed');
      await api.sleep(450, s.tok);
      if (!diff) { t.set('error', 'error'); t.el.append(h('p', { class: 'ejm-ui-caption', text: 'No match for the old text; it may already be applied.' })); return; }
      const pre = h('pre', { class: 'ejm-ui-diff', tabindex: '0', 'aria-label': 'Proposed change to ' + w.path }, ...diff.map(l => h('span', { class: 'ejm-ui-diff__line' + ({ add: ' ejm-ui-diff__line--add', del: ' ejm-ui-diff__line--del', hunk: ' ejm-ui-diff__line--hunk' }[diffKind(l)] || ''), text: l })));
      const accept = h('button', { class: 'ejm-ui-btn ejm-ui-btn--primary ejm-ui-btn--sm', type: 'button', text: 'Accept' });
      const reject = h('button', { class: 'ejm-ui-btn ejm-ui-btn--sm', type: 'button', text: 'Reject' });
      const review = h('div', { class: 'ejm-demo__review', role: 'group', 'aria-label': 'Review the proposed change' }, accept, reject, h('p', { class: 'ejm-ui-caption', text: D.reviewNote }));
      t.el.append(pre, review); stickLog();
      api.say('Review needed: ' + D.agent + ' proposes a change to ' + w.path + '. Accept or Reject.');
      accept.addEventListener('click', () => {
        const r = applyEdits(fs[w.path], w.edits);
        review.remove();
        if (!r.ok) { t.set('error', 'error'); log.append(h('p', { class: 'ejm-ui-caption', text: r.error })); return; }
        const before = fs[w.path]; fs[w.path] = r.text;
        markChanged(w.path, before, r.text);
        t.set('ok', 'applied'); openFile(w.path, true);
        const p = agentMsg(); p.textContent = st.applied; stickLog();
        api.say('Change accepted and applied to ' + w.path + '.');
      });
      reject.addEventListener('click', () => {
        review.remove(); t.set(null, 'rejected');
        const p = agentMsg(); p.textContent = st.rejected; stickLog();
        api.say('Change rejected. ' + w.path + ' is unchanged.');
      });
    }
    function markChanged(path, before, after) {
      const a = splitLines(before), b = splitLines(after);
      const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const set = s.changed[path] || (s.changed[path] = new Set()), fresh = new Set();
      for (let i = 0, j = 0; j < b.length;) {
        if (i < a.length && a[i] === b[j]) { i++; j++; } else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) i++; else { set.add(j); fresh.add(j); j++; }
      }
      s.flash = { path, lines: fresh };
    }
    function matchPrompt(text) { const w = text.toLowerCase(); for (const m of D.match) if (m.words.some(x => w.includes(x))) return m.id; return null; }
    async function run(text) {
      s.tok = api.token(); s.running = true; paintRun();
      if (s.title === 'New chat') { s.title = text.length > 28 ? text.slice(0, 27) + '…' : text; paintChats(); }
      userMsg(text);
      api.say('Run started.');
      try {
        const id = matchPrompt(text);
        if (!id) { await api.sleep(400, s.tok); const p = agentMsg(); p.textContent = D.fallback; p.parentNode.prepend(h('span', { class: 'ejm-ui-badge', text: 'scripted reply' })); api.say('Scripted reply: ' + D.fallback); }
        else for (const st of D.scenarios[id].steps) { if (st.say) await sayStep(st.say); else if (st.tool) await toolStep(st); else if (st.write) await writeStep(st); }
        api.say('Run finished.');
      } catch (e) { if (e !== CANCEL) throw e; log.append(h('p', { class: 'ejm-ui-caption ejm-demo__stopped', text: 'Stopped.' })); api.say('Run stopped.'); }
      api.cancel(s.tok); s.running = false; s.tok = null; paintRun();
    }
    const input = h('input', { class: 'ejm-ui-input', type: 'text', placeholder: 'Ask ' + D.agent + ' about harbor', 'aria-label': 'Message ' + D.agent, autocomplete: 'off', spellcheck: 'false' });
    const sendBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--primary', type: 'submit', text: 'Send' });
    const stopBtn = h('button', { class: 'ejm-ui-btn', type: 'button', text: 'Stop', hidden: true, onclick: () => s.tok && api.cancel(s.tok) });
    const form = h('form', { class: 'ejm-demo__composer-ide', onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v && !s.running) { input.value = ''; run(v); } } }, input, sendBtn, stopBtn);
    const chips = h('div', { class: 'ejm-demo__chips', role: 'group', 'aria-label': 'Suggested prompts' }, ...D.chips.map(c => h('button', { class: 'ejm-ui-chip', type: 'button', text: c.label, onclick: () => { if (!s.running) run(c.prompt); } })));
    const agentName = h('span', { class: 'ejm-ui-label', text: D.agent });
    const modelLabel = h('span', { class: 'ejm-ui-caption' });
    const newChat = h('button', { class: 'ejm-ui-btn ejm-ui-btn--ghost ejm-ui-btn--icon', type: 'button', 'aria-label': 'New chat', text: '+', onclick: () => { if (s.tok) api.cancel(s.tok); log.replaceChildren(emptyChat); emptyChat.hidden = false; s.title = 'New chat'; paintChats(); api.say('New chat.'); } });

    /* files */
    const tree = h('ul', { class: 'ejm-ui-tree', role: 'tree', 'aria-label': 'Files' });
    const tabs = h('div', { class: 'ejm-ui-tabs', role: 'tablist', 'aria-label': 'Open files' });
    const panel = h('div', { class: 'ejm-demo__panel', role: 'tabpanel' });
    const chatRow = h('li', { class: 'ejm-ui-row', role: 'option', 'aria-selected': 'true' });
    const chatList = h('ul', { role: 'listbox', 'aria-label': 'Chats' }, chatRow);
    const paintChats = () => { chatRow.replaceChildren(h('span', { text: s.title }), h('span', { class: 'ejm-ui-row__meta', text: 'now' })); };
    const dirs = [...new Set(project.files.filter(f => f.path.includes('/')).map(f => f.path.split('/')[0]))];
    const treeEntries = () => {
      const out = []; project.files.filter(f => !f.path.includes('/')).forEach(f => out.push({ path: f.path, lvl: 0 }));
      dirs.forEach(d => { out.push({ dir: d, lvl: 0 }); if (s.folders[d]) project.files.filter(f => f.path.startsWith(d + '/')).forEach(f => out.push({ path: f.path, lvl: 1 })); });
      return out;
    };
    let focusPath = null;
    function paintTree() {
      const entries = treeEntries(); tree.replaceChildren();
      const first = focusPath && entries.some(e => (e.path || e.dir) === focusPath) ? focusPath : (entries[0].path || entries[0].dir);
      for (const e of entries) {
        const key = e.path || e.dir, row = h('div', { class: 'ejm-ui-tree__row', tabindex: key === first ? '0' : '-1', 'data-key': key }, h('span', { class: 'ejm-ui-tree__marker' }), h('span', { class: 'ejm-ui-tree__label ejm-ui-mono', text: e.path ? base(e.path) : e.dir }));
        row.style.setProperty('--lvl', e.lvl);
        const li = h('li', { class: 'ejm-ui-tree__item', role: 'treeitem', 'aria-level': e.lvl + 1 }, row);
        if (e.dir) li.setAttribute('aria-expanded', s.folders[e.dir] ? 'true' : 'false');
        else { li.setAttribute('aria-selected', e.path === s.active ? 'true' : 'false'); if (s.changed[e.path]) row.append(h('span', { class: 'ejm-ui-tree__meta', text: 'M', title: 'changed in this demo' })); }
        row.addEventListener('click', () => activate(key));
        tree.append(li);
      }
    }
    function activate(key) { focusPath = key; if (dirs.includes(key)) { s.folders[key] = !s.folders[key]; paintTree(); tree.querySelector('[data-key="' + key + '"]').focus(); } else openFile(key); }
    tree.addEventListener('keydown', (e) => {
      const rows = [...tree.querySelectorAll('.ejm-ui-tree__row')], i = rows.indexOf(document.activeElement); if (i < 0) return;
      const key = rows[i].dataset.key, go = (j) => { e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, j))].focus(); };
      focusPath = key;
      if (e.key === 'ArrowDown') go(i + 1); else if (e.key === 'ArrowUp') go(i - 1); else if (e.key === 'Home') go(0); else if (e.key === 'End') go(rows.length - 1);
      else if (e.key === 'ArrowRight' && dirs.includes(key)) { e.preventDefault(); if (!s.folders[key]) activate(key); else go(i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); if (dirs.includes(key) && s.folders[key]) activate(key); else if (key.includes('/')) go(rows.findIndex(r => r.dataset.key === key.split('/')[0])); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(key); }
    });
    tree.addEventListener('focusin', (e) => { const k = e.target.dataset && e.target.dataset.key; if (k) { focusPath = k; tree.querySelectorAll('.ejm-ui-tree__row').forEach(r => { r.tabIndex = r === e.target ? 0 : -1; }); } });

    function openFile(path, flash) {
      if (!s.open.includes(path)) s.open.push(path);
      s.active = path; paintTabs(); paintEditor(flash); paintTree();
    }
    function closeFile(path) {
      const i = s.open.indexOf(path); if (i < 0) return;
      s.open.splice(i, 1);
      if (s.active === path) s.active = s.open[Math.min(i, s.open.length - 1)] || null;
      paintTabs(); paintEditor(); paintTree();
      const t = tabs.querySelector('[role=tab][aria-selected=true]'); (t || tree.querySelector('[tabindex="0"]')).focus();
    }
    function paintTabs() {
      tabs.replaceChildren(...s.open.map(p => {
        const sel = p === s.active, tab = h('button', { class: 'ejm-ui-tab', role: 'tab', type: 'button', 'aria-selected': sel ? 'true' : 'false', tabindex: sel ? '0' : '-1', 'data-path': p, onclick: () => openFile(p) }, h('span', { class: 'ejm-ui-mono', text: base(p) }), s.changed[p] ? h('span', { class: 'ejm-ui-badge ejm-ui-badge--warning', text: 'M' }) : null);
        tab.addEventListener('keydown', (e) => {
          const i = s.open.indexOf(p), go = (j) => { e.preventDefault(); openFile(s.open[(j + s.open.length) % s.open.length]); tabs.querySelector('[aria-selected=true]').focus(); };
          if (e.key === 'ArrowRight') go(i + 1); else if (e.key === 'ArrowLeft') go(i - 1); else if (e.key === 'Home') go(0); else if (e.key === 'End') go(s.open.length - 1);
          else if (e.key === 'Delete') { e.preventDefault(); closeFile(p); }
        });
        const close = h('button', { class: 'ejm-demo__close', type: 'button', 'aria-label': 'Close ' + p, text: '×', onclick: () => closeFile(p) });
        return h('div', { class: 'ejm-demo__tab', 'data-selected': sel ? 'true' : null, role: 'presentation' }, tab, close);
      }));
    }
    function paintEditor(flash) {
      panel.replaceChildren();
      if (!s.active) { panel.append(h('div', { class: 'ejm-ui-empty' }, h('p', { class: 'ejm-ui-empty__title', text: 'No file open' }), h('p', { class: 'ejm-ui-empty__text', text: 'Pick a file from the tree, or press ' + snd + ' K.' }))); return; }
      const p = s.active, changed = s.changed[p] || new Set(), fl = flash && s.flash && s.flash.path === p ? s.flash : null;
      const code = h('code');
      splitLines(fs[p]).forEach((l, i) => {
        const el = h('span', { class: 'ejm-demo__ln' + (changed.has(i) ? ' is-changed' : '') + (fl && fl.lines.has(i) ? ' is-flash' : ''), 'data-n': i + 1 }, ...tokenLine(l, langOf[p]));
        code.append(el);
      });
      panel.append(h('pre', { class: 'ejm-ui-code ejm-demo__editor', tabindex: '0', 'aria-label': p + ', read only in this demo' }, code));
      const tab = tabs.querySelector('[aria-selected=true]'); if (tab) panel.setAttribute('aria-labelledby', ''); panel.removeAttribute('aria-labelledby');
      pathLabel.textContent = p;
    }

    /* command palette */
    const pal = h('div', { class: 'ejm-demo__palette', hidden: true });
    const palInput = h('input', { class: 'ejm-ui-input', type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'ejm-ide-pal-list', 'aria-autocomplete': 'list', 'aria-label': 'Run a command or open a file', placeholder: 'Run a command or open a file', autocomplete: 'off', spellcheck: 'false' });
    const palList = h('ul', { id: 'ejm-ide-pal-list', role: 'listbox', 'aria-label': 'Results' });
    pal.append(h('div', { class: 'ejm-ui-palette', role: 'dialog', 'aria-label': 'Command palette' }, palInput, palList));
    let palItems = [], palSel = 0, lastFocus = null;
    function palCommands() {
      return [
        ...D.models.map((m, i) => ({ label: 'Switch model: ' + m, hint: i === s.model ? 'current' : 'label only', run: () => { s.model = i; paintStatusBar(); api.say('Model label set to ' + m + '. Replies stay scripted.'); } })),
        { label: 'Toggle theme', hint: 'this demo only', run: () => { api.setTheme(api.theme === 'dark' ? 'light' : 'dark'); api.say('Theme: ' + api.theme + '.'); } },
        ...project.files.map(f => ({ label: 'Open file: ' + f.path, hint: '', run: () => openFile(f.path) }))
      ];
    }
    function paintPalette() {
      const q = palInput.value.toLowerCase();
      palItems = palCommands().filter(c => c.label.toLowerCase().includes(q));
      palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
      palList.replaceChildren(...(palItems.length ? palItems.map((c, i) => h('li', { class: 'ejm-ui-menu__item', role: 'option', id: 'ejm-ide-pal-' + i, 'aria-selected': i === palSel ? 'true' : 'false', onclick: () => pick(c) }, h('span', { text: c.label }), c.hint ? h('span', { class: 'ejm-ui-menu__hint', text: c.hint }) : null)) : [h('li', { class: 'ejm-ui-menu__item', role: 'presentation', text: 'No matches. Try another search.' })]));
      palInput.setAttribute('aria-activedescendant', palItems.length ? 'ejm-ide-pal-' + palSel : '');
    }
    function openPalette() { lastFocus = document.activeElement; pal.hidden = false; palInput.value = ''; palSel = 0; paintPalette(); palInput.focus(); api.say('Command palette opened. Type to filter, arrows to choose, Enter to run, Escape to close.'); }
    function closePalette() { pal.hidden = true; }
    function restoreFocus() { const f = lastFocus && lastFocus.isConnected ? lastFocus : (tabs.querySelector('[aria-selected=true]') || tree.querySelector('[tabindex="0"]')); if (f) f.focus(); }
    function pick(c) { closePalette(); if (c) c.run(); restoreFocus(); }
    palInput.addEventListener('input', () => { palSel = 0; paintPalette(); });
    pal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); restoreFocus(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (palItems.length) { palSel = (palSel + (e.key === 'ArrowDown' ? 1 : palItems.length - 1)) % palItems.length; paintPalette(); } }
      else if (e.key === 'Enter') { e.preventDefault(); pick(palItems[palSel]); }
      else if (e.key === 'Tab') e.preventDefault();
    });

    /* shell */
    const pathLabel = h('span', { class: 'ejm-ui-mono' });
    const runStatus = h('span', { class: 'ejm-ui-status', 'data-state': 'idle', text: 'Idle' });
    const modelStat = h('span', { class: 'ejm-ui-mono' });
    const paintStatusBar = () => { modelStat.textContent = D.models[s.model]; modelLabel.textContent = D.models[s.model]; };
    function paintRun() {
      runStatus.dataset.state = s.running ? 'running' : 'idle'; runStatus.textContent = s.running ? 'Running' : 'Idle';
      sendBtn.hidden = s.running; stopBtn.hidden = !s.running; input.disabled = s.running;
    }
    const shell = h('div', { class: 'ejm-demo__ide ejm-ui-shell' },
      h('div', { class: 'ejm-ui-titlebar' }, h('span', { class: 'ejm-ui-caption', text: 'harbor' }), h('span', { class: 'ejm-ui-badge', text: 'sample project' }),
        h('button', { class: 'ejm-ui-btn ejm-ui-btn--ghost ejm-ui-btn--sm ejm-demo__cmdbtn', type: 'button', onclick: openPalette }, 'Commands ', h('span', { class: 'ejm-ui-kbd', text: snd + ' K' }))),
      h('nav', { class: 'ejm-ui-sidebar', 'aria-label': 'Chats and files' },
        h('div', { class: 'ejm-ui-pane__head' }, h('span', { class: 'ejm-ui-label', text: 'chats' }), newChat), chatList,
        h('div', { class: 'ejm-ui-pane__head' }, h('span', { class: 'ejm-ui-label', text: 'files' })), tree),
      h('main', { class: 'ejm-ui-main' }, tabs, panel),
      h('aside', { class: 'ejm-ui-aside ejm-demo__chat', 'aria-label': D.agent + ' chat' },
        h('div', { class: 'ejm-ui-pane__head' }, agentName, modelLabel), chips, log, form),
      h('div', { class: 'ejm-ui-statusbar' }, runStatus, pathLabel, h('span', { class: 'ejm-demo__sbspacer' }), modelStat, h('span', {}, h('span', { class: 'ejm-ui-kbd', text: snd }), ' ', h('span', { class: 'ejm-ui-kbd', text: 'K' }), ' commands')),
      pal);
    shell.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); } });
    api.body.append(shell);
    paintChats(); paintTabs(); paintTree(); paintEditor(); paintStatusBar(); paintRun();
  }

  /* ---------- ejm-harness ---------- */
  function buildHarness(api, { data: D }) {
    const s = { tick: 0, limit: D.defaults.limit, cmds: D.defaults.commands, seq: 0, sessions: [], queue: [], next: 1, loop: false, journalLines: 0 };
    const fmt = (t) => '+' + (t * D.tickMs / 1000).toFixed(2) + 's';
    const journal = h('div', { class: 'ejm-ui-log ejm-demo__journal', role: 'log', 'aria-live': 'off', 'aria-label': 'Event journal, append only', tabindex: '0' });
    const log = (event, detail, level, sessionName) => {
      s.seq++;
      const row = h('div', { class: 'ejm-ui-log__line', 'data-level': level || 'info', 'data-session': sessionName || null }, h('span', { class: 'ejm-demo__seq', text: '#' + String(s.seq).padStart(3, '0') }), h('span', { class: 'ejm-ui-log__time', text: fmt(s.tick) }), h('span', { text: event + (detail ? '  ' + detail : '') }));
      const atEnd = journal.scrollHeight - journal.clientHeight - journal.scrollTop < 24;
      journal.append(row); if (atEnd) journal.scrollTop = journal.scrollHeight;
    };
    const countFor = (name) => journal.querySelectorAll('[data-session="' + name + '"]').length;

    /* controls */
    const slider = (id, label, min, max, val, onchange) => {
      const out = h('output', { for: id, text: String(val) }), inp = h('input', { class: 'ejm-ui-slider', id, type: 'range', min, max, step: '1', value: val });
      const paint = () => { inp.style.setProperty('--p', ((inp.value - min) / (max - min) * 100) + '%'); out.textContent = inp.value; };
      inp.addEventListener('input', () => { paint(); onchange(+inp.value, false); });
      inp.addEventListener('change', () => onchange(+inp.value, true));
      paint();
      return h('div', { class: 'ejm-ui-field' }, h('label', { class: 'ejm-ui-field__label', for: id, text: label }), h('div', { class: 'ejm-ui-slider-row' }, inp, out));
    };
    const limitField = slider('ejm-harness-limit', 'Max concurrent', 1, 8, s.limit, (v, final) => { const old = s.limit; s.limit = v; if (final && v !== old) { log('governor.limit', old + ' to ' + v, 'info'); api.say('Max concurrent set to ' + v + '.'); } paintStats(); ensureLoop(); });
    const cmdField = slider('ejm-harness-cmds', 'Command slots', 1, 4, s.cmds, (v, final) => { const old = s.cmds; s.cmds = v; if (final && v !== old) { log('governor.commands', old + ' to ' + v, 'info'); api.say('Command slots set to ' + v + '.'); } paintStats(); });
    const crashBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--danger', type: 'button', text: 'Crash worker', onclick: crash });
    const addBtn = h('button', { class: 'ejm-ui-btn ejm-ui-btn--primary', type: 'button', text: 'Add session', onclick: () => add(1) });
    const add5 = h('button', { class: 'ejm-ui-btn', type: 'button', text: 'Add 5', onclick: () => add(5) });
    const stat = (label) => { const v = h('span', { class: 'ejm-ui-stat__value', text: '0' }); return { v, el: h('div', { class: 'ejm-ui-stat' }, h('span', { class: 'ejm-ui-label', text: label }), v) }; };
    const stR = stat('running'), stQ = stat('queued'), stD = stat('done'), stC = stat('commands');
    const list = h('ul', { class: 'ejm-demo__sessions', 'aria-label': 'Sessions, sample data', tabindex: '0' });
    const emptyList = h('li', { class: 'ejm-demo__sessions-empty ejm-ui-caption', text: 'No sessions yet. Press Add session.' });
    list.append(emptyList);

    /* sessions */
    function add(n) {
      for (let i = 0; i < n; i++) {
        const id = s.next++, name = 'session-a' + id, plan = D.plan.map(p => ({ ...p, ticks: p.min + Math.floor(api.rand() * (p.max - p.min + 1)) }));
        const se = { id, name, state: 'queued', plan, phase: 0, done: 0, total: plan.reduce((a, p) => a + p.ticks, 0), holds: false, waiting: false, uncertain: false, rec: 0 };
        se.badge = h('span', { class: 'ejm-ui-badge' }); se.what = h('span', { class: 'ejm-ui-caption' });
        se.bar = h('span', { class: 'ejm-ui-progress__bar' });
        se.track = h('div', { class: 'ejm-ui-progress__track', role: 'progressbar', 'aria-label': name + ' progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, se.bar);
        se.el = h('li', { class: 'ejm-demo__session' }, h('div', { class: 'ejm-demo__session-head' }, h('span', { class: 'ejm-ui-mono', text: name }), se.badge, se.what), h('div', { class: 'ejm-ui-progress' }, se.track));
        emptyList.hidden = true; list.append(se.el);
        s.sessions.push(se); s.queue.push(se);
        log('session.queued', name, 'info', name);
        paintSession(se);
      }
      paintStats(); ensureLoop();
    }
    const stateWord = (se) => se.state === 'running' ? (se.waiting ? 'waiting' : 'running') : se.state;
    function paintSession(se) {
      const pct = se.state === 'done' ? 100 : Math.round((se.plan.slice(0, se.phase).reduce((a, p) => a + p.ticks, 0) + se.done) / se.total * 100);
      const word = stateWord(se);
      se.badge.textContent = word + (se.uncertain && se.state !== 'queued' ? ', 1 uncertain' : '');
      se.badge.className = 'ejm-ui-badge' + ({ running: ' ejm-ui-badge--success', done: '', waiting: ' ejm-ui-badge--warning', recovering: ' ejm-ui-badge--special' }[word] || '');
      const ph = se.plan[se.phase];
      se.what.textContent = se.state === 'running' ? (se.waiting ? 'waiting for a command slot' : ph.label) : se.state === 'recovering' ? 'replaying the journal' : se.state === 'queued' ? 'waiting for the governor' : '';
      se.bar.style.setProperty('--value', pct); se.track.setAttribute('aria-valuenow', pct);
      se.el.dataset.state = se.state;
    }
    function paintStats() {
      const run = s.sessions.filter(x => x.state === 'running' || x.state === 'recovering').length;
      stR.v.textContent = run + ' / ' + s.limit; stQ.v.textContent = String(s.queue.length);
      stD.v.textContent = String(s.sessions.filter(x => x.state === 'done').length);
      stC.v.textContent = s.sessions.filter(x => x.holds).length + ' / ' + s.cmds;
      crashBtn.disabled = !s.sessions.some(x => x.state === 'running');
    }
    const active = () => s.sessions.filter(x => x.state === 'running' || x.state === 'recovering');
    function advance(se) {
      const ph = se.plan[se.phase];
      if (ph.kind === 'command' && !se.holds) {
        if (s.sessions.filter(x => x.holds).length >= s.cmds) { if (!se.waiting) { se.waiting = true; log('command.wait', se.name + ' waits for a free command slot', 'warn', se.name); } return; }
        se.holds = true; se.waiting = false; log('tool.call', se.name + ' starts a local command', 'info', se.name);
      }
      if (se.done === 0 && ph.kind === 'model') log('model.request', se.name, 'info', se.name);
      se.done++;
      if (se.done >= ph.ticks) {
        if (ph.kind === 'command') { se.holds = false; log('tool.result', se.name + ' command finished', 'info', se.name); } else log('model.response', se.name, 'info', se.name);
        se.phase++; se.done = 0;
        if (se.phase >= se.plan.length) { se.state = 'done'; log('session.done', se.name, 'info', se.name); api.say(se.name + ' done.'); }
      }
    }
    function recoverStep(se) {
      if (--se.rec > 0) return;
      const ph = se.plan[se.phase];
      if (ph.kind === 'command') {
        log('tool.uncertain', se.name + ' call marked uncertain, not run again', 'warn', se.name);
        se.uncertain = true; se.phase++; se.done = 0;
      } else { log('model.retry', se.name + ' request is sent again, no side effects', 'info', se.name); se.done = 0; }
      se.state = se.phase >= se.plan.length ? 'done' : 'running';
      log('session.resumed', se.name, 'info', se.name);
      api.say(se.name + ' resumed from the journal.' + (ph.kind === 'command' ? ' Its interrupted command was marked uncertain and not run again.' : ''));
      if (se.state === 'done') { log('session.done', se.name, 'info', se.name); api.say(se.name + ' done.'); }
    }
    function step() {
      s.tick++;
      for (const se of s.sessions) {
        if (se.state === 'running') advance(se);
        else if (se.state === 'recovering') recoverStep(se);
      }
      while (s.queue.length && active().length < s.limit) {
        const se = s.queue.shift(); se.state = 'running';
        log('session.admitted', se.name + ' (' + active().length + '/' + s.limit + ' running)', 'info', se.name);
        api.say(se.name + ' admitted.');
      }
      s.sessions.forEach(paintSession); paintStats();
    }
    function crash() {
      const victims = s.sessions.filter(x => x.state === 'running');
      if (!victims.length) return;
      log('worker.crashed', victims.length + ' running session' + (victims.length > 1 ? 's' : '') + ' interrupted', 'error');
      api.say('Worker crashed. ' + victims.length + ' running sessions interrupted. Recovering from the journal.');
      for (const se of victims) {
        se.holds = false; se.waiting = false; se.state = 'recovering'; se.rec = D.recoveryTicks;
        log('session.interrupted', se.name, 'warn', se.name);
      }
      log('recovery.start', 'journal is read, nothing is erased', 'warn');
      for (const se of victims) log('recovery.replay', 'replayed ' + countFor(se.name) + ' events for ' + se.name, 'warn', se.name);
      s.sessions.forEach(paintSession); paintStats(); ensureLoop();
    }
    async function ensureLoop() {
      if (s.loop) return;
      s.loop = true; const tok = api.token(); s.tok = tok;
      try { while (s.sessions.some(x => x.state !== 'done')) { await api.sleep(D.tickMs, tok); step(); } }
      catch (e) { if (e !== CANCEL) throw e; return; }
      s.loop = false; api.cancel(tok);
    }
    api.cleanup(() => { s.loop = false; });

    /* languages */
    let lang = D.langs[0].id;
    const langTabs = h('div', { class: 'ejm-ui-tabs', role: 'tablist', 'aria-label': 'SDK language' });
    const langPanel = h('div', { class: 'ejm-demo__lang', role: 'tabpanel' });
    function paintLang() {
      langTabs.replaceChildren(...D.langs.map(l => {
        const t = h('button', { class: 'ejm-ui-tab', role: 'tab', type: 'button', id: 'ejm-lang-tab-' + l.id, 'aria-selected': String(l.id === lang), 'aria-controls': 'ejm-lang-panel', tabindex: l.id === lang ? '0' : '-1', text: l.label, onclick: () => { lang = l.id; paintLang(); } });
        t.addEventListener('keydown', (e) => {
          const i = D.langs.findIndex(x => x.id === lang), go = (j) => { e.preventDefault(); lang = D.langs[(j + D.langs.length) % D.langs.length].id; paintLang(); langTabs.querySelector('[aria-selected=true]').focus(); };
          if (e.key === 'ArrowRight') go(i + 1); else if (e.key === 'ArrowLeft') go(i - 1); else if (e.key === 'Home') go(0); else if (e.key === 'End') go(D.langs.length - 1);
        });
        return t;
      }));
      const l = D.langs.find(x => x.id === lang);
      langPanel.id = 'ejm-lang-panel'; langPanel.setAttribute('aria-labelledby', 'ejm-lang-tab-' + lang);
      const code = h('code'); splitLines(l.code).forEach((ln, i, a) => { code.append(...tokenLine(ln, l.id === 'ts' ? 'ts' : l.id), i < a.length - 1 ? '\n' : ''); });
      langPanel.replaceChildren(h('p', { class: 'ejm-ui-caption', text: l.caption }), h('pre', { class: 'ejm-ui-code', tabindex: '0', 'aria-label': l.label + ' example' }, code));
    }

    const gov = h('fieldset', { class: 'ejm-demo__gov' }, h('legend', { class: 'ejm-ui-label', text: 'resource governor (sample values)' }), limitField, cmdField,
      h('div', { class: 'ejm-demo__btns' }, addBtn, add5, crashBtn), h('p', { class: 'ejm-demo__hint', text: D.realDefaults }));
    api.body.append(h('div', { class: 'ejm-demo__harness' },
      h('div', { class: 'ejm-demo__col' }, gov, h('div', { class: 'ejm-demo__stats' }, stR.el, stQ.el, stD.el, stC.el), list),
      h('div', { class: 'ejm-demo__col' }, h('div', { class: 'ejm-ui-pane__head' }, h('span', { class: 'ejm-ui-label', text: 'event journal (sample events, append only)' })), journal),
      h('div', { class: 'ejm-demo__langs' }, h('div', { class: 'ejm-ui-pane__head' }, h('span', { class: 'ejm-ui-label', text: 'open a session from your language' })), langTabs, langPanel)));
    paintLang();
    log('engine.start', 'journal opened, limit ' + s.limit + ', command slots ' + s.cmds, 'info');
    add(D.defaults.start);
  }

  /* ---------- boot ---------- */
  const BUILDERS = { cli: buildCli, ide: buildIde, harness: buildHarness };
  async function boot(host) {
    const kind = host.dataset.ejmDemo, build = BUILDERS[kind];
    if (!build || host.dataset.demoBooted) return;
    host.dataset.demoBooted = '1';
    const fallback = [...host.childNodes];
    const ready = new Promise((res) => {
      if (host.dataset.demoStart === 'eager' || !('IntersectionObserver' in window)) return res();
      const io = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) { io.disconnect(); res(); } }, { rootMargin: '200px' });
      io.observe(host);
    });
    try {
      await ready; await loadUi();
      const url = new URL(host.dataset.demoData || kind + '.json', new URL('demos/', BASE));
      const data = await getJson(url.href);
      const project = data.project ? await getJson(new URL(data.project, url).href) : null;
      makeFrame(host, kind, data, (api) => build(api, { data, project }));
    } catch (err) {
      host.replaceChildren(...fallback, h('p', { class: 'ejm-demo__error', role: 'status', text: 'The interactive demo could not load. The static version above shows what it does.' }));
    }
  }
  const start = () => document.querySelectorAll('[data-ejm-demo]').forEach(boot);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
