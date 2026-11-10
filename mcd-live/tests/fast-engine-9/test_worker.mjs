/* The real model worker, run in a separate Node worker thread with a bridge
 * for the browser self/fetch interfaces. No main-thread model substitute. */
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {writeFileSync} from 'node:fs';
const base=new URL('../../mcd-worker.js',import.meta.url).href;
const bootstrap=`
const {parentPort}=require('node:worker_threads');const fs=require('node:fs/promises');
globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};
globalThis.fetch=async u=>{const url=new URL(u,${JSON.stringify(base)});url.search='';const b=await fs.readFile(url);return {ok:true,status:200,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}};
(async()=>{await import(${JSON.stringify(base)});parentPort.on('message',m=>self.onmessage({data:m}));parentPort.postMessage({loaded:true})})();`;
const w=new Worker(bootstrap,{eval:true});let id=0,pending=new Map();
await new Promise((r,j)=>{w.once('message',r);w.once('error',j)});
w.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);m.type==='error'?p.reject(new Error(m.message)):p.resolve(m)}});
const send=(type,data={},transfer=[])=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});w.postMessage({id:key,type,...data},transfer)});
let init=await send('init',{width:3,height:2,tuning:{v:45,a:36.7,late:180,scale:1}});assert.equal(init.version,9);
for(let i=0;i<240;i++){
 const frame=new Float32Array(6).fill(i%12<6?.3:.7),r=await send('step',{frame:frame.buffer,audio:i%12<6?.03:.2,dt:1/30},[frame.buffer]);
 assert.equal(r.steps,i);assert.equal(r.primed,i===0);assert.ok(r.traces.every(Number.isFinite));assert.ok(new Float32Array(r.corr).every(x=>x>=0));
}
// Simulated loop boundaries are intentionally absent from the worker API.
// Continuing samples must never reset steps or prime the filters.
const f=new Float32Array(6).fill(.1);let r=await send('step',{frame:f.buffer,audio:.03,dt:.35},[f.buffer]);assert.equal(r.steps,240);assert.equal(r.primed,false);
const fcut=new Float32Array(6).fill(.85);r=await send('step',{frame:fcut.buffer,audio:.2,dt:1/30,cut:true},[fcut.buffer]);
assert.equal(r.cut,true);assert.ok(r.traces[0]>.01);assert.equal(r.traces[2],0);assert.equal(r.traces[4],0);assert.equal(r.traces[5],0);assert.ok(r.traces[3]>0);
await send('params',{tuning:{v:1,a:200,late:800,scale:.25},reset:true});
const f2=new Float32Array(6).fill(.1);r=await send('step',{frame:f2.buffer,audio:.03,dt:1/30},[f2.buffer]);assert.equal(r.steps,0);assert.equal(r.primed,true);
await w.terminate();const result={status:'PASS',native_worker_thread:true,continuous_updates:240,loop_state_preserved:true,parameter_reset:true};
writeFileSync(new URL('worker_validation_report.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
