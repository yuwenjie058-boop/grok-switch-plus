const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createController,createPolicy}=require('./local-cron.cjs');
function setup(t, overrides={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'local-cron-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config={agentIds:['box-a'],activatedAt:60000};
 const a={id:'job',isEnabled:true,createdAt:1,lastRunAt:null,trigger:{type:'cron',schedule:'* * * * *'}};
 let now=120010; const calls=[];
 const deps={config,stateDir:dir,now:()=>now,isReady:async()=>true,isBoxHosted:()=>true,list:async()=>[{agentId:'box-a',automation:a}],next:(a)=>Math.floor((a.lastRunAt??a.createdAt)/60000)*60000+60000,fire:async(x)=>{calls.push(x);return 'ok'},log:()=>{},...overrides};
 return {c:createController(deps),deps,a,calls,dir,setNow:n=>now=n};
}
test('due slot starts immediately via native scheduled execution',async t=>{const x=setup(t);await x.c.tick();assert.equal(x.calls.length,1);assert.equal(x.calls[0].scheduledForMs,120000);assert.equal(x.calls[0].runAsSubagent,false)});
test('same slot is not repeated by concurrent ticks or another process/controller',async t=>{const x=setup(t);await Promise.all([x.c.tick(),x.c.tick()]);await createController(x.deps).tick();assert.equal(x.calls.length,1)});
test('paused task and non-Box identity never execute',async t=>{const x=setup(t);x.a.isEnabled=false;await x.c.tick();x.a.isEnabled=true;x.deps.isBoxHosted=()=>false;await x.c.tick();assert.equal(x.calls.length,0)});
test('unmanaged agents and mixed/event triggers keep native cloud authority',t=>{const p=createPolicy({agentIds:['box-a'],activatedAt:1});assert.equal(p('other',{trigger:{type:'cron'}}),false);assert.equal(p('box-a',{trigger:{type:'slack'}}),false);assert.equal(p('box-a',{trigger:{type:'cron'}}),true)});
test('activation does not backfill previous slots',async t=>{const x=setup(t,{config:{agentIds:['box-a'],activatedAt:120001}});await x.c.tick();assert.equal(x.calls.length,0)});
test('native lastRunAt suppresses a slot already covered',async t=>{const x=setup(t);x.a.lastRunAt=120000;await x.c.tick();assert.equal(x.calls.length,0)});
test('future slot is not fired early',async t=>{const x=setup(t);x.setNow(119999);x.a.lastRunAt=60000;await x.c.tick();assert.equal(x.calls.length,0)});
test('uncertain failure is recorded and never automatically retried',async t=>{let count=0;const x=setup(t,{fire:async()=>{count++;throw Error('unknown delivery')}});await x.c.tick();await createController(x.deps).tick();assert.equal(count,1);const r=JSON.parse(fs.readFileSync(path.join(x.dir,fs.readdirSync(x.dir)[0])));assert.equal(r.status,'uncertain')});
test('durable claim failure prevents dispatch',async t=>{const x=setup(t);fs.rmdirSync(x.dir);fs.writeFileSync(x.dir,'not a directory');await assert.rejects(x.c.tick());assert.equal(x.calls.length,0)});
test('long-running job does not block unrelated due jobs',async t=>{let release;const blocked=new Promise(r=>release=r);const x=setup(t,{fire:async arg=>{x.calls.push(arg);if(arg.automation.id==='job')await blocked;return 'ok'}});x.deps.list=async()=>[{agentId:'box-a',automation:x.a},{agentId:'box-a',automation:{...x.a,id:'second'}}];const pending=x.c.tick();await new Promise(r=>setImmediate(r));assert.equal(x.calls.length,2);release();await pending});
test('suspend stops wakes until resumed',async t=>{const x=setup(t);x.c.suspend();await x.c.tick();assert.equal(x.calls.length,0);x.c.resume();await x.c.tick();assert.equal(x.calls.length,1)});
test('invalid outcome is not reported as successful',async t=>{const x=setup(t,{fire:async()=>undefined});await x.c.tick();const r=JSON.parse(fs.readFileSync(path.join(x.dir,fs.readdirSync(x.dir)[0])));assert.equal(r.status,'not_executed')});

test('a slow previous slot cannot block a different job at the next minute',async t=>{let release;const blocked=new Promise(r=>release=r);const x=setup(t,{fire:async arg=>{x.calls.push(arg);if(arg.automation.id==='job')await blocked;return 'ok'}});const first=x.c.tick();await new Promise(r=>setImmediate(r));x.setNow(180010);x.deps.list=async()=>[{agentId:'box-a',automation:{...x.a,id:'new-minute'}}];await x.c.tick();assert.equal(x.calls.length,2);release();await first});
