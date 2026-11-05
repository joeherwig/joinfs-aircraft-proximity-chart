import { select, pointer } from 'd3-selection';
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from 'd3-force';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';
import { drag as d3drag } from 'd3-drag';
import { scaleOrdinal, scaleLinear } from 'd3-scale';
import { schemeTableau10 } from 'd3-scale-chromatic';
import { extent, quantile } from 'd3-array';
import { buildIndex, parseRelated, neighbourOf, MAX_POINTS } from './proximity.js';
import { parseModels, groupModels, pickRow, titleFit, virtualAircraft, isLookupLine, resolveAirline, callsignScore, modelScore } from './models.js';
import { createMatcher, makeReference, makeDoc8643, makeRelated, makeAirlines } from './joinfs-matcher.js';
import { COMPONENT, SCRIPT_URL, pickLanguage, loadLocale, makeTranslator } from './i18n.js';
import css from './style.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ENGINE_TYPE_ORDER = ['piston', 'turboprop', 'jet', 'turboshaft', 'electric', 'none'];
const WING_ORDER = ['low', 'mid', 'high', 'biplane', 'rotor'];
const COLOR_BY = ['engineType', 'manufacturer', 'wing', 'gear'];
const FOCUS_NEIGHBOURS = 10;
const FILTER_ATTRIBUTES = [['engine-type', 'engineType'], ['engines', 'engines'], ['wing', 'wing'], ['gear', 'gear'], ['manufacturer', 'manufacturer']];
const LABEL_ZOOM = 2.2;
const OTHER = '\u0000other';
const TOP_LIVERIES = 10;
const TYPING_PAUSE_MS = 400; // a text field acts this long after the last keystroke, without Enter
const AIRLINE_SLACK = 0.15; // a type with the airline's livery may be this much less similar and still be preferred

/** Rows that share a designator ICAO folded several aircraft into (GLID, GLIM ...) get a label telling them apart: "GLID · two-seat trainer". */
function labelSharedDesignators(aircraft) {
  const rows = new Map();
  for (const a of aircraft) rows.set(a.icao, (rows.get(a.icao) ?? 0) + 1);
  for (const a of aircraft) if (rows.get(a.icao) > 1) a.label = `${a.icao} · ${a.name.split(', ').pop()}`;
}

// One fetch per URL per page.
const dataCache = new Map();
function fetchOnce(url, parse) {
  if (!dataCache.has(url)) {
    // revalidate: a changed data file must show up without clearing the browser cache
    dataCache.set(url, fetch(url, { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return parse(r);
    }));
    dataCache.get(url).catch(() => dataCache.delete(url)); // allow a retry after a failure
  }
  return dataCache.get(url);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c);
  return el;
}

class ProximityChart extends HTMLElement {
  static get observedAttributes() { return ['lang', 'src', 'related-src', 'focus', 'k', 'min-proximity', 'search', 'color-by', 'engine-type', 'engines', 'wing', 'gear', 'manufacturer', 'callsign', 'aircraft-title']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.t = makeTranslator({});
    this.lang = 'en';
    this.s = {
      search: '', callsign: '', title: '', colorBy: 'engineType', k: 4, minProx: 20,
      filters: { engineType: '', engines: '', wing: '', gear: '', manufacturer: '' },
      focus: null, openWhy: new Set(), livery: null,
    };
    this.models = null; // Map<aircraft index, models[]> once a models list is loaded
    this.modelInfo = null;
    this.modelsNote = '';
    this.modelsVersion = 0;
    this.livCache = new Map();
    this.index = null;
    this.loadState = 'idle'; // idle | loading | ready | error
    this.errorText = '';
    this.built = false;
  }

  connectedCallback() {
    if (this.built) return;
    this.built = true;
    this.#readStateAttributes();
    this.#buildShell();
    this.#load();
  }

  disconnectedCallback() {
    this.sim?.stop();
    Object.values(this.typingTimers ?? {}).forEach(clearTimeout);
  }

  attributeChangedCallback(name, oldValue, value) {
    if (!this.built || oldValue === value) return;
    if (name === 'lang') this.#setLanguage().then(() => this.#renderAll());
    else if (name === 'src' || name === 'related-src') this.#load();
    else if (name === 'focus') this.#focusFromAttribute();
    else {
      this.#readStateAttributes();
      this.#renderChrome();
      if (this.index) { this.#recolor(); this.#rebuildGraph(); }
    }
  }

  /** Select an aircraft type programmatically. */
  focus(icao) {
    if (!this.index) { this.pendingFocus = icao; return; }
    const squash = x => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const q = squash(icao);
    const list = this.index.aircraft;
    let i = list.findIndex(a => squash(a.icao) === q);
    if (i < 0) i = list.findIndex(a => (a.aliases ?? []).some(x => squash(x) === q)); // e.g. A32N -> A20N, H125 -> AS50
    this.#setFocus(i >= 0 ? i : null);
  }

  /** Match the aircraft against a JoinFS models list (the text of "models - <simulator>.txt"). Returns false if it holds no models. */
  loadModels(text, name = '') {
    if (!this.index) { this.pendingModels = [text, name]; return true; }
    const parsed = parseModels(text);
    if (!parsed.length) {
      this.modelsNote = this.t('toolbar.modelsInvalid');
      this.#renderChrome();
      return false;
    }
    // the types of the list that the data does not know (SZD30, AS7 ...) get nodes of their own while the list is loaded
    const virtuals = virtualAircraft(parsed, this.baseAircraft);
    if (virtuals.length || this.index.aircraft !== this.baseAircraft) this.#setAircraft(virtuals.length ? [...this.baseAircraft, ...virtuals] : this.baseAircraft);
    const { byAircraft, unmatched } = groupModels(parsed, this.index.aircraft);
    this.modelsNote = '';
    this.models = byAircraft;
    this.parsedModels = parsed;
    this.prepared = this.joinfs ? this.joinfs.prepareModels(parsed) : null;
    this.nodeOfModel = new Map();
    for (const [node, list] of byAircraft) for (const m of list) this.nodeOfModel.set(m, node);
    this.modelInfo = { name, models: parsed.length - unmatched, types: byAircraft.size };
    this.modelsVersion++;
    this.livCache.clear();
    this.s.livery = null;
    this.#afterModelsChanged();
    // a focus given as an attribute (focus="SZD30") may name one of the new nodes
    if (this.s.focus === null && this.getAttribute('focus')) this.#focusFromAttribute();
    return true;
  }

  /** Use another aircraft list (the data's, or the data's plus the model set's own types): new index and graph; the data's nodes keep their numbers. */
  #setAircraft(list) {
    this.index = buildIndex(list, this.related);
    this.#buildGraph();
    this.#rebuildGraph(true);
  }

