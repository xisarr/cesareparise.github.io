/* Pure input/display helpers. The scientific MCD remains compiled C/WASM. */
export const DEFAULTS = Object.freeze({v:45, a:36.7, late:180, scale:1});
export const VERSION = 'fast-engine-9';
export const MAX_PIXELS = 2073600; // Allows true 1x processing up to 1920×1080; never silently rescale.
export const clamp = (x,lo=0,hi=1)=>Math.min(hi,Math.max(lo,x));

/* Delta = imposed visual delay - imposed auditory delay.
 * Negative -> vision leads (delay audio); positive -> audio leads (delay video). */
export function delaySeconds(ms) {
  const delta=clamp(Number(ms)||0,-600,600)/1000;
  return {video:Math.max(0,delta), audio:Math.max(0,-delta)};
}

/* Keep the entire source frame. Only spatial downsampling changes the lattice. */
export function geometry(vw,vh,downsample=8,maxPixels=MAX_PIXELS) {
  if(!(vw>0&&vh>0))throw new Error('Video dimensions are not available.');
  const factor=Math.max(1,Number(downsample)||1);
  const w=Math.max(1,Math.round(vw/factor));
  const h=Math.max(1,Math.round(vh/factor));
  return {vw,vh,w,h,downsample:factor,capped:false,tooLarge:w*h>maxPixels,aspect:vw/vh};
}

/* Display-only moving average of two successive frame differences.
 * Never average image intensities before they enter the MCD. */
export function averageVisualChanges(current,previous) {
  if(!Number.isFinite(current))return Number.NaN;
  if(previous===undefined||previous===null)return current;
  return Number.isFinite(previous)?(current+previous)/2:Number.NaN;
}

/* Defaults are specific to the input mode; choices persist until page reload. */
export function defaultDisplaySettings(mode) {
  return {corrScale:'db',lagScale:'db',corrGain:mode==='movie'?-20:0,lagGain:-40};
}
export function greyPixels(rgba) {
  const out=new Float32Array(rgba.length/4);
  for(let i=0,j=0;i<out.length;i++,j+=4)
    out[i]=(0.2126*rgba[j]+0.7152*rgba[j+1]+0.0722*rgba[j+2])/255;
  return out;
}
/* 16-bit packed luminance reduces the AV-delay buffer by half relative to
 * float32; quantisation error is <= 1/65535 and conversion to float takes
 * place only when a processed frame is submitted to the compiled MCD. */
export function greyPixels16(rgba) {
  const out=new Uint16Array(rgba.length/4);
  for(let i=0,j=0;i<out.length;i++,j+=4)
    out[i]=Math.round((.2126*rgba[j]+.7152*rgba[j+1]+.0722*rgba[j+2])*257);
  return out;
}
/* Editing-cut heuristic. Evaluated on a small full-frame thumbnail. Spatial structure and an adaptive motion baseline let
 * moderate edits pass without the old 50%-of-pixels / 0.17-MAD restriction.
 * This is an editable input-preprocessing heuristic, not part of the MCD.
 * Uniform flashes are deliberately protected; no detector is infallible. */
export function detectSceneCut(previous,current,{maxSamples=6144,sensitivity=50,baseline=.004}={}) {
  const empty={cut:false,meanChange:0,changedFraction:0,oppositeFraction:0,structureChange:0,correlation:1,histogramChange:0,threshold:0};
  if(!previous||!current||previous.length!==current.length||!current.length)return empty;
  const norm=previous instanceof Uint16Array||current instanceof Uint16Array?65535:1;
  const step=Math.max(1,Math.ceil(current.length/maxSamples));
  const k=2**((50-clamp(sensitivity,0,100))/60);
  let n=0,absSum=0,sumDelta=0,changed=0,pos=0,neg=0,sx=0,sy=0,sxx=0,syy=0,sxy=0;
  const h0=new Float64Array(32),h1=new Float64Array(32),deltas=[];
  for(let i=0;i<current.length;i+=step){
    const x=previous[i]/norm,y=current[i]/norm,d=y-x,mag=Math.abs(d);
    // Static black/white letterboxing must not dilute a scene transition.
    if(mag<.005&&((x<.015&&y<.015)||(x>.985&&y>.985)))continue;
    n++;absSum+=mag;sumDelta+=d;deltas.push(d);
    sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
    h0[Math.min(31,Math.floor(x*32))]++;h1[Math.min(31,Math.floor(y*32))]++;
    if(mag>.035*k){changed++;if(d>0)pos++;else neg++;}
  }
  if(n<8)return empty;
  const meanChange=absSum/n,meanDelta=sumDelta/n;
  const structureChange=deltas.reduce((sum,d)=>sum+Math.abs(d-meanDelta),0)/n;
  const vx=Math.max(0,sxx/n-(sx/n)**2),vy=Math.max(0,syy/n-(sy/n)**2);
  const covariance=sxy/n-sx*sy/n/n;
  const correlation=vx>1e-7&&vy>1e-7?clamp(covariance/Math.sqrt(vx*vy),-1,1):1;
  let histogramChange=0;for(let i=0;i<32;i++)histogramChange+=Math.abs(h0[i]-h1[i]);histogramChange/=2*n;
  const changedFraction=changed/n,oppositeFraction=changed?Math.min(pos,neg)/changed:0;
  const threshold=Math.max(.028*k,Math.max(0,baseline)*4.5*k+.008*k);
  const structural=structureChange>.018*k&&(correlation<.92||histogramChange>.55);
  const widespread=changedFraction>=.22&&changed/Math.ceil(current.length/step)>=.12;
  const abrupt=meanChange>threshold;
  const veryLarge=meanChange>.17*k&&changedFraction>.45;
  const cut=structural&&widespread&&(abrupt||veryLarge);
  return {cut,meanChange,changedFraction,oppositeFraction,structureChange,correlation,histogramChange,threshold};
}
export class SceneCutDetector {
  constructor(){this.reset();}
  reset(){this.previous=null;this.motion=[];this.last=null;}
  inspect(current,{sensitivity=50,forced=false}={}){
    const sorted=[...this.motion].sort((a,b)=>a-b);
    const baseline=sorted.length?sorted[Math.floor(sorted.length/2)]:.004;
    const result=detectSceneCut(this.previous,current,{sensitivity,baseline});
    if(forced&&this.previous){result.cut=true;result.forced=true;}
    if(!result.cut&&this.previous){this.motion.push(result.meanChange);if(this.motion.length>30)this.motion.shift();}
    if(result.cut)this.motion=[];
    this.previous=current;this.last=result;return result;
  }
}
/* Missing data is kept out of the polyline AND its scale estimate. */
export function visualTraceSample(rawChange,{suppression=false,crossedCut=false,inCutWindow=false}={}){
  return suppression&&(crossedCut||inCutWindow)?Number.NaN:rawChange;
}
export function meanAbsoluteDifference(a,b) {
  if(!a||!b||a.length!==b.length) return 0;
  let s=0;for(let i=0;i<a.length;i++)s+=Math.abs(a[i]-b[i]);
  return s/a.length;
}
export class FrameHistory {
  constructor(seconds=1.0){this.seconds=seconds;this.items=[];}
  clear(){this.items.length=0;}
  push(item){
    if(this.items.length&&item.t<=this.items[this.items.length-1].t)return;
    this.items.push(item);
    while(this.items.length>2&&this.items[1].t<item.t-this.seconds)this.items.shift();
  }
  at(t){
    let lo=0,hi=this.items.length-1,best=-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(this.items[m].t<=t+1e-7){best=m;lo=m+1;}else hi=m-1;}
    return best<0?null:this.items[best];
  }
  latest(){return this.items[this.items.length-1]||null;}
}
/* Timestamped mono power packets from AudioWorklet. Each packet is ~5 ms.
 * Partial overlap uses constant power within a packet, never the last value
 * of an entire video frame. Packet coverage is reported, not hidden. */
