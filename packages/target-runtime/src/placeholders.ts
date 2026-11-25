const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

export type PlaceholderValues = Readonly<Record<string, string | number>>;

/**
 * Fills `{name}` tokens with typed values. Unknown names are an error rather than being left in
 * place, so a typo can't silently become a literal argument or objective text.
 */
export function fillPlaceholders(template: string, values: PlaceholderValues): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`unknown placeholder {${name}} in "${template}"`);
    return String(value);
  });
}

export function fillArgv(argv: readonly string[], values: PlaceholderValues): string[] {
  return argv.map((token) => fillPlaceholders(token, values));
}

export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}
