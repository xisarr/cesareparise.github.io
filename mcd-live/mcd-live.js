import {USAGE_CONFIG} from './usage-config.js?v=chart-launch-13';
import {createUsageTracker,installPageViewBeacon} from './usage-analytics.js?v=usage-1';
const usage=createUsageTracker(USAGE_CONFIG);
try{installPageViewBeacon(USAGE_CONFIG);}catch{}
window.getMCDUsageDiagnostics=()=>usage.status();
import {DEFAULTS,VERSION,MAX_PIXELS,clamp,delaySeconds,geometry,greyPixels16,SceneCutDetector,meanAbsoluteDifference,visualTraceSample,averageVisualChanges,defaultDisplaySettings,FrameHistory,AudioHistory,movieRms,responseStrength} from './signal-utils.js?v=fast-engine-9';
import {correlationLUT,lagLUTs,gradientCSS,PALETTE_SIZE} from './mcd-palettes.js?v=fast-engine-9';
import {MovieAudioOutput,DelayedVideoPreview} from './playback-timing.js?v=playback-8';
import {listExampleMovies,isExampleMovieName,exampleMovieLabel,exampleMovieURL} from './example-movies.js?v=example-catalogue-14';
import {parseYouTubeURL,youtubeSupport,acquireYouTubeTab} from './youtube-input.js?v=youtube-capture-15';
import {YouTubePlayer} from './youtube-player.js?v=youtube-capture-15';
const INTERFACE_VERSION='youtube-capture-15';
import {chooseProcessingFrame} from './frame-scheduler.js?v=fast-engine-9';
const CUT_SENSITIVITY=50;
const $=id=>document.getElementById(id);

// UI only: reveal video-processing controls on demand. No timing/model changes.
const downsamplingDetails=$('downsamplingDetails');
const downsamplingSummary=$('downsamplingSummary');
const downsamplingOptions=$('downsamplingOptions');
const DOWNSAMPLING_HIDE_MS=3000;
let downsamplingCloseTimer=null,downsamplingCloseArmed=false;
let downsamplingDisclosureRevision=0,downsamplingChangeRevision=0;
let downsamplingSelectActive=false;
function cancelDownsamplingClose(){
  clearTimeout(downsamplingCloseTimer);downsamplingCloseTimer=null;
  downsamplingCloseArmed=false;
}
function postponeDownsamplingClose(){
  clearTimeout(downsamplingCloseTimer);downsamplingCloseTimer=null;
  if(!downsamplingCloseArmed||!downsamplingDetails.open||downsamplingSelectActive)return;
  downsamplingCloseTimer=setTimeout(()=>{
    downsamplingCloseTimer=null;
    if(!downsamplingCloseArmed||!downsamplingDetails.open||downsamplingSelectActive)return;
    downsamplingCloseArmed=false;
    // Keep keyboard focus on a visible control after an automatic collapse.
    if(downsamplingOptions.contains(document.activeElement))downsamplingSummary.focus({preventScroll:true});
    downsamplingDetails.open=false;
  },DOWNSAMPLING_HIDE_MS);
}
function armDownsamplingClose(){
  if(!downsamplingDetails.open)return;
  downsamplingCloseArmed=true;postponeDownsamplingClose();
}
function updateDownsamplingValue(){
  const factor=+$('downsample').value;
  $('downsamplingValue').textContent=factor===1?'1× · full resolution':`1/${factor}`;
}
// Reopening manually never inherits the timer from an earlier change.
downsamplingSummary.addEventListener('click',cancelDownsamplingClose);
downsamplingDetails.addEventListener('toggle',()=>{
  downsamplingDisclosureRevision++;
  cancelDownsamplingClose();
  if(!downsamplingDetails.open)downsamplingSelectActive=false;
});
// Do not collapse a native dropdown while the user is choosing an option.
$('downsample').addEventListener('pointerdown',()=>{
  downsamplingSelectActive=true;postponeDownsamplingClose();
});
$('downsample').addEventListener('keydown',event=>{
  if(['Enter',' ','ArrowDown','ArrowUp','Home','End','F4'].includes(event.key))downsamplingSelectActive=true;
  if(event.key==='Escape')downsamplingSelectActive=false;
  postponeDownsamplingClose();
});
$('downsample').addEventListener('change',()=>{downsamplingSelectActive=false;});
$('downsample').addEventListener('blur',()=>{downsamplingSelectActive=false;postponeDownsamplingClose();});
for(const eventName of ['pointerdown','keydown','input','change','focusin']){
  downsamplingOptions.addEventListener(eventName,postponeDownsamplingClose);
}
window.addEventListener('pagehide',cancelDownsamplingClose);
function cutsEnabled(){return $('suppressCuts').getAttribute('aria-pressed')==='true';}
function updateCutButton(){
  $('cutToggleState').textContent=cutsEnabled()?'On':'Off';
}
const sourceVideo=$('sourceVideo');
let video=sourceVideo;
const movieAudioOutput=new MovieAudioOutput(sourceVideo);
// A separate, video-only sink cannot enter the local movie's permanent audio
// output graph. It stays outside the player crop and never plays any sound.
const tabVideo=document.createElement('video');
tabVideo.muted=true;tabVideo.volume=0;tabVideo.playsInline=true;
tabVideo.setAttribute('aria-hidden','true');tabVideo.tabIndex=-1;
tabVideo.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
document.body.append(tabVideo);
let youtubeCapture=null,youtubeState=-1,youtubeSegmentReady=false,youtubeSegmentSerial=0,youtubeTimeSample=null,youtubeInterrupted=false;
const youtubePlayer=new YouTubePlayer($('youtubePlayer'),{
  onState:handleYouTubeState,
  onError:error=>{if(mode==='youtube'&&(running||starting))fail(error);else if(mode==='youtube')setYouTubeStatus(error.message,true);},
  onAutoplayBlocked:()=>{if(mode==='youtube')setYouTubeStatus('Tab sharing is ready. Press Play in the YouTube player; your browser blocked automatic playback.');}
});
const delayedPreview=new DelayedVideoPreview($('playbackCanvas'));
let movieTail=null;
const processCanvas=document.createElement('canvas');
const processContext=processCanvas.getContext('2d',{willReadFrequently:true});
const cutCanvas=document.createElement('canvas'),cutContext=cutCanvas.getContext('2d',{willReadFrequently:true});
const cutDetector=new SceneCutDetector();
let cutEvents=[],lastCutDetail=null,seekActive=false,seekResume=false,seekSerial=0,seekCommitTimer=null,seekResetPromise=null;
let moviePaused=false,pauseStarted=0,lastDisplayedMediaTime=0;

const frameHistory=new FrameHistory(1.2),audioHistory=new AudioHistory(3);
const TRACE_SECONDS=10,TRACE_CAPACITY=2400,LIVE_LOOKBACK=.05;
let g=geometry(640,360),worker=null,requestId=0,pending=new Map(),modelReady=false;
let phase='idle',running=false,starting=false,session=0,epoch=0,busy=false;
let frameCallback=null,frameCallbackIsTimer=false,raf=null,stream=null,audioContext=null,audioSource=null,audioNode=null,audioAnalyser=null,muteNode=null;
let analyserBuffer=null,audioTrack=null,lastAudioPacket=0,lastFallback=0,audioClockOffset=0;
let mode='live',movie=null,movieLoading=false,fileGeneration=0;
let exampleDownloadController=null;
function cancelExampleDownload(){
  if(exampleDownloadController){exampleDownloadController.abort();exampleDownloadController=null;}
}
let sourceFirstT=null,lastMediaT=null,loopCount=0,lastAnchor=null,sessionStart=0;
let samplePeriod=1/30,actualVideoLag=0,audioCoverage=1,lastRms=0,sourceDimensions='';
let corrValues=null,lagValues=null,corrImage=null,lagImage=null;
let traceData=[],traceStart=null,loopMarks=[],tracePeaks=[.02,.03,.001,.001,1e-12,1e-6];
let lastTracePaint=0,lastInfoPaint=0,lastStateSteps=0,resetCount=0;
let parameterTimer=null,geometryTimer=null,configurationSerial=0;
let metrics;
let lastProcessedCutSerial=null,goodDownsample=8;
const displaySettings={live:defaultDisplaySettings('live'),movie:defaultDisplaySettings('movie'),youtube:defaultDisplaySettings('movie')};
function rememberDisplaySettings(){
  displaySettings[mode]={corrScale:$('scaleCorr').value,lagScale:$('scaleLag').value,
    corrGain:+$('gainCorr').value,lagGain:+$('gainLag').value};
}
function restoreDisplaySettings(){
  const p=displaySettings[mode];
  $('scaleCorr').value=p.corrScale;$('scaleLag').value=p.lagScale;
  $('gainCorr').value=p.corrGain;$('gainLag').value=p.lagGain;
}

