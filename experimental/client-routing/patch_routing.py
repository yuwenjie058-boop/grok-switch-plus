"""Fail-closed text transforms for the 0.57.1 coordinator and profile bootstrap.

Only short matching anchors and replacement logic are included. The operator must
supply their own client. No creation-preference transform is applied.
"""
from pathlib import Path

MARKER = "grok-switch-box-routing"
GUARD_MARK = "__gsBoxRouting"
ANCHOR = (
    'function Rb(){let t=new Map,e=new Set,r;return{requiredAgents:e,'
    'harnessOf:n=>t.get(n),noteRoster({agents:n}){if(!Array.isArray(n))return!1;let o=!1;'
    'for(let a of n){if(!G(a)||typeof a.id!="string")continue;let i=a.id,'
    'l=LD({raw:a.harness,previous:t.get(i)});t.set(i,l),'
    'l==="temporal"?(o||=!e.has(i),e.add(i)):e.delete(i)}return o},'
)
HELPER = (
    'var __gsBoxRoutingOn=void 0;'
    'function __gsBoxRouting(){return !1}'
)
PATCHED = (
    'function Rb(){let t=new Map,e=new Set,r,__gsBox=__gsBoxRouting()?new Set():null;'
    'return{requiredAgents:e,'
    'harnessOf:n=>__gsBox!==null&&__gsBox.has(n)?"box":t.get(n),'
    'noteRoster({agents:n}){if(!Array.isArray(n))return!1;let o=!1;for(let a of n){'
    'if(!G(a)||typeof a.id!="string")continue;let i=a.id,'
    'l=LD({raw:a.harness,previous:t.get(i)});'
    'if(__gsBox!==null){if(a.harness===void 0){__gsBox.add(i),l="box"}'
    'else if(l==="temporal"&&__gsBox.has(i)){l="box"}}'
    't.set(i,l),'
    'l==="temporal"?(o||=!e.has(i),e.add(i)):e.delete(i)}return o},'
)


def patch_roster_v1(source):
    """Return dist/node-agent-coordinator/main.cjs with box routing forced."""
    if GUARD_MARK in source:
        return source
    if source.count(ANCHOR) != 1 or source.count('function Rb(){') != 1:
        raise ValueError('unknown coordinator harness map; refusing patch')
    out = source.replace(ANCHOR, PATCHED, 1)
    out = out.replace('function Rb(){', HELPER + 'function Rb(){', 1)
    if GUARD_MARK not in out:
        raise ValueError('coordinator patch did not apply')
    return out


TRANSCRIPT_MARK = '__gsOwnsBox'

def patch_coordinator(source):
    out = patch_roster_v1(source)
    if TRANSCRIPT_MARK in out:
        return patch_restart_routing(out)
    replacements = [
        ('return{requiredAgents:e,harnessOf:n=>__gsBox!==null',
         'return{__gsOwnsBox:n=>__gsBox!==null&&__gsBox.has(n),requiredAgents:e,harnessOf:n=>__gsBox!==null'),
        ('gatewayTranscript({payload:n,legacyServerActive:o}){if(o)return null;if(!G(n))return n;',
         'gatewayTranscript({payload:n,legacyServerActive:o}){if(!G(n))return o?null:n;'),
        ('let i=a??r,l=[...t.values()].some(u=>u!=="box");',
         'let i=a??r;if(o&&!(__gsBox!==null&&__gsBox.has(i)))return null;let l=[...t.values()].some(u=>u!=="box");'),
        ('acceptsAgent:({agentId:E})=>f.harnessOf(E)!=="unsupported"',
         'acceptsAgent:({agentId:E})=>!f.__gsOwnsBox(E)&&f.harnessOf(E)!=="unsupported"'),
    ]
    for before, after in replacements:
        if out.count(before) != 1:
            raise ValueError('unknown transcript routing anchor: '+before[:75])
        out = out.replace(before, after, 1)
    before='ne.isActive({agentId:J.id})?Ue('
    if out.count(before) != 2:
        raise ValueError('unknown transcript read routing anchors')
    out=out.replace(before,'!f.__gsOwnsBox(J.id)&&ne.isActive({agentId:J.id})?Ue(')
    return patch_restart_routing(out)


RESTART_MARK = 'box-routing-v4'
SEED_ANCHOR = ('async function M(){try{let E=await V.dispatchCommand("listAgents",{});'
               'k(E),S===void 0&&I({payload:{agents:E},snapshot:!0}),'
               'n.postEvent("agents-roster-seed",{agents:E})}catch(E){'
               'process.stderr.write(`node-agent-coordinator: agents roster seed skipped: ${Ae(E)}\n`)}}')


