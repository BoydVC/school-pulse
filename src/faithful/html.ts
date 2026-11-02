import { parse, type HTMLElement } from 'node-html-parser';
import { collapse } from './text.js';

export function parseHtml(html: string): HTMLElement {
  return parse(html, { blockTextElements: { script: false, style: false, pre: true } });
}

export function textOf(el: HTMLElement | null | undefined): string {
  if (!el) return '';
  return collapse(el.text);
}

export function attr(el: HTMLElement, name: string): string | null {
  const value = el.getAttribute(name);
  if (value === undefined || value === null) return null;
  return value;
}

export function hasAttr(el: HTMLElement, name: string): boolean {
  return el.getAttribute(name) !== undefined;
}

export function classNames(el: HTMLElement): string {
  return attr(el, 'class') ?? '';
}

export interface SavedFrom {
  url: string | null;
  frn: string | null;
  fg: string | null;
}

/** WebKit-style "saved from url" comment, used by parents who save the portal page. */
export function savedFrom(html: string): SavedFrom {
  const match = /saved from url=\(\d+\)(\S+)/i.exec(html);
  if (!match?.[1]) return { url: null, frn: null, fg: null };
  const url = match[1].replace(/-+$/, '');
  try {
    const parsed = new URL(url);
    return {
      url,
      frn: parsed.searchParams.get('frn'),
      fg: parsed.searchParams.get('fg'),
    };
  } catch {
    return { url, frn: null, fg: null };
  }
}

export function metaContent(root: HTMLElement, name: string): string | null {
  const el = root.querySelector(`meta[name="${name}"]`);
  if (!el) return null;
  return attr(el, 'content');
}

function isElement(node: { nodeType?: number; tagName?: string }): node is HTMLElement {
  return node.nodeType === 1 && typeof node.tagName === 'string';
}

export function elementChildren(el: HTMLElement): HTMLElement[] {
  return el.childNodes.filter(isElement);
}

/** Direct rows of a table, including rows inside thead/tbody (not nested tables). */
export function directRows(table: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  for (const child of elementChildren(table)) {
    if (child.tagName === 'TR') rows.push(child);
    else if (child.tagName === 'THEAD' || child.tagName === 'TBODY' || child.tagName === 'TFOOT') {
      for (const row of elementChildren(child)) {
        if (row.tagName === 'TR') rows.push(row);
      }
    }
  }
  return rows;
}

export function directCells(row: HTMLElement): HTMLElement[] {
  return elementChildren(row).filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH');
}

export function headerRows(table: HTMLElement): HTMLElement[] {
  const headerish: HTMLElement[] = [];
  for (const row of directRows(table)) {
    const cells = directCells(row);
    if (cells.length === 0) continue;
    const ths = cells.filter((cell) => cell.tagName === 'TH');
    if (ths.length >= Math.ceil(cells.length / 2)) headerish.push(row);
    else break;
  }
  return headerish;
}

export interface LogicalHeader {
  labels: string[];
}

/**
 * Expand colspans. A second header row fills columns opened by colspan
 * (PowerSchool quick lookup: term code colspan=2 over % and Grade).
 */
export function logicalHeaders(table: HTMLElement): string[] {
  const rows = headerRows(table);
  const first = rows[0];
  if (!first) return [];
  const top: { label: string; colspan: number; rowspan: number }[] = [];
  for (const cell of directCells(first)) {
    top.push({
      label: textOf(cell),
      colspan: Number(attr(cell, 'colspan') || 1),
      rowspan: Number(attr(cell, 'rowspan') || 1),
    });
  }
  const second = rows[1];
  const secondLabels = second ? directCells(second).map((cell) => textOf(cell)) : [];
  const labels: string[] = [];
  let secondIndex = 0;
  for (const cell of top) {
    if (cell.colspan > 1 && cell.rowspan === 1 && secondLabels.length > 0) {
      for (let i = 0; i < cell.colspan; i += 1) {
        const sub = secondLabels[secondIndex] ?? '';
        secondIndex += 1;
        labels.push(collapse(`${cell.label} ${sub}`) || cell.label);
      }
    } else {
      for (let i = 0; i < cell.colspan; i += 1) {
        labels.push(i === 0 ? cell.label : `${cell.label}#${i}`);
      }
    }
  }
  return labels;
}

export function bodyRows(table: HTMLElement): HTMLElement[] {
  const headers = new Set(headerRows(table));
  return directRows(table).filter((row) => !headers.has(row));
}

export function cellsOf(row: HTMLElement): HTMLElement[] {
  return directCells(row);
}

export function rowIdNumber(row: HTMLElement): string | null {
  const id = attr(row, 'id') ?? '';
  const match = /(\d{3,})/.exec(id);
  return match?.[1] ?? null;
}

export function isPurple(el: HTMLElement): boolean {
  const style = `${attr(el, 'style') ?? ''} ${attr(el, 'color') ?? ''}`.toLowerCase();
  if (style.includes('purple')) return true;
  const fonts = el.querySelectorAll('font');
  for (const font of fonts) {
    const color = (attr(font, 'color') ?? '').toLowerCase();
    if (color === 'purple' || color === '#800080') return true;
  }
  return false;
}

export function imageAlts(el: HTMLElement): string[] {
  const alts: string[] = [];
  for (const img of el.querySelectorAll('img')) {
    const alt = collapse(attr(img, 'alt') || attr(img, 'title') || '');
    if (alt) alts.push(alt);
  }
  return alts;
}
