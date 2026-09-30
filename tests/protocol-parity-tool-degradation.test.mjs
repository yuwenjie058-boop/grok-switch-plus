import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const anthropic = require('../src/protocols/anthropic-messages.cjs');
const responses = require('../src/protocols/openai-responses.cjs');
const chat = require('../src/protocols/openai-chat.cjs');
const tools = require('../src/protocols/tools.cjs');

// The two protocols whose transcript pairs a call with the result slot right
// after it already degrade a part-level malformation in the chat adapter's
// sense: the part is skipped and counted, the call it could not answer is
// closed with the shared sentence, and nothing is ever invented. A result the
// host stored only after the group closed still takes its slot back.

const image = 'iVBORw0KGgo=';
const call = (id, name = 'Read') => ({ type: 'tool-call', toolCallId: id, toolName: name, args: {} });
const result = (id, extra = {}) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', result: 'read ' + id, ...extra }]
});
const orphan = (id, extra = {}) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', result: 'read ' + id, ...extra }]
});
const stray = () => ({ role: 'tool', content: [{ type: 'text', text: 'a stray part that is not a tool result' }] });
const withImage = { experimental_content: [{ type: 'image', data: image, mimeType: 'image/png' }] };

const build = (adapter, messages) => adapter.buildRequest({ model: 'm', stream: true, maxTokens: 32, messages, tools: [] }).body;
const blocks = (message) => (Array.isArray(message.content) ? message.content : []);

const VIEWS = [
  {
    id: 'anthropic-messages',
    wire: (messages) => build(anthropic, messages).messages,
    roles: (out) => out.map((message) => message.role),
    calls: (out) => out.flatMap(blocks).filter((b) => b.type === 'tool_use').map((b) => b.id),
    answers: (out) => out.flatMap(blocks).filter((b) => b.type === 'tool_result').map((b) => ({ id: b.tool_use_id, content: b.content })),
    // Here the image block is nested inside the tool_result it belongs to.
    images: (out) => out.flatMap(blocks)
      .filter((b) => b.type === 'tool_result' && Array.isArray(b.content))
      .reduce((n, b) => n + b.content.filter((x) => x.type === 'image').length, 0),
    // Every tool_use has to be answered in the user message right after its
    // assistant turn, and no message may carry an empty content array.
    paired: (out) => {
      for (let i = 0; i < out.length; i += 1) {
        const ids = blocks(out[i]).filter((b) => b.type === 'tool_use').map((b) => b.id);
        if (ids.length === 0) continue;
        assert.equal(out[i].role, 'assistant', 'a tool_use only exists on an assistant turn');
        const next = out[i + 1];
        assert.ok(next != null, 'a tool_use turn is never the last message');
        assert.equal(next.role, 'user', 'the results come in the user message right after the turn');
        const answered = blocks(next).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id);
        for (const id of ids) assert.ok(answered.includes(id), 'tool_use ' + id + ' is answered in the next message');
      }
      for (const message of out) assert.notDeepEqual(message.content, [], 'no message carries an empty content array');
    }
  },
  {
    id: 'openai-responses',
    wire: (messages) => build(responses, messages).input,
    roles: (out) => out.map((item) => item.type),
    calls: (out) => out.filter((i) => i.type === 'function_call').map((i) => i.call_id),
    answers: (out) => out.filter((i) => i.type === 'function_call_output').map((i) => ({ id: i.call_id, content: i.output })),
    images: (out) => out.filter((i) => i.type === 'message').reduce((n, i) => n + i.content.filter((p) => p.type === 'input_image').length, 0),
    paired: (out) => {
      for (let i = 0; i < out.length; i += 1) {
        if (out[i].type !== 'function_call') continue;
        const answeredLater = out.slice(i + 1).some((x) => x.type === 'function_call_output' && x.call_id === out[i].call_id);
        assert.ok(answeredLater, 'function_call ' + out[i].call_id + ' is answered later in the transcript');
      }
    }
  }
];

