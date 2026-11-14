// A phone reply is walked one item at a time: each item is tagged with its project and task, so
// the phone can speak it, wait for TJ's answer, and fold a newer item over an older one about the
// same task. Tally ends each reply to a [phone] message with a fenced block:
//
//   ```items
//   [{"project":"genlock","task":"phone digest","kind":"question","say":"…","ask":"Ship it?"}]
//   ```
//
// The block is cut out of the text the phone shows. A reply without one is a single item, so a
// reply that forgot the block still reads exactly as before.

const BLOCK = /```items[^\n]*\n([\s\S]*?)```\s*$/;
const KINDS = new Set(['update', 'question', 'done', 'blocked']);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The spoken form of written text: no markdown marks, no code. */
export const plain = (text) => String(text || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_#>|]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The images an item asks TJ to review: local image files on the Mac, as paths or {path, caption}.
 * Up to 12; anything else (a URL, a non-image) is left out, since the bridge sends each as a file.
 */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i;
export function imagesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? { path: x } : x && typeof x === 'object' ? { path: x.path, caption: x.caption } : null))
    .filter((x) => x && typeof x.path === 'string' && x.path.startsWith('/') && IMAGE_EXT.test(x.path))
    .slice(0, 12)
    .map((x) => ({ path: x.path, ...(str(x.caption, 120) ? { caption: str(x.caption, 120) } : {}) }));
}

/**
 * The documents an item hands TJ: local files on the Mac of any type (a PDF, a page, a sheet, an
 * image), as paths or {path, name, caption}. Up to 12. The bridge sends each as a file and the phone
 * lists them as links to open or save. A URL is not a file: put links in say, where they show as links.
 */
export function filesOf(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x) => (typeof x === 'string' ? { path: x } : x && typeof x === 'object' ? x : null))
    .filter((x) => x && typeof x.path === 'string' && x.path.startsWith('/') && !x.path.endsWith('/'))
    .slice(0, 12)
    .map((x) => {
      const label = str(x.name, 80) || str(x.caption, 120);
      return { path: x.path, ...(label ? { caption: label } : {}) };
    });
}

/** { text, items }: the text to show, and the items to walk (ids `${turn}-${i}`). */
export function parseItems(raw, turn = 'r') {
  const full = String(raw || '').trim();
  const m = full.match(BLOCK);
  let list = null;
  if (m) {
    try { const j = JSON.parse(m[1]); if (Array.isArray(j)) list = j; } catch { /* a broken block reads as plain text */ }
  }
  const text = list ? full.slice(0, m.index).trim() : full;
  const items = (list || [])
    .filter((x) => x && typeof x === 'object' && str(x.say, 600))
    .slice(0, 40)
    .map((x, i) => {
      const kind = KINDS.has(x.kind) ? x.kind : (str(x.ask, 300) ? 'question' : 'update');
      const options = Array.isArray(x.options) ? x.options.map((o) => str(o, 60)).filter(Boolean).slice(0, 6) : [];
      return {
        id: `${turn}-${i}`, project: str(x.project, 60), task: str(x.task, 80), kind, say: str(x.say, 600),
        ...(str(x.ask, 300) ? { ask: str(x.ask, 300) } : {}), ...(options.length ? { options } : {}),
        ...(imagesOf(x.images).length ? { images: imagesOf(x.images) } : {}),
        ...(filesOf(x.files).length ? { files: filesOf(x.files) } : {}),
      };
    });
  // An empty block is Tally saying there is nothing new to hear (a session's report repeats what TJ
  // was already told): shown with the rest, never walked or read, so he hears each update once.
  if (list && !list.length) return { text, items: [{ id: `${turn}-0`, project: '', task: '', kind: 'update', say: plain(text) }], quiet: true };
  if (!items.length) return { text, items: [{ id: `${turn}-0`, project: '', task: '', kind: 'update', say: plain(text) }] };
  // block: Tally chose what the phone should hear, so it is meant for the phone whatever began the turn.
  return { text: text || items.map((x) => x.say).join('\n\n'), items, block: true };
}

/**
 * One message for Tally from a whole walk: every answer, labelled with its item's project and
 * task and the question it answers, plus what was heard and skipped. One walk, one Tally turn.
 */
export function formatAnswers(answers, { left = 0 } = {}) {
  const label = (a) => [a.project, a.task].filter(Boolean).join(' / ') || 'your reply';
  const parts = [];
  let n = 0;
  for (const a of Array.isArray(answers) ? answers : []) {
    if (!a || typeof a !== 'object') continue;
    const asked = str(a.ask, 300);
    const said = str(a.answer, 2000);
    n++;
    if (said) parts.push(`(${n}) ${label(a)}${asked ? ` - asked "${asked}"` : ''}: ${said}`);
    else parts.push(`(${n}) ${label(a)}: ${a.skipped ? 'skipped, heard but not answered' : 'heard'}`);
  }
  const tail = left > 0 ? ` ${left} more item${left === 1 ? ' is' : 's are'} still unheard on the phone; TJ will walk ${left === 1 ? 'it' : 'them'} later, so do not repeat ${left === 1 ? 'it' : 'them'}.` : '';
  return `Answers from the phone walk-through: ${parts.join(' ')}${tail}`;
}

/**
 * Whether the phone walks a reply. TJ wants news on the phone without asking from it, so any reply
 * Tally ended with an items block walks, whatever began the turn (a phone message, a session's
 * report, TJ at the laptop or Remote Control). A reply to the laptop with no block was written for
 * the screen he typed at, so it is shown, not walked. Never a reply whose block was empty.
 */
export function walkable({ answers, quiet, items, block }) {
  if (quiet) return false;
  return answers !== 'laptop' || Boolean(block) || items.some((it) => it.images?.length || it.files?.length);
}
