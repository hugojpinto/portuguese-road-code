/** Tiny DOM toolkit shared by both simulator pages (no framework). */
import type { ExperimentResult, MetricDef, RuleDef } from './experiment';
import { fmt, pairedDiff } from './stats';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
export function setPath(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

export type Control =
  | { kind: 'range'; key: string; label: string; min: number; max: number; step: number; help?: string; format?: (v: number) => string; scale?: number }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[]; help?: string };

export interface ControlGroup {
  title: string;
  open?: boolean;
  controls: Control[];
}

/** Render a schema-driven controls panel bound to `state` (mutated in place). */
export function buildControls(container: HTMLElement, groups: ControlGroup[], state: any, onChange: (key: string) => void): () => void {
  const refreshers: (() => void)[] = [];
  groups.forEach((g, gi) => {
    const host = gi === 0 ? container : el('details', { class: 'group', ...(g.open ? { open: '' } : {}) }, el('summary', {}, g.title));
    if (gi > 0) container.append(host);
    for (const c of g.controls) {
      const wrap = el('div', { class: 'ctl' });
      if (c.kind === 'range') {
        const scale = c.scale ?? 1;
        const val = el('span', { class: 'val' });
        const input = el('input', { type: 'range', min: String(c.min), max: String(c.max), step: String(c.step) }) as HTMLInputElement;
        const show = () => {
          const v = getPath(state, c.key) * scale;
          input.value = String(v);
          val.textContent = c.format ? c.format(v) : String(+v.toFixed(4));
        };
        input.addEventListener('input', () => {
          setPath(state, c.key, Number(input.value) / scale);
          show();
          onChange(c.key);
        });
        show();
        refreshers.push(show);
        wrap.append(el('label', {}, el('span', {}, c.label), val), input);
      } else {
        const sel = el('select') as HTMLSelectElement;
        for (const o of c.options) sel.append(el('option', { value: o.value }, o.label));
        const show = () => (sel.value = getPath(state, c.key));
        sel.addEventListener('change', () => {
          setPath(state, c.key, sel.value);
          onChange(c.key);
        });
        show();
        refreshers.push(show);
        wrap.append(el('label', {}, el('span', {}, c.label)), sel);
      }
      if (c.help) wrap.append(el('div', { class: 'help' }, c.help));
      host.append(wrap);
    }
  });
  return () => refreshers.forEach((f) => f());
}

export function renderKv(container: HTMLElement, rows: ([string, string, boolean?] | 'sep')[]): void {
  container.replaceChildren(
    ...rows.flatMap((r) => (r === 'sep' ? [el('div', { class: 'sep' })] : [el('div', { class: 'k' }, r[0]), el('div', { class: `v${r[2] ? ' bad' : ''}` }, r[1])])),
  );
}

export function fmtClock(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Bar chart (mean ± 95% CI) for one metric across rules, as inline SVG. */
export function barChart<R extends string>(res: ExperimentResult<R>, metric: MetricDef, rules: RuleDef<R>[]): HTMLElement {
  const W = 300;
  const rowH = 26;
  const labelW = 110;
  const H = rules.length * rowH + 8;
  const stats = rules.map((r) => res.summary[metric.key]?.[r.id]);
  const maxV = Math.max(1e-9, ...stats.map((s) => (s ? s.mean + (Number.isFinite(s.ci95) ? s.ci95 : 0) : 0)));
  const x = (v: number) => labelW + ((W - labelW - 54) * Math.max(0, v)) / maxV;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  rules.forEach((r, i) => {
    const s = stats[i];
    if (!s) return;
    const y = 4 + i * rowH;
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', '0');
    t.setAttribute('y', String(y + 16));
    t.setAttribute('fill', 'currentColor');
    t.setAttribute('font-size', '11');
    t.textContent = r.short;
    svg.append(t);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(labelW));
    rect.setAttribute('y', String(y + 4));
    rect.setAttribute('height', '16');
    rect.setAttribute('rx', '3');
    rect.setAttribute('width', String(Math.max(1, x(s.mean) - labelW)));
    rect.setAttribute('fill', r.color);
    svg.append(rect);
    if (Number.isFinite(s.ci95)) {
      const l = document.createElementNS(ns, 'path');
      const y0 = y + 12;
      l.setAttribute('d', `M${x(s.mean - s.ci95)} ${y0}H${x(s.mean + s.ci95)}M${x(s.mean - s.ci95)} ${y0 - 5}v10M${x(s.mean + s.ci95)} ${y0 - 5}v10`);
      l.setAttribute('stroke', 'currentColor');
      l.setAttribute('stroke-width', '1.3');
      l.setAttribute('opacity', '0.75');
      svg.append(l);
    }
    const v = document.createElementNS(ns, 'text');
    v.setAttribute('x', String(W - 2));
    v.setAttribute('y', String(y + 16));
    v.setAttribute('text-anchor', 'end');
    v.setAttribute('fill', 'currentColor');
    v.setAttribute('font-size', '11');
    v.setAttribute('font-family', 'var(--mono)');
    v.textContent = fmt(s.mean, metric.digits ?? 2);
    svg.append(v);
  });
  return el('div', { class: 'chart' }, el('h3', {}, metric.label.trim()), el('div', { class: 'unit' }, metric.unit ?? ''), svg as unknown as Node);
}

