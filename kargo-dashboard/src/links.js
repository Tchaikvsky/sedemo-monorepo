// Kargo UI deep links: <instance>/project/<project>/{freight/<name>|stage/<name>}.
// Returns undefined when there is no instance URL or no name to link to.
export function kargoLink(kargoUrl, project, kind, name) {
  if (!kargoUrl || !name) return undefined;
  const seg = encodeURIComponent;
  return `${kargoUrl.replace(/\/+$/, '')}/project/${seg(project)}/${kind}/${seg(name)}`;
}

// <instance>/project/<project>
export function projectLink(kargoUrl, project) {
  return kargoUrl ? `${kargoUrl.replace(/\/+$/, '')}/project/${encodeURIComponent(project)}` : undefined;
}
