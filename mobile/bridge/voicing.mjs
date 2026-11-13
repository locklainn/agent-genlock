// The phone hears replies in the Genlock voice, made on this Mac by the speaker (lib/speaker.mjs)
// and sent as small m4a clips, one per sentence, tagged with the item they read. The phone plays
// them in order and captions each sentence as it plays; if an item's first clip is late, it reads
// that item in its own built-in voice instead.
//
//   {kind:'clip', item, i, text, seconds, data}   one sentence of an item, base64 m4a
//   {kind:'clip', item, done:true, n}             that item is whole (n clips)
//   {kind:'clip', item, failed:true}              no clips are coming: read it with the built-in voice
//
// "Came in while we talked." is said by the phone before an item that arrived mid-walk; it is sent
// once per project voice as item `late:<project>`, so it is in the same voice as what follows.

export const LATE = 'Came in while we talked.';

/** What the phone's arrival screen says for a reply: WalkPlan.kt arrivalLine, word for word. */
const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const count = (n, one, many) => `${NUMBERS[n] ?? String(n)} ${n === 1 ? one : many}`;
export function arrivalLine(items) {
  const questions = items.filter((it) => it.kind === 'question' || it.ask).length;
  const updates = items.length - questions;
  const s = [updates > 0 ? count(updates, 'update', 'updates') : null, questions > 0 ? count(questions, 'question', 'questions') : null]
    .filter(Boolean).join(', ') || 'nothing new';
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

/** What the phone reads for an item, less the "came in" line (WalkPlan.kt Item.spoken()). */
export function spokenOf(item) {
  const head = [item.project, item.task].filter((s) => s && s.trim()).join(', ');
  return [head ? `${head}.` : null, item.say, item.ask].filter(Boolean).join(' ').replace(/[*`#_]/g, '');
}

export class Voicer {
  /**
   * speak(ask) -> async iterable of {i, text, seconds, audio: Buffer}: lib/speaker.mjs's speak.
   * send(msg): to the phone.
   */
  constructor({ speak, send, log = () => {}, keep = 60 }) {
    Object.assign(this, { speak, send, log, keep });
    this.cache = new Map(); // item id -> [msgs], whole items only
    this.items = new Map(); // item id -> {text, project}, for a phone that asks again
    this.chain = Promise.resolve();
    this.making = new Map(); // item id -> msgs sent so far, while it is being made
  }

  /** Voice a reply's items in order, then each project's "came in" line. Returns when all are sent. */
  reply(items) {
    for (const it of items) this.items.set(it.id, { text: spokenOf(it), project: it.project || '' });
    for (const p of new Set(items.map((it) => it.project || ''))) this.items.set(`late:${p}`, { text: LATE, project: p });
    const ids = [...items.map((it) => it.id), ...new Set(items.map((it) => `late:${it.project || ''}`))];
    const run = this.chain.then(async () => { for (const id of ids) await this.voice(id); });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Voice a line that is no item (the arrival screen's "Three updates, one question."), in the hub's voice. */
  line(id, text) {
    this.items.set(id, { text, project: '' });
    const run = this.chain.then(() => this.voice(id));
    this.chain = run.catch(() => {});
    return run;
  }

  /** The phone asks for an item's clips (it reconnected, or missed them): resend, or make them now. */
  again(id) {
    const hit = this.cache.get(id);
    if (hit) { for (const m of hit) this.send(m); return Promise.resolve(); }
    // Being made right now: send what is made so far; the rest goes out as it is made.
    const making = this.making.get(id);
    if (making) { for (const m of making) this.send(m); return Promise.resolve(); }
    if (!this.items.has(id)) { this.send({ kind: 'clip', item: id, failed: true }); return Promise.resolve(); }
    // Queued behind others: once its turn comes, it is made (and sent) then, or it was made in the
    // meantime and is resent. Before, a reconnecting phone's ask for a queued item got nothing at all.
    const run = this.chain.then(() => (this.cache.has(id) ? this.again(id) : this.voice(id)));
    this.chain = run.catch(() => {});
    return run;
  }

  async voice(id) {
    if (this.cache.has(id)) return;
    const { text, project } = this.items.get(id) || {};
    if (!text) return;
    const msgs = [];
    this.making.set(id, msgs);
    const out = (m) => { msgs.push(m); this.send(m); };
    try {
      for await (const c of this.speak({ text, project, format: 'm4a' })) {
        out({ kind: 'clip', item: id, i: c.i, text: c.text, seconds: c.seconds, data: c.audio.toString('base64') });
      }
      out({ kind: 'clip', item: id, done: true, n: msgs.length });
      this.cache.set(id, msgs);
      while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value);
    } catch (e) {
      this.log('voice', id, e.message);
      this.send({ kind: 'clip', item: id, failed: true });
    }
    this.making.delete(id);
    while (this.items.size > this.keep * 2) this.items.delete(this.items.keys().next().value);
  }
}