const corrPalette=correlationLUT('violet'),lagPalette=lagLUTs('blue-orange');
// Create RGBA lookup words with native byte order; one write per output pixel.
function packedPalette(rgb){
  const words=new Uint32Array(PALETTE_SIZE),bytes=new Uint8Array(words.buffer);
  for(let i=0;i<PALETTE_SIZE;i++){bytes[4*i]=rgb[3*i];bytes[4*i+1]=rgb[3*i+1];bytes[4*i+2]=rgb[3*i+2];bytes[4*i+3]=255;}
  return words;
}
const corrWords=packedPalette(corrPalette),visionWords=packedPalette(lagPalette.negative),audioWords=packedPalette(lagPalette.positive);
let mapsDirty=false,lastMapPaint=0,engineName='',queueBacklog=0;
function updatePalettes(){
  document.querySelector('.correlation-bar').style.background=gradientCSS(corrPalette);
  document.querySelector('.lag-bar').style.background=gradientCSS(lagPalette.negative,lagPalette.positive);
  $('correlationCanvas').setAttribute('aria-label','Correlation map: black at zero, increasing violet with activity');
  $('lagCanvas').setAttribute('aria-label','Lag map: blue for vision lead, black at zero, orange for audio lead');
  if(corrValues)paintMaps();else clearMaps();
}
const refs=[1e-16,1e-10];
function freshMetrics(){return {captured:0,processed:0,skipped:0,warmup:0,callbackGaps:0,detectedCuts:0,suppressedCuts:0,resyncs:0,render:[],lastPresented:null,startWall:performance.now()/1000,compute:[],turnaround:[],sourceTimes:[],lastFrameWall:0,lastGap:0};}
metrics=freshMetrics();
function tuning(){return {v:+$('tauV').value,a:+$('tauA').value,late:+$('tauLate').value,scale:2**(+$('timeScale').value)};}
// Time constants in milliseconds, converted by the existing worker for C/WASM.
// Human values remain the startup defaults; rat values were supplied by the author.
const TEMPORAL_PRESETS=Object.freeze({
  human:Object.freeze({v:DEFAULTS.v,a:DEFAULTS.a,late:DEFAULTS.late}),
  rat:Object.freeze({v:10,a:10,late:138})
});
function activeTemporalPreset(p=tuning()){
  const close=(a,b)=>Math.abs(a-b)<1e-8;
  if(!close(p.scale,1))return null;
  for(const [name,preset] of Object.entries(TEMPORAL_PRESETS)){
    if(close(p.v,preset.v)&&close(p.a,preset.a)&&close(p.late,preset.late))return name;
  }
  return null;
}
function updateTemporalPresetButtons(p=tuning()){
  const active=activeTemporalPreset(p);
  $('resetTuning').setAttribute('aria-pressed',String(active==='human'));
  $('ratTuning').setAttribute('aria-pressed',String(active==='rat'));
}
function applyTemporalPreset(name){
  const preset=TEMPORAL_PRESETS[name];
  if(!preset)return;
  for(const [id,value] of [['tauV',preset.v],['tauA',preset.a],['tauLate',preset.late]]){
    $(id).value=String(value);
    $(id+'Number').value=String(value);
  }
  // A preset must load its actual constants, not inherit a previous scale factor.
  $('timeScale').value='0'; // logarithmic slider: 2**0 = 1×
  scheduleTuningChange(); // existing atomic parameter update and state/trace reset
}
function num(v){return Number(v.toFixed(3)).toString();}
function setStatus(text,kind='idle'){$('status').textContent=text;$('status').dataset.kind=kind;}
function runButton(){
  $('loadSynchronyChart').disabled=!modelReady||movieLoading||starting;
  $('exampleMovie').disabled=!modelReady||movieLoading||starting;
  const support=mode==='youtube'?youtubeSupport():null;
  $('loadYouTube').disabled=!modelReady||movieLoading||starting||running||!!(support&&!support.supported);
  $('youtubeURL').disabled=starting||running;
  const b=$('toggleRun');b.disabled=!(starting||running)&&(!modelReady||movieLoading||(mode==='movie'&&!movie)||(mode==='youtube'&&(!support.supported||!$('youtubeURL').value.trim())));
  b.hidden=mode==='youtube'&&!starting&&!running;
  b.dataset.running=String(running);b.setAttribute('aria-pressed',String(running));
  b.textContent=starting?'Cancel start':running?'Stop demo':mode==='movie'?'Start movie':mode==='youtube'?'Share tab & start':'Start live demo';
}
function callCore(type,data={},transfer=[]){
  const id=++requestId;
  return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...data},transfer);});
}
function makeWorker(){
  worker=new Worker(`./mcd-worker.js?v=${VERSION}`,{type:'module'});
  worker.onmessage=({data:m})=>{
    const p=pending.get(m.id);if(!p)return;pending.delete(m.id);
    if(m.type==='error')p.reject(new Error(m.message));else p.resolve(m);
  };
  worker.onerror=e=>{for(const p of pending.values())p.reject(new Error(e.message||'Model worker failed.'));pending.clear();modelReady=false;stop();setStatus('Could not run the compiled model. Reload this page.','error');};
}
async function initialiseCore(newG){
  usage.breakActivity();
  if(newG.tooLarge)throw new Error(`Full resolution would require ${newG.w*newG.h} detectors. Limit: ${MAX_PIXELS}. Increase spatial downsampling.`);
  const current=++configurationSerial;
  modelReady=false;epoch++;busy=false;runButton();
  g=newG;cutDetector.reset();cutEvents=[];lastCutDetail=null;
  const thumbnailScale=Math.min(1,96/Math.max(g.vw,g.vh));
  cutCanvas.width=Math.max(8,Math.round(g.vw*thumbnailScale));cutCanvas.height=Math.max(8,Math.round(g.vh*thumbnailScale));
  sourceDimensions=`${g.vw}x${g.vh}`;
  processCanvas.width=g.w;processCanvas.height=g.h;
  processContext.imageSmoothingEnabled=true;processContext.imageSmoothingQuality='high';
  for(const id of ['correlationCanvas','lagCanvas']){$(id).width=g.w;$(id).height=g.h;}
  corrImage=$('correlationCanvas').getContext('2d').createImageData(g.w,g.h);
  lagImage=$('lagCanvas').getContext('2d').createImageData(g.w,g.h);
  document.documentElement.style.setProperty('--source-ratio',`${g.vw}/${g.vh}`);
  document.documentElement.style.setProperty('--map-ratio',`${g.vw}/${g.vh}`);
  frameHistory.clear();delayedPreview.clear();lastAnchor=null;lastProcessedCutSerial=null;sourceFirstT=null;clearTraces();clearMaps();updateGeometryLabels();
  const engineInfo=await callCore('init',{width:g.w,height:g.h,tuning:tuning()});
  engineName=engineInfo.engine;
  if(current!==configurationSerial)return;
  modelReady=true;resetCount++;lastStateSteps=0;goodDownsample=+$('downsample').value;runButton();
  if(!running&&!starting&&!movieLoading)setStatus('Model ready');
}
function requestedGeometry(){return geometry(video.videoWidth||640,video.videoHeight||360,+$('downsample').value);}
function updateGeometryLabels(){
  updateDownsamplingValue();
  const area=mode==='youtube'?'player region':'full frame';
  $('sourceSize').textContent=`${g.vw} × ${g.vh} · ${area}`;
  $('resolution').textContent=`${g.w} × ${g.h}`;
  $('geometryReadout').textContent=`${g.vw} × ${g.vh} source → ${g.w} × ${g.h} processing pixels. ${mode==='youtube'?'Player region only.':'Full frame.'}`;
  $('resolutionWarning').hidden=g.w*g.h<=100000;
  $('resolutionWarning').textContent=g.w*g.h>100000?'High resolution may slow processing: use 1/2 or lower if frames are skipped.':'';
}
function updateControls(){
  const p=tuning();
  updateTemporalPresetButtons(p);
  $('readScale').textContent=`${num(p.scale)}×`;
  $('effectiveV').textContent=num(p.v*p.scale);$('effectiveA').textContent=num(p.a*p.scale);$('effectiveLate').textContent=num(p.late*p.scale);
  const d=+$('avDelay').value;
  $('readDelay').textContent=`${d>0?'+':''}${d} ms`;
  const target=mode==='movie'?'playback and model':'model inputs';
  $('delayLabel').textContent=mode==='youtube'?'YouTube model-input delay':'Imposed audiovisual delay';
  $('delayExplanation').textContent=d<0?`Audio delayed ${-d} ms in ${target}: vision leads.`:d>0?`Video delayed ${d} ms in ${target}: audio leads.`:`No added audiovisual delay in ${target}.`;
  if(mode==='youtube')$('delayExplanation').textContent+=' YouTube playback timing is unchanged.';
  for(const [id,out,scaleId] of [['gainCorr','gainCorrValue','scaleCorr'],['gainLag','gainLagValue','scaleLag']]){
    const db=+$(id).value,gain=10**(db/20);
    $(out).textContent=$(scaleId).value==='db'?`${db>0?'+':''}${db} dB`:`${gain<.001?gain.toExponential(2):Number(gain.toPrecision(4)).toLocaleString('en-GB',{maximumFractionDigits:6})}×`;
    $(id).setAttribute('aria-valuetext',$(out).textContent);
  }
  updateGeometryLabels();
  const shortest=Math.min(p.v,p.a,p.late)*p.scale;
  $('samplingWarning').hidden=shortest>=samplePeriod*1000/2;
  updateCutButton();
  $('samplingWarning').textContent=`Fastest filter: ${num(shortest)} ms; recent video interval: ${(samplePeriod*1000).toFixed(1)} ms. Shorter time constants increase computation but cannot restore unsampled video detail.`;
}
function clearMaps(){
  corrValues=lagValues=null;mapsDirty=false;
  for(const id of ['correlationCanvas','lagCanvas']){const c=$(id),ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);}
}
function setMirroring(){
  const m=mode==='live'&&$('mirror').checked;
  for(const id of ['sourceVideo','stillCanvas','playbackCanvas','correlationCanvas','lagCanvas'])$(id).style.transform=m?'scaleX(-1)':'none';
}
function paintMaps(){
  if(!corrValues||corrValues.length!==g.w*g.h)return;
  const t0=performance.now(),ck=10**(+$('gainCorr').value/20)/refs[0],lk=10**(+$('gainLag').value/20)/refs[1];
  const logC=$('scaleCorr').value==='db',logL=$('scaleLag').value==='db';
  const c32=new Uint32Array(corrImage.data.buffer),l32=new Uint32Array(lagImage.data.buffer),last=PALETTE_SIZE-1;
  const clamp01=x=>x>0?(x<1?x:1):0;
  for(let i=0;i<corrValues.length;i++){
    const cq=Math.max(0,corrValues[i])*ck,l=lagValues[i],lq=Math.abs(l)*lk;
    const cm=clamp01(logC?Math.log10(1+cq)/3:cq/70),lm=clamp01(logL?Math.log10(1+lq)/3:lq/70);
    c32[i]=corrWords[Math.round(cm*last)];l32[i]=(l<0?visionWords:audioWords)[Math.round(lm*last)];
  }
  $('correlationCanvas').getContext('2d').putImageData(corrImage,0,0);
  $('lagCanvas').getContext('2d').putImageData(lagImage,0,0);
  mapsDirty=false;lastMapPaint=performance.now();metrics.render.push(lastMapPaint-t0);if(metrics.render.length>120)metrics.render.shift();
}
function clearTraces(){traceData=[];traceStart=null;loopMarks=[];tracePeaks=[.02,.03,.001,.001,1e-12,1e-6];for(let i=0;i<6;i++)$('traceValue'+i).textContent='—';drawTraces();}
function canvasContext(canvas){
  const dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(1,canvas.clientWidth),h=Math.max(1,canvas.clientHeight);
  const W=Math.round(w*dpr),H=Math.round(h*dpr);
  if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return {ctx,w,h};
}
function drawTraces(){
  const last=traceData[traceData.length-1],end=Math.max(TRACE_SECONDS,last?.t||0),start=end-TRACE_SECONDS;
  const ticks=[];for(let t=Math.ceil(start/2)*2;t<=end+1e-8;t+=2)ticks.push(t);
  for(let i=0;i<6;i++){
    const {ctx,w,h}=canvasContext($('trace'+i));ctx.clearRect(0,0,w,h);ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    ctx.lineWidth=1;ctx.strokeStyle='#eceff4';
    for(const t of ticks){const x=(t-start)/TRACE_SECONDS*w;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for(const t of loopMarks){if(t<start||t>end)continue;const x=(t-start)/TRACE_SECONDS*w;ctx.save();ctx.setLineDash([3,3]);ctx.strokeStyle='#bfc7d1';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();ctx.restore();}
    const zero=i===5?h/2:h-5;ctx.strokeStyle='#cbd1da';ctx.beginPath();ctx.moveTo(0,zero);ctx.lineTo(w,zero);ctx.stroke();
    ctx.strokeStyle='#000';ctx.lineWidth=2.1;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();let began=false;
    for(const point of traceData){
      if(point.t<start)continue;
      const x=(point.t-start)/TRACE_SECONDS*w,v=point.v[i];
      // A suppressed editing cut is missing data, not a zero-valued change.
      // End the path here so the line does not connect across the gap.
      if(!Number.isFinite(v)){began=false;continue;}
      let y;
      if(i<4)y=h-5-clamp(v/Math.max(tracePeaks[i],1e-12))*(h-10);
      else {const q=responseStrength(Math.abs(v),refs[i-4],+(i===4?$('gainCorr'):$('gainLag')).value,$(i===4?'scaleCorr':'scaleLag').value);y=i===5?h/2-Math.sign(v)*q*(h/2-4):h-5-q*(h-10);}
      if(!began){ctx.moveTo(x,y);began=true;}else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  const {ctx,w,h}=canvasContext($('timeAxis'));ctx.clearRect(0,0,w,h);ctx.strokeStyle='#8b96a5';ctx.fillStyle='#566373';ctx.lineWidth=1;ctx.font='10px system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.beginPath();ctx.moveTo(0,2);ctx.lineTo(w,2);ctx.stroke();
  for(const t of ticks){const x=(t-start)/TRACE_SECONDS*w;ctx.beginPath();ctx.moveTo(x,2);ctx.lineTo(x,8);ctx.stroke();ctx.fillText(String(t),clamp(x,10,w-10),11);}
}
function addTraces(values,t,suppressedCut=false,sourceT=t,previousDifferenceT=sourceT,gapAll=false){
  if(traceStart===null)traceStart=t;
  // Keep NaN exclusively in the visual-change display trace when a cut is suppressed.
  // All model outputs remain untouched.
  const v=values.map((x,i)=>gapAll||i===0&&suppressedCut?Number.NaN:(Number.isFinite(x)?x:0));
  traceData.push({t:t-traceStart,sourceT,previousDifferenceT,v});if(traceData.length>TRACE_CAPACITY)traceData.shift();
  while(traceData.length>2&&traceData[1].t<t-traceStart-TRACE_SECONDS-.5)traceData.shift();
  for(let i=0;i<6;i++){
    // Display-only trace normalisation; raw values are shown at the right.
    if(!Number.isFinite(v[i])){ $('traceValue'+i).textContent='—'; continue; }
    const floor=i===0?.0005:i<4?1e-10:1e-30;
    tracePeaks[i]=i===0?Math.max(floor,...traceData.map(p=>Number.isFinite(p.v[0])?Math.abs(p.v[0]):0)):Math.max(Math.abs(v[i]),tracePeaks[i]*.997,floor);
    $('traceValue'+i).textContent=i>=4?v[i].toExponential(2):v[i].toFixed(4);
  }
  if(performance.now()-lastTracePaint>65){drawTraces();lastTracePaint=performance.now();}
}
function formatTime(t){if(!Number.isFinite(t))return '—';return `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,'0')}`;}
function setYouTubeStatus(message,error=false){
  $('youtubeStatus').textContent=message;$('youtubeStatus').dataset.kind=error?'error':'idle';
}
function youtubeProcessingStatus(){
  if(youtubeState===1)return 'YouTube tab processing';
  if(youtubeState===3)return 'YouTube buffering — analysis waiting';
  if(youtubeState===0)return 'YouTube ended — choose Play or seek in the player';
  return 'YouTube paused — press Play in the player';
}
function youtubeCaptureIssue(){
  if(youtubeCapture?.videoTrack.muted)return 'Captured video is interrupted. Keep the YouTube player visible in this tab.';
  if(audioTrack?.muted)return 'Shared tab audio is interrupted. Analysis is waiting for the captured soundtrack.';
  if(audioContext?.state!=='running')return 'Tab-audio processing is suspended. Stop and share the tab again.';
  return '';
}
function handleYouTubeState(state,previous){
  youtubeState=state;youtubeTimeSample=null;
  if(mode!=='youtube'||!running)return;
  // Pause/buffering/seeking starts a fresh segment. Browser capture uses its
  // own clock; the embed's approximate playhead is not a model timestamp.
  if(state!==previous)void resetYouTubeSegment();
  setStatus(youtubeProcessingStatus(),state===1?'live':'idle');
}
async function resetYouTubeSegment(){
  if(mode!=='youtube'||!running)return;
  const token=session,serial=++youtubeSegmentSerial;
  youtubeSegmentReady=false;usage.breakActivity();epoch++;busy=false;
  frameHistory.clear();audioHistory.clear();lastAnchor=null;sourceFirstT=null;lastProcessedCutSerial=null;
  cutDetector.reset();cutEvents=[];lastCutDetail=null;clearMaps();clearTraces();
  try{
    await callCore('reset');
    if(token!==session||serial!==youtubeSegmentSerial)return;
    lastStateSteps=0;resetCount++;youtubeSegmentReady=true;
  }catch(error){if(token===session)fail(error);}
}
function monitorYouTubePlayback(){
  if(mode!=='youtube'||!running||youtubeState!==1)return;
  const now=performance.now()/1000;
  if(youtubeTimeSample&&now-youtubeTimeSample.wall<.25)return;
  const time=youtubePlayer.time();if(time===null)return;
  const rate=youtubePlayer.rate(),previous=youtubeTimeSample;
  youtubeTimeSample={time,wall:now,rate};
  // Also catch seeks that do not emit a buffering/pause event. This detects
  // discontinuities only; no sample timing is inferred from the player API.
  if(previous&&previous.rate===rate&&Math.abs((time-previous.time)-(now-previous.wall)*rate)>.75)void resetYouTubeSegment();
}
function paintAudioStatus(rms){
  const db=20*Math.log10(Math.max(rms,1e-9)),pct=clamp((db+85)/85)*100;
  $('audioBar').style.width=`${pct}%`;$('audioMeter').setAttribute('aria-valuenow',pct.toFixed(1));
  let message,warning=false;
  if(mode==='movie')message=`Embedded audio → mono · RMS ${rms.toFixed(4)}`;
  else if(mode==='youtube'){
    if(audioTrack?.muted){message='Shared tab audio is interrupted. Check the YouTube player and tab sharing.';warning=true;}
    else if(audioContext?.state!=='running'){message='Tab-audio processing is suspended. Stop and share the tab again.';warning=true;}
    else if(youtubeState!==1)message='Tab audio selected · analysis waits for YouTube playback.';
    else if(rms<.00003){message='Little or no tab audio. Check the player volume and that the tab is not muted.';warning=true;}
    else message=`Tab soundtrack → mono · ${db.toFixed(1)} dBFS · no captured-audio playback`;
  }
  else if(audioTrack?.readyState==='ended'){message='Microphone track ended. Stop and start again.';warning=true;}
  else if(audioTrack?.muted){message='Microphone reports a muted/interrupted track. Check the selected input.';warning=true;}
  else if(audioContext?.state!=='running'){message=`Audio engine ${audioContext?.state||'off'}. Stop and restart.`;warning=true;}
  else if(rms<.00003){message='Little or no microphone signal. Check the input selection if speaking.';warning=true;}
  else message=`Microphone ${db.toFixed(1)} dBFS · ${performance.now()-lastAudioPacket<300?'audio worklet':'analyser fallback'}`;
  $('audioStatus').textContent=message;$('audioStatus').dataset.warning=String(warning);
}
function updatePerformance(force=false){
  const now=performance.now()/1000;if(!force&&now-lastInfoPaint<.5)return;lastInfoPaint=now;
  const elapsed=Math.max(.1,now-metrics.startWall);
  const cameraFps=metrics.captured/elapsed,modelFps=metrics.processed/elapsed;
  const avg=arr=>arr.length?arr.reduce((a,b)=>a+b,0)/arr.length:0;
  const comp=avg(metrics.compute),turn=avg(metrics.turnaround),skipPct=100*metrics.skipped/Math.max(1,metrics.processed+metrics.skipped);
  let q=null;try{q=video.getVideoPlaybackQuality?.();}catch(_e){}
  const dropped=q&&q.totalVideoFrames>0?q.droppedVideoFrames:'unavailable';
  $('fpsReadout').textContent=`${mode==='youtube'?'Input samples':'Input'} ${cameraFps.toFixed(1)} ${mode==='youtube'?'Hz':'fps'} · MCD ${modelFps.toFixed(1)} fps`;
  $('computeReadout').textContent=`${comp.toFixed(1)} ms/frame`;
  $('skipReadout').textContent=`Skipped ${metrics.skipped} · Cuts ${metrics.suppressedCuts}`;
  $('performance').dataset.warning=String(metrics.skipped>0||comp>samplePeriod*1000);
  $('performanceDetail').textContent=`Captured callbacks: ${metrics.captured}. Processed: ${metrics.processed}. Skipped: ${metrics.skipped} (${skipPct.toFixed(1)}%). Initial buffer frames: ${metrics.warmup}. Missed presented-frame callbacks: ${metrics.callbackGaps}. Browser-reported drops: ${dropped}. Mean worker round trip: ${turn.toFixed(1)} ms. Recent source interval: ${(samplePeriod*1000).toFixed(1)} ms. Frame-quantised visual delay: ${actualVideoLag.toFixed(1)} ms. Audio packet coverage: ${(audioCoverage*100).toFixed(0)}%. Movie loops: ${loopCount}. Detected editing/loop cuts: ${metrics.detectedCuts}. Cut transitions suppressed: ${metrics.suppressedCuts}. ${engineName}. Model updates since last reset: ${lastStateSteps}. Queue: ${(queueBacklog*1000).toFixed(0)} ms. Rendering: ${avg(metrics.render).toFixed(1)} ms/map pair. Overload resynchronisations: ${metrics.resyncs} (both pathways re-primed; missing segment shown as a gap). Hardware/driver losses cannot be inferred from these counters.`;
  if(mode==='youtube')$('performanceDetail').textContent=$('performanceDetail').textContent
    .replace(`Captured callbacks: ${metrics.captured}.`,`Captured samples: ${metrics.captured}. A nominal 30 Hz timer reads the latest decoded player crop; successive samples may repeat a video frame.`)
    .replace(`Missed presented-frame callbacks: ${metrics.callbackGaps}.`,'Native presented-frame callback counts are unavailable in YouTube sampling mode.')
    +' YouTube playback time is used only to detect seeks, not to timestamp model inputs. Capture latency is not calibrated.';
  updateMovieTransport();
  updateControls();
}
function captureFrame(now,meta={}){
  frameCallback=null;if(!running||seekActive||moviePaused)return;
  if(mode==='youtube'){
    if(!youtubeCapture?.isValid()){fail(new Error('Tab sharing changed or ended. Share this tab again with audio.'));return;}
    if(youtubeState!==1||!youtubeSegmentReady||youtubeCaptureIssue()){scheduleFrame();return;}
  }
  if(video.seeking){scheduleFrame();return;}
  if(video.readyState<2||!video.videoWidth){scheduleFrame();return;}
  if(`${video.videoWidth}x${video.videoHeight}`!==sourceDimensions){
    if(modelReady)initialiseCore(requestedGeometry()).catch(fail);
    scheduleFrame();return;
  }
  let t,loopRolled=false;
  if(mode==='movie'){
    const mt=Number.isFinite(meta.mediaTime)?meta.mediaTime:video.currentTime;lastDisplayedMediaTime=mt;
    if(lastMediaT!==null&&mt<lastMediaT-.005){
      loopCount++;loopRolled=true;
      if(traceStart!==null)loopMarks.push(loopCount*movie.duration-traceStart);
    }
    t=loopCount*movie.duration+mt;lastMediaT=mt;
  }else t=now/1000-sessionStart;
  const previous=frameHistory.latest();
  if(previous&&t<=previous.t+1e-6){scheduleFrame();return;}
  if(previous){const dt=t-previous.t;if(dt>0&&dt<.3)samplePeriod=.9*samplePeriod+.1*dt;}
  if(Number.isFinite(meta.presentedFrames)){
    if(metrics.lastPresented!==null&&meta.presentedFrames>metrics.lastPresented+1)metrics.callbackGaps+=meta.presentedFrames-metrics.lastPresented-1;
    metrics.lastPresented=meta.presentedFrames;
  }
  try{
    processContext.drawImage(video,0,0,g.w,g.h);
    const data=greyPixels16(processContext.getImageData(0,0,g.w,g.h).data);
    const loopEdge=!!(mode==='movie'&&previous&&loopRolled);
    let detection=null;
    if(mode==='movie'||mode==='youtube'){
      cutContext.drawImage(video,0,0,cutCanvas.width,cutCanvas.height);
      detection=cutDetector.inspect(greyPixels16(cutContext.getImageData(0,0,cutCanvas.width,cutCanvas.height).data),{sensitivity:CUT_SENSITIVITY,forced:loopEdge});
    }
    const cutFound=!!(loopEdge||detection?.cut);
    if(cutFound){
      metrics.detectedCuts++;
      const event={t,start:(previous?.t??t)-samplePeriod*.5,end:t+samplePeriod*1.5,kind:loopEdge?'loop':'edit',mediaTime:mode==='youtube'?t:lastMediaT,...detection};
      cutEvents.push(event);lastCutDetail=event;
      if(cutsEnabled())maskEarlierVisualSamples(event);
      $('cutStatus').textContent=`Detected ${metrics.detectedCuts} · last ${event.kind} at ${formatMovieTime(event.mediaTime)} · suppressed ${metrics.suppressedCuts}`;
    }
    while(cutEvents.length&&cutEvents[0].end<t-TRACE_SECONDS-2)cutEvents.shift();
    const cutSerial=(previous?.cutSerial??0)+(cutFound?1:0);
    const rawVisualChange=previous?meanAbsoluteDifference(previous.data,data)/65535:0;
    const visualChange=averageVisualChanges(rawVisualChange,previous?.rawVisualChange);
    const previousDifferenceT=previous?.t??t;
    metrics.captured++;metrics.lastFrameWall=performance.now()/1000;
    const id=metrics.captured;
    frameHistory.push({id,t,data,cutSerial,cutFound,rawVisualChange,visualChange,previousDifferenceT});if(sourceFirstT===null)sourceFirstT=t;
    if(mode==='movie')delayedPreview.capture(video,t,+$('avDelay').value);
    $('sourceHint').hidden=true;
  }catch(e){fail(e);return;}
  scheduleFrame();pump();
}
function scheduleFrame(){
  if(!running||moviePaused||seekActive||movieTail||frameCallback!==null)return;
  // The YouTube capture sink is invisible: compositor-driven frame callbacks
  // are not guaranteed there. Sample its latest decoded crop on a timer.
  // Existing camera/movie frame scheduling is unchanged.
  frameCallbackIsTimer=mode==='youtube'||!video.requestVideoFrameCallback;
  if(!frameCallbackIsTimer)frameCallback=video.requestVideoFrameCallback(captureFrame);
  else {
    const token=session;
    frameCallback=setTimeout(()=>{if(token===session)captureFrame(performance.now(),{mediaTime:video.currentTime});},1000/30);
  }
}
function checkFallback(){
  if(!audioAnalyser||!analyserBuffer||!running||mode==='movie')return;
  const now=performance.now();
  if(now-lastAudioPacket<350||now-lastFallback<20)return;
  audioAnalyser.getFloatTimeDomainData(analyserBuffer);
  let sq=0,pk=0;for(const x of analyserBuffer){sq+=x*x;pk=Math.max(pk,Math.abs(x));}
  const end=now/1000-sessionStart;
  const start=lastFallback?lastFallback/1000-sessionStart:end-analyserBuffer.length/audioContext.sampleRate;
  audioHistory.push(start,end,Math.sqrt(sq/analyserBuffer.length),pk);lastFallback=now;
}
function pump(){
  if(!running||moviePaused||seekActive||video.seeking||!modelReady||busy)return;
  if(mode==='youtube'&&(youtubeState!==1||!youtubeSegmentReady||!youtubeCapture?.isValid()||youtubeCaptureIssue()))return;
  const latest=frameHistory.latest();if(!latest)return;
  const eligible=mode!=='movie'?frameHistory.at(performance.now()/1000-sessionStart-LIVE_LOOKBACK):latest;
  const selected=movieTail?.anchor?{anchor:movieTail.anchor,resync:false,backlog:0}:chooseProcessingFrame(frameHistory.items,eligible,lastAnchor,samplePeriod);
  if(!selected)return;
  const {anchor}=selected,resync=selected.resync;queueBacklog=selected.backlog;
  if(!anchor||lastAnchor&&(movieTail?anchor.t<=lastAnchor.t+1e-7:anchor.id<=lastAnchor.id))return;
  const delay=delaySeconds(+$('avDelay').value);
  if(anchor.t<(sourceFirstT??anchor.t)+Math.max(delay.video,delay.audio)-1e-6){setStatus('Buffering imposed delay…');return;}
  const visual=frameHistory.at(anchor.t-delay.video);
  if(!visual)return;
  let dt=lastAnchor?anchor.t-lastAnchor.t:samplePeriod;
  if(!(dt>0))return;
  // Do not silently integrate missing input after a long scheduling gap.
  if(dt>5&&!resync){metrics.lastGap=dt;stop(false);setStatus('Stopped after a long sampling gap. Press Start to begin a new run.','warning');return;}
  const aEnd=anchor.t-delay.audio,aStart=aEnd-(resync?samplePeriod:dt);
  let a;
  if(mode==='movie'){
    a=movieRms(movie.envelope,Math.max(0,aStart),aEnd,movie.duration,$('loopMovie').checked);audioCoverage=1;
  }else {
    const measure=audioHistory.measure(aStart,aEnd);
    a=measure.rms;audioCoverage=measure.coverage;
  }
  if(!lastAnchor){if(!metrics.processed)metrics.warmup=Math.max(0,anchor.id-1);}
  else if(!movieTail)metrics.skipped+=Math.max(0,anchor.id-lastAnchor.id-1);
  lastAnchor={id:anchor.id,t:anchor.t};actualVideoLag=(anchor.t-visual.t)*1000;lastRms=a;
  const suppressCut=mode!=='live'&&cutsEnabled();
  const cut=!!(suppressCut&&lastProcessedCutSerial!==null&&visual.cutSerial!==lastProcessedCutSerial);
  const data=new Float32Array(visual.data.length);
  for(let i=0;i<data.length;i++)data[i]=visual.data[i]/65535;
  const ticket=epoch,runSession=session;
  busy=true;const start=performance.now();
  callCore('step',{frame:data.buffer,audio:a,dt,cut,resync},[data.buffer]).then(m=>{
    if(ticket!==epoch||runSession!==session)return;
    busy=false;if(!running)return;
    corrValues=new Float32Array(m.corr);lagValues=new Float32Array(m.lag);lastStateSteps=m.steps;
    // Count successful model work, not Start clicks, primes or failed capture.
    const cameraTrack=stream?.getVideoTracks?.()[0];
    const inputValid=mode==='movie'?!!movie?.envelope:
      !!(audioTrack?.readyState==='live'&&audioTrack.enabled&&!audioTrack.muted&&
         cameraTrack?.readyState==='live'&&!cameraTrack.muted&&audioContext?.state==='running'&&audioCoverage>=.8);
    usage.successfulFrame({mode,valid:inputValid&&!m.primed&&!moviePaused&&!seekActive&&
      m.traces?.length===6&&m.traces.slice(1).every(Number.isFinite)&&
      corrValues.length===g.w*g.h&&lagValues.length===g.w*g.h});
    metrics.processed++;if(m.resynced){metrics.resyncs++;usage.breakActivity();}lastProcessedCutSerial=visual.cutSerial;if(m.cut)metrics.suppressedCuts++;metrics.compute.push(m.computeMs);metrics.turnaround.push(performance.now()-start);
    if(metrics.compute.length>120)metrics.compute.shift();if(metrics.turnaround.length>120)metrics.turnaround.shift();
    // Display-only summary follows the source frame through the delay buffer.
    // Missing values remain missing if either difference overlaps a suppressed cut.
    m.traces[0]=visualTraceSample(visual.visualChange,{suppression:suppressCut,crossedCut:cut||m.cut,inCutWindow:isCutWindow(visual.t)||isCutWindow(visual.previousDifferenceT)});
    mapsDirty=true;addTraces(m.traces,anchor.t,!Number.isFinite(m.traces[0]),visual.t,visual.previousDifferenceT,m.resynced);paintAudioStatus(a);
    if(lastCutDetail)$('cutStatus').textContent=`Detected ${metrics.detectedCuts} · suppressed ${metrics.suppressedCuts} · last ${lastCutDetail.kind} at ${formatMovieTime(lastCutDetail.mediaTime)}`;
    // Keep model work independent of display refresh; rendering is batched in animationTick.
    queueMicrotask(pump);
    setStatus(moviePaused?'Movie paused':movieTail?'Finishing delayed playback…':mode==='movie'?'Movie processing':mode==='youtube'?youtubeProcessingStatus():'Live processing',moviePaused?'idle':'live');updatePerformance();
  }).catch(e=>{if(ticket!==epoch||runSession!==session)return;busy=false;fail(e);});
}
function animationTick(){
  if(!running||moviePaused||seekActive)return;
  if(mode==='youtube'){
    if(!youtubeCapture?.isValid()){fail(new Error('Tab sharing changed or ended. Share this tab again with audio.'));return;}
    const issue=youtubeCaptureIssue();
    if(issue){
      if(!youtubeInterrupted){youtubeInterrupted=true;void resetYouTubeSegment();}
      setStatus('YouTube capture interrupted','warning');setYouTubeStatus(issue,true);
      $('audioBar').style.width='0%';$('audioMeter').setAttribute('aria-valuenow','0');
      $('audioStatus').textContent=issue;$('audioStatus').dataset.warning='true';
    }else {
      if(youtubeInterrupted){youtubeInterrupted=false;void resetYouTubeSegment();setYouTubeStatus('Capture resumed. Analysis starts a new segment.');}
      monitorYouTubePlayback();
      if(youtubeState!==1){setStatus(youtubeProcessingStatus());paintAudioStatus(0);}
    }
  }
  if(movieTail){
    const elapsed=Math.min(movieTail.seconds,performance.now()/1000-movieTail.started);
    const t=movieTail.sourceEnd+elapsed;
    if(t-movieTail.lastUpdate>=samplePeriod*.9||elapsed>=movieTail.seconds){
      movieTail.lastUpdate=t;movieTail.anchor={id:frameHistory.latest()?.id||0,t};
      delayedPreview.present(t,+$('avDelay').value);
    }
    if(elapsed>=movieTail.seconds&&lastAnchor?.t>=t-1e-7&&!busy){stop();return;}
  }
  checkFallback();pump();if(mapsDirty&&performance.now()-lastMapPaint>=1000/30)paintMaps();updatePerformance();
  raf=requestAnimationFrame(animationTick);
}
async function refreshDevices(){
  if(!navigator.mediaDevices?.enumerateDevices)return;
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    for(const [id,kind,name] of [['videoDevice','videoinput','Camera'],['audioDevice','audioinput','Microphone']]){
      const select=$(id),old=select.value;
      select.replaceChildren(new Option('System default',''));
      devices.filter(d=>d.kind===kind&&d.deviceId&&!['default','communications'].includes(d.deviceId)).forEach((d,i)=>select.add(new Option(d.label||`${name} ${i+1}`,d.deviceId)));
      if([...select.options].some(o=>o.value===old))select.value=old;
    }
  }catch(e){console.warn('Device names are available after permission.',e);}
}
function freezePreview(){
  if(mapsDirty)paintMaps();
  if(mode==='youtube')return; // never overlay captured pixels on the player
  if(video.readyState<2||!video.videoWidth)return;
  const c=$('stillCanvas');c.width=video.videoWidth;c.height=video.videoHeight;
  try{c.getContext('2d').drawImage(mode==='movie'&&!$('playbackCanvas').hidden?$('playbackCanvas'):video,0,0,c.width,c.height);c.hidden=false;}catch(_e){}
}
function releaseLive(){
  if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  for(const n of [audioSource,audioNode,audioAnalyser,muteNode]){try{n?.disconnect();}catch(_e){}}
  if(audioContext){audioContext.close().catch(()=>{});audioContext=null;}
  audioSource=audioNode=audioAnalyser=muteNode=null;analyserBuffer=null;audioTrack=null;
}
function stop(message=true){
  usage.breakActivity();
  session++;epoch++;seekSerial++;seekActive=false;seekResume=false;moviePaused=false;clearTimeout(seekCommitTimer);running=false;starting=false;phase='idle';busy=false;
  if(frameCallback!==null){if(frameCallbackIsTimer)clearTimeout(frameCallback);else video.cancelVideoFrameCallback(frameCallback);frameCallback=null;}
  if(raf!==null){cancelAnimationFrame(raf);raf=null;}
  freezePreview();video.pause();movieAudioOutput.pause({flush:true});delayedPreview.clear();movieTail=null;
  if(mode==='youtube'){
    youtubeSegmentSerial++;youtubeSegmentReady=false;youtubeTimeSample=null;youtubeInterrupted=false;
    youtubeCapture?.release();youtubeCapture=null;
    youtubePlayer.pause();
    setYouTubeStatus('Sharing stopped. Share this tab with audio to start a new run.');
  }
  if(mode!=='movie'){releaseLive();video.srcObject=null;}
  $('audioBar').style.width='0%';$('audioMeter').setAttribute('aria-valuenow','0');
  $('audioStatus').textContent=mode==='live'?'Camera and microphone off.':mode==='youtube'?'Tab capture off. No microphone is used.':'Movie stopped. Start resumes from the selected position.';
  $('audioStatus').dataset.warning='false';runButton();drawTraces();
  updateMovieTransport();if(message)setStatus('Stopped');
}
function fail(error){stop(false);const message=error?.message||String(error);setStatus(message,'error');if(mode==='youtube')setYouTubeStatus(message,true);console.error(error);}
async function resetForStart(){
  usage.breakActivity();
  epoch++;frameHistory.clear();delayedPreview.clear();audioHistory.clear();movieTail=null;lastAnchor=null;lastProcessedCutSerial=null;sourceFirstT=null;lastMediaT=null;loopCount=0;
  samplePeriod=1/30;actualVideoLag=0;audioCoverage=1;lastRms=0;lastAudioPacket=0;lastFallback=0;
  lastStateSteps=0;cutDetector.reset();cutEvents=[];lastCutDetail=null;clearTraces();clearMaps();metrics=freshMetrics();
  await callCore('reset');resetCount++;
}
async function connectTabAudio(token){
  // The soundtrack is taken only from the selected capture's audio track.
  // Neither this branch nor its analyser fallback requests a microphone.
  audioClockOffset=performance.now()/1000-audioContext.currentTime-sessionStart;
  audioSource=audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
  muteNode=audioContext.createGain();muteNode.gain.value=0;muteNode.connect(audioContext.destination);
  audioAnalyser=audioContext.createAnalyser();audioAnalyser.fftSize=2048;
  audioAnalyser.channelCount=1;audioAnalyser.channelCountMode='explicit';
  analyserBuffer=new Float32Array(audioAnalyser.fftSize);
  audioSource.connect(audioAnalyser);audioAnalyser.connect(muteNode);
  try{
    await audioContext.audioWorklet.addModule(`./audio-worklet.js?v=${VERSION}`);if(token!==session)return;
    audioNode=new AudioWorkletNode(audioContext,'mcd-mic-level',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    audioNode.port.onmessage=({data:m})=>{if(token!==session)return;lastAudioPacket=performance.now();audioHistory.push(m.start+audioClockOffset,m.end+audioClockOffset,m.rms,m.peak);};
    audioNode.onprocessorerror=()=>{lastAudioPacket=0;console.warn('Tab audio worklet unavailable; using the same tab stream analyser.');};
    audioSource.connect(audioNode);audioNode.connect(muteNode);
  }catch(error){if(token!==session)return;console.warn('Using tab-stream analyser fallback',error);}
}
async function start(){
  if(running||starting||!modelReady||movieLoading)return;
  if(mode==='movie'&&!movie)return;
  const token=++session;starting=true;phase='starting';runButton();
  sessionStart=performance.now()/1000;
  try{
    if(mode==='live'){
      if(!isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('Use HTTPS or localhost to access camera and microphone.');
      setStatus('Requesting camera and microphone…');
      audioContext=new AudioContext({latencyHint:'interactive'});const resume=audioContext.resume();resume.catch(()=>{});
      const acquired=await navigator.mediaDevices.getUserMedia({
        video:{...($('videoDevice').value?{deviceId:{exact:$('videoDevice').value}}:{facingMode:'user'}),width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30}},
        audio:{...($('audioDevice').value?{deviceId:{exact:$('audioDevice').value}}:{}),channelCount:{ideal:1},echoCancellation:false,noiseSuppression:false,autoGainControl:false}
      });
      if(token!==session){acquired.getTracks().forEach(t=>t.stop());return;}
      stream=acquired;audioTrack=stream.getAudioTracks()[0];if(!audioTrack)throw new Error('No microphone track was provided.');
      await resume;if(token!==session)return;
      video.removeAttribute('src');video.srcObject=stream;video.muted=true;await video.play();if(token!==session)return;
      audioClockOffset=performance.now()/1000-audioContext.currentTime-sessionStart;
      audioSource=audioContext.createMediaStreamSource(stream);
      muteNode=audioContext.createGain();muteNode.gain.value=0;muteNode.connect(audioContext.destination);
      audioAnalyser=audioContext.createAnalyser();audioAnalyser.fftSize=2048;analyserBuffer=new Float32Array(audioAnalyser.fftSize);
      audioSource.connect(audioAnalyser);audioAnalyser.connect(muteNode);
      try{
        await audioContext.audioWorklet.addModule(`./audio-worklet.js?v=${VERSION}`);if(token!==session)return;
        audioNode=new AudioWorkletNode(audioContext,'mcd-mic-level',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
        audioNode.port.onmessage=({data:m})=>{if(token!==session)return;lastAudioPacket=performance.now();audioHistory.push(m.start+audioClockOffset,m.end+audioClockOffset,m.rms,m.peak);};
        audioNode.onprocessorerror=()=>{lastAudioPacket=0;console.warn('AudioWorklet unavailable; using analyser.');};
        audioSource.connect(audioNode);audioNode.connect(muteNode);
      }catch(e){if(token!==session)return;console.warn('Using analyser audio fallback',e);}
      await refreshDevices();if(token!==session)return;
    }else if(mode==='youtube'){
      const descriptor=parseYouTubeURL($('youtubeURL').value);
      const support=youtubeSupport();if(!support.supported)throw new Error(support.message);
      $('sourceHint').hidden=true;$('youtubePlayerRegion').hidden=false;
      // Display the embed and request sharing in the original click/Enter
      // gesture. Do not await the external YouTube script before permission.
      const playerReady=youtubePlayer.load(descriptor);
      playerReady.catch(error=>{if(token===session&&mode==='youtube')fail(error);});
      setStatus('Choose this tab and share tab audio…');
      setYouTubeStatus('Choose this tab in the browser dialog and enable “Share tab audio”.');
      const request=acquireYouTubeTab($('youtubePlayerRegion'),{
        isCurrent:()=>token===session&&mode==='youtube',
        onEnded:message=>{if(token===session)fail(new Error(message));}
      });
      request.catch(()=>{});
      audioContext=new AudioContext({latencyHint:'interactive'});
      const resume=audioContext.resume();resume.catch(()=>{});
      const acquired=await request;
      if(token!==session){acquired.release();return;}
      youtubeCapture=acquired;stream=acquired.stream;audioTrack=acquired.audioTrack;
      await resume;if(token!==session)return;
      if(audioContext.state!=='running')throw new Error('Tab-audio processing could not start. Stop and share the tab again.');
      video=tabVideo;video.srcObject=new MediaStream([acquired.videoTrack]);video.muted=true;video.volume=0;
      await video.play();if(token!==session)return;
      await connectTabAudio(token);if(token!==session)return;
      await playerReady;if(token!==session)return;
      youtubeState=youtubePlayer.state;youtubeTimeSample=null;youtubeInterrupted=false;
    }else {
      if(video.srcObject!==null)video.srcObject=null;
      if(video.src!==movie.url)video.src=movie.url;
      video.loop=$('loopMovie').checked;
      if(video.ended||video.currentTime>=movie.duration-.02)video.currentTime=0;
      // Resume the audio context in the Start user gesture. One decoder supplies
      // both the heard soundtrack and the captured images.
      await movieAudioOutput.resume(+$('avDelay').value,$('hearMovie').checked);if(token!==session)return;
      movieAudioOutput.flush();
      await video.play();if(token!==session)return;
    }
    await initialiseCore(requestedGeometry());if(token!==session)return;
    await resetForStart();if(token!==session)return;
    // Re-map microphone time after initialisation; queued live data uses the
    // same session clock, so no movie timestamp assumptions leak into live mode.
    $('stillCanvas').hidden=true;setMirroring();
    starting=false;running=true;moviePaused=false;phase='running';metrics.startWall=performance.now()/1000;updateMovieTransport();
    if(mode==='youtube'){
      youtubeSegmentReady=true;
      setYouTubeStatus('Sharing this tab’s audio and player region. Use the YouTube player to play, pause or seek.');
      youtubePlayer.play();
    }
    $('sourceHint').hidden=true;runButton();setStatus(mode==='movie'?'Movie processing':mode==='youtube'?youtubeProcessingStatus():'Live processing','live');
    scheduleFrame();raf=requestAnimationFrame(animationTick);
  }catch(e){if(token===session)fail(e);}
}
function metadataReady(url){
  return new Promise((resolve,reject)=>{
    const done=()=>{clearTimeout(timer);video.removeEventListener('loadedmetadata',ok);video.removeEventListener('error',bad);};
    const ok=()=>{done();resolve();};const bad=()=>{done();reject(new Error('This browser cannot decode this video. Try MP4 (H.264/AAC) or WebM.'));};
    const timer=setTimeout(()=>{done();reject(new Error('Movie metadata did not load. Try a shorter or differently encoded movie.'));},20000);
    video.addEventListener('loadedmetadata',ok);video.addEventListener('error',bad);video.src=url;video.load();
  });
}
async function extractMovieEnvelope(file){
  const Ctx=window.OfflineAudioContext||window.webkitOfflineAudioContext;
  const context=new Ctx(1,1,48000);
  let audio;
  try{audio=await context.decodeAudioData(await file.arrayBuffer());}
  catch(_e){throw new Error('The embedded audio could not be decoded. Use a movie with an audio track supported by this browser, such as AAC in MP4 or Opus in WebM.');}
  const channels=Array.from({length:audio.numberOfChannels},(_,i)=>audio.getChannelData(i).slice().buffer),rate=audio.sampleRate;
  return await new Promise((resolve,reject)=>{
    const w=new Worker(`./movie-audio-worker.js?v=${VERSION}`,{type:'module'});
    const timer=setTimeout(()=>{w.terminate();reject(new Error('Audio preparation timed out. Try a shorter movie.'));},120000);
    w.onmessage=({data:m})=>{clearTimeout(timer);w.terminate();if(m.error)reject(new Error(m.error));else resolve({...m,prefix:new Float64Array(m.prefix)});};
    w.onerror=e=>{clearTimeout(timer);w.terminate();reject(new Error(e.message||'Could not prepare movie audio.'));};
    w.postMessage({id:1,channels,sampleRate:rate},channels);
  });
}
async function loadMovie(file,{builtInChart=false,exampleFilename=null}={}){
  if(!file)return;
  cancelExampleDownload();
  const fileId=++fileGeneration;stop(false);movieLoading=true;runButton();setStatus(exampleFilename?'Preparing example movie…':'Preparing local movie…');
  let url;
  try{
    if(file.size>250*1024*1024)throw new Error('Please choose a short movie smaller than 250 MB for this browser demonstration.');
    if(movie){URL.revokeObjectURL(movie.url);movie=null;}
    url=URL.createObjectURL(file);video.srcObject=null;video.muted=true;
    await metadataReady(url);if(fileId!==fileGeneration){URL.revokeObjectURL(url);return;}
    if(!video.videoWidth||!Number.isFinite(video.duration)||video.duration<=0)throw new Error('A finite video with an embedded soundtrack is required.');
    const duration=video.duration;
    const envelope=await extractMovieEnvelope(file);if(fileId!==fileGeneration){URL.revokeObjectURL(url);return;}
    movie={url,name:file.name,envelope,duration,builtInChart,exampleFilename};
    if(exampleFilename){
      // Flash transitions in the synchrony chart are deliberate stimuli.
      // Naturalistic example movies use ordinary cut suppression.
      $('suppressCuts').setAttribute('aria-pressed',String(!builtInChart));updateCutButton();
      $('loopMovie').checked=true;video.loop=true;
    }
    $('movieInfo').textContent=`${file.name} · ${formatTime(duration)} · ${envelope.channels} ch → mono · local processing`;
    if(builtInChart)$('movieInfo').textContent=`Audiovisual synchrony chart · ${formatTime(duration)} · mono audio · cut suppression off`;
    if(Math.abs(envelope.duration-duration)>.15)$('movieInfo').textContent+=' · audio/video durations differ; missing soundtrack intervals are treated as silence';
    await initialiseCore(requestedGeometry());if(fileId!==fileGeneration)return;
    $('stillCanvas').hidden=true;$('sourceHint').hidden=true;setMirroring();
    movieLoading=false;runButton();updateMovieTransport();setStatus('Movie ready');
    $('audioStatus').innerHTML=envelope.peak>0?'Mono soundtrack decoded. <span class="ready-to-start" style="color:#16803d;font-weight:600">Press Start movie.</span>':'The decoded soundtrack is silent.';
    $('audioStatus').dataset.warning=String(envelope.peak===0);
  }catch(e){if(fileId!==fileGeneration)return;movieLoading=false;if(url)URL.revokeObjectURL(url);movie=null;runButton();fail(e);}
}
async function switchMode(){
  cancelExampleDownload();
  rememberDisplaySettings();
  stop(false);fileGeneration++;movieLoading=false;mode=$('inputMode').value;
  youtubePlayer.unload();youtubeState=-1;video=mode==='youtube'?tabVideo:sourceVideo;
  restoreDisplaySettings();updateControls();
  $('liveControls').hidden=mode!=='live';$('movieControls').hidden=mode!=='movie';$('mirrorLabel').hidden=mode!=='live';$('movieCutControls').hidden=mode==='live';updateMovieTransport();
  $('movieInfo').hidden=mode!=='movie';$('youtubeControls').hidden=mode!=='youtube';$('youtubePlaybackNote').hidden=mode!=='youtube';
  $('youtubePlayerRegion').hidden=mode!=='youtube';$('sourceStage').classList.toggle('youtube-mode',mode==='youtube');
  video.srcObject=null;
  if(mode==='movie'&&movie){video.src=movie.url;video.load();video.muted=true;}
  else {video.removeAttribute('src');video.load();}
  $('sourceHint').hidden=mode==='youtube'||(mode==='movie'&&!!movie);$('sourceHint').textContent=mode==='movie'?'Choose a movie with embedded audio':'Press Start live demo';
  $('stillCanvas').hidden=true;setMirroring();clearMaps();clearTraces();
  $('audioStatus').textContent=mode==='live'?'The live microphone is not played through the speakers.':mode==='youtube'?'The shared tab’s soundtrack is the model input. No microphone or captured-audio playback.':'Choose a local movie; embedded audio is mixed to mono for the model.';
  runButton();setStatus(mode==='movie'&&movie?'Movie ready':'Model ready');
  if(mode==='youtube'){
    const support=youtubeSupport();
    setYouTubeStatus(support.supported?'Paste a YouTube URL, then choose Load & share tab.':support.message,!support.supported);
    if(!support.supported)setStatus('YouTube analysis is not supported in this browser','warning');
  }
}
async function populateExampleMovies(){
  const picker=$('exampleMovie');
  const previous=picker.value;
  const requested=new URLSearchParams(window.location.search).get('example');
  try{
    const names=await listExampleMovies();
    // An incoming deep link can still work if the public API is unavailable.
    if(isExampleMovieName(requested)&&!names.includes(requested))names.push(requested);
    picker.replaceChildren(new Option('Select an example…',''));
    for(const filename of names){picker.add(new Option(exampleMovieLabel(filename),filename));}
    if(previous&&names.includes(previous))picker.value=previous;
    else if(requested&&names.includes(requested))picker.value=requested;
  }catch(error){
    console.warn('Could not list the example movies',error);
    picker.replaceChildren(new Option('Examples unavailable — reload to retry',''));
  }
  picker.disabled=!modelReady||movieLoading||starting;
}

// A direct link from the research page selects the original movie but NEVER
// starts playback automatically. The visitor must press Start movie.
async function loadExampleMovie(filename){
  if(!isExampleMovieName(filename)){
    setStatus('Invalid example-movie filename.','error');return;
  }
  if(movieLoading||starting||!modelReady)return;
  if(mode!=='movie'){
    $('inputMode').value='movie';
    await switchMode();
  }
  stop(false);cancelExampleDownload();
  const generation=++fileGeneration;
  const controller=new AbortController();exampleDownloadController=controller;
  movieLoading=true;runButton();updateMovieTransport();
  setStatus(`Loading ${exampleMovieLabel(filename)}…`);
  try{
    const response=await fetch(exampleMovieURL(filename),{signal:controller.signal,credentials:'same-origin'});
    if(!response.ok)throw new Error(`Could not download ${filename} (HTTP ${response.status}). Check mcd-live/examples/.`);
    const size=Number(response.headers.get('content-length'));
    if(Number.isFinite(size)&&size>250*1024*1024)throw new Error('This movie is larger than the 250 MB demonstration limit.');
    const blob=await response.blob();
    if(generation!==fileGeneration||controller.signal.aborted)return;
    if(!blob.size)throw new Error(`The example movie ${filename} is empty.`);
    if(blob.size>250*1024*1024)throw new Error('This movie is larger than the 250 MB demonstration limit.');
    exampleDownloadController=null;
    $('movieFile').value='';
    $('exampleMovie').value=filename;
    await loadMovie(new File([blob],filename,{type:blob.type||'video/mp4'}),{
      exampleFilename:filename,builtInChart:filename.toLowerCase()==='av_synchrony_chart.mp4'
    });
  }catch(error){
    if(generation!==fileGeneration||controller.signal.aborted)return;
    movieLoading=false;runButton();updateMovieTransport();
    setStatus(error?.message||'Could not load the example movie.','error');
  }finally{
    if(exampleDownloadController===controller)exampleDownloadController=null;
  }
}
function loadSynchronyChart(){return loadExampleMovie('av_synchrony_chart.mp4');}

function scheduleTuningChange(){
  usage.breakActivity();
  updateControls();clearTimeout(parameterTimer);
  parameterTimer=setTimeout(async()=>{
    if(!modelReady){scheduleTuningChange();return;}
    const ticket=++configurationSerial;++epoch;busy=false;modelReady=false;runButton();
    try{
      await callCore('params',{tuning:tuning(),reset:true});if(ticket!==configurationSerial)return;
      lastAnchor=null;lastProcessedCutSerial=null;clearTraces();clearMaps();lastStateSteps=0;resetCount++;modelReady=true;runButton();
    }catch(e){fail(e);}
  },140);
}
function scheduleGeometryChange(){
  usage.breakActivity();
  cancelDownsamplingClose();
  const changeRevision=++downsamplingChangeRevision;
  const disclosureRevision=downsamplingDisclosureRevision;
  updateControls();clearTimeout(geometryTimer);
  geometryTimer=setTimeout(async()=>{
    const candidate=requestedGeometry();
    if(candidate.tooLarge){
      const message=`${candidate.w} × ${candidate.h} exceeds the ${MAX_PIXELS.toLocaleString('en-GB')}-detector limit. Choose a larger downsampling factor. No silent resizing is applied.`;
      $('downsample').value=goodDownsample;updateControls();
      $('resolutionWarning').hidden=false;$('resolutionWarning').textContent=message;
      setStatus('Resolution too high — settings restored','warning');return;
    }
    try{
      await initialiseCore(candidate);
      // Start the three-second countdown only after this change succeeds.
      // A newer change or manual close/reopen cancels the previous countdown.
      if(changeRevision===downsamplingChangeRevision&&
         disclosureRevision===downsamplingDisclosureRevision&&modelReady&&
         g.w===candidate.w&&g.h===candidate.h)armDownsamplingClose();
    }catch(e){cancelDownsamplingClose();fail(e);}
  },180);
}
/* The first trace is attached to the displayed/delayed source frame.
 * A new cut can also invalidate the preceding boundary sample, so mask it
 * retroactively and recompute scale from finite values, not the old peak. */
function isCutWindow(t){return cutEvents.some(e=>t>=e.start-1e-7&&t<=e.end+1e-7);}
function maskEarlierVisualSamples(event){
  const overlaps=t=>t>=event.start-1e-7&&t<=event.end+1e-7;
  for(const p of traceData)if(overlaps(p.sourceT)||overlaps(p.previousDifferenceT))p.v[0]=Number.NaN;
  tracePeaks[0]=Math.max(.0005,...traceData.map(p=>Number.isFinite(p.v[0])?Math.abs(p.v[0]):0));
  drawTraces();
}
function formatMovieTime(t){
  if(!Number.isFinite(t))return '0:00.0';t=Math.max(0,t);
  return `${Math.floor(t/60)}:${Math.floor(t%60).toString().padStart(2,'0')}.${Math.floor(t*10+1e-6)%10}`;
}
function updateMovieTransport(){
  const ready=mode==='movie'&&!!movie&&!movieLoading;
  $('movieTransport').hidden=mode!=='movie';
  const slider=$('movieSeek');slider.disabled=!ready||starting;
  slider.max=ready?String(movie.duration):'1';
  if(!seekActive)slider.value=ready?String(clamp(video.currentTime,0,movie.duration)):'0';
  const t=ready?+slider.value:0;
  $('movieSeekTime').textContent=`${formatMovieTime(t)} / ${formatMovieTime(ready?movie.duration:0)}`;
  slider.setAttribute('aria-valuetext',`${formatMovieTime(t)} of ${formatMovieTime(ready?movie.duration:0)}`);
  $('pauseMovie').disabled=!ready||!running||starting||seekActive||!!movieTail;
  $('pauseMovie').textContent=moviePaused?'Resume':'Pause';
}
function cancelScheduling(){
  if(frameCallback!==null){if(frameCallbackIsTimer)clearTimeout(frameCallback);else video.cancelVideoFrameCallback(frameCallback);frameCallback=null;}
  if(raf!==null){cancelAnimationFrame(raf);raf=null;}
}
async function pauseOrResumeMovie(){
  usage.breakActivity();
  if(mode!=='movie'||!movie||!running||starting||seekActive)return;
  if(!moviePaused){
    moviePaused=true;pauseStarted=performance.now()/1000;phase='paused';
    video.pause();movieAudioOutput.pause();cancelScheduling();setStatus('Movie paused');if(mapsDirty)paintMaps();drawTraces();
  }else{
    const token=session;
    try{await movieAudioOutput.resume(+$('avDelay').value,$('hearMovie').checked);if(token!==session)return;
      await video.play();if(token!==session)return;
      metrics.startWall+=Math.max(0,performance.now()/1000-pauseStarted);
      moviePaused=false;phase='running';setStatus('Movie processing','live');
      scheduleFrame();raf=requestAnimationFrame(animationTick);
    }catch(e){if(token===session)fail(e);}
  }
  updateMovieTransport();
}
function beginMovieSeek(){
  usage.breakActivity();
  if(mode!=='movie'||!movie||movieLoading||starting||!modelReady)return false;
  if(seekActive)return true;
  seekActive=true;seekResume=running&&!moviePaused;seekSerial++;epoch++;busy=false;
  cancelScheduling();video.pause();movieAudioOutput.pause({flush:true});delayedPreview.clear();movieTail=null;$('stillCanvas').hidden=true;
  // Native worker replies sent before the seek are rejected by epoch/session.
  frameHistory.clear();lastAnchor=null;lastProcessedCutSerial=null;sourceFirstT=null;lastMediaT=null;loopCount=0;
  cutDetector.reset();cutEvents=[];lastCutDetail=null;clearMaps();clearTraces();
  seekResetPromise=callCore('reset');seekResetPromise.catch(()=>{});
  phase='seeking';setStatus('Choose movie position…');updateMovieTransport();return true;
}
function previewMovieSeek(){
  if(!beginMovieSeek())return;
  ++seekSerial;clearTimeout(seekCommitTimer);
  const target=clamp(+$('movieSeek').value,0,Math.max(0,movie.duration-.001));
  try{video.currentTime=target;}catch(e){fail(e);return;}
  $('movieSeekTime').textContent=`${formatMovieTime(target)} / ${formatMovieTime(movie.duration)}`;
  $('movieSeek').setAttribute('aria-valuetext',`${formatMovieTime(target)} of ${formatMovieTime(movie.duration)}`);
}
async function finishMovieSeek(){
  if(!seekActive)return;
  const ticket=seekSerial,runSession=session;
  try{
    await seekResetPromise;
    const until=performance.now()+5000;
    while(video.seeking&&ticket===seekSerial&&runSession===session){
      if(performance.now()>until)throw new Error('This movie did not finish seeking. Try a nearby position.');
      await new Promise(r=>setTimeout(r,20));
    }
    if(!seekActive||ticket!==seekSerial||runSession!==session)return;
    const resume=seekResume;seekActive=false;seekResume=false;
    lastMediaT=null;loopCount=0;lastStateSteps=0;resetCount++;metrics=freshMetrics();
    frameHistory.clear();lastAnchor=null;lastProcessedCutSerial=null;sourceFirstT=null;
    cutDetector.reset();cutEvents=[];lastCutDetail=null;samplePeriod=1/30;
    $('cutStatus').textContent='Seek completed; cut counts restarted.';
    if(running&&resume){
      await movieAudioOutput.resume(+$('avDelay').value,$('hearMovie').checked);if(ticket!==seekSerial||runSession!==session||seekActive)return;
      await video.play();if(ticket!==seekSerial||runSession!==session||seekActive)return;
      moviePaused=false;phase='running';setStatus('Movie processing','live');scheduleFrame();raf=requestAnimationFrame(animationTick);
    }else if(running){moviePaused=true;pauseStarted=performance.now()/1000;phase='paused';setStatus('Movie paused');}
    else {moviePaused=false;phase='idle';setStatus('Position selected — press Start movie');}
    updateMovieTransport();runButton();
  }catch(e){if(runSession===session&&ticket===seekSerial)fail(e);}
}
function commitMovieSeek(){clearTimeout(seekCommitTimer);seekCommitTimer=setTimeout(finishMovieSeek,25);}
$('pauseMovie').addEventListener('click',pauseOrResumeMovie);
$('movieSeek').addEventListener('pointerdown',beginMovieSeek);
$('movieSeek').addEventListener('input',previewMovieSeek);
$('movieSeek').addEventListener('change',commitMovieSeek);
$('movieSeek').addEventListener('pointerup',commitMovieSeek);
$('movieSeek').addEventListener('pointercancel',commitMovieSeek);
video.addEventListener('timeupdate',()=>{if(mode==='movie')updateMovieTransport();});
video.addEventListener('loadeddata',()=>{if(mode==='movie')updateMovieTransport();});

$('toggleRun').addEventListener('click',()=>{if(running||starting)stop();else start();});
$('loadYouTube').addEventListener('click',()=>{if(mode==='youtube')void start();});
$('youtubeURL').addEventListener('input',runButton);
$('youtubeURL').addEventListener('keydown',event=>{
  if(event.key==='Enter'&&mode==='youtube'&&!$('loadYouTube').disabled){event.preventDefault();void start();}
});
$('inputMode').addEventListener('change',switchMode);
$('movieFile').addEventListener('change',e=>{
  $('exampleMovie').value='';
  loadMovie(e.target.files?.[0]);
});
$('exampleMovie').addEventListener('change',e=>{if(e.target.value)void loadExampleMovie(e.target.value);});
$('loadSynchronyChart').addEventListener('click',loadSynchronyChart);
$('loopMovie').addEventListener('change',()=>{video.loop=$('loopMovie').checked;});
$('hearMovie').addEventListener('change',()=>movieAudioOutput.setAudible($('hearMovie').checked));
video.addEventListener('ended',()=>{
  if(mode!=='movie'||!running||$('loopMovie').checked)return;
  const seconds=Math.abs(+$('avDelay').value)/1000;
  if(!seconds){stop();return;}
  movieTail={seconds,started:performance.now()/1000,sourceEnd:loopCount*movie.duration+movie.duration,
    lastUpdate:-Infinity,anchor:null};
  setStatus('Finishing delayed playback…','live');updateMovieTransport();
});
for(const id of ['videoDevice','audioDevice'])$(id).addEventListener('change',async()=>{if(mode==='live'&&(running||starting)){stop(false);await start();}});
for(const id of ['tauV','tauA','tauLate']){
  const range=$(id),number=$(id+'Number');
  range.addEventListener('input',()=>{number.value=range.value;scheduleTuningChange();});
  number.addEventListener('change',()=>{const x=+number.value;number.value=String(clamp(Number.isFinite(x)?x:+range.value,+range.min,+range.max));range.value=number.value;scheduleTuningChange();});
}
$('timeScale').addEventListener('input',scheduleTuningChange);
function changeDelay(){
  if(mode==='movie'){
    if(movieTail){stop(false);setStatus('Delay changed — press Start movie');}
    movieAudioOutput.setDelay(+$('avDelay').value);
    const latest=frameHistory.latest();
    if(+$('avDelay').value<=0)delayedPreview.clear();
    else if(latest)delayedPreview.present(latest.t,+$('avDelay').value);
  }
  scheduleTuningChange();
}
$('avDelay').addEventListener('input',changeDelay);
$('zeroDelay').addEventListener('click',()=>{$('avDelay').value=0;changeDelay();});
$('resetTuning').addEventListener('click',()=>applyTemporalPreset('human'));
$('ratTuning').addEventListener('click',()=>applyTemporalPreset('rat'));
$('resetState').addEventListener('click',async()=>{
  usage.breakActivity();
  if(!modelReady)return;
  const ticket=++configurationSerial;++epoch;busy=false;modelReady=false;runButton();
  try{await callCore('reset');if(ticket!==configurationSerial)return;clearTraces();clearMaps();lastAnchor=null;lastProcessedCutSerial=null;lastStateSteps=0;resetCount++;modelReady=true;runButton();}catch(e){fail(e);}
});
$('downsample').addEventListener('change',scheduleGeometryChange);
$('suppressCuts').addEventListener('click',()=>{
  $('suppressCuts').setAttribute('aria-pressed',String(!cutsEnabled()));
  scheduleTuningChange();
});
$('mirror').addEventListener('change',setMirroring);
for(const id of ['scaleCorr','scaleLag','gainCorr','gainLag'])$(id).addEventListener('input',()=>{rememberDisplaySettings();updateControls();paintMaps();drawTraces();});

window.addEventListener('resize',drawTraces);
window.addEventListener('pagehide',()=>{cancelExampleDownload();stop(false);});
navigator.mediaDevices?.addEventListener?.('devicechange',refreshDevices);
window.getMCDDiagnostics=()=>({version:INTERFACE_VERSION,youtube:{supported:youtubeSupport().supported,cropped:!!youtubeCapture?.cropped,audio:!!audioTrack&&mode==='youtube',currentTabVerified:!!youtubeCapture?.currentTabVerified,valid:!!youtubeCapture?.isValid(),playerState:youtubeState,playerReady:youtubePlayer.ready,capturedAudioReplayed:false,modelDelayOnly:true},engine:engineName,resyncs:metrics.resyncs,queueBacklog,meanComputeMs:metrics.compute.length?metrics.compute.reduce((a,b)=>a+b,0)/metrics.compute.length:0,meanRenderMs:metrics.render.length?metrics.render.reduce((a,b)=>a+b,0)/metrics.render.length:0,playback:{mode,automatic:mode==='movie',delayScope:mode==='movie'?'playback-and-model':'model-inputs-only',audio:movieAudioOutput.status(),video:delayedPreview.status(),draining:!!movieTail},phase,running,starting,mode,moviePaused,seekActive,sourceKind:mode==='live'?'live':mode==='youtube'?'youtube-tab':movie?.builtInChart?'synchrony-chart':movie?.exampleFilename?'example-movie':'local-movie',position:mode==='youtube'?youtubePlayer.time():video.currentTime,duration:mode==='movie'?(movie?.duration||0):0,modelReady,busy,geometry:{...g},display:{corr:{palette:'violet',scale:$('scaleCorr').value,gainDb:+$('gainCorr').value},lag:{palette:'blue-orange',scale:$('scaleLag').value,gainDb:+$('gainLag').value}},tuning:tuning(),temporalPreset:activeTemporalPreset(),delay:+$('avDelay').value,loopCount,steps:lastStateSteps,resetCount,detectedCuts:metrics.detectedCuts,suppressedCuts:metrics.suppressedCuts,cutSuppression:cutsEnabled(),cutSensitivity:CUT_SENSITIVITY,lastCut:lastCutDetail?{...lastCutDetail}:null,cutWindows:cutEvents.map(e=>({start:e.start,end:e.end,t:e.t,kind:e.kind})),captured:metrics.captured,processed:metrics.processed,skipped:metrics.skipped,rms:lastRms,audioCoverage,actualVideoLag,lastTrace:traceData[traceData.length-1]||null,tracePoints:traceData.length,visualTraceGaps:traceData.filter(p=>!Number.isFinite(p.v[0])).length,visualTraceSamples:traceData.filter(p=>Number.isFinite(p.v[0])&&p.v[0]>0).length,movieChannels:movie?.envelope.channels||null,visualTracePeak:tracePeaks[0],recentVisualTrace:traceData.map(p=>({t:p.t,sourceT:p.sourceT,previousDifferenceT:p.previousDifferenceT,value:Number.isFinite(p.v[0])?p.v[0]:null}))});
makeWorker();$('movieCutControls').hidden=true;restoreDisplaySettings();updateControls();updatePalettes();setMirroring();refreshDevices();
void populateExampleMovies();
initialiseCore(requestedGeometry()).then(()=>{
  const requested=new URLSearchParams(window.location.search).get('example');
  if(isExampleMovieName(requested))void loadExampleMovie(requested);
}).catch(fail);