def patch_restart_routing(source):
    """Persist confirmed ownership per profile; retry a failed gateway seed."""
    if RESTART_MARK in source:
        required = ['Rb({dataDir:r.processConfig.boxRoutingProfileDir})', '__gsRosterSeed(',
                    '__gsSeedController?.reset()', '__gsSeedController?.stop()', 'f.__gsStop()',
                    'acceptsAgent:({agentId:E})=>!f.__gsOwnsBox(E)&&f.harnessOf(E)!=="unsupported"',
                    'Xt=!0,f.__gsStop(),__gsSeedController?.stop(),V.close(),ne.stop()']
        if not all(x in source for x in required):
            raise ValueError('incomplete restart routing patch')
        if source.count('!f.__gsOwnsBox(J.id)&&ne.isActive({agentId:J.id})?Ue(') != 2:
            raise ValueError('incomplete transcript read routing patch')
        # A version marker alone does not prove that the entire embedded
        # runtime is current. Re-stage source updates made within this patch
        # release instead of preserving an earlier same-version snapshot.
        start_anchor, tail = 'function __gsRoutingDir(options = {}) {', 'var Fb=require("node:crypto");'
        if source.count(start_anchor) != 1 or source.count(tail) != 1:
            raise ValueError('unknown current routing runtime anchors')
        start, end = source.index(start_anchor), source.index(tail)
        if end <= start:
            raise ValueError('unknown current roster store region')
        runtime = Path(__file__).with_name('box-routing-store.cjs').read_text(encoding='utf8')
        runtime = runtime[runtime.index(start_anchor):]
        if source[start:end].strip() == runtime.strip():
            return source
        return source[:start] + runtime + '\n' + source[end:]
    if 'box-routing-v3' in source:
        start_anchor, tail = 'function __gsRoutingDir(options = {}) {', 'var Fb=require("node:crypto");'
        close = 'Xt=!0,__gsSeedController?.stop(),V.close(),ne.stop()'
        required = [start_anchor, tail, close, 'Rb({dataDir:r.processConfig.boxRoutingProfileDir})',
                    'return __gsSeedController.request()', '__gsSeedController?.reset()']
        if any(source.count(anchor) != 1 for anchor in required):
            raise ValueError('unknown v3 restart routing upgrade anchors')
        start, end = source.index(start_anchor), source.index(tail)
        if end <= start:
            raise ValueError('unknown v3 roster store region')
        runtime = Path(__file__).with_name('box-routing-store.cjs').read_text(encoding='utf8')
        out = source[:start] + runtime + '\n' + source[end:]
        return out.replace(close, 'Xt=!0,f.__gsStop(),__gsSeedController?.stop(),V.close(),ne.stop()', 1)
    head, tail = 'var __gsBoxRoutingOn=void 0;', 'var Fb=require("node:crypto");'
    checks = [head, tail, 'let f=Rb(),', SEED_ANCHOR,
              'bootstrap:{processConfig:{appVersion:r,isPackaged:n,dataDir:o}}',
              'l=!1,_=void 0,c.invalidateHealthCache()',
              'Xt=!0,V.close(),ne.stop()']
    for anchor in checks:
        if source.count(anchor) != 1:
            raise ValueError('unknown restart routing anchor: ' + anchor[:80])
    start, end = source.index(head), source.index(tail)
    if end <= start or 'function Rb(){' not in source[start:end]:
        raise ValueError('unknown roster store region')
    runtime = Path(__file__).with_name('box-routing-store.cjs').read_text(encoding='utf8')
    out = source[:start] + runtime + '\n' + source[end:]
    out = out.replace('let f=Rb(),', 'let f=Rb({dataDir:r.processConfig.boxRoutingProfileDir}),', 1)
    out = out.replace('bootstrap:{processConfig:{appVersion:r,isPackaged:n,dataDir:o}}',
                      'bootstrap:{processConfig:{appVersion:r,isPackaged:n,dataDir:o,'
                      '...qt(t.processConfig.boxRoutingProfileDir)?'
                      '{boxRoutingProfileDir:t.processConfig.boxRoutingProfileDir}:{}}}', 1)
    # Keep the native seed implementation when the profile marker is disabled.
    seed = ('let __gsSeedController;'
            'async function M(){if(!__gsBoxRouting(r.processConfig.boxRoutingProfileDir))'
            'return __gsNativeSeed();'
            '__gsSeedController??=__gsRosterSeed({'
            'read:()=>V.dispatchCommand("listAgents",{}),'
            'install:E=>{k(E),S===void 0&&I({payload:{agents:E},snapshot:!0}),'
            'n.postEvent("agents-roster-seed",{agents:E})},report:E=>f.__gsStatus(E)});'
            'return __gsSeedController.request()}'
            + SEED_ANCHOR.replace('async function M()', 'async function __gsNativeSeed()', 1))
    out = out.replace(SEED_ANCHOR, seed, 1)
    out = out.replace('l=!1,_=void 0,c.invalidateHealthCache()',
                      'l=!1,__gsSeedController?.reset(),_=void 0,c.invalidateHealthCache()', 1)
    out = out.replace('Xt=!0,V.close(),ne.stop()',
                      'Xt=!0,f.__gsStop(),__gsSeedController?.stop(),V.close(),ne.stop()', 1)
    return out


def patch_client_routing_profile(source):
    """Pass Electron's exact profile path, not the separate sandbox data root."""
    anchor = ('processConfig:{appVersion:Ib().version,isPackaged:Ae.app.isPackaged,'
              'dataDir:(0,ca.getSandRootDir)()},artifactPath:Kxe()')
    patched = ('processConfig:{appVersion:Ib().version,isPackaged:Ae.app.isPackaged,'
               'dataDir:(0,ca.getSandRootDir)(),boxRoutingProfileDir:Ae.app.getPath("userData")},'
               'artifactPath:Kxe()')
    if source.count(patched) == 1 and anchor not in source:
        return source
    if patched in source:
        raise ValueError('ambiguous routing profile bootstrap')
    if source.count(anchor) != 1:
        raise ValueError('unknown routing profile bootstrap anchor')
    return source.replace(anchor, patched, 1)
