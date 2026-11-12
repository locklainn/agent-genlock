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
      };
    });
  if (!items.length) return { text, items: [{ id: `${turn}-0`, project: '', task: '', kind: 'update', say: plain(text) }] };
  return { text: text || items.map((x) => x.say).join('\n\n'), items };
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
