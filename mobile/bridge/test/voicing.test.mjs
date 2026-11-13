// The bridge voices each walk item through the speaker and sends the clips tagged with the item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseItems } from '../items.mjs';
import { Voicer, spokenOf, LATE } from '../voicing.mjs';

// A speaker that "speaks" each sentence as its own text, in a voice named after the project.
function fakeSpeak(asked) {
  return async function* (ask) {
    asked.push(ask);
    if (ask.text.includes('BROKEN')) throw new Error('speaker down');
    const parts = ask.text.split(/(?<=\.)\s+/);
    for (let i = 0; i < parts.length; i++) yield { i, text: parts[i], seconds: 1, audio: Buffer.from(`${ask.project}|${parts[i]}`) };
  };
}

const reply = 'Two things.\n\n```items\n'
  + '[{"project":"genlock","task":"voice","say":"The speaker works. It streams.","ask":"Ship it?"},'
  + '{"project":"ghostlight","task":"show","say":"Lights are set."}]\n```';

test('a reply with 2 items produces clip messages for both item ids', async () => {
  const sent = []; const asked = [];
  const v = new Voicer({ speak: fakeSpeak(asked), send: (m) => sent.push(m) });
  const { items } = parseItems(reply, 'r1');
  await v.reply(items);
  const clips = (id) => sent.filter((m) => m.kind === 'clip' && m.item === id);
  for (const it of items) {
    assert.ok(clips(it.id).some((m) => m.data), `no audio for ${it.id}`);
    assert.ok(clips(it.id).at(-1).done, `${it.id} not closed with done`);
  }
  assert.deepEqual(clips('r1-0').filter((m) => m.data).map((m) => m.text), ['genlock, voice.', 'The speaker works.', 'It streams.', 'Ship it?']);
  assert.equal(Buffer.from(clips('r1-1')[0].data, 'base64').toString(), 'ghostlight|ghostlight, show.');
  // Each item asked in its own project's voice, and the "came in" line once per project.
  assert.deepEqual(asked.map((a) => a.project), ['genlock', 'ghostlight', 'genlock', 'ghostlight']);
  assert.ok(clips('late:genlock').some((m) => m.text === LATE));
  // Items first, so the first item's clips are not held up behind the "came in" lines.
  assert.equal(sent.findIndex((m) => m.item === 'late:genlock') > sent.findIndex((m) => m.item === 'r1-1' && m.done), true);
});

test('asking again resends from the cache without speaking again', async () => {
  const sent = []; const asked = [];
  const v = new Voicer({ speak: fakeSpeak(asked), send: (m) => sent.push(m) });
  await v.reply(parseItems(reply, 'r2').items);
  const before = asked.length; sent.length = 0;
  await v.again('r2-1');
  assert.equal(asked.length, before);
  assert.ok(sent.at(-1).done && sent.every((m) => m.item === 'r2-1'));
  sent.length = 0;
  await v.again('unknown-0');
  assert.deepEqual(sent, [{ kind: 'clip', item: 'unknown-0', failed: true }]);
});

test('a speaker that fails tells the phone to use its own voice', async () => {
  const sent = [];
  const v = new Voicer({ speak: fakeSpeak([]), send: (m) => sent.push(m) });
  await v.reply([{ id: 'r3-0', project: 'p', task: '', say: 'BROKEN thing' }]);
  assert.ok(sent.some((m) => m.item === 'r3-0' && m.failed));
});

test('the spoken text matches what the phone reads', () => {
  assert.equal(spokenOf({ project: 'genlock', task: 'voice', say: 'It *works*.', ask: 'Ship?' }), 'genlock, voice. It works. Ship?');
  assert.equal(spokenOf({ project: '', task: '', say: 'Just this.' }), 'Just this.');
});

test('a phone asking again for an item still being made gets what is made so far, and the rest as it comes', async () => {
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const speak = async function* () {
    yield { i: 0, text: 'One.', seconds: 1, audio: Buffer.from('a') };
    await gate;
    yield { i: 1, text: 'Two.', seconds: 1, audio: Buffer.from('b') };
  };
  const v = new Voicer({ speak, send: (m) => sent.push(m) });
  const done = v.reply([{ id: 'x', project: '', task: '', say: 'One. Two.' }]);
  await new Promise((r) => setTimeout(r, 20));
  sent.length = 0;
  await v.again('x');
  assert.deepEqual(sent.map((m) => m.i), [0]);
  release();
  await done;
  assert.ok(sent.some((m) => m.item === 'x' && m.done));
});

test('a phone asking for an item queued behind another gets it once made', async () => {
  const sent = [];
  const speak = async function* ({ text }) { yield { i: 0, text, seconds: 1, audio: Buffer.from('a') }; };
  const v = new Voicer({ speak, send: (m) => sent.push(m) });
  v.reply([{ id: 'a', project: '', task: '', say: 'A.' }, { id: 'b', project: '', task: '', say: 'B.' }]);
  await v.again('b');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(sent.filter((m) => m.item === 'b' && m.done).length >= 1);
});
