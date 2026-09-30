import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('journal permits timing-only updates while rejecting content and unknown-field changes', async () => {
  const source = fs.readFileSync(new URL('../src/runtime.cjs', import.meta.url), 'utf8');
  const helper = source.match(/async function grokSwitchJournalUserMessagesEqual[\s\S]*?\n}/);
  assert.ok(helper, 'timing-only journal compatibility helper exists');
  const encode = x => Buffer.from(JSON.stringify(x));
  const scope = vm.createContext({ Buffer,
    requiredBlob: async (_ctx, _store, value) => value,
    UserMessage: { fromBinary(value) {
      const msg = JSON.parse(Buffer.from(value).toString());
      Object.defineProperty(msg, 'toBinary', { value() { return encode(this); } });
      return msg;
    } }
  });
  vm.runInContext(helper[0], scope);
  const before = {text:'425',messageId:'same',startedAtMs:'100',completedAtMs:'200',attachment:'A',unknown:'preserve'};
  const after = {...before,startedAtMs:'300',completedAtMs:'400'};
  const compare = (a,b) => scope.grokSwitchJournalUserMessagesEqual({}, {}, encode(a), encode(b));
  assert.equal(await compare(before,after), true);
  for (const field of ['text','messageId','attachment','unknown']) {
    assert.equal(await compare(before,{...after,[field]:'changed'}),false, field);
  }
  assert.equal(await compare(before,before),true);
});
