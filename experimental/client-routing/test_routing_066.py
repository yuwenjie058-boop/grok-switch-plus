"""Synthetic 0.66 contracts only; no installed app or user profiles are read."""
import hashlib
import subprocess
import unittest
from unittest.mock import patch

import patch_routing_066 as adapter


def routing_runtime():
    return adapter.routing_runtime()


SYNTHETIC_FACTORY = 'function YB(){return {synthetic: true};}\n'
SYNTHETIC_DIGEST = hashlib.sha256(SYNTHETIC_FACTORY.encode()).hexdigest()


def coordinator_fixture():
    # Matching fragments plus a synthetic factory; no vendor implementation.
    return '\n'.join([
        SYNTHETIC_FACTORY + adapter.FACTORY_TAIL,
        *(before for before, _ in adapter.wiring()),
        adapter.READ_ANCHOR, adapter.READ_ANCHOR,
        'be.isActive({agentId:G.id})?{status:"failed"}:syntheticFallback()',
        '/* synthetic creation, authorization and local-exec untouched sentinel */',
    ])


class Routing066Tests(unittest.TestCase):
    def run_js(self, body):
        result = subprocess.run(['node', '-e', '''
const assert = require('node:assert/strict');
function N(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function B1({raw, previous}) { return raw === undefined ? previous ?? 'box'
  : raw === 'box' || raw === 'temporal' ? raw : 'unsupported'; }
''' + routing_runtime() + '\n' + body], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_native_automation_transition_contract(self):
        self.run_js('''
const api = YB();
assert.equal(typeof api.noteBoxAutomationRows, 'function');
assert.deepEqual(api.noteRoster({agents: null}), {addedTemporal: false, staleBoxAutomations: []});
api.noteRoster({agents: [{id:'synthetic', harness:'box'}]});
api.noteBoxAutomationRows('synthetic');
assert.deepEqual(api.noteRoster({agents:[{id:'synthetic', harness:'temporal'}]}),
  {addedTemporal:true, staleBoxAutomations:['synthetic']});
api.noteBoxAutomationRows('synthetic');
assert.deepEqual(api.noteRoster({agents:[{id:'synthetic', harness:'temporal'}]}),
  {addedTemporal:false, staleBoxAutomations:[]});
api.__gsStop();
''')

    def test_automation_duplicate_rows_preserve_native_order(self):
        self.run_js('''
const api = YB();
api.noteBoxAutomationRows('a');
assert.deepEqual(api.noteRoster({agents:[{id:'a',harness:'temporal'},
  {id:'a',harness:'box'},{id:'a',harness:'temporal'}]}),
  {addedTemporal:true,staleBoxAutomations:['a']});
assert.equal(api.requiredAgents.has('a'), true);
api.noteRoster({agents:[{id:'a',harness:'box'}]});
assert.deepEqual(api.noteRoster({agents:[{id:'a',harness:'temporal'}]}),
  {addedTemporal:true,staleBoxAutomations:[]});
api.__gsStop();
''')

    def test_opted_in_box_identity_and_automation_survive_platform_roster(self):
        self.run_js('''
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(),'routing066-'));
const box = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const temporal = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
try {
  fs.writeFileSync(path.join(root,'grok-switch-box-routing'),'');
  let api = YB({dataDir:root});
  api.noteRoster({agents:[{id:box}]});
  api.noteBoxAutomationRows(box);
  assert.deepEqual(api.noteRoster({agents:[{id:box,harness:'temporal'},
    {id:temporal,harness:'temporal'}]}),{addedTemporal:true,staleBoxAutomations:[]});
  assert.equal(api.harnessOf(box),'box');
  assert.equal(api.requiredAgents.has(box),false);
  assert.equal(api.requiredAgents.has(temporal),true);
  const event = {type:'append',agentId:box};
  assert.equal(api.gatewayTranscript({payload:event,legacyServerActive:true}),event);
  assert.equal(api.gatewayTranscript({payload:{type:'append',agentId:temporal},legacyServerActive:true}),null);
  api.__gsStop();
  api = YB({dataDir:root});
  assert.equal(api.__gsOwnsBox(box),true);
  api.noteRoster({agents:[{id:box,harness:'future'}]});
  assert.equal(api.harnessOf(box),'box');
  api.__gsStop();
} finally { fs.rmSync(root,{recursive:true,force:true}); }
''')

    def test_marker_off_keeps_native_routes_and_does_not_write(self):
        self.run_js('''
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'routing066-off-'));
try {
  const api=YB({dataDir:root});
  api.noteRoster({agents:[{id:'a'},{id:'a',harness:'temporal'}]});
  assert.equal(api.harnessOf('a'),'temporal');
  assert.equal(api.__gsOwnsBox('a'),false);
  assert.equal(api.gatewayTranscript({payload:{agentId:'a'},legacyServerActive:true}),null);
  api.__gsStop();
  assert.deepEqual(fs.readdirSync(root),[]);
} finally { fs.rmSync(root,{recursive:true,force:true}); }
''')

    def test_transform_idempotent_and_same_version_runtime_refresh(self):
        with patch.object(adapter, 'NATIVE_ROSTER_SHA256', SYNTHETIC_DIGEST):
            source = coordinator_fixture()
            out = adapter.patch_coordinator(source)
        self.assertEqual(adapter.patch_coordinator(out), out)
        stale = out.replace('const staleBoxAutomations = [];',
                            'const staleBoxAutomations = []; /* old owned runtime */')
        self.assertEqual(adapter.patch_coordinator(stale), out)
        self.assertIn('synthetic creation, authorization and local-exec untouched sentinel', out)
        self.assertIn('be.isActive({agentId:G.id})?{status:"failed"}:syntheticFallback()', out)
        self.assertEqual(out.count(adapter.READ_PATCHED), 2)

    def test_native_factory_digest_and_anchor_counts_fail_closed(self):
        source = coordinator_fixture()
        with self.assertRaisesRegex(ValueError, 'digest'):
            adapter.patch_coordinator(source)
        with patch.object(adapter, 'NATIVE_ROSTER_SHA256', SYNTHETIC_DIGEST):
            for before, _ in adapter.wiring():
                with self.subTest(anchor=before[:50]):
                    with self.assertRaises(ValueError):
                        adapter.patch_coordinator(source.replace(before, '', 1))
                    with self.assertRaises(ValueError):
                        adapter.patch_coordinator(source + '\n' + before)
            with self.assertRaises(ValueError):
                adapter.patch_coordinator(source.replace(adapter.READ_ANCHOR, '', 1))

    def test_existing_patch_rejects_missing_or_duplicate_wiring(self):
        with patch.object(adapter, 'NATIVE_ROSTER_SHA256', SYNTHETIC_DIGEST):
            out = adapter.patch_coordinator(coordinator_fixture())
        for _, after in adapter.wiring():
            with self.subTest(anchor=after[:50]):
                with self.assertRaises(ValueError):
                    adapter.patch_coordinator(out.replace(after, '', 1))
                with self.assertRaises(ValueError):
                    adapter.patch_coordinator(out + '\n' + after)
        with self.assertRaisesRegex(ValueError, 'read guards'):
            adapter.patch_coordinator(out.replace(adapter.READ_PATCHED, adapter.READ_ANCHOR, 1))
        with self.assertRaises(ValueError):
            adapter.patch_coordinator(out.replace(adapter.RUNTIME_END, ''))

    def test_profile_bootstrap_is_exact_and_idempotent(self):
        out = adapter.patch_client_routing_profile(adapter.MAIN_ANCHOR)
        self.assertEqual(adapter.patch_client_routing_profile(out), out)
        self.assertIn('boxRoutingProfileDir:Te.app.getPath("userData")', out)
        for bad in ('unknown', adapter.MAIN_ANCHOR * 2, out * 2,
                    out + adapter.MAIN_ANCHOR):
            with self.assertRaises(ValueError):
                adapter.patch_client_routing_profile(bad)

    def test_patched_runtime_rejects_reversed_boundary(self):
        with patch.object(adapter, 'NATIVE_ROSTER_SHA256', SYNTHETIC_DIGEST):
            out = adapter.patch_coordinator(coordinator_fixture())
        malformed = out.replace(adapter.FACTORY_TAIL, '').replace(
            adapter.RUNTIME_HEAD, adapter.FACTORY_TAIL + adapter.RUNTIME_HEAD, 1)
        with self.assertRaisesRegex(ValueError, 'boundary'):
            adapter.patch_coordinator(malformed)

    def test_server_filter_and_two_read_guards_isolate_owned_box(self):
        filter_expression = adapter.wiring()[2][1].split('acceptsAgent:', 1)[1]
        read_expression = adapter.READ_PATCHED + 'G.id):"gateway"'
        self.run_js('''
const f = { __gsOwnsBox: id => id === 'box', harnessOf: id => id === 'bad' ? 'unsupported' : id };
const be = {isActive:()=>true}; const It = id => 'server:'+id;
const accepts = ''' + filter_expression + ''';
assert.equal(accepts({agentId:'box'}),false);
assert.equal(accepts({agentId:'temporal'}),true);
assert.equal(accepts({agentId:'bad'}),false);
const read = G => ''' + read_expression + ''';
assert.equal(read({id:'box'}),'gateway');
assert.equal(read({id:'temporal'}),'server:temporal');
''')

    def test_seed_order_background_retry_reset_and_stop(self):
        self.run_js('''
(async()=>{
const jobs = [], reads = [], events = [], installed = [], reports = [];
const clock = {schedule(delay,callback){const job={delay,callback,cancelled:false};jobs.push(job);
  return {dispose(){job.cancelled=true;}};}};
__gsRoutingClock = () => clock;
__gsBoxRouting = () => true;
let sequence=0, arrived=0;
const w={begin:()=>++sequence,arrive:()=>{arrived=++sequence;},isNewest:ticket=>{
  if(ticket<=arrived)return false;arrived=ticket;return true;}};
const t={processConfig:{boxRoutingProfileDir:'synthetic'}};
const q={dispatchCommand(method,args,options){
  assert.equal(method,'listAgents');assert.deepEqual(options,{demand:'background'});
  return new Promise((resolve,reject)=>reads.push({resolve,reject}));}};
const b = rows => installed.push(rows), B = () => {}, y = undefined;
const n={postEvent:(name,payload)=>events.push({name,payload})}, f={__gsStatus:x=>reports.push(x)};
const ue=String;
''' + adapter.seed_wrapper() + '''
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const first=J();J();await tick();assert.equal(reads.length,1);
w.arrive();reads[0].resolve([{id:'old-order'}]);await first;
assert.equal(events[0].payload.isNewestRoster,false);
const failed=J();await tick();reads[1].reject({code:'EIO'});await failed;
assert.equal(jobs.at(-1).delay,1000);jobs.at(-1).callback();await tick();
reads[2].resolve([{id:'retry'}]);await tick();assert.equal(events.at(-1).payload.isNewestRoster,true);
const old=J();await tick();__gsSeedController.reset();const newer=J();await tick();
reads[3].resolve([{id:'stale-after-reset'}]);await old;
assert.equal(installed.length,2);
reads[4].resolve([{id:'new-epoch'}]);await newer;assert.equal(installed.length,3);
const pending=J();await tick();__gsSeedController.stop();reads[5].resolve([{id:'after-stop'}]);
await pending;await J();assert.equal(installed.length,3);assert.equal(reads.length,6);
assert.equal(reports.at(-1).seedState,'stopped');
})().catch(error=>{console.error(error);process.exitCode=1;});
''')

    def test_disabled_seed_retains_native_no_retry_behavior(self):
        self.run_js('''
(async()=>{
__gsBoxRouting = () => false;
let attempts=0, tickets=0;
const t={processConfig:{}}, w={begin:()=>++tickets,isNewest:()=>true};
const q={dispatchCommand:async()=>{attempts++;throw new Error('synthetic seed failure');}};
const b=()=>{}, B=()=>{}, y=undefined, n={postEvent:()=>{}}, ue=()=> 'synthetic';
const f={__gsStatus:()=>{throw new Error('disabled seed wrote health');}};
''' + adapter.seed_wrapper() + '''
const write=process.stderr.write;process.stderr.write=()=>true;
try { await J();await J(); } finally {process.stderr.write=write;}
assert.equal(attempts,2);assert.equal(tickets,2);assert.equal(__gsSeedController,undefined);
})().catch(error=>{console.error(error);process.exitCode=1;});
''')


if __name__ == '__main__':
    unittest.main()