// One answer per call, no answer without a call, and the protocol's own pairing
// rule still holds - that is the whole point of degrading instead of dropping.
function assertPaired(view, out) {
  const calls = view.calls(out);
  const answers = view.answers(out);
  assert.equal(answers.length, calls.length, view.id + ': one answer per call');
  for (const id of calls) {
    assert.equal(answers.filter((a) => a.id === id).length, 1, view.id + ': call ' + id + ' is answered exactly once');
  }
  for (const a of answers) assert.ok(calls.includes(a.id), view.id + ': answer ' + a.id + ' belongs to a call that was sent');
  view.paired(out);
}

for (const view of VIEWS) {
  test(view.id + ': an id-less result part degrades instead of failing the turn', () => {
    const out = view.wire([
      { role: 'assistant', content: [call('call_a'), call('call_b')] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'call_a', toolName: 'Read', result: 'read call_a' },
        { type: 'tool-result', toolName: 'Read', result: 'the host lost the id of this one' }
      ] }
    ]);
    assert.deepEqual(view.roles(out), view.id === 'anthropic-messages'
      ? ['assistant', 'user']
      : ['function_call', 'function_call', 'function_call_output', 'function_call_output'],
      'the group is closed before anything else is written');
    assertPaired(view, out);
    const answers = view.answers(out);
    assert.equal(answers.find((a) => a.id === 'call_a').content, 'read call_a', 'the pair-able part is untouched');
    assert.equal(answers.find((a) => a.id === 'call_b').content, tools.unansweredToolCallText('call_b'),
      'the call it could not answer is closed with the shared sentence');
    assert.ok(!JSON.stringify(out).includes('the host lost the id'), 'the unpaired part never reaches the wire');
  });

  test(view.id + ': a part that is not a tool result is degraded, not fatal', () => {
    const out = view.wire([
      { role: 'assistant', content: [call('call_a')] },
      stray()
    ]);
    assertPaired(view, out);
    assert.equal(view.answers(out)[0].content, tools.unansweredToolCallText('call_a'));
    assert.ok(!JSON.stringify(out).includes('a stray part'), 'nothing is invented from the stray part');
  });

  test(view.id + ': a result no call opened is dropped, never answered by a guess', () => {
    const out = view.wire([
      { role: 'assistant', content: [call('call_a')] },
      result('call_a'),
      orphan('call_z')
    ]);
    assertPaired(view, out);
    assert.deepEqual(view.answers(out).map((a) => a.id), ['call_a'], 'the orphan result is not answered and opens no call');
    assert.ok(!JSON.stringify(out).includes('call_z'), 'neither the orphan nor a call invented for it reaches the wire');
  });

  test(view.id + ': a late real result takes the placeholder slot back', () => {
    const out = view.wire([
      { role: 'assistant', content: [call('call_a'), call('call_b')] },
      result('call_a'),
      { role: 'user', content: 'Continue' },
      result('call_b')
    ]);
    assertPaired(view, out);
    const answers = view.answers(out);
    assert.equal(answers.length, 2, 'no placeholder is left behind');
    assert.equal(answers.find((a) => a.id === 'call_b').content, 'read call_b', 'the real result took the slot back');
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes('was not answered'), 'nothing still claims the call was unanswered');
    assert.ok(serialized.includes('Continue'), 'the message that closed the group did not move');
  });

  test(view.id + ': a call nobody answered is closed at the end of history', () => {
    const out = view.wire([{ role: 'assistant', content: [call('call_a')] }]);
    assertPaired(view, out);
    const answers = view.answers(out);
    assert.equal(answers.length, 1);
    assert.equal(answers[0].content, tools.unansweredToolCallText('call_a'));
  });

  test(view.id + ': a tool message with no usable part writes no empty content', () => {
    assert.deepEqual(view.wire([{ role: 'tool', content: [] }]), [], 'an empty result carries nothing to the wire');
    const out = view.wire([{ role: 'assistant', content: [call('call_a')] }, { role: 'tool', content: [] }]);
    assertPaired(view, out);
    assert.equal(view.answers(out)[0].content, tools.unansweredToolCallText('call_a'));
  });

  test(view.id + ': the image of a dropped result is dropped with it', () => {
    const out = view.wire([
      { role: 'assistant', content: [call('call_a')] },
      result('call_a', withImage),
      orphan('call_z', withImage)
    ]);
    assertPaired(view, out);
    assert.equal(view.images(out), 1, 'only the answered result carries its image out');
  });

  test(view.id + ': a tool message that is not a content array is still fatal', () => {
    assert.throws(
      () => view.wire([{ role: 'assistant', content: [call('call_a')] }, { role: 'tool', content: 42 }]),
      (error) => error.name === 'ProtocolError' && error.code === 'unsupported-shape' && error.protocol === view.id
    );
  });

  test(view.id + ': a content malformation that cannot be expressed is still fatal', () => {
    assert.throws(
      () => view.wire([
        { role: 'assistant', content: [call('call_a')] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_a', toolName: 'Read', experimental_content: [{ type: 'unsupported' }] }] }
      ]),
      (error) => error.name === 'ProtocolError' && error.code === 'unsupported-shape' && error.protocol === view.id,
      'content with no equivalent is a genuine loss, not a pairing loss'
    );
  });
}

