"use strict";
// Single scheduling authority for explicitly opted-in Box cron tasks.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT='/home/box/agent-data/grok-switch-local-cron';
function createPolicy(config) {
 if(!Array.isArray(config.agentIds)||config.agentIds.some(x=>typeof x!=='string')||!Number.isFinite(config.activatedAt))throw Error('Invalid local cron configuration');
 const ids=new Set(config.agentIds);
 return (agentId,automation)=>ids.has(agentId)&&automation?.trigger?.type==='cron';
}
function writeAtomic(file,value) {
 const temp=file+'.'+process.pid+'.tmp';
 const fd=fs.openSync(temp,'w',0o600);
 try {fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
 fs.renameSync(temp,file);
}
function createController(deps) {
 const managed=createPolicy(deps.config),clock=deps.now||Date.now;
 let ticking=false,suspended=false,timer;
 const running=new Set();
 function claim(agentId,automation,slot) {
  const hash=crypto.createHash('sha256').update(JSON.stringify([agentId,automation.id,slot])).digest('hex');
  const runUuid=hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32);
  fs.mkdirSync(deps.stateDir,{recursive:true,mode:0o700});
  const file=path.join(deps.stateDir,hash+'.json');let fd;
  try {fd=fs.openSync(file,'wx',0o600)} catch(e) {if(e.code==='EEXIST')return null;throw e}
  const receipt={agentId,automationId:automation.id,scheduledForMs:slot,runUuid,claimedAt:clock(),status:'claimed'};
  try {fs.writeFileSync(fd,JSON.stringify(receipt));fs.fsyncSync(fd)} finally {fs.closeSync(fd)}
  return {file,receipt};
 }
 async function dispatch(agentId,automation,slot) {
  const claimed=claim(agentId,automation,slot);if(!claimed)return;
  const {file,receipt}=claimed;
  deps.log?.('[local-cron] dispatch '+JSON.stringify(receipt));
  try {
   const result=await deps.fire({agentId,automation,runUuid:receipt.runUuid,scheduledForMs:slot,runAsSubagent:false});
   receipt.status=result==='ok'?'ok':result==='error'?'error':result==='interrupted'?'interrupted':'not_executed';
  } catch(e) {receipt.status='uncertain';receipt.errorType=e?.constructor?.name||'Error'}
  receipt.finishedAt=clock();writeAtomic(file,receipt);
  deps.log?.('[local-cron] outcome '+JSON.stringify(receipt));
 }
 async function tick() {
  if(ticking||suspended)return;ticking=true;const pending=[];
  try {
   if(!await deps.isReady())return;
   const now=clock();
   for(const {agentId,automation} of await deps.list()) {
    if(suspended)break;
    if(!managed(agentId,automation)||!automation.isEnabled||!deps.isBoxHosted(agentId))continue;
    // Only the current one-minute window: no historical catch-up after outages.
    const anchor=Math.max(automation.lastRunAt??automation.createdAt,deps.config.activatedAt-1,now-60000);
    const slot=deps.next({...automation,lastRunAt:anchor});
    if(!Number.isFinite(slot)||slot>now||slot<deps.config.activatedAt||now-slot>=60000)continue;
    const key=agentId+':'+automation.id;if(running.has(key))continue;running.add(key);
    pending.push(dispatch(agentId,automation,slot).finally(()=>running.delete(key)));
   }
  } finally {ticking=false}
  await Promise.all(pending);
 }
 return {tick,suspend(){suspended=true},resume(){suspended=false},stop(){suspended=true;clearInterval(timer)},start(){
  if(timer)return;timer=setInterval(()=>{void tick().catch(e=>deps.log?.('[local-cron] tick failed '+(e?.code||e?.constructor?.name||'Error')))},10000);timer.unref?.();
 }};
}
let config={agentIds:[],activatedAt:0};
try {config=JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'))} catch(e) {if(e.code!=='ENOENT')throw e}
const managed=createPolicy(config);
function start(deps) {const c=createController({...deps,config,stateDir:path.join(ROOT,'receipts')});c.start();return c}
module.exports={createPolicy,createController,managed,start};
