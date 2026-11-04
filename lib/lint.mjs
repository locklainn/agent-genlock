/* Clarity lint. Words that describe a FEELING about the work rather than an observable
   state. A requirement may use one only if it also names something checkable. */
const VAGUE = [
  'improve', 'improved', 'better', 'best', 'cleaner', 'clean up', 'cleanup',
  'nicer', 'nice', 'properly', 'correctly', 'robust', 'robustly', 'solid',
  'handle', 'handles', 'support', 'supports', 'works', 'working', 'good',
  'fast', 'faster', 'performant', 'simple', 'simpler', 'polish', 'polished',
  'appropriate', 'appropriately', 'as needed', 'as necessary', 'make sense',
  'makes sense', 'sensible', 'reasonable', 'tidy', 'neat', 'streamline',
  'optimize', 'optimise', 'modernize', 'modernise', 'refactor', 'sane',
  'seamless', 'intuitive', 'user-friendly', 'etc', 'and so on', 'various',
  'some', 'stuff', 'things', 'fix up', 'look at', 'review',
];

/* Evidence that a requirement names something a machine or an eye can land on. */
const CONCRETE = [
  /\d/,                                  // any number
  /[\w./-]+\.[A-Za-z0-9]{1,6}\b/,        // a filename with an extension
  /\//,                                  // a path or a URL
  /`[^`]+`/, /"[^"]+"/, /'[^']+'/,       // a quoted literal
  /\b[A-Za-z_]\w*\(\)/,                  // a function call
  /\b(exits?|exit|returns?|equals?|matches|contains|prints?|emits?|refuses?|rejects?|renders?|resolves?|non-zero|zero|true|false|null|empty|present|absent|identical|byte-for-byte)\b/,
];

const CHECK_PREFIXES = ['manual:', 'file:', 'read:', 'eye:'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isConcrete = (text) => CONCRETE.some((p) => p.test(text.toLowerCase()));

/** Return a list of problems. An empty list means the requirement is usable. */
export function lintRequirement(text, check) {
  const problems = [];
  text = (text || '').trim();
  check = (check || '').trim();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length < 4)
    problems.push(`the requirement is ${words.length} words; say what must be TRUE, not what to do`);

  const hits = VAGUE.filter((v) => new RegExp(`\\b${esc(v)}\\b`).test(text.toLowerCase()));
  if (hits.length && !isConcrete(text))
    problems.push(`${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')} describes a feeling, `
      + 'not an observable state, and nothing else here is checkable. Name the number, '
      + 'file, command or output that would settle it');

  if (!check)
    problems.push('no check. Give the command that proves it, or prefix a human check '
      + "with 'manual:' / 'file:' / 'eye:'. A requirement with no check is a wish");
  else if (check.split(/\s+/).length < 2 && !CHECK_PREFIXES.some((p) => check.toLowerCase().startsWith(p)))
    problems.push(`the check '${check}' is not runnable and is not marked manual:`);

  return problems;
}

export function lintTitle(title) {
  const problems = [];
  title = (title || '').trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (words.length < 3) problems.push(`the title is ${words.length} words; name the outcome, not the verb`);
  if (/^(fix|update|change|improve|refactor|cleanup|clean up)\b.{0,12}$/i.test(title))
    problems.push(`'${title}' names an activity, not an outcome`);
  return problems;
}