export class AudioHistory {
  constructor(seconds=3){this.seconds=seconds;this.items=[];}
  clear(){this.items.length=0;}
  push(start,end,rms,peak=0){
    if(!(end>start)||!Number.isFinite(rms))return;
    this.items.push({start,end,power:rms*rms,peak});
    while(this.items.length>2&&this.items[0].end<end-this.seconds)this.items.shift();
  }
  measure(start,end){
    if(!(end>start))return {rms:0,coverage:0,peak:0};
    let energy=0,covered=0,peak=0;
    for(let i=this.items.length-1;i>=0;i--){
      const p=this.items[i];if(p.end<=start)break;if(p.start>=end)continue;
      const n=Math.max(0,Math.min(end,p.end)-Math.max(start,p.start));
      energy+=n*p.power;covered+=n;peak=Math.max(peak,p.peak);
    }
    return {rms:Math.sqrt(Math.max(0,energy/(end-start))),coverage:Math.min(1,covered/(end-start)),peak};
  }
}
/* Arithmetic mean of channels BEFORE squaring: this is true mono downmix,
 * not an average of independent-channel powers. Prefix energy uses ~1ms bins. */
export function buildMonoEnvelope(channels,sampleRate){
  if(!channels.length||!channels[0].length||!(sampleRate>0))throw new Error('No decoded audio samples.');
  const n=channels[0].length,k=channels.length;
  const block=Math.max(1,Math.round(sampleRate/1000));
  const bins=Math.ceil(n/block),prefix=new Float64Array(bins+1);
  let peak=0;
  for(let b=0;b<bins;b++){
    let energy=0;
    const end=Math.min(n,(b+1)*block);
    for(let i=b*block;i<end;i++){
      let mono=0;for(let c=0;c<k;c++)mono+=channels[c][i]||0;
      mono/=k;energy+=mono*mono;peak=Math.max(peak,Math.abs(mono));
    }
    prefix[b+1]=prefix[b]+energy/sampleRate;
  }
  return {prefix,sampleRate,block,length:n,duration:n/sampleRate,channels:k,peak};
}
export function movieRms(envelope,start,end,period,loop=true){
  if(!(end>start))return 0;
  const {prefix,sampleRate,block,length,duration}=envelope;
  function single(t){
    t=clamp(t,0,duration);
    const sample=t*sampleRate,b=Math.min(prefix.length-2,Math.floor(sample/block));
    if(t>=duration)return prefix[prefix.length-1];
    const denom=Math.min(block,length-b*block);
    return prefix[b]+(prefix[b+1]-prefix[b])*clamp((sample-b*block)/denom);
  }
  function cumulative(t){
    if(!loop)return single(t);
    const p=period>0?period:duration;
    const rounds=Math.floor(t/p),r=t-rounds*p;
    return rounds*single(p)+single(r);
  }
  return Math.sqrt(Math.max(0,(cumulative(end)-cumulative(start))/(end-start)));
}
/* These are display transforms only, not physical sound-pressure decibels. */
export function responseStrength(x,ref,gainDb,mode){
  const q=Math.max(0,x)*Math.pow(10,gainDb/20)/ref;
  return mode==='linear'?clamp(q/70):clamp(20*Math.log10(1+q)/60);
}
