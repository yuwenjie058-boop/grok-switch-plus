import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {createWorld,baseConfig,textPart,objectPart} from './support/ctx-compact-harness.mjs';
const section=readFileSync(new URL('../src/ctx-compact.cjs',import.meta.url),'utf8');
for(const shape of ['text','object']) {
 for(const operation of ['writeFileSync','fsyncSync','renameSync']) {
  test(`${shape}: failed ${operation} preserves evidence and records no fold`,()=>{
   const w=createWorld(section,'storage-failure');
   try {
    w.setConfig(baseConfig());
    const real=w.api.grokSwitchFs();
    const shim=Object.create(real);
    shim[operation]=()=>{throw new Error('injected storage failure');};
    w.api.grokSwitchFs=()=>shim;
    const value=shape==='text'?'x'.repeat(100000):{stdout:'x'.repeat(100000)};
    const messages=[shape==='text'?textPart(value):objectPart(value)];
    const result=w.run(messages);
    assert.ok(JSON.stringify(result.messages)===JSON.stringify(messages),'original evidence preserved');
    assert.equal(result.stats.savedChars,0);
    assert.equal(result.stats.folded,0);
    assert.equal(result.stats.storageWriteFailed,1);
    assert.equal(w.ledgerExists(),false);
   }finally{w.cleanup();}
  });
 }
 test(`${shape}: truncated cache is replaced before successful folding`,()=>{
  const w=createWorld(section,'storage-repair');
  try {
   w.setConfig(baseConfig());
   const value=shape==='text'?'y'.repeat(100000):{stdout:'y'.repeat(100000)};
   const msg=[shape==='text'?textPart(value):objectPart(value)];
   const first=w.run(msg);
   const file=w.dir+'/ctx-cache/'+w.cacheFiles()[0].name;
   w.api.grokSwitchFs().writeFileSync(file,'truncated');
   const second=w.run(msg);
   assert.ok(JSON.stringify(second.messages)===JSON.stringify(first.messages),'frozen shape replayed');
   assert.ok(readFileSync(file,'utf8')===(shape==='text'?value:JSON.stringify(value)),'complete original restored');
  }finally{w.cleanup();}
 });
 test(`${shape}: lost original and failed recovery retire old folded ledger`,()=>{
  const w=createWorld(section,'storage-replay');
  try {
   w.setConfig(baseConfig());
   const value=shape==='text'?'z'.repeat(100000):{stdout:'z'.repeat(100000)};
   const msg=[shape==='text'?textPart(value):objectPart(value)];
   assert.equal(w.run(msg).stats.folded,1);
   const real=w.api.grokSwitchFs();
   real.unlinkSync(w.dir+'/ctx-cache/'+w.cacheFiles()[0].name);
   const shim=Object.create(real);
   shim.writeFileSync=(path,...args)=>{
    if(String(path).includes('ctx-cache')) throw new Error('cache volume unavailable');
    return real.writeFileSync(path,...args);
   };
   w.api.grokSwitchFs=()=>shim;
   const result=w.run(msg);
   assert.ok(JSON.stringify(result.messages)===JSON.stringify(msg),'no dangling marker');
   assert.equal(result.stats.storageWriteFailed,1);
   assert.equal(result.stats.savedChars,0);
   assert.ok(Object.values(w.ledger()).every(e=>e.shape==='full'));
  }finally{w.cleanup();}
 });
}
test('dry-run neither reads nor writes originals',()=>{
 const w=createWorld(section,'storage-dry');
 try {
  w.setConfig(baseConfig({mode:'dry-run'}));
  w.api.grokSwitchFs=()=>{throw new Error('unexpected filesystem access');};
  const result=w.run([objectPart({stdout:'d'.repeat(100000)})]);
  assert.equal(result.stats.savedChars,88000);
 }finally{w.cleanup();}
});
