"""Fail-closed 0.66.0 adapter using our shared durable routing runtime.

Only short anchors and a digest identify the operator-supplied native factory.
Creation policy, server permissions and feature gates are not patch targets.
"""
import hashlib
from pathlib import Path

ADAPTER_MARK = 'client-0.66.0'
RUNTIME_HEAD = '// grok-switch client-0.66.0 runtime begin\n'
RUNTIME_END = '// grok-switch client-0.66.0 runtime end\n'
FACTORY_HEAD = 'function YB(){'
FACTORY_TAIL = 'var AR=require("node:crypto");'
NATIVE_ROSTER_SHA256 = '6480d8962f5104a3226ddc55f14e0100f74bd25bd4f598d4cb4d0bce4103c164'
SEED_ANCHOR = (
    'async function J(){let _=w.begin();try{let G=await q.dispatchCommand("listAgents",{},'
    '{demand:"background"});b(G),y===void 0&&B({payload:{agents:G},snapshot:!0}),'
    'n.postEvent("agents-roster-seed",{agents:G,isNewestRoster:w.isNewest(_)})}catch(G){'
    'process.stderr.write(`node-agent-coordinator: agents roster seed skipped: ${ue(G)}\n`)}}'
)
MAIN_ANCHOR = ('processConfig:{appVersion:Tw().version,isPackaged:Te.app.isPackaged,'
               'dataDir:(0,Lc.getSandRootDir)()},artifactPath:B1e()')
MAIN_PATCHED = MAIN_ANCHOR.replace('dataDir:(0,Lc.getSandRootDir)()',
    'dataDir:(0,Lc.getSandRootDir)(),boxRoutingProfileDir:Te.app.getPath("userData")')


def once(source, before, after):
    if source.count(before) != 1:
        raise ValueError('unknown 0.66 routing anchor: ' + before[:80])
    return source.replace(before, after, 1)


def routing_runtime():
    """Adapt only exact owned-source statements; retain native automation state."""
    source = Path(__file__).with_name('box-routing-store.cjs').read_text('utf8')
    substitutions = [
        ('function Rb(__gsOptions = {}) {', 'function YB(__gsOptions = {}) {'),
        ('!G(a)', '!N(a)'), ('LD({ raw:', 'B1({ raw:'),
        ('if (G(n)', 'if (N(n)'), ('if (!G(n)', 'if (!N(n)'),
        ('  const __gsClock =', '  const __gsBoxAutomationRows = new Set();\n  const __gsClock ='),
        ('    requiredAgents,', '''    requiredAgents,
    noteBoxAutomationRows(id) {
      if (harnesses.get(id) !== 'temporal') __gsBoxAutomationRows.add(id);
    },'''),
        ('      if (!Array.isArray(n)) return false;\n      let o = false;',
         '''      const staleBoxAutomations = [];
      if (!Array.isArray(n)) return { addedTemporal: false, staleBoxAutomations };
      let o = false;'''),
        ("        if (l === 'temporal') { o ||= !requiredAgents.has(i); requiredAgents.add(i); }",
         '''        if (l === 'temporal') {
          if (!requiredAgents.has(i)) {
            o = true;
            if (__gsBoxAutomationRows.delete(i)) staleBoxAutomations.push(i);
          }
          requiredAgents.add(i);
        }'''),
        ('      return o;', '      return { addedTemporal: o, staleBoxAutomations };'),
    ]
    for before, after in substitutions:
        source = once(source, before, after)
    return RUNTIME_HEAD + source + '\n' + RUNTIME_END


def seed_wrapper():
    # Begin the ticket per attempt (including retries); a reset invalidates the
    # in-flight attempt before a newer ticket can ever install its response.
    return (
        'let __gsSeedController,__gsSeedTicket;'
        'async function J(){if(!__gsBoxRouting(t.processConfig.boxRoutingProfileDir))'
        'return __gsNativeSeed066();'
        '__gsSeedController??=__gsRosterSeed({'
        'read:()=>{__gsSeedTicket=w.begin();return q.dispatchCommand("listAgents",{},'
        '{demand:"background"})},'
        'install:G=>{b(G),y===void 0&&B({payload:{agents:G},snapshot:!0}),'
        'n.postEvent("agents-roster-seed",{agents:G,isNewestRoster:w.isNewest(__gsSeedTicket)})},'
        'report:G=>f.__gsStatus(G)});return __gsSeedController.request()}'
        + SEED_ANCHOR.replace('async function J()', 'async function __gsNativeSeed066()', 1)
    )