// The sentence every protocol writes into a result slot it has to fill. The
// replay gate recognises a closure by this wording, so it is one literal.
test('the unanswered sentence is one literal shared by every protocol', () => {
  const literal = 'Tool call call_x was not answered: the host stored no tool result for it, so this call returned no output.';
  assert.equal(tools.unansweredToolCallText('call_x'), literal);
  assert.match(literal, /^Tool call call_x was not answered/, 'the shape the replay gate recognises');
  const chatMessages = build(chat, [{ role: 'assistant', content: [call('call_x')] }]).messages;
  assert.equal(chatMessages[1].content, tools.unansweredToolCallText('call_x'),
    'the chat adapter writes the same sentence, so the three cannot drift apart');
  for (const view of VIEWS) {
    const out = view.wire([{ role: 'assistant', content: [call('call_x')] }]);
    assert.equal(view.answers(out)[0].content, literal, view.id + ' writes the same sentence');
  }
});

const shapeLog = (dir) => readFileSync(join(dir, 'grok-switch-shape.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

function withShapeLog(run) {
  const dir = mkdtempSync(join(tmpdir(), 'shape-log-'));
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

for (const view of VIEWS) {
  test(view.id + ': the shape log names the part-level losses under the shared counters', () => {
    withShapeLog((dir) => {
      const out = view.wire([
        { role: 'assistant', content: [call('call_a'), call('call_b')] },
        { role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'call_a', toolName: 'Read', result: 'read call_a' },
          { type: 'text', text: 'stray' },
          { type: 'tool-result', toolName: 'Read', result: 'no id' }
        ] }
      ]);
      assertPaired(view, out);
      const records = shapeLog(dir);
      assert.equal(records.length, 1, 'one request writes one line');
      const record = records[0];
      assert.equal(record.protocol, view.id, 'the protocol is named so one reader can tell the writers apart');
      assert.equal(record.messages, out.length, 'the logged count is the wire count');
      assert.equal(record.roles.length, out.length, 'one logged role per wire item');
      assert.equal(record.dropped, 2, 'both unpaired parts are counted');
      assert.equal(record.droppedNonResult, 1, 'one was not a tool result');
      assert.equal(record.droppedMissingId, 1, 'the other had no id');
      assert.equal(record.placeholders, 1, 'the call they could not answer is closed');
      assert.equal(record.lateResults, 0, 'nothing arrived late here');
      const serialized = JSON.stringify(record);
      assert.ok(!serialized.includes('read call_'), 'no message text reaches the log');
      assert.ok(!serialized.includes('stray'), 'and no stray part text either');
    });
  });

  test(view.id + ': the shape log can be silenced without changing the payload', () => {
    const input = [{ role: 'assistant', content: [call('call_a')] }, result('call_a')];
    const expected = view.wire(input);
    withShapeLog((dir) => {
      process.env.GROK_SWITCH_SHAPE_LOG = '0';
      assert.deepEqual(view.wire(input), expected, 'silencing is payload-neutral');
      assert.throws(() => shapeLog(dir), /ENOENT/, 'nothing was written while silenced');
    });
  });
}
