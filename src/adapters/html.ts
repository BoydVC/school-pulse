export type Element = { readonly attrs: string; readonly inner: string };

export function elements(html: string, tag: string): Element[] {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi");
  const found: Element[] = [];
  for (const match of html.matchAll(pattern)) {
    found.push({ attrs: match[1] ?? "", inner: match[2] ?? "" });
  }
  return found;
}

export function attr(attrs: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(attrs);
  if (!match) return null;
  const raw = match[1] ?? match[2];
  return raw === undefined ? null : decode(raw);
}

export function hasClass(attrs: string, className: string): boolean {
  return (attr(attrs, "class") ?? "").split(/\s+/).includes(className);
}

export function textContent(html: string): string {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function cell(rowInner: string, className: string): string | null {
  for (const td of [...elements(rowInner, "td"), ...elements(rowInner, "th")]) {
    if (hasClass(td.attrs, className)) {
      const text = textContent(td.inner);
      return text.length > 0 ? text : null;
    }
  }
  return null;
}

export function decode(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}