  async #onModelsFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again
    if (!file) return;
    try {
      this.loadModels(await file.text(), file.name);
    } catch (err) {
      console.warn(`[${COMPONENT}] Could not read ${file.name}: ${err.message ?? err}`);
      this.modelsNote = this.t('toolbar.modelsInvalid');
      this.#renderChrome();
    }
  }

  #clearModels() {
    this.prepared = null;
    this.nodeOfModel = null;
    if (this.index.aircraft !== this.baseAircraft) {
      if (this.s.focus !== null && this.s.focus >= this.baseAircraft.length) this.s.focus = null;
      this.#setAircraft(this.baseAircraft);
    }
    this.models = null;
    this.parsedModels = null;
    this.modelInfo = null;
    this.modelsNote = '';
    this.modelsVersion++;
    this.livCache.clear();
    this.s.livery = null;
    this.#stateChanged();
    this.#afterModelsChanged();
  }

  #afterModelsChanged() {
    this.#renderChrome();
    this.#rebuildGraph();
    this.#renderPanel();
  }

  /** The airline code the callsign stands for, taken from the loaded models list ('' without a list or a match). */
  #airline() {
    if (!this.parsedModels || !this.models) return '';
    const key = `${this.s.callsign}\u0001${this.modelsVersion}`;
    if (this.airlineCache?.key !== key) {
      this.airlineCache = { key, code: resolveAirline(this.s.callsign, this.parsedModels), exact: this.parsedModels.some(m => callsignScore(m, this.s.callsign) > 0) };
    }
    return this.airlineCache.code;
  }

  /** How well a model fits what was entered: the airline it stands for, or the callsign as a word in the title or livery. */
  #score(m) { return modelScore(m, this.#airline(), this.s.callsign); }

  #hasCallsign() { return this.s.callsign.trim() !== ''; }

  #hasTitle() { return this.s.title.trim() !== ''; }

  /** The designator a remote on this node reports: its own (also for a node of the model set's own, SZD30), or the designator the Title box was started from (GLID). */
  #titleTag(focus) {
    const air = this.index.aircraft;
    if (air[focus].virtual) return air[focus].icao;
    return this.titleResult === focus ? this.titleBase : air[focus].icao;
  }

  /** The callsign box as JoinFS would receive it: a known ICAO airline code (also in "DLH123") is the ICAO airline, anything else an airline name. */
  #remoteAirline() {
    const text = this.s.callsign.trim();
    if (!text) return { icaoAirline: '', atcAirline: '' };
    const m = /^([A-Za-z]{3})([0-9].*)?$/.exec(text);
    if (m && this.joinfs.isAirlineCode(m[1])) return { icaoAirline: m[1].toUpperCase(), atcAirline: '' };
    return { icaoAirline: '', atcAirline: text.replace(/[ 0-9]+$/, '') };
  }

  /**
   * The installed model JoinFS would inject for the selected aircraft as a remote (its designator, the Title box, the callsign's airline), with the node it is
   * shown on: { model, node, total, type }. Null without a models list, a selection or an acceptable model. Cached per remote and models list.
   */
  #injected() {
    if (!this.index || !this.joinfs || !this.prepared || this.s.focus === null) return null;
    const tag = this.#titleTag(this.s.focus);
    const remote = { icaoType: tag, title: this.s.title.trim(), livery: '', ...this.#remoteAirline() };
    const key = JSON.stringify([remote, this.modelsVersion]);
    if (this.injectedKey !== key) {
      this.injectedKey = key;
      const found = this.joinfs.match(this.prepared, remote);
      this.injectedValue = null;
      if (found) {
        const air = this.index.aircraft;
        const effective = found.ranking.find(r => r.model === found.model)?.effectiveIcao;
        const node = this.nodeOfModel.get(found.model.source) ?? (effective ? air.findIndex(a => a.icao === effective) : -1);
        if (node >= 0) this.injectedValue = { model: found.model.source, node, total: found.total, type: found.type };
      }
      this.livCache.clear();
    }
    return this.injectedValue;
  }

  #airlineNote() {
    if (!this.models || !this.s.callsign.trim()) return '';
    const code = this.#airline();
    if (code) return this.t('toolbar.airlineResolved', { code });
    return this.airlineCache.exact ? this.t('toolbar.callsignInTitle') : this.t('toolbar.airlineUnknown');
  }

  /** The installed models of an aircraft, best first; with a callsign, the airline's liveries come before the rest. */
  #liveries(i) {
    this.#airline();
    const list = this.models.get(i);
    const injected = this.#injected();   // refreshes (and clears the cache of) the order when the selection, title, callsign or list changed
    if (!injected && !this.#hasCallsign() && !this.#hasTitle()) return list;
    if (!this.livCache.has(i)) {
      const score = new Map(list.map(m => [m, this.#score(m)]));
      // title words first (up to 30 points, like JoinFS), then the airline / callsign fit
      const matched = injected?.model;
      const rank = m => (m === matched ? 1e9 : 0) + titleFit(this.s.title, m.title) * 10 + score.get(m);
      this.livCache.set(i, { list: [...list].sort((a, b) => rank(b) - rank(a)), score });
    }
    return this.livCache.get(i).list;
  }

  /**
   * Whether an aircraft counts as installed. A generic class line of a collapsed designator (GLID: "Glider, 15 m class" ...) only supplies parameters:
   * it holds models (a JS3 is listed there), but is shown as installed only while it is the place of the model that would be injected.
   */
  #isAvail(i) {
    if (!this.models?.has(i)) return false;
    return !isLookupLine(this.index.aircraft, i) || this.#injected()?.node === i;
  }

  /** The one aircraft that gets the green mark: the requested type if it is installed (it is taken as is), else its most similar installed type. */
  #bestMatch() {
    const f = this.s.focus;
    if (f === null || !this.models) return null;
    // the installed model JoinFS would inject for this remote - possibly on another node than the selected one (the right airline on a look-alike)
    if (this.joinfs && this.prepared) return this.#injected()?.node ?? null;
    if (this.#isAvail(f)) return f;
    const cands = this.#focusNeighbours(f).filter(n => this.#isAvail(n.index)).map(n => ({ index: n.index, percent: n.p.percent }));
    if (!cands.length) return null;
    // With a callsign, an installed type that has the airline's livery wins unless it is clearly less similar.
    const withAirline = this.#hasCallsign() ? cands.find(c => this.#score(this.#liveries(c.index)[0]) > 0) : null;
    if (withAirline && cands[0].percent - withAirline.percent <= AIRLINE_SLACK) return withAirline.index;
    return cands[0].index;
  }

  /** The livery that would be used for an aircraft: the one the user chose, else the best ranked. */
  #liveryOf(i) {
    const list = this.#liveries(i);
    const c = this.s.livery;
    return (c && c.i === i && list.find(m => `${m.title}\u0001${m.livery}` === c.key)) || list[0];
  }

  // ---------------------------------------------------------------- loading

  #readStateAttributes() {
    const k = parseInt(this.getAttribute('k'), 10);
    if (k >= 1 && k <= 12) this.s.k = k;
    const m = parseFloat(this.getAttribute('min-proximity'));
    if (m >= 0 && m <= 100) this.s.minProx = m;
    const s = this.s;
    s.search = this.getAttribute('search') ?? '';
    s.callsign = this.getAttribute('callsign') ?? '';
    s.title = this.getAttribute('aircraft-title') ?? '';
    this.livCache.clear();
    const colorBy = this.getAttribute('color-by');
    s.colorBy = COLOR_BY.includes(colorBy) ? colorBy : 'engineType';
    for (const [attr, key] of FILTER_ATTRIBUTES) s.filters[key] = this.getAttribute(attr) ?? '';
  }

  async #setLanguage() {
    this.lang = pickLanguage(this.getAttribute('lang'));
    this.t = makeTranslator(await loadLocale(this.lang));
    this.nf = new Intl.NumberFormat(this.lang, { maximumFractionDigits: 1 });
    this.setAttribute('data-lang', this.lang);
  }

  async #load() {
    const token = (this.loadToken = (this.loadToken ?? 0) + 1);
    this.loadState = 'loading';
    await this.#setLanguage();
    this.#renderAll();
    const specUrl = new URL(this.getAttribute('src') || 'aircraft-specs.json', SCRIPT_URL).href;
    const relatedUrl = new URL(this.getAttribute('related-src') || 'XPMP2_related.dat', SCRIPT_URL).href;
    const doc8643Url = new URL(this.getAttribute('doc8643-src') || 'doc8643.json', SCRIPT_URL).href;
    const airlinesUrl = new URL(this.getAttribute('airlines-src') || 'airlines.json', SCRIPT_URL).href;
    const optionalJson = url => fetchOnce(url, r => r.json()).catch(err => {
      console.warn(`[${COMPONENT}] Could not load ${url}: ${err.message ?? err}. The installed model is then chosen by type proximity only, not as JoinFS does.`);
      return null;
    });
    try {
      const [spec, relatedText, doc8643, airlines] = await Promise.all([
        fetchOnce(specUrl, r => r.json()),
        fetchOnce(relatedUrl, r => r.text()).catch(err => {
          console.warn(`[${COMPONENT}] Could not load ${relatedUrl}: ${err.message ?? err}. Continuing without related types.`);
          return '';
        }),
        optionalJson(doc8643Url),
        optionalJson(airlinesUrl),
      ]);
      if (token !== this.loadToken) return;
      const aircraft = spec.aircraft ?? spec;
      labelSharedDesignators(aircraft);
      this.baseAircraft = aircraft;
      this.related = parseRelated(relatedText);
      // JoinFS' own matcher, ported (src/joinfs-matcher.js): decides which installed model is shown as the answer
      this.joinfs = doc8643 && airlines ? createMatcher({ reference: makeReference(aircraft), doc8643: makeDoc8643(doc8643), related: makeRelated(relatedText), airlines: makeAirlines(airlines) }) : null;
      this.index = buildIndex(aircraft, this.related);
      this.loadState = 'ready';
      this.#buildGraph();
      this.#renderAll();
      this.#rebuildGraph(true);
      if (this.pendingModels) { const [text, name] = this.pendingModels; this.pendingModels = null; this.loadModels(text, name); }
      if (this.pendingFocus) { const p = this.pendingFocus; this.pendingFocus = null; this.focus(p); }
      else this.#focusFromAttribute();
    } catch (err) {
      if (token !== this.loadToken) return;
      console.warn(`[${COMPONENT}] Could not load ${specUrl}: ${err.message ?? err}`);
      this.loadState = 'error';
      this.errorText = this.t('status.error', { url: specUrl }) + (location.protocol === 'file:' ? ' ' + this.t('status.errorFile') : '');
      this.#renderStatus();
    }
  }

  #focusFromAttribute() {
    const icao = this.getAttribute('focus');
    if (icao) this.focus(icao);
    else if (this.getAttribute('search')) this.#focusFirstMatch(); // as if the text was typed into the form and confirmed
  }

  // ---------------------------------------------------------------- shell

  #buildShell() {
    const root = this.shadowRoot;
    root.append(h('style', {}, css));
    this.$toolbar = h('div', { class: 'toolbar', role: 'search' });
    this.$status = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
    this.$legend = h('div', { class: 'legend' });
    this.$hint = h('div', { class: 'hint' });
    this.$tip = h('div', { class: 'tip', hidden: true, role: 'tooltip' });
    this.$file = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true, onchange: e => this.#onModelsFile(e) });
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.$stage = h('div', { class: 'stage' }, this.svg, this.$legend, this.$status, this.$hint, this.$tip);
    this.$panel = h('aside', { class: 'panel' });
    this.$root = h('div', { class: 'root', onkeydown: e => { if (e.key === 'Escape') this.#setFocus(null); } },
      this.$toolbar, h('div', { class: 'main' }, this.$stage, this.$panel));
    root.append(this.$root);

    const svg = select(this.svg);
    this.gZoom = svg.append('g');
    this.gEdges = this.gZoom.append('g');
    this.gFocusEdges = this.gZoom.append('g');
    this.gNodes = this.gZoom.append('g');
    this.zoom = d3zoom().scaleExtent([0.25, 10]).on('zoom', e => {
      this.gZoom.attr('transform', e.transform);
      this.$root.style.setProperty('--inv', String(1 / e.transform.k));
      this.$root.classList.toggle('labels-on', e.transform.k >= LABEL_ZOOM);
    });
    svg.call(this.zoom).on('dblclick.zoom', null);
    svg.on('click', e => { if (e.target === this.svg) this.#setFocus(null); });
  }

  // ---------------------------------------------------------------- chrome rendering

  #renderAll() {
    this.svg.setAttribute('aria-label', this.t('chart.aria'));
    this.#renderChrome();
    this.#renderStatus();
    this.#renderLegend();
    this.#renderPanel();
    this.$hint.textContent = this.t('chart.hint');
    if (this.nodeSel) this.nodeSel.attr('aria-label', d => this.#nodeLabel(d.a));
  }

  #renderStatus() {
    this.$status.className = 'status' + (this.loadState === 'error' ? ' error' : '');
    if (this.loadState === 'loading') this.$status.textContent = this.t('status.loading');
    else if (this.loadState === 'error') this.$status.textContent = this.errorText;
    else if (this.index) this.$status.textContent = this.t('status.count', { shown: this.nf.format(this.matchCount ?? this.index.aircraft.length), total: this.nf.format(this.index.aircraft.length) });
    else this.$status.textContent = '';
  }

  #distinct(key, order) {
    const set = [...new Set(this.index.aircraft.map(a => a[key]))];
    if (order) return set.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return set.sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
  }

  #renderChrome() {
    const t = this.t;
    const s = this.s;
    const select_ = (label, key, options, value, onchange) =>
      h('label', {}, label,
        h('select', { onchange: e => onchange(e.target.value) },
          h('option', { value: '' }, t('filter.all')),
          options.map(o => h('option', { value: String(o.value), selected: String(o.value) === String(value) }, o.label))));
    const range = (labelKey, min, max, value, onchange) => {
      const label = h('span', {}, t(labelKey, { n: this.nf.format(value) }));
      const input = h('input', { type: 'range', min, max, step: 1, value, 'aria-label': t(labelKey, { n: this.nf.format(value) }),
        oninput: e => { const v = Number(e.target.value); label.textContent = t(labelKey, { n: this.nf.format(v) }); },
        onchange: e => onchange(Number(e.target.value)) });
      return h('label', {}, label, input);
    };

    const parts = [
      h('label', {}, t('toolbar.search'),
        h('input', { type: 'search', class: 'search', value: s.search, placeholder: t('toolbar.searchPlaceholder'), 'aria-label': t('toolbar.search'),
          oninput: e => { s.search = e.target.value; this.#applyClasses(); this.#stateChanged(); this.#whenTypingStops('search', () => this.#focusFirstMatch()); },
          onchange: () => this.#focusFirstMatch(), // also on Tab / losing focus, not only Enter
          onkeydown: e => { if (e.key === 'Enter') this.#focusFirstMatch(); } })),
      h('label', {}, t('toolbar.callsign'),
        h('input', { type: 'search', class: 'callsign', value: s.callsign, placeholder: t('toolbar.callsignPlaceholder'), 'aria-label': t('toolbar.callsign'), autocomplete: 'off',
          oninput: e => {
            s.callsign = e.target.value; this.livCache.clear(); this.#stateChanged();
            this.$airlineNote.textContent = this.#airlineNote();
            if (this.models && s.focus !== null) { this.#applyClasses(); this.#renderPanel(); }
            this.#whenTypingStops('callsign', () => this.#applyCallsign());
          },
          onchange: () => this.#applyCallsign(), // also on Tab / losing focus
          onkeydown: e => { if (e.key === 'Enter') this.#applyCallsign(); } })),
      (this.$airlineNote = h('span', { class: 'note ok-note', role: 'status' }, this.#airlineNote())),
      h('label', {}, t('toolbar.title'),
        h('input', { type: 'search', class: 'aircraft-title', value: s.title, placeholder: t('toolbar.titlePlaceholder'), 'aria-label': t('toolbar.title'), autocomplete: 'off',
          oninput: e => { s.title = e.target.value; this.livCache.clear(); this.#stateChanged(); this.$titleNote.textContent = this.#titleNote(); this.#applyClasses(); if (this.models && s.focus !== null) this.#renderPanel(); this.#whenTypingStops('title', () => this.#applyTitle()); },
          onchange: () => this.#applyTitle(), // also on Tab / losing focus
          onkeydown: e => { if (e.key === 'Enter') this.#applyTitle(); } })),
      (this.$titleNote = h('span', { class: 'note ok-note', role: 'status' }, this.#titleNote())),
    ];
    if (this.index) {
      // Colour, filters and graph settings live in a dialog behind one button, to keep the toolbar simple.
      const colorBy = h('label', {}, t('toolbar.colorBy'),
        h('select', { onchange: e => { s.colorBy = e.target.value; this.#recolor(); this.#stateChanged(); } },
          COLOR_BY.map(k => h('option', { value: k, selected: k === s.colorBy }, t(k === 'engineType' ? 'filter.engineType' : `filter.${k}`)))));
      const dialogParts = [
        colorBy,
        select_(t('filter.engineType'), 'engineType', this.#distinct('engineType', ENGINE_TYPE_ORDER).map(v => ({ value: v, label: t.enum('engineType', v) })), s.filters.engineType, v => this.#setFilter('engineType', v)),
        select_(t('filter.engines'), 'engines', this.#distinct('engines').map(v => ({ value: v, label: String(v) })), s.filters.engines, v => this.#setFilter('engines', v)),
        select_(t('filter.wing'), 'wing', this.#distinct('wing', WING_ORDER).map(v => ({ value: v, label: t.enum('wing', v) })), s.filters.wing, v => this.#setFilter('wing', v)),
        select_(t('filter.gear'), 'gear', this.#distinct('gear').map(v => ({ value: v, label: t.enum('gear', v) })), s.filters.gear, v => this.#setFilter('gear', v)),
        select_(t('filter.manufacturer'), 'manufacturer', this.#distinct('manufacturer').map(v => ({ value: v, label: v === '-' ? t('detail.noManufacturer') : v })), s.filters.manufacturer, v => this.#setFilter('manufacturer', v)),
        range('toolbar.neighbours', 1, 12, s.k, v => { s.k = v; this.#rebuildGraph(); this.#stateChanged(); }),
        range('toolbar.minProximity', 0, 100, s.minProx, v => { s.minProx = v; this.#rebuildGraph(); this.#stateChanged(); }),
      ];
      const active = Object.values(s.filters).filter(v => v !== '').length;
      const dialog = h('dialog', { class: 'filters-dialog', 'aria-label': t('toolbar.filters') },
        h('h2', {}, t('toolbar.filters')), h('div', { class: 'filters-body' }, dialogParts),
        h('button', { type: 'button', onclick: () => dialog.close() }, t('detail.close')));
      dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); }); // backdrop click
      dialog.addEventListener('close', () => this.#renderChrome()); // refresh the active-filter count
      parts.push(
        h('button', { type: 'button', onclick: () => dialog.showModal() }, active ? `${t('toolbar.filters')} (${active})` : t('toolbar.filters')),
        dialog,
        h('button', { type: 'button', title: t('toolbar.loadModelsHint'), onclick: () => this.$file.click() }, t('toolbar.loadModels')),
        this.models ? h('button', { type: 'button', onclick: () => this.#clearModels() }, t('toolbar.clearModels')) : null,
        this.modelInfo ? h('span', { class: 'note', title: this.modelInfo.name }, t('toolbar.modelsLoaded', { n: this.nf.format(this.modelInfo.models), types: this.nf.format(this.modelInfo.types) })) : null,
        this.modelsNote ? h('span', { class: 'note error', role: 'status' }, this.modelsNote) : null,
        this.$file,
        h('button', { type: 'button', onclick: () => this.#reset() }, t('toolbar.reset')));
    }
    this.$toolbar.replaceChildren(...parts.filter(Boolean));
  }

  /** The form state as attribute-style parameters; defaults are left out. */
  get state() {
    const s = this.s;
    const out = {};
    if (s.search.trim()) out.search = s.search;
    if (s.callsign.trim()) out.callsign = s.callsign;
    if (s.title.trim()) out['aircraft-title'] = s.title;
    if (s.colorBy !== 'engineType') out['color-by'] = s.colorBy;
    for (const [attr, key] of FILTER_ATTRIBUTES) if (s.filters[key] !== '') out[attr] = s.filters[key];
    if (s.k !== 4) out.k = String(s.k);
    if (s.minProx !== 20) out['min-proximity'] = String(s.minProx);
    if (s.focus !== null && this.index) out.focus = this.index.aircraft[s.focus].icao;
    return out;
  }

  #stateChanged() {
    this.dispatchEvent(new CustomEvent('joinfs-proximity-change', { bubbles: true, composed: true, detail: this.state }));
  }

  #reset() {
    const s = this.s;
    s.search = '';
    s.callsign = '';
    s.title = '';
    this.livCache.clear();
    Object.keys(s.filters).forEach(k => { s.filters[k] = ''; });
    s.focus = null;
    s.colorBy = 'engineType';
    this.#stateChanged();
    this.#renderChrome();
    this.#rebuildGraph();
    this.#renderPanel();
    this.svg && select(this.svg).transition().duration(300).call(this.zoom.transform, this.fitTransform ?? zoomIdentity);
  }

  #setFilter(key, value) {
    this.s.filters[key] = value;
    this.#stateChanged();
    this.#applyClasses();
  }

  // ---------------------------------------------------------------- graph

  #nodeLabel(a) {
    return `${a.icao}, ${a.name}, ${a.manufacturer === '-' ? this.t('detail.noManufacturer') : a.manufacturer}`;
  }

  #buildGraph() {
    const aircraft = this.index.aircraft;
    const [lo, hi] = extent(aircraft, a => Math.log(a.mtowKg || 1));
    const radius = scaleLinear().domain([lo, hi]).range([3, 10]);
    this.nodes = aircraft.map((a, i) => {
      const angle = i * 2.399963; // golden angle: spread the start positions
      const dist = 8 * Math.sqrt(i);
      return { i, a, r: radius(Math.log(a.mtowKg || 1)), x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
    });

    this.gNodes.selectAll('*').remove();
    this.nodeSel = this.gNodes.selectAll('g').data(this.nodes).join('g')
      .attr('class', 'node').attr('role', 'img').attr('aria-label', d => this.#nodeLabel(d.a))
      .on('mouseenter', (e, d) => { this.#showTip(e, d); select(e.currentTarget).classed('show-label', true); })
      .on('mousemove', (e, d) => this.#showTip(e, d))
      .on('mouseleave', (e, d) => { this.$tip.hidden = true; this.#applyClasses(); })
      .on('click', (e, d) => { e.stopPropagation(); this.#setFocus(this.s.focus === d.i ? null : d.i); });
    this.nodeSel.append('circle').attr('class', 'back').attr('r', d => d.r);
    this.nodeSel.append('circle').attr('class', 'dot').attr('r', d => d.r);
    this.nodeSel.append('text').attr('dy', d => -d.r - 3).text(d => d.a.label ?? d.a.icao);
    this.nodeSel.append('text').attr('class', 'check').attr('dx', d => d.r + 2).attr('dy', d => -d.r).text('✔');
    this.nodeSel.call(d3drag()
      .on('start', (e, d) => { if (!e.active) this.sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on('end', (e, d) => { if (!e.active) this.sim.alphaTarget(0); d.fx = d.fy = null; }));

    this.sim = forceSimulation(this.nodes)
      .force('charge', forceManyBody().strength(-45).distanceMax(320))
      .force('x', forceX(0).strength(0.06))
      .force('y', forceY(0).strength(0.06))
      .force('collide', forceCollide(d => d.r + 3))
      .on('tick', () => this.#tick())
      .stop();
    this.#recolor();
  }

  /** Nodes passing search and filters. */
  #matches(d) {
    const { search, filters } = this.s;
    const a = d.a;
    for (const [k, v] of Object.entries(filters)) if (v !== '' && String(k === 'engines' ? a.engines : a[k]) !== v) return false;
    if (search.trim() === '') return true;
    return this.#searchTier(a) <= this.#bestSearchTier();
  }

  /**
   * How well an aircraft matches the search: 1 = ICAO type or alias equals it, 2 = ICAO type or alias starts with it,
   * 3 = found anywhere (name, manufacturer, title hints, ...), 4 = no match. Punctuation and spaces are ignored, like
   * JoinFS does when it looks a type tag up (JU-52 = JU52).
   */
  #searchTier(a) {
    const squash = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const q = this.s.search.trim().toLowerCase();
    const qs = squash(q);
    const codes = [a.icao, ...(a.aliases ?? [])].map(squash);
    if (qs && codes.includes(qs)) return 1;
    if (qs && codes.some(c => c.startsWith(qs))) return 2;
    const fields = [a.icao, a.name, a.manufacturer, ...(a.aliases ?? []), ...(a.titleHints ?? [])];
    return fields.some(x => x.toLowerCase().includes(q) || (qs !== '' && squash(x).includes(qs))) ? 3 : 4;
  }

  /** Only the best tier that has any hit counts: "C177" finds the Cardinal, not the C-17 whose title hint says "CC-177". */
  #bestSearchTier() {
    const key = this.s.search;
    if (this.bestTierFor !== key) {
      this.bestTierFor = key;
      this.bestTier = Math.min(4, ...this.nodes.map(d => this.#searchTier(d.a)));
    }
    return this.bestTier;
  }

  #rebuildGraph(fit = false) {
    if (!this.index) return;
    const { k, minProx } = this.s;
    this.matchFlags = this.nodes.map(d => this.#matches(d));
    const visible = new Set(this.nodes);
    this.visibleSet = visible;

    const seen = new Set();
    this.links = [];
    for (const d of visible) {
      let taken = 0;
      for (const nb of this.index.neighbours[d.i]) {
        if (taken >= k) break;
        if (nb.p.percent * 100 < minProx) break; // neighbours are sorted: the rest is lower
        const other = this.nodes[nb.index];
        if (!visible.has(other)) continue;
        taken++;
        const key = d.i < nb.index ? `${d.i}-${nb.index}` : `${nb.index}-${d.i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        this.links.push({ source: d, target: other, percent: nb.p.percent });
      }
    }

    this.#applyVisibility();
    this.edgeSel = this.gEdges.selectAll('line').data(this.links).join('line').attr('class', 'edge');
    this.sim.nodes([...visible])
      .force('link', forceLink(this.links).distance(l => 34 + (1 - l.percent) * 140).strength(l => 0.15 + 0.85 * l.percent));
    this.sim.alpha(1).stop();
    this.sim.tick(fit ? 320 : 120);
    this.#tick();
    this.sim.alpha(0.3).restart();
    if (this.s.focus !== null) this.#refreshFocus(); else this.#applyClasses();
    this.#renderStatus();
    if (fit) requestAnimationFrame(() => this.#fit());
  }

  /** Hidden nodes stay hidden, except the selected one: choosing a type that is not installed still shows where it sits. */
  #applyVisibility() {
    this.gNodes.selectAll('.node').attr('display', d => (this.visibleSet?.has(d) || d.i === this.s.focus ? null : 'none'));
  }

  #fit() {
    const w = this.$stage.clientWidth || 800;
    const hgt = this.$stage.clientHeight || 600;
    // Percentile bounds: a few isolated outliers must not shrink the main cluster.
    const q = key => { const v = this.nodes.map(d => d[key]).sort((a, b) => a - b); return [quantile(v, 0.03), quantile(v, 0.97)]; };
    const xs = q('x');
    const ys = q('y');
    const k = Math.min(w / (xs[1] - xs[0] + 60), hgt / (ys[1] - ys[0] + 60), 3);
    const cx = (xs[0] + xs[1]) / 2;
    const cy = (ys[0] + ys[1]) / 2;
    this.fitTransform = zoomIdentity.translate(w / 2 - cx * k, hgt / 2 - cy * k).scale(k);
    select(this.svg).call(this.zoom.transform, this.fitTransform);
  }

  #tick() {
    this.edgeSel?.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
    this.nodeSel?.attr('transform', d => `translate(${d.x},${d.y})`);
    this.focusEdgeSel?.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
  }

  #applyClasses() {
    if (!this.nodeSel) return;
    const f = this.s.focus;
    const q = this.s.search.trim() !== '';
    this.matchFlags = this.nodes.map(d => this.#matches(d));
    this.matchCount = this.matchFlags.filter(Boolean).length;
    const set = new Set();
    if (f !== null) {
      set.add(f);
      this.#focusNeighbours(f).forEach(n => set.add(n.index));
    }
    const best = this.#bestMatch();
    // a title that has picked a row: the search hits are not ringed and that row stays visible and on top (no check: that is reserved for installed models)
    const titled = this.#titleResolved();
    const resolved = titled ? f : null;
    // the answer must never be dimmed: the best installed match may lie outside the top-k neighbours of the selection
    if (best !== null) set.add(best);
    const filtering = q || Object.values(this.s.filters).some(v => v !== '');
    this.nodeSel
      .classed('focus', d => d.i === f)
      .classed('unavail', d => !!this.models && !this.#isAvail(d.i))
      .classed('best', d => d.i === best) // the green check means "installed": only the best installed match gets it, never a row that merely fits the title
      .classed('dim', d => f !== null && !set.has(d.i))
      .classed('faded', d => filtering && !this.matchFlags[d.i] && d.i !== best && d.i !== resolved && d.i !== f) // the answer stays visible whatever the search says
      .classed('match', d => q && !titled && this.matchFlags[d.i] && this.matchCount <= 30)
      .classed('show-label', d => set.has(d.i) || (q && this.matchFlags[d.i] && this.matchCount <= 30));
    // answers and the selection are drawn on top of the other nodes, so neither the circle nor the check mark is covered
    this.nodeSel.filter(d => d.i === best || d.i === resolved || d.i === f).raise();
    if (this.$titleNote) this.$titleNote.textContent = this.#titleNote();
    this.edgeSel?.classed('dim', l => f !== null);
    this.#renderStatus();
  }

  #recolor() {
    if (!this.index) return;
    const key = this.s.colorBy;
    const counts = new Map();
    this.index.aircraft.forEach(a => counts.set(a[key], (counts.get(a[key]) ?? 0) + 1));
    let cats = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0]);
    if (key === 'manufacturer') cats = cats.filter(c => c !== '-').slice(0, 9);
    this.catKey = a => (cats.includes(a[key]) ? a[key] : OTHER);
    this.colorScale = scaleOrdinal().domain([...cats, OTHER]).range([...schemeTableau10.slice(0, cats.length), '#98a2b3']);
    this.legendCats = [...cats, ...(this.index.aircraft.some(a => !cats.includes(a[key])) ? [OTHER] : [])];
    this.nodeSel?.select('circle.dot').attr('fill', d => this.colorScale(this.catKey(d.a)));
    this.#renderLegend();
  }

  #renderLegend() {
    if (!this.legendCats) { this.$legend.replaceChildren(); return; }
    const key = this.s.colorBy;
    const label = c => (c === OTHER ? this.t('legend.other') : key === 'manufacturer' ? c : this.t.enum(key, c));
    this.$legend.replaceChildren(...this.legendCats.map(c =>
      h('div', {}, h('span', { class: 'sw', style: `background:${this.colorScale(c)}` }), label(c))),
      h('div', { class: 'size-note' }, this.t('legend.size')));
  }

  #showTip(e, d) {
    const a = d.a;
    const [x, y] = pointer(e, this.$stage);
    this.$tip.replaceChildren(h('b', {}, a.icao), h('div', {}, a.name),
      h('div', {}, a.manufacturer === '-' ? this.t('detail.noManufacturer') : a.manufacturer),
      h('div', {}, `${this.t('feature.mtow')}: ${this.t('unit.kg', { n: this.nf.format(a.mtowKg) })}`));
    this.$tip.hidden = false;
    this.$tip.style.left = `${Math.min(x + 14, this.$stage.clientWidth - 200)}px`;
    this.$tip.style.top = `${Math.max(y - 10, 0)}px`;
  }

  /** Callsign confirmed: selects the searched aircraft if none is selected yet, otherwise updates the selected one. */
  /**
   * The title of the remote aircraft picks, among the rows of the selected designator (GLID, GLIM ...), the one that describes it - the same rule as
   * JoinFS - and selects that row. Changing the title again starts from the designator the user selected, not from the row it chose.
   */
  /** Runs `action` once the user has paused typing in a field: the field acts without Enter, but not on every keystroke. */
  #whenTypingStops(field, action) {
    this.typingTimers ??= {};
    clearTimeout(this.typingTimers[field]);
    this.typingTimers[field] = setTimeout(action, TYPING_PAUSE_MS);
  }

  #applyTitle() {
    if (!this.index) return;
    if (this.s.focus === null) this.#focusFirstMatch();
    const f = this.s.focus;
    if (f !== null && this.#hasTitle()) {
      const air = this.index.aircraft;
      const baseIcao = this.titleResult === f ? this.titleBase : air[f].icao;
      const rows = air.map((a, i) => i).filter(i => air[i].icao === baseIcao);
      const row = rows.length > 1 ? pickRow(rows, air, this.s.title) : f;
      this.titleBase = baseIcao;
      this.titleResult = row;
      if (row !== f) this.#setFocus(row);
    }
    this.$titleNote.textContent = this.#titleNote();
    this.#applyClasses();
  }

  /** True while the selected aircraft is the one the title in the Title box picked. */
  #titleResolved() {
    return this.#hasTitle() && this.s.focus !== null && this.titleResult === this.s.focus;
  }

  /** What the Title box tells: which row the title picked, that a single-row type is not changed by it, or that a type must be selected first. */
  #titleNote() {
    if (!this.index || !this.#hasTitle()) return '';
    const f = this.s.focus;
    if (f === null) return this.t('toolbar.titleNeedsType');
    const air = this.index.aircraft;
    const a = air[f];
    const baseIcao = this.titleResult === f ? this.titleBase : a.icao;
    if (air.filter(x => x.icao === baseIcao).length < 2) return this.t('toolbar.titleSingleRow', { icao: a.icao });
    return this.t('toolbar.titleResolved', { row: a.label ?? `${a.icao} · ${a.name}` });
  }

  #applyCallsign() {
    if (!this.index) return;
    if (this.s.focus === null) this.#focusFirstMatch();
    else this.#refreshFocus();
  }

  #focusFirstMatch() {
    if (!this.nodes || !this.s.search.trim()) return;
    const hits = this.nodes.filter(n => this.matchFlags[n.i]).sort((x, y) => x.a.icao.localeCompare(y.a.icao));
    if (hits.length) {
      this.#setFocus(hits[0].i);
      if (this.#hasTitle()) this.#applyTitle();   // the title then picks the row of the type the search found
    }
  }

  // ---------------------------------------------------------------- selection / panel

  #setFocus(i) {
    if (!this.index) return;
    this.s.focus = i;
    this.#stateChanged();
    this.s.openWhy.clear();
    this.s.livery = null;
    this.#refreshFocus();
    if (i !== null) {
      this.dispatchEvent(new CustomEvent('joinfs-proximity-select', {
        bubbles: true, composed: true,
        detail: { icao: this.index.aircraft[i].icao, neighbours: this.#focusNeighbours(i).map(n => n.icao) },
      }));
    }
  }

  /**
   * The most similar types of an aircraft, limited to the minimum proximity. With a models list, if the aircraft itself is not
   * installed and none of the listed types is, the most similar installed type takes the last place and remembers its real
   * position (`rank`), so the list always holds something that can be used.
   */
  #focusNeighbours(i) {
    const all = this.index.neighbours[i];
    const list = all.filter(n => n.p.percent * 100 >= this.s.minProx).slice(0, FOCUS_NEIGHBOURS);
    if (!this.models) return list;
    // the aircraft JoinFS would inject for the title (see joinfs-matcher.js) is always listed, with its real position (e.g. "(22)"), even when types that are
    // closer but not installed fill the list: the closer ones are greyed out, the matched one takes the last place
    const matched = i === this.s.focus ? this.#injected()?.node : undefined;
    if (matched !== undefined && matched !== i) {
      if (!list.some(n => n.index === matched)) {
        const extra = neighbourOf(this.index, i, matched);
        if (extra) {
          if (list.length >= FOCUS_NEIGHBOURS) list.pop();
          list.push(extra);
        }
      }
      return list;
    }
    if (!this.#isAvail(i) && !list.some(n => this.#isAvail(n.index))) {
      const at = all.findIndex(n => this.#isAvail(n.index));
      if (at >= 0) {
        const extra = { ...all[at], rank: at + 1 };
        if (list.length >= FOCUS_NEIGHBOURS) list.pop();
        list.push(extra);
      }
    }
    return list;
  }

  #refreshFocus() {
    const i = this.s.focus;
    const links = i === null ? [] : this.#focusNeighbours(i)
      .map(n => ({ source: this.nodes[i], target: this.nodes[n.index], percent: n.p.percent }));
    this.focusEdgeSel = this.gFocusEdges.selectAll('line').data(links).join('line')
      .attr('class', 'edge focus').attr('stroke-width', l => 1 + 2.5 * l.percent);
    this.#applyVisibility();
    this.#tick();
    this.#applyClasses();
    this.#renderPanel();
  }

  #renderPanel() {
    const t = this.t;
    const f = this.s.focus;
    if (f === null || !this.index) {
      this.$panel.replaceChildren(h('p', { class: 'empty' }, this.loadState === 'ready' ? t('detail.empty') : ''));
      return;
    }
    const a = this.index.aircraft[f];
    const n = v => this.nf.format(v);
    const row = (labelKey, value) => [h('dt', {}, t(labelKey)), h('dd', {}, value)];
    const list = this.#focusNeighbours(f);
    const best = this.#bestMatch();
    this.$panel.replaceChildren(
      h('button', { class: 'close', type: 'button', 'aria-label': t('detail.close'), title: t('detail.close'), onclick: () => this.#setFocus(null) }, '×'),
      h('h2', {}, a.icao, this.models ? (best === f ? this.#check(' ', 'big') : this.#isAvail(f) ? null : h('small', { class: 'muted' }, ` ${t('detail.notInstalled')}`)) : null),
      h('p', { class: 'name' }, a.name),
      h('dl', {},
        row('detail.manufacturer', a.manufacturer === '-' ? t('detail.noManufacturer') : a.manufacturer),
        row('detail.span', t('unit.m', { n: n(a.spanM) })),
        row('detail.length', t('unit.m', { n: n(a.lengthM) })),
        row('detail.mtow', t('unit.kg', { n: n(a.mtowKg) })),
        row('detail.cruise', t('unit.kt', { n: n(a.cruiseKt) })),
        row('detail.engines', n(a.engines)),
        row('detail.engineType', t.enum('engineType', a.engineType)),
        row('detail.wing', t.enum('wing', a.wing)),
        row('detail.gear', t.enum('gear', a.gear))),
      ...(a.aliases?.length ? [h('p', { class: 'tags' }, h('b', {}, t('detail.aliases')), ' ', a.aliases.map(x => h('span', { class: 'chip' }, x)))] : []),
      // a type of the model set's own (SZD30 ...): its numbers are the class line's - say which
      ...(a.virtual ? [h('p', { class: 'muted' }, t('detail.parametersFrom', { line: this.index.aircraft[a.lookup].name }))] : []),
      ...(a.titleHints?.length ? [h('p', { class: 'tags' }, h('b', {}, t('detail.titleHints')), ' ', a.titleHints.map(x => h('span', { class: 'chip' }, x)))] : []),
      ...(this.#isAvail(f) ? [this.#liveryBlock(f)] : []),
      h('h3', {}, t('detail.similar')),
      list.length === 0 ? h('p', { class: 'empty' }, t('detail.none'))
        : h('ul', { class: 'sim' }, list.map(nb => this.#similarRow(nb, best))));
  }

  #check(after = '', cls = '') {
    return h('span', { class: `ok ${cls}`.trim(), title: this.t('detail.installed'), role: 'img', 'aria-label': this.t('detail.installed') }, `${after}✔`);
  }

  /** The top liveries of an installed aircraft; click one to choose it. */
  #liveryList(i) {
    const isBest = this.#bestMatch() === i;
    const picked = this.s.livery?.i === i ? this.s.livery.key : null; // clicked by the user
    return h('ul', { class: 'liveries' }, this.#liveries(i).slice(0, TOP_LIVERIES).map(m => {
      // only the livery that will be used, of the aircraft that will be used (or one the user clicked), is marked
      const chosen = picked ? picked === `${m.title}${m.livery}` : isBest && this.#liveryOf(i) === m;
      const fits = this.#hasCallsign() && this.#score(m) > 0;
      return h('li', { class: chosen ? 'chosen' : null },
        h('button', { type: 'button', 'aria-pressed': String(chosen), onclick: () => this.#chooseLivery(i, m) },
          h('span', { class: 'ok mark' }, chosen ? '✔' : ''),
          h('span', { class: 'lv' }, m.livery || m.title, m.livery && m.livery !== m.title ? h('small', {}, m.title) : null),
          m.airline || fits ? h('span', { class: fits ? 'chip fits' : 'chip', title: fits ? this.t('detail.airlineMatch') : null }, m.airline || this.s.callsign.trim().toUpperCase()) : null));
    }));
  }

  #toggle(i, label) {
    const open = this.s.openWhy.has(i);
    return h('button', { class: 'why', type: 'button', 'aria-expanded': String(open), 'aria-label': label, title: label,
      onclick: () => { open ? this.s.openWhy.delete(i) : this.s.openWhy.add(i); this.#renderPanel(); } }, open ? '▾' : '▸');
  }

  /** The selected aircraft's livery with a collapsible list of its top liveries. */
  #liveryBlock(i) {
    const t = this.t;
    const m = this.#liveryOf(i);
    const best = this.#bestMatch() === i;
    return h('section', { class: best ? 'liveries-box best' : 'liveries-box' },
      h('div', { class: 'row' },
        h('div', { class: 'cur' }, h('small', {}, t('detail.livery')), h('div', {}, best ? this.#check(' ') : null, m.livery || m.title, m.airline ? h('span', { class: 'chip code' }, m.airline) : null)),
        this.#toggle(i, t('detail.liveries', { n: this.nf.format(this.models.get(i).length) }))),
      this.s.openWhy.has(i) ? this.#liveryList(i) : null);
  }

  #chooseLivery(i, m) {
    const key = `${m.title}\u0001${m.livery}`;
    this.s.livery = this.s.livery?.i === i && this.s.livery.key === key ? null : { i, key };
    this.#renderPanel();
    this.dispatchEvent(new CustomEvent('joinfs-proximity-livery', {
      bubbles: true, composed: true, detail: { icao: this.index.aircraft[i].icao, title: m.title, livery: m.livery },
    }));
  }

  #similarRow(nb, best) {
    const t = this.t;
    const b = this.index.aircraft[nb.index];
    const pct = Math.round(nb.p.percent * 100);
    const open = this.s.openWhy.has(nb.index);
    const li = h('li', { class: this.models && !this.#isAvail(nb.index) ? 'unavail' : nb.index === best ? 'best' : null },
      h('div', { class: 'row' },
        h('button', { class: 'pick', type: 'button', onclick: () => this.#setFocus(nb.index) },
          nb.index === best ? this.#check(' ') : null,
          h('b', {}, b.icao), h('span', { class: 'pct' }, `${pct}%`), nb.rank ? h('span', { class: 'rank' }, t('detail.rank', { n: nb.rank })) : null,
          h('small', {}, `${b.name} · ${b.manufacturer === '-' ? t('detail.noManufacturer') : b.manufacturer}`),
          this.#isAvail(nb.index) ? h('small', { class: 'lvline' }, `${nb.index === best ? '✔ ' : ''}${t('detail.livery')}: ${this.#liveryOf(nb.index).livery || this.#liveryOf(nb.index).title}${this.#liveryOf(nb.index).airline ? ` (${this.#liveryOf(nb.index).airline})` : ''}`) : null),
        this.#toggle(nb.index, `${this.#isAvail(nb.index) ? t('detail.liveriesAndWhy') : t('detail.why')} ${b.icao}`)),
      h('div', { class: 'bar', role: 'img', 'aria-label': t('detail.proximity', { n: pct }) }, h('i', { style: `width:${pct}%` })));
    if (open && this.#isAvail(nb.index)) li.append(this.#liveryList(nb.index));
    if (open) {
      li.append(h('div', { class: 'breakdown' },
        nb.p.physical.parts.map(p => h('div', { class: 'f' }, t(`feature.${p.feature}`),
          h('div', { class: 'bar', role: 'img', 'aria-label': `${t(`feature.${p.feature}`)}: ${Math.round((1 - p.distance) * 100)}%` },
            h('i', { style: `width:${(1 - p.distance) * 100}%` })))),
        nb.p.manufacturerBonus ? h('span', { class: 'chip' }, `+${nb.p.manufacturerBonus} ${t('detail.bonusManufacturer')}`) : null,
        nb.p.relatedBonus ? h('span', { class: 'chip' }, `+${nb.p.relatedBonus} ${t('detail.bonusRelated')}`) : null,
        h('div', {}, `${t('detail.points', { n: nb.p.total })} / ${MAX_POINTS}`)));
    }
    return li;
  }
}

if (!customElements.get(COMPONENT)) customElements.define(COMPONENT, ProximityChart);
