/** Replace `{token}` for known keys; leave unknown tokens (e.g. `{A|B}`) intact. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z][a-z0-9_]*)\}/g, (all, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : all,
  );
}

export function templateHas(template: string, token: string): boolean {
  return template.includes(`{${token}}`);
}
