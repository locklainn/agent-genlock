// Writes app/src/test/resources/voice-text.json: what lib/voices.mjs makes of each input, so
// VoiceTextTest can hold the phone's port (VoiceText.kt) to the Mac's exact sentences and words.
//   node mobile/android/voice-text-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakable, sentences } from '../../lib/voices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inputs = [
  'genlock, phone app. 422 pages -> 474. FY2025\'s budget pages now classify.',
  'Version 1.13.8 is pinned; 2.x ignores espeak-ng-data. That is 12.5% faster, at 1,234,567 rows.',
  'Done! Next: the **bridge** sends `item.voice` → the phone. "Quoted start." (Aside.) [Bracket.] ok',
  'First line.\n\n- a bullet item\n- another one\n1. numbered\n2) also numbered\n\nLast para.',
  'Code:\n```js\nconst x = 1;\n```\nafter the fence.',
  'A tracking number 1234567890123456 and a time of 3:45 and a ratio 0.53-0.65 of playback.',
  'This sentence is deliberately very long, with many clauses, so that it goes past the limit of two hundred and twenty characters; it keeps going, and going, with commas everywhere, until the splitter has to cut it at a comma or semicolon, which is exactly what we want to check here, yes.',
  'Wait…  Really?  Yes. Non-breaking space here.',
  'what about a lower case start. it stays one sentence! OK then.',
  '| table | cells | # heading > quote _under_ ok',
  'v2 build, T-K34H3 and G-SVGX8, 6 threads at 0.52x.',
  '',
  '   ',
  '100 200 1000 1001 19 20 21 99 101 110 999 1000000 2000000000',
];
const out = inputs.map((text) => ({ text, speakable: speakable(text), sentences: sentences(text) }));
fs.writeFileSync(path.join(here, 'app/src/test/resources/voice-text.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.length} cases`);