def wiring():
    return [
        ('let f=YB(),', 'let f=YB({dataDir:t.processConfig.boxRoutingProfileDir}),'),
        ('bootstrap:{processConfig:{appVersion:t,isPackaged:n,dataDir:s}}',
         'bootstrap:{processConfig:{appVersion:t,isPackaged:n,dataDir:s,'
         '...sr(r.processConfig.boxRoutingProfileDir)?'
         '{boxRoutingProfileDir:r.processConfig.boxRoutingProfileDir}:{}}}'),
        ('acceptsAgent:({agentId:_})=>f.harnessOf(_)!=="unsupported"',
         'acceptsAgent:({agentId:_})=>!f.__gsOwnsBox(_)&&f.harnessOf(_)!=="unsupported"'),
        ('l=!1,A=void 0,d.invalidateHealthCache()',
         'l=!1,__gsSeedController?.reset(),A=void 0,d.invalidateHealthCache()'),
        ('_t=!0,q.close(),be.stop()',
         '_t=!0,f.__gsStop(),__gsSeedController?.stop(),q.close(),be.stop()'),
        (SEED_ANCHOR, seed_wrapper()),
    ]


READ_ANCHOR = 'be.isActive({agentId:G.id})?It('
READ_PATCHED = '!f.__gsOwnsBox(G.id)&&' + READ_ANCHOR


def _validate_patched(source):
    for before, after in wiring():
        if source.count(after) != 1 or before in source:
            raise ValueError('incomplete 0.66 routing wiring: ' + before[:65])
    if source.count(READ_PATCHED) != 2 or source.count(READ_ANCHOR) != 2:
        raise ValueError('incomplete 0.66 transcript read guards')
    for marker in (RUNTIME_HEAD, RUNTIME_END, FACTORY_TAIL):
        if source.count(marker) != 1:
            raise ValueError('unknown 0.66 runtime region')
    begin, end = source.index(RUNTIME_HEAD), source.index(RUNTIME_END) + len(RUNTIME_END)
    tail = source.index(FACTORY_TAIL)
    if end <= begin or tail < end or source[end:tail].strip():
        raise ValueError('unknown 0.66 runtime boundary')
    return begin, end


def patch_coordinator(source):
    if ADAPTER_MARK in source:
        begin, end = _validate_patched(source)
        return source[:begin] + routing_runtime() + source[end:]
    if '__gsBoxRouting' in source:
        raise ValueError('unexpected previous routing adapter')
    if source.count(FACTORY_HEAD) != 1 or source.count(FACTORY_TAIL) != 1:
        raise ValueError('unknown 0.66 harness factory boundaries')
    begin, end = source.index(FACTORY_HEAD), source.index(FACTORY_TAIL)
    if end <= begin or hashlib.sha256(source[begin:end].encode()).hexdigest() != NATIVE_ROSTER_SHA256:
        raise ValueError('unknown 0.66 harness factory digest')
    out = source[:begin] + routing_runtime() + source[end:]
    for before, after in wiring():
        out = once(out, before, after)
    if out.count(READ_ANCHOR) != 2:
        raise ValueError('unknown 0.66 transcript read routing anchors')
    out = out.replace(READ_ANCHOR, READ_PATCHED)
    _validate_patched(out)
    return out


def patch_client_routing_profile(source):
    if source.count(MAIN_PATCHED) == 1 and MAIN_ANCHOR not in source:
        return source
    if 'boxRoutingProfileDir' in source:
        raise ValueError('ambiguous 0.66 routing profile bootstrap')
    return once(source, MAIN_ANCHOR, MAIN_PATCHED)
