/* Serial model worker. SIMD state transitions with a numerical-identical
 * scalar fallback. No RK substep loop and no dt-dependent work queue. */
let ex=null,width=0,height=0,input,corr,lag,trace,needsPrime=true,engine='';
let tuning={v:45,a:36.7,late:180,scale:1};
function views(){const b=ex.memory.buffer,n=width*height;input=new Float32Array(b,ex.mcd_input_ptr(),n);corr=new Float32Array(b,ex.mcd_corr_ptr(),n);lag=new Float32Array(b,ex.mcd_lag_ptr(),n);trace=new Float32Array(b,ex.mcd_trace_ptr(),6);}
function parameters(p){const t={...tuning,...p};if(!ex.mcd_set_tuning(t.v/1000,t.a/1000,t.late/1000,t.scale))throw new Error('Invalid temporal constants.');tuning=t;}
async function loadEngine(){
  let firstError;
  for(const name of ['mcd.wasm','mcd-scalar.wasm']){
    try{
      const r=await fetch(`./${name}?v=fast-engine-9`);if(!r.ok)throw new Error(`Could not load ${name} (${r.status}).`);
      const candidate=(await WebAssembly.instantiate(await r.arrayBuffer(),{})).instance.exports;
      if(candidate.mcd_version()!==9)throw new Error('Old compiled model. Copy both new .wasm files, then reload.');
      ex=candidate;engine=ex.mcd_simd()?'SIMD state-transition':'scalar state-transition';return;
    }catch(e){firstError=firstError||e;}
  }
  throw firstError||new Error('Could not load the compiled model.');
}
async function handle(m){
  if(m.type==='init'){
    if(!ex)await loadEngine();width=m.width;height=m.height;
    if(!Number.isInteger(width)||!Number.isInteger(height)||!ex.mcd_init(width,height))throw new Error('Processing image is too large.');
    views();parameters(m.tuning);needsPrime=true;return {type:'ready',version:9,engine,width,height};
  }
  if(!ex)throw new Error('Model has not loaded.');
  if(m.type==='params'){parameters(m.tuning);if(m.reset){ex.mcd_reset();needsPrime=true;}return {type:'parameters'};}
  if(m.type==='reset'){ex.mcd_reset();needsPrime=true;return {type:'resetDone'};}
  if(m.type==='step'){
    const t0=performance.now(),a=Number(m.audio),dt=Number(m.dt),frame=new Float32Array(m.frame),cut=!!m.cut,resynced=!!m.resync;
    if(frame.length!==input.length||!Number.isFinite(a)||a<0||!Number.isFinite(dt)||!(dt>0)||(!resynced&&dt>5))throw new Error('Invalid frame, sound envelope or time step.');
    input.set(frame);const primed=needsPrime||resynced;
    if(primed){if(!ex.mcd_prime(a))throw new Error('Invalid model input.');needsPrime=false;}
    else if(!(cut?ex.mcd_step_cut(a,dt):ex.mcd_step(a,dt)))throw new Error('State-transition update failed.');
    return {type:'frame',engine,corr:new Float32Array(corr),lag:new Float32Array(lag),traces:Array.from(trace),computeMs:performance.now()-t0,steps:ex.mcd_steps(),quadratureNodes:ex.mcd_quadrature_nodes(),primed,resynced,cut:cut&&!primed};
  }
  throw new Error('Unknown worker message.');
}
let chain=Promise.resolve();
self.onmessage=({data:m})=>{
 chain=chain.then(async()=>{try{const r=await handle(m),transfer=[];if(r.corr){transfer.push(r.corr.buffer,r.lag.buffer);r.corr=r.corr.buffer;r.lag=r.lag.buffer;}self.postMessage({id:m.id,...r},transfer);}catch(e){self.postMessage({id:m.id,type:'error',message:String(e.message||e)});}});
};
