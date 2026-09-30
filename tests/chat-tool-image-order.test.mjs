import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const chat = require('../src/protocols/openai-chat.cjs');
const image = 'iVBORw0KGgo=';
const call = id => ({type:'tool-call',toolCallId:id,toolName:'Read',args:{path:'example.png'}});
const result = (id, screenshot=true) => ({role:'tool',content:[{
  type:'tool-result',toolCallId:id,toolName:'Read',result:'read '+id,
  ...(screenshot?{experimental_content:[{type:'image',data:image,mimeType:'image/png'}]}:{})
}]});
const map = messages => chat.buildRequest({model:'m',stream:true,maxTokens:32,messages,tools:[]}).body.messages;

// A user/image message between two parallel tool results is rejected by
// DeepSeek as an insufficient tool result, even though both results exist.
test('parallel image results remain contiguous before their image messages', () => {
  const input=[{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_a'),result('call_b'),{role:'user',content:'Continue'}];
  const original=structuredClone(input);
  const out=map(input);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool','user','user','user']);
  assert.deepEqual(out.slice(1,3).map(m=>m.tool_call_id),['call_a','call_b']);
  assert.deepEqual(out.slice(1,3).map(m=>m.content),['read call_a','read call_b']);
  for(const m of out.slice(3,5))assert.deepEqual(m.content,[
    {type:'text',text:'[Image output of tool Read]'},
    {type:'image_url',image_url:{url:'data:image/png;base64,'+image}}
  ]);
  assert.equal(out[5].content,'Continue');
  assert.deepEqual(input,original,'request building must not rewrite saved history');
});

test('tool images flush at end of history after every result', () => {
  const out=map([{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_a'),result('call_b',false)]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool','user']);
  assert.equal(out[3].content[1].image_url.url,'data:image/png;base64,'+image);
});

test('image batches do not cross a subsequent assistant turn', () => {
  const out=map([{role:'assistant',content:[call('call_a')]},result('call_a'),{role:'assistant',content:[call('call_b')]},result('call_b')]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','user','assistant','tool','user']);
});

test('text-only parallel results keep existing order and contents', () => {
  const out=map([{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_a',false),result('call_b',false)]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool']);
  assert.deepEqual(out.slice(1).map(m=>m.content),['read call_a','read call_b']);
});

// DeepSeek rejects the whole request when a tool_calls group is left open, so an
// unanswered call is closed with an explicit marker rather than dropped.
test('an unanswered tool_call is closed with a synthetic result', () => {
  const out=map([{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_a',false)]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool']);
  assert.deepEqual(out.slice(1).map(m=>m.tool_call_id),['call_a','call_b']);
  assert.equal(out[1].content,'read call_a');
  assert.match(out[2].content,/call_b was not answered/);
});

test('a tool_calls group left open at the end of history is still closed', () => {
  const out=map([{role:'assistant',content:[call('call_a')]}]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool']);
  assert.equal(out[1].tool_call_id,'call_a');
  assert.match(out[1].content,/call_a was not answered/);
});

test('a tool result no assistant opened is dropped rather than answered by guesswork', () => {
  const out=map([{role:'assistant',content:[call('call_a')]},result('call_a',false),result('call_x',false)]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool']);
  assert.deepEqual(out.slice(1).map(m=>m.tool_call_id),['call_a']);
});

test('an unanswered group is closed before the images it carried are flushed', () => {
  const out=map([{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_b')]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool','user']);
  assert.deepEqual(out.slice(1,3).map(m=>m.tool_call_id),['call_b','call_a']);
  assert.match(out[2].content,/call_a was not answered/);
  assert.equal(out[3].content[1].image_url.url,'data:image/png;base64,'+image);
});

// The group has to be closed *and* its images flushed, in that order, when the
// host moves on to a later turn while a parallel call is still unanswered --
// this is the only path where both happen in the same step. Dropping the
// closure here leaves the call unanswered until the end of history (after the
// image), and flushing the images first puts a user message inside the group.
test('an unanswered call is closed before the group images when a later turn arrives', () => {
  const out=map([{role:'assistant',content:[call('call_a'),call('call_b')]},result('call_b'),{role:'user',content:'Continue'}]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool','user','user']);
  assert.deepEqual(out.slice(1,3).map(m=>m.tool_call_id),['call_b','call_a']);
  assert.equal(out[1].content,'read call_b');
  assert.match(out[2].content,/call_a was not answered/);
  assert.equal(out[3].content[1].image_url.url,'data:image/png;base64,'+image);
  assert.equal(out[4].content,'Continue');
});

// The shape log is evidence, not payload: it names the roles, a 12-hex digest of
// each tool_call_id, and the three counters - and must never carry message text
// or a full id, and must never change what reaches the wire.
const shapeLog = (dir) => readFileSync(join(dir, "grok-switch-shape.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

function withShapeLog(run) {
  const dir = mkdtempSync(join(tmpdir(), "shape-log-"));
  const previousDir = process.env.GROK_SWITCH_LOG_DIR;
  const previousFlag = process.env.GROK_SWITCH_SHAPE_LOG;
  process.env.GROK_SWITCH_LOG_DIR = dir;
  delete process.env.GROK_SWITCH_SHAPE_LOG;
  try {
    return run(dir);
  } finally {
    if (previousDir === undefined) delete process.env.GROK_SWITCH_LOG_DIR;
    else process.env.GROK_SWITCH_LOG_DIR = previousDir;
    if (previousFlag !== undefined) process.env.GROK_SWITCH_SHAPE_LOG = previousFlag;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the shape log records the wire shape without any message text or full id', () => {
  withShapeLog((dir) => {
    const out = map([{ role: 'assistant', content: [call('call_secret_1'), call('call_secret_2')] }, result('call_secret_1', false)]);
    assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool', 'tool'], 'the wire shape is what the log describes');
    const records = shapeLog(dir);
    assert.equal(records.length, 1, 'one request writes one line');
    const record = records[0];
    assert.deepEqual(record.roles, ['assistant', 'tool', 'tool'], 'roles in order');
    assert.equal(record.messages, 3, 'message count');
    assert.equal(record.placeholders, 1, 'one placeholder was added for the unanswered call');
    assert.equal(record.unanswered, 1, 'and counted as unanswered');
    assert.equal(record.dropped, 0, 'nothing was dropped here');
    assert.equal(record.toolCallIdDigests.length, 2, 'one digest per tool message');
    for (const digest of record.toolCallIdDigests) assert.match(digest, /^[0-9a-f]{12}$/, 'digests are truncated sha256');
    assert.equal(record.protocol, 'openai-chat', 'the protocol is named');
    const serialized = JSON.stringify(record);
    assert.ok(!serialized.includes('call_secret'), 'no full tool_call_id reaches the log');
    assert.ok(!serialized.includes('read call_'), 'no message text reaches the log');
  });
});

test('the shape log can be silenced, and a broken log target cannot change the payload', () => {
  const expected = map([{ role: 'assistant', content: [call('call_a')] }, result('call_a')]);
  withShapeLog((dir) => {
    process.env.GROK_SWITCH_SHAPE_LOG = '0';
    assert.deepEqual(map([{ role: 'assistant', content: [call('call_a')] }, result('call_a')]), expected, 'silencing is payload-neutral');
    assert.throws(() => shapeLog(dir), /ENOENT/, 'nothing was written while silenced');
  });
  withShapeLog((dir) => {
    // A log target that cannot be written: the request must still succeed.
    process.env.GROK_SWITCH_LOG_DIR = join(dir, 'not-a-directory', 'deeper');
    assert.deepEqual(map([{ role: 'assistant', content: [call('call_a')] }, result('call_a')]), expected, 'a logging failure cannot change the payload');
  });
});

// --- part-level malformations -------------------------------------------------
// A part with no id can never be paired with a call, and one such part used to
// fail the whole turn with ProtocolError/incomplete-tool-call. It is dropped as
// an orphan - counted, never guessed at - and the rest of the turn still goes out.
test('an id-less tool result part is dropped as an orphan instead of failing the turn', () => {
  const input=[
    {role:'assistant',content:[call('call_a'),call('call_b')]},
    {role:'tool',content:[
      {type:'tool-result',toolCallId:'call_a',toolName:'Read',result:'read call_a'},
      {type:'tool-result',toolName:'Read',result:'the host lost the id of this one'}
    ]}
  ];
  const out=map(input);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool']);
  assert.equal(out[1].content,'read call_a','the pair-able part is untouched');
  assert.match(out[2].content,/call_b was not answered/,'the call it could not answer is still closed');
  assert.ok(!JSON.stringify(out).includes('the host lost the id'),'the unpaired part never reaches the wire');
});

// A tool content array with a part that is not a tool result used to fail the
// turn with ProtocolError/unsupported-shape. The part is unrepresentable, so it
// is dropped, and the call falls back to the same readable "not answered"
// placeholder - never to output invented from the stray part.
test('a part that is not a tool result is degraded, not fatal', () => {
  const out=map([
    {role:'assistant',content:[call('call_a')]},
    {role:'tool',content:[{type:'text',text:'a stray part that is not a tool result'}]}
  ]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool']);
  assert.match(out[1].content,/call_a was not answered/);
  assert.ok(!JSON.stringify(out).includes('a stray part'),'nothing is invented from the stray part');
});

// A result the host stored only after the group was closed: the placeholder the
// boundary injected is rewritten in place, so the wire order does not move and
// the image the late result carries still rides the deferred-image channel out.
test('a tool result that arrives after its call was closed replaces the placeholder in place', () => {
  // The image a normal path produces, to compare the late one against without
  // spelling an encoded image out twice.
  const normalImageUrl=map([{role:'assistant',content:[call('call_a')]},result('call_a'),{role:'user',content:'C'}])[2].content[1].image_url.url;
  const out=map([
    {role:'assistant',content:[call('call_a'),call('call_b')]},
    result('call_a',false),
    {role:'user',content:'Continue'},
    result('call_b')
  ]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','tool','user','user']);
  assert.deepEqual(out.slice(1,3).map(m=>m.tool_call_id),['call_a','call_b']);
  assert.equal(out[1].content,'read call_a');
  assert.equal(out[2].content,'read call_b','the late result took the placeholder slot back');
  assert.equal(out[3].content,'Continue','the message that closed the group did not move');
  assert.equal(out[4].content[1].image_url.url,normalImageUrl,'the late result image still comes out');
  assert.ok(!out.some(m=>typeof m.content==='string'&&/was not answered/.test(m.content)),'no placeholder is left behind');
});

// The same shape one turn later: the placeholder sits before a user message and
// an assistant turn, and the late result still has to land in its own slot.
test('a late tool result after a later assistant turn still replaces its placeholder', () => {
  const out=map([
    {role:'assistant',content:[call('call_a')]},
    {role:'user',content:'Continue'},
    {role:'assistant',content:[call('call_c')]},
    result('call_c',false),
    result('call_a',false)
  ]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','user','assistant','tool']);
  assert.equal(out[1].content,'read call_a','the placeholder before the user message was rewritten');
  assert.equal(out[4].content,'read call_c','the later turn is untouched');
});

// The rewrite is only for an id a placeholder was injected for. A result whose
// call nobody opened stays an orphan, and its image goes with it.
test('a late tool result that never had a placeholder is still dropped as an orphan', () => {
  const out=map([
    {role:'assistant',content:[call('call_a')]},
    result('call_a',false),
    {role:'user',content:'Continue'},
    result('call_z')
  ]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','user']);
  assert.deepEqual(out.slice(1,2).map(m=>m.tool_call_id),['call_a'],'the orphan and the image it carried are dropped together');
});

// "__proto__" is a legal tool_call_id, so the placeholder bookkeeping has to
// treat it as an ordinary key rather than as a prototype.
test('a tool_call_id of "__proto__" is an ordinary key', () => {
  const out=map([
    {role:'assistant',content:[call('__proto__')]},
    {role:'user',content:'Continue'},
    result('__proto__',false)
  ]);
  assert.deepEqual(out.map(m=>m.role),['assistant','tool','user']);
  assert.equal(out[1].content,'read __proto__');
});

// The shape log has to show the part-level losses by name, so a reader can tell
// "a part had no id" from "a part was not a result" from "a result had no call".
test('the shape log names the part-level losses instead of hiding them', () => {
  withShapeLog((dir) => {
    map([
      {role:'assistant',content:[call('call_a'),call('call_b')]},
      {role:'tool',content:[
        {type:'tool-result',toolCallId:'call_a',toolName:'Read',result:'read call_a'},
        {type:'text',text:'stray'},
        {type:'tool-result',toolName:'Read',result:'no id'}
      ]}
    ]);
    const record=shapeLog(dir)[0];
    assert.equal(record.dropped,2,'both unpaired parts are counted');
    assert.equal(record.droppedNonResult,1,'one was not a tool result');
    assert.equal(record.droppedMissingId,1,'the other had no id');
    assert.equal(record.placeholders,1,'the call they could not answer is closed');
    assert.equal(record.lateResults,0,'nothing arrived late here');
  });
});

test('the shape log records a late result and the placeholder it retired', () => {
  withShapeLog((dir) => {
    map([
      {role:'assistant',content:[call('call_a'),call('call_b')]},
      result('call_a',false),
      {role:'user',content:'Continue'},
      result('call_b',false)
    ]);
    const record=shapeLog(dir)[0];
    assert.equal(record.lateResults,1,'the late result is named');
    assert.equal(record.placeholders,0,'and the placeholder it replaced is no longer on the wire');
    assert.equal(record.unanswered,0,'so the call is not reported as unanswered');
    assert.equal(record.dropped,0,'and it was not dropped either');
  });
});
