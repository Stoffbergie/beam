const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const reserved = new Set(["www", "mail", "beam", "api", "admin", "smtp", "mx", "ftp"]);

export function validName(name: string): boolean {
  return namePattern.test(name) && !reserved.has(name);
}

export function tunnelName(hostname: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) return null;
  const name = hostname.slice(0, -suffix.length);
  return name.includes(".") ? null : name;
}
