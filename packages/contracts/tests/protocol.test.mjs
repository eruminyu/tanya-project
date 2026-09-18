import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseMessage} from '../dist/index.js';
const fixtures = JSON.parse(await readFile(new URL('../fixtures/wire.json', import.meta.url), 'utf8'));
for (const fixture of fixtures) test(fixture.name, () => {
  if (fixture.valid) assert.deepEqual(parseMessage(fixture.message), fixture.message);
  else assert.throws(() => parseMessage(fixture.message));
});
test('parser returns an independent validated message', () => {
  const original = structuredClone(fixtures[0].message);
  const parsed = parseMessage(original);
  original.scope.session_id = 'changed';
  assert.notEqual(parsed.scope.session_id, original.scope.session_id);
});
for (const sequence of [NaN,Infinity,-Infinity]) test('reject non-JSON sequence ' + sequence, () => {
 const message = structuredClone(fixtures[0].message); message.sequence = sequence;
 assert.throws(() => parseMessage(message));
});

test('reject non-JSON objects and inherited envelope fields', () => {
 const message=structuredClone(fixtures[0].message);
 assert.throws(()=>parseMessage(Object.assign(new Date(),message)));
 assert.throws(()=>parseMessage(Object.create(message)));
 message[Symbol('extra')]='hidden';
 assert.throws(()=>parseMessage(message));
});
