/* SIMD/scalar equivalence, exact dt use, long-gap resynchronisation policy,
 * palette identity and native worker fallback (no browser emulation). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Worker} from 'node:worker_threads';
import {chooseProcessingFrame} from '../../frame-scheduler.js';
import {CORRELATION_PALETTES,LAG_PALETTES,correlationLUT,lagLUTs} from '../../mcd-palettes.js';
const checks={};
const make=async name=>(await WebAssembly.instantiate(fs.readFileSync(new URL('../../'+name,import.meta.url)),{})).instance.exports;
const a=await make('mcd.wasm'),b=await make('mcd-scalar.wasm');
assert.equal(a.mcd_version(),9);assert.equal(a.mcd_simd(),1);assert.equal(b.mcd_simd(),0);
let worst=0,tests=0,rand=44;
const rng=()=>((rand=Math.imul(rand,1664525)+1013904223|0)>>>0)/4294967296;
for(const n of [1,2,3,7,64,513])for(const scale of [.25,1,4]){
 for(const e of [a,b]){e.mcd_init(n,1);e.mcd_set_tuning(.045,.0367,.18,scale);}
 const ia=new Float32Array(a.memory.buffer,a.mcd_input_ptr(),n),ib=new Float32Array(b.memory.buffer,b.mcd_input_ptr(),n);
 ia.fill(.3);ib.set(ia);a.mcd_prime(.02);b.mcd_prime(.02);
 for(let k=0;k<50;k++){
  for(let i=0;i<n;i++)ia[i]=.1+rng()*.8;ib.set(ia);
  const sound=.01+rng()*.2,dt=.014+rng()*.09;
  const fn=k===23?'mcd_step_cut':'mcd_step';a[fn](sound,dt);b[fn](sound,dt);
  for(const which of ['corr','lag','trace']){
   const length=which==='trace'?6:n;
   const x=new Float32Array(a.memory.buffer,a['mcd_'+which+'_ptr'](),length),y=new Float32Array(b.memory.buffer,b['mcd_'+which+'_ptr'](),length);
   for(let i=0;i<length;i++){assert.ok(Number.isFinite(x[i]));const err=Math.abs(x[i]-y[i])/Math.max(1e-20,Math.abs(x[i]),Math.abs(y[i]));worst=Math.max(worst,err);assert.ok(err<2e-5);}
  }tests++;
 }
}
checks.simd_scalar_even_odd_pixels={status:'PASS',updates:tests,max_relative_difference:worst};
const items=Array.from({length:50},(_,id)=>({id,t:id/30}));
assert.equal(chooseProcessingFrame(items,items[25],items[20],1/30).anchor.id,21);
assert.equal(chooseProcessingFrame(items,items[25],items[20],1/30).resync,false);
let q=chooseProcessingFrame(items,items[45],items[20],1/30);assert.equal(q.anchor.id,45);assert.equal(q.skipped,24);assert.ok(q.resync);
assert.equal(chooseProcessingFrame(items,items[20],items[20]),null);
assert.equal(chooseProcessingFrame(items,items[25],null).anchor.id,25);
q=chooseProcessingFrame([{id:60,t:20}],{id:60,t:20},{id:50,t:1},1/30);assert.ok(q.resync&&q.anchor.t===20);
checks.ordered_queue_and_explicit_overload='PASS';
assert.deepEqual(Object.keys(CORRELATION_PALETTES),['violet']);assert.deepEqual(Object.keys(LAG_PALETTES),['blue-orange']);
assert.deepEqual([...correlationLUT().slice(0,3)],[0,0,0]);for(const lut of Object.values(lagLUTs()))assert.deepEqual([...lut.slice(0,3)],[0,0,0]);
checks.fixed_palettes_black_zero='PASS';
// Real Node worker thread. Deliberately fail SIMD compilation on the first
// instantiate call, to exercise the scalar fallback without changing app code.
const base=new URL('../../mcd-worker.js',import.meta.url).href;
const bootstrap=`const {parentPort}=require('node:worker_threads');const fs=require('node:fs/promises');
globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};
globalThis.fetch=async u=>{const url=new URL(u,${JSON.stringify(base)});url.search='';const b=await fs.readFile(url);return {ok:true,status:200,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}};
const original=WebAssembly.instantiate;let first=true;WebAssembly.instantiate=async(...args)=>{if(first){first=false;throw new WebAssembly.CompileError('SIMD intentionally unsupported in this test');}return original(...args)};
(async()=>{await import(${JSON.stringify(base)});parentPort.on('message',m=>self.onmessage({data:m}));parentPort.postMessage({loaded:true})})();`;
const w=new Worker(bootstrap,{eval:true});await new Promise((res,rej)=>{w.once('message',res);w.once('error',rej)});
let id=0,pending=new Map();w.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.type==='error'?p.reject(Error(m.message)):p.resolve(m)}});
const send=(type,data={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});w.postMessage({id:key,type,...data})});
const init=await send('init',{width:3,height:1,tuning:{v:45,a:36.7,late:180,scale:1}});assert.equal(init.engine,'scalar state-transition');
await send('step',{frame:new Float32Array(3).fill(.2).buffer,audio:.02,dt:.06});
await send('step',{frame:new Float32Array(3).fill(.9).buffer,audio:.2,dt:.06});
const gap=await send('step',{frame:new Float32Array(3).fill(.4).buffer,audio:.03,dt:20,resync:true});
assert.ok(gap.resynced&&gap.primed);assert.deepEqual([...new Float32Array(gap.corr)],[0,0,0]);assert.equal(gap.steps,0);
const next=await send('step',{frame:new Float32Array(3).fill(.4).buffer,audio:.03,dt:.06});assert.ok(!next.resynced&&!next.primed&&next.steps===1);
assert.ok(Math.abs(next.traces[2])<1e-12);await w.terminate();
checks.native_worker_scalar_fallback_and_explicit_resync='PASS';
fs.writeFileSync(new URL('fast_runtime_report.json',import.meta.url),JSON.stringify({status:'PASS',checks},null,2));console.log(JSON.stringify({status:'PASS',checks},null,2));
