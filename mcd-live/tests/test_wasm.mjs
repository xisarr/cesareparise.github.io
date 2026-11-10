/* Execute the shipped binary and compare it to independent SciPy ODE outputs. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const dir=path.dirname(fileURLToPath(import.meta.url));
const bytes=readFileSync(path.join(dir,'../mcd.wasm'));
const module=await WebAssembly.compile(bytes);
assert.equal(WebAssembly.Module.imports(module).length,0,'core must have no JavaScript numerical imports');
const e=(await WebAssembly.instantiate(module,{})).exports;
assert.equal(e.mcd_version(),7);assert.equal(e.mcd_init(1,1),1);
assert.deepEqual(Array.from(new Float64Array(e.memory.buffer,e.mcd_parameters_ptr(),4)),[.045,.0367,.18,.18]);
const input=new Float32Array(e.memory.buffer,e.mcd_input_ptr(),1);
const fixture=JSON.parse(readFileSync(path.join(dir,'ode_reference.json'),'utf8'));
const maxErrors=Array(12).fill(0);
for(const f of fixture.samples){
  assert.equal(e.mcd_set_tuning(...f.tuning),1);
  input[0]=f.video;assert.equal(e.mcd_step(f.audio,f.dt),1);
  const y=[...new Float64Array(e.memory.buffer,e.mcd_debug_ptr(),10),
    new Float32Array(e.memory.buffer,e.mcd_corr_ptr(),1)[0],
    new Float32Array(e.memory.buffer,e.mcd_lag_ptr(),1)[0]];
  y.forEach((v,i)=>{maxErrors[i]=Math.max(maxErrors[i],Math.abs(v-f.expected[i])/fixture.peaks[i]);});
}
assert.ok(Math.max(...maxErrors)<1e-4,'WASM mismatch with continuous ODE reference');
const benchmarks=[];
for(const [w,h,scale] of [[90,160,1],[180,320,1],[90,160,.25]]){
  e.mcd_init(w,h);e.mcd_set_tuning(.045,.0367,.18,scale);
  const I=new Float32Array(e.memory.buffer,e.mcd_input_ptr(),w*h);
  I.fill(.2);e.mcd_prime(.01);
  // Warm-up JIT (not a model startup delay).
  for(let k=0;k<5;k++)e.mcd_step(.01,1/30);
  const t0=performance.now(),frames=45;
  for(let k=0;k<frames;k++){
    I.fill(k%20<10?.8:.2);e.mcd_step(k%20<10?.08:.01,1/30);
  }
  benchmarks.push({width:w,height:h,timeScale:scale,frames,msPerFrame:(performance.now()-t0)/frames,stateBytes:e.mcd_state_bytes()});
}
const report={status:'PASS',wasmBytes:bytes.length,numericalImports:0,maxPeakNormalisedError:Math.max(...maxErrors),benchmarks,
  benchmarkScope:'Node WebAssembly runtime on this machine; model plus input fills only, not capture, copying to/from worker, rendering or real devices.'};
writeFileSync(path.join(dir,'wasm_validation_report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
