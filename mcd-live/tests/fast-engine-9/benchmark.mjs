/* Usage: node benchmark.mjs /path/to/previous/mcd.wasm
 * Engine-only same-run comparison; no media capture or rendering. */
import fs from 'node:fs';import os from 'node:os';import {performance} from 'node:perf_hooks';
const previous=process.argv[2];
if(!previous){console.error('Supply the previous mcd.wasm from your backup.');process.exit(1);}
const modes=[['previous RK4',previous],['new SIMD',new URL('../../mcd.wasm',import.meta.url)],['new scalar',new URL('../../mcd-scalar.wasm',import.meta.url)]];
const rows=[];
for(const [name,path] of modes){
 const {instance:{exports:e}}=await WebAssembly.instantiate(fs.readFileSync(path),{});
 for(const [w,h] of [[160,90],[320,180],[640,360]])for(const dt of [1/30,1/16.6,.24]){
  if(!e.mcd_init(w,h))throw Error('init failed');
  const input=new Float32Array(e.memory.buffer,e.mcd_input_ptr(),w*h);input.fill(.25);e.mcd_prime(.01);const times=[];
  for(let k=0;k<16;k++){
   for(let i=0;i<input.length;i++)input[i]=.2+.3*Math.sin(i*.01+k*.2)**2;
   const t=performance.now();if(!e.mcd_step(.03+.01*Math.sin(k*.3),dt))throw Error('update failed');times.push(performance.now()-t);
  }
  const a=times.slice(4).sort((a,b)=>a-b),median=(a[5]+a[6])/2;
  const r={engine:name,width:w,height:h,dt,median_ms:median,min_ms:a[0],max_ms:a.at(-1),quadrature_nodes:e.mcd_quadrature_nodes?.()??null};rows.push(r);console.log(JSON.stringify(r));
 }
}
fs.writeFileSync(new URL('local-benchmark-report.json',import.meta.url),JSON.stringify({runtime:process.version,cpu:os.cpus()[0].model,method:'same process, 16 steps, first 4 discarded; engine only',rows},null,2));