/** Full results table with paired-difference significance markers vs the baseline rule. */
export function resultsTable<R extends string>(res: ExperimentResult<R>, metrics: MetricDef[], rules: RuleDef<R>[], baseline: R): HTMLElement {
  const thead = el('tr', {}, el('th', {}, 'Metric'), ...rules.map((r) => el('th', { style: `color:${r.color}` }, r.short)));
  const rows = metrics
    .filter((m) => res.summary[m.key])
    .map((m) => {
      const means = rules.map((r) => res.summary[m.key][r.id]?.mean ?? NaN);
      const finite = means.filter(Number.isFinite);
      const best = m.better === 'lower' ? Math.min(...finite) : m.better === 'higher' ? Math.max(...finite) : NaN;
      const worst = m.better === 'lower' ? Math.max(...finite) : m.better === 'higher' ? Math.min(...finite) : NaN;
      const tr = el('tr', {}, el('td', { title: m.help ?? '' }, `${m.label}${m.unit ? ` (${m.unit})` : ''}`));
      rules.forEach((r, i) => {
        const s = res.summary[m.key][r.id];
        let sig = '';
        if (r.id !== baseline && res.samples[m.key]?.[r.id] && res.samples[m.key]?.[baseline]) {
          const d = pairedDiff(res.samples[m.key][r.id], res.samples[m.key][baseline]);
          if (d.significant) sig = d.mean > 0 ? ' ▲' : ' ▼';
        }
        const cls = finite.length > 1 && means[i] === best && best !== worst ? 'best' : finite.length > 1 && means[i] === worst && best !== worst ? 'worst' : '';
        tr.append(
          el(
            'td',
            { class: cls },
            fmt(s?.mean ?? NaN, m.digits ?? 2),
            el('span', { class: 'ci' }, Number.isFinite(s?.ci95) ? ` ±${fmt(s.ci95, 1)}` : ''),
            el('span', { class: 'sig' }, sig),
          ),
        );
      });
      return tr;
    });
  const base = rules.find((r) => r.id === baseline)!;
  return el(
    'div',
    { class: 'tablewrap' },
    el('table', { class: 'results' }, el('thead', {}, thead), el('tbody', {}, ...rows)),
    el('p', { class: 'muted', style: 'font-size:12px' }, `± = 95% confidence interval of the mean over replicates. ▲/▼ = significantly higher/lower than “${base.short}” (paired test over identical traffic, 95%). Green = best, red = worst.`),
  );
}

export function setupThemeToggle(btn: HTMLButtonElement): void {
  const apply = (t: string | null) => {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  };
  try {
    apply(localStorage.getItem('rr-theme'));
  } catch {
    /* storage unavailable */
  }
  btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    apply(next);
    try {
      localStorage.setItem('rr-theme', next);
    } catch {
      /* ignore */
    }
  });
}

/** Read a CSS custom property (for canvas drawing in the active theme). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Fit a canvas' backing store to its CSS size × devicePixelRatio. Returns CSS size. */
export function fitCanvas(canvas: HTMLCanvasElement, cssHeight: number): { w: number; h: number; ctx: CanvasRenderingContext2D } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  canvas.style.height = `${cssHeight}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h: cssHeight, ctx };
}
