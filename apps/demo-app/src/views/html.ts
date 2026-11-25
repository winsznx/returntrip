/** Markup that has already been escaped or built from escaped parts. */
export class SafeHtml {
  readonly value: string;

  constructor(value: string) {
    this.value = value;
  }
}

export type HtmlValue = SafeHtml | string | number | null | undefined | false | readonly HtmlValue[];

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

/** Tagged template that escapes every interpolated value unless it is already SafeHtml. */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let markup = strings[0] ?? '';
  for (const [index, value] of values.entries()) {
    markup += render(value) + (strings[index + 1] ?? '');
  }
  return new SafeHtml(markup);
}

function render(value: HtmlValue): string {
  if (value instanceof SafeHtml) {
    return value.value;
  }
  if (value === null || value === undefined || value === false) {
    return '';
  }
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  if (typeof value === 'number') {
    return escapeHtml(String(value));
  }
  return value.map(render).join('');
}
