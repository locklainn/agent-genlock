// Replies are walked one item at a time, each tagged with project and task; a walk's answers go
// back to Tally as one message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseItems, formatAnswers } from '../items.mjs';

const block = (items) => 'Written reply for the screen.\n\n```items\n' + JSON.stringify(items) + '\n```';

test('a reply with an items block becomes tagged items, and the block leaves the shown text', () => {
  const { text, items } = parseItems(block([
    { project: 'genlock', task: 'phone digest', kind: 'question', say: 'The walk is built.', ask: 'Ship it?', options: ['yes', 'no'] },
    { project: 'budget', task: 'FY26 pages', say: 'Pages now classify.' },
  ]), 'm1');
  assert.equal(text, 'Written reply for the screen.');
  assert.deepEqual(items, [
    { id: 'm1-0', project: 'genlock', task: 'phone digest', kind: 'question', say: 'The walk is built.', ask: 'Ship it?', options: ['yes', 'no'] },
    { id: 'm1-1', project: 'budget', task: 'FY26 pages', kind: 'update', say: 'Pages now classify.' },
  ]);
});

test('a plain reply, or one whose block is broken, is one item with the whole text spoken', () => {
  for (const raw of ['**Two** things: `a` and b.', 'Hi.\n\n```items\n[not json\n```']) {
    const { text, items } = parseItems(raw, 'm2');
    assert.equal(text, raw);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'm2-0');
    assert.equal(items[0].project, '');
  }
  assert.equal(parseItems('**Two** things: `a` and b.').items[0].say, 'Two things: a and b.');
});

test('an item with no spoken line is dropped; an unknown kind is inferred from whether it asks', () => {
  const { items } = parseItems(block([{ project: 'x' }, { project: 'x', task: 't', say: 'Hm.', ask: 'Which?', kind: 'weird' }]), 'm3');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'question');
});

test('a walk becomes one message: each answer with its project, task and question; skips listed; unheard counted', () => {
  const text = formatAnswers([
    { item: 'm1-0', project: 'genlock', task: 'phone digest', ask: 'Ship it?', answer: 'yes, ship it' },
    { item: 'm1-1', project: 'budget', task: 'FY26 pages', skipped: true },
    { item: 'm1-2', project: 'budget', task: 'audit', heard: true },
  ], { left: 3 });
  assert.equal(text, 'Answers from the phone walk-through: (1) genlock / phone digest - asked "Ship it?": yes, ship it '
    + '(2) budget / FY26 pages: skipped, heard but not answered (3) budget / audit: heard '
    + '3 more items are still unheard on the phone; TJ will walk them later, so do not repeat them.');
});

test('an empty items block means nothing new: shown as text, marked quiet so the phone does not walk it', () => {
  const r = parseItems(block([]), 't9');
  assert.equal(r.quiet, true);
  assert.equal(r.text, 'Written reply for the screen.');
  assert.equal(r.items.length, 1);
  assert.equal(parseItems(block([{ project: 'p', task: 't', say: 'New.' }]), 't9').quiet, undefined);
  assert.equal(parseItems('No block at all.', 't9').quiet, undefined);
});

test('an item can carry images to review: local image paths, with or without a caption; others are left out', () => {
  const r = parseItems(block([{ project: 'p', task: 't', say: 'Look at these.', images: [
    '/tmp/a.png', { path: '/tmp/b.JPG', caption: 'the side door' }, 'https://x.test/c.png', '/tmp/notes.txt', 'relative.png',
  ] }]), 't7');
  assert.deepEqual(r.items[0].images, [{ path: '/tmp/a.png' }, { path: '/tmp/b.JPG', caption: 'the side door' }]);
  assert.equal(parseItems(block([{ say: 'No images.' }]), 't7').items[0].images, undefined);
});

test('a reply to the laptop is not walked, unless it carries images to review; an empty block never is', async () => {
  const { walkable } = await import('../items.mjs');
  const plain = [{ id: 'r-0', say: 'x' }];
  const review = [{ id: 'r-0', say: 'x', images: [{ path: '/tmp/a.png' }] }];
  assert.equal(walkable({ answers: 'phone', items: plain }), true);
  assert.equal(walkable({ answers: 'laptop', items: plain }), false);
  assert.equal(walkable({ answers: 'laptop', items: review }), true);
  assert.equal(walkable({ answers: 'phone', quiet: true, items: plain }), false);
  // TJ, 2026-11-14: updates walk without a request from the phone: any reply with a block.
  assert.equal(walkable({ answers: 'laptop', items: plain, block: true }), true);
  assert.equal(parseItems(block([{ say: 'News.' }]), 'b').block, true);
  assert.equal(parseItems('No block.', 'b').block, undefined);
});
