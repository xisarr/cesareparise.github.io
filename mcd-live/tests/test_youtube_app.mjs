/** Application integration test without a browser.
 * Actual application modules, native Node workers and shipped WASM run against
 * explicit DOM/media/player/capture doubles. This validates application state
 * and routing; it DOES NOT validate layout, codecs, browser capture or YouTube.
 * Run: node tests/test_youtube_app.mjs [output-directory]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import {Worker as NodeWorker} from 'node:worker_threads';
import {webcrypto} from 'node:crypto';
import {File as NodeFile} from 'node:buffer';

const root=new URL('../',import.meta.url),html=fs.readFileSync(new URL('index.html',root),'utf8');
const out=path.resolve(process.argv[2]||new URL('./youtube-test-output/',import.meta.url).pathname);
fs.mkdirSync(out,{recursive:true});
const report={status:'FAIL',runtime:'Real application modules and native Node worker/WASM; DOM, canvas pixels, media decoding, audio devices, capture and YouTube API are test doubles',browser_tested:false,native_capture_tested:false,checks:{}};
const realConsole=console,logs=[],unhandled=[],workers=[],nodes=[],videos=[],rafCallbacks=new Map();
let clock=1000,nextId=0,frameNumber=0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
process.on('unhandledRejection',error=>unhandled.push(String(error?.stack||error)));
const elements=new Map(),windowEvents=new EventTarget();
class Element extends EventTarget {
  constructor(tag='div',attrs={}){
    super();this.tagName=tag.toUpperCase();this.attributes={...attrs};this.id=attrs.id||'';this.dataset={};this.style={setProperty(name,value){this[name]=value;}};
    this.value=attrs.value??'';this.checked='checked' in attrs;this.disabled='disabled' in attrs;this.hidden='hidden' in attrs;
    this.min=attrs.min??'';this.max=attrs.max??'';this.step=attrs.step??'';this.textContent='';this.innerHTML='';this.open=false;
    this.children=[];this.options=[];this.parentElement=null;this.isConnected=false;this.clientWidth=460;this.clientHeight=47;
    this.width=300;this.height=150;this.classNames=new Set((attrs.class||'').split(/\s+/));
    this.classList={toggle:(name,on)=>{if(on??!this.classNames.has(name))this.classNames.add(name);else this.classNames.delete(name);},contains:name=>this.classNames.has(name)};
  }
  getAttribute(name){return this.attributes[name]??null;}
  setAttribute(name,value){this.attributes[name]=String(value);if(name==='id')this.id=String(value);}
  removeAttribute(name){delete this.attributes[name];if(name==='src')this.src='';}
  append(...children){for(const child of children){child.remove();child.parentElement=this;child.isConnected=this.isConnected;this.children.push(child);if(child.id&&child.isConnected)elements.set(child.id,child);}}
  appendChild(child){this.append(child);return child;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);if(elements.get(this.id)===this)elements.delete(this.id);this.parentElement=null;this.isConnected=false;}
  cloneNode(){return new Element(this.tagName,this.attributes);}
  contains(node){return node===this||this.children.some(child=>child.contains(node));}
  focus(){document.activeElement=this;}
  replaceChildren(...children){this.children=[];this.options=children;this.append(...children);if(this.tagName==='SELECT')this.value=children[0]?.value||'';}
  add(option){this.options.push(option);this.append(option);}
  getBoundingClientRect(){return {x:0,y:0,width:this.clientWidth,height:this.clientHeight};}
  getContext(){if(!this.context)this.context=new CanvasContext(this);return this.context;}
}
class CanvasContext {
  constructor(canvas){this.canvas=canvas;this.source=null;}
  drawImage(source){this.source=source;}
  getImageData(_x,_y,w,h){
    const data=new Uint8ClampedArray(w*h*4),f=this.source?.frame||0;
    for(let i=0;i<w*h;i++){const x=i%w,y=Math.floor(i/w),v=((x+f)%w<Math.max(2,w/10)&&y>h/3&&y<h*2/3)?210:110;data.set([v,v,v,255],i*4);}
    return {data,width:w,height:h};
  }
  createImageData(w,h){return {data:new Uint8ClampedArray(w*h*4),width:w,height:h};}
  putImageData(){} setTransform(){} clearRect(){} fillRect(){} beginPath(){} moveTo(){} lineTo(){} stroke(){} fill(){} save(){} restore(){} setLineDash(){} fillText(){} measureText(text){return {width:String(text).length*6};}
}
class Video extends Element {
  constructor(attrs={}){super('video',attrs);this.src='';this.srcObject=null;this.videoWidth=640;this.videoHeight=360;this.readyState=0;this.duration=4;this.currentTime=0;this.paused=true;this.ended=false;this.seeking=false;this.muted=true;this.volume=1;this.loop=false;this.frame=0;this.callbacks=new Map();videos.push(this);}
  async play(){this.paused=false;this.readyState=4;}
  pause(){this.paused=true;}
  load(){this.currentTime=0;this.readyState=this.src?4:0;this.ended=false;queueMicrotask(()=>{this.dispatchEvent(new Event('loadedmetadata'));this.dispatchEvent(new Event('loadeddata'));});}
  requestVideoFrameCallback(callback){const id=++nextId;this.callbacks.set(id,callback);return id;}
  cancelVideoFrameCallback(id){this.callbacks.delete(id);}
  getVideoPlaybackQuality(){return {totalVideoFrames:this.frame,droppedVideoFrames:0};}
}
function attributes(text){const attrs={};for(const m of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[m[1]]=m[2]??'';return attrs;}
for(const m of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)){
  const attrs=attributes(m[2]);if(!attrs.id)continue;
  const element=m[1]==='video'?new Video(attrs):new Element(m[1],attrs);element.isConnected=true;elements.set(attrs.id,element);
  if(m[1]==='select'){
    const body=html.slice(m.index+m[0].length).split('</select>')[0];
    element.options=[...body.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map(item=>{const a=attributes(item[1]),e=new Element('option',a);e.textContent=item[2];return e;});
    element.value=element.options.find(o=>'selected' in o.attributes)?.value??element.options[0]?.value??'';
  }
}
const documentEvents=new EventTarget(),body=new Element('body'),head=new Element('head'),documentElement=new Element('html');
body.isConnected=head.isConnected=documentElement.isConnected=true;
const region=elements.get('youtubePlayerRegion'),iframe=elements.get('youtubePlayer');iframe.parentElement=region;region.children.push(iframe);
const bars=new Map([['.correlation-bar',new Element('span')],['.lag-bar',new Element('span')]]);
const document={body,head,documentElement,activeElement:null,visibilityState:'visible',
  getElementById:id=>elements.get(id)||null,
  createElement:tag=>tag==='video'?new Video():new Element(tag),
  querySelector:selector=>bars.get(selector)||null,
  addEventListener:documentEvents.addEventListener.bind(documentEvents),removeEventListener:documentEvents.removeEventListener.bind(documentEvents)};
class Option extends Element {constructor(label,value){super('option',{value});this.textContent=label;}}
class Track extends EventTarget {
  constructor(kind,captured=false){super();this.kind=kind;this.captured=captured;this.readyState='live';this.enabled=true;this.muted=false;this.stopped=0;}
  stop(){this.readyState='ended';this.stopped++;}
  getSettings(){return {displaySurface:mediaTest.kind==='window'?'window':'browser',width:640,height:360};}
  getCaptureHandle(){return {handle:mediaTest.kind==='wrong-tab'?'other':mediaTest.handle,origin:location.origin};}
  async cropTo(target){mediaTest.crops.push(target);if(mediaTest.kind==='crop-reject')throw new DOMException('Test crop failure','NotSupportedError');}
}
class MediaStream {
  constructor(tracks=[]){this.tracks=[...tracks];}
  getTracks(){return this.tracks;}
  getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}
  getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}
  get active(){return this.tracks.some(t=>t.readyState==='live');}
}
const mediaTest={kind:'good',calls:0,micCalls:0,handle:null,crops:[],streams:[],finishPermission:null};
function newStream(captured=false){const tracks=[new Track('video',captured)];if(mediaTest.kind!=='no-audio'||!captured)tracks.push(new Track('audio',captured));const stream=new MediaStream(tracks);mediaTest.streams.push(stream);return stream;}
const mediaDevices=new EventTarget();
Object.assign(mediaDevices,{enumerateDevices:async()=>[],setCaptureHandleConfig:config=>{mediaTest.handle=config.handle;},
  getUserMedia:async()=>{mediaTest.micCalls++;return newStream();},
  getDisplayMedia:async options=>{mediaTest.calls++;mediaTest.options=options;if(mediaTest.kind==='denied')throw new DOMException('Denied','NotAllowedError');const stream=newStream(true);if(mediaTest.kind==='pending')await new Promise(resolve=>{mediaTest.finishPermission=resolve;});return stream;}});
class Param {constructor(value=0){this.value=value;}setValueAtTime(value){this.value=value;}}
class AudioNode {
  constructor(context,kind){this.context=context;this.kind=kind;this.connections=[];nodes.push(this);}
  connect(node){this.connections.push(node);return node;}
  disconnect(){this.connections=[];}
}
class AudioContext {
  constructor(){this.state='suspended';this.start=clock;this.sampleRate=48000;this.destination=new AudioNode(this,'destination');this.audioWorklet={addModule:async()=>{throw Error('No browser AudioWorklet in Node test; exercise analyser fallback');}};}
  get currentTime(){return (clock-this.start)/1000;}
  async resume(){this.state='running';}
  async suspend(){this.state='suspended';}
  async close(){this.state='closed';}
  createGain(){const n=new AudioNode(this,'gain');n.gain=new Param(1);return n;}
  createDelay(){const n=new AudioNode(this,'delay');n.delayTime=new Param();return n;}
  createAnalyser(){const n=new AudioNode(this,'analyser');n.fftSize=2048;n.getFloatTimeDomainData=buffer=>{for(let i=0;i<buffer.length;i++)buffer[i]=.1*Math.sin(i*.13);};return n;}
  createMediaStreamSource(stream){const n=new AudioNode(this,'stream-source');n.stream=stream;return n;}
  createMediaElementSource(video){const n=new AudioNode(this,'element-source');n.video=video;return n;}
}
class OfflineAudioContext {
  async decodeAudioData(){const channels=[0,1].map(c=>Float32Array.from({length:192000},(_,i)=>.12*Math.sin(2*Math.PI*(440+c*220)*i/48000)));return {numberOfChannels:2,sampleRate:48000,getChannelData:i=>channels[i]};}
}
class Worker {
  constructor(url){
    const moduleURL=new URL(url,root);moduleURL.search='';this.ready=false;this.queue=[];this.dead=false;
    const bootstrap=`const {parentPort}=require('node:worker_threads');const fs=require('node:fs/promises');globalThis.self={postMessage:(m,t)=>parentPort.postMessage(m,t)};globalThis.fetch=async u=>{const url=new URL(u,${JSON.stringify(moduleURL.href)});url.search='';const b=await fs.readFile(url);return {ok:true,status:200,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}};(async()=>{await import(${JSON.stringify(moduleURL.href)});parentPort.on('message',m=>self.onmessage({data:m}));parentPort.postMessage({loaded:true})})().catch(e=>{throw e;});`;
    this.worker=new NodeWorker(bootstrap,{eval:true});workers.push(this);
    this.worker.on('message',data=>{if(data.loaded){this.ready=true;for(const [m,t] of this.queue)this.worker.postMessage(m,t);this.queue=[];}else if(!this.dead)this.onmessage?.({data});});
    this.worker.on('error',error=>this.onerror?.({message:error.message}));
  }
  postMessage(message,transfer=[]){if(this.ready)this.worker.postMessage(message,transfer);else this.queue.push([message,transfer]);}
  terminate(){this.dead=true;return this.worker.terminate();}
}
let yt;
class Player {
  constructor(frame,{events}){this.iframe=frame;this.events=events;this.base=0;this.since=clock;this.state=-1;this.calls=[];yt=this;queueMicrotask(()=>events.onReady({target:this}));}
  getCurrentTime(){return this.base+(this.state===1?(clock-this.since)/1000:0);}
  getPlaybackRate(){return 1;}
  emit(state){this.base=this.getCurrentTime();this.since=clock;this.state=state;this.events.onStateChange({data:state});}
  playVideo(){this.calls.push('play');this.emit(1);}
  pauseVideo(){this.calls.push('pause');this.emit(2);}
  destroy(){this.calls.push('destroy');this.state=-1;}
  seekTo(time){this.calls.push('seek');this.base=time;this.since=clock;}
}
Object.assign(globalThis,{window:globalThis,document,Option,MediaStream,AudioContext,OfflineAudioContext,Worker,File:globalThis.File||NodeFile,
  YT:{Player},CropTarget:{fromElement:async region=>({region})},
  requestAnimationFrame:callback=>{const id=++nextId;rafCallbacks.set(id,callback);return id;},cancelAnimationFrame:id=>rafCallbacks.delete(id),
  addEventListener:windowEvents.addEventListener.bind(windowEvents),removeEventListener:windowEvents.removeEventListener.bind(windowEvents)});
for(const [name,value] of Object.entries({navigator:{mediaDevices},location:new URL('http://localhost/mcd-live/'),isSecureContext:true,crypto:webcrypto,performance:{now:()=>clock}}))Object.defineProperty(globalThis,name,{configurable:true,value});
globalThis.fetch=async input=>{const url=input instanceof URL?new URL(input):new URL(input,root);url.search='';const data=await fsAsync.readFile(url);return {ok:true,status:200,json:async()=>JSON.parse(data.toString()),arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};};
globalThis.console={...realConsole,warn:(...args)=>logs.push(args.map(String).join(' ')),error:(...args)=>logs.push(args.map(String).join(' ')),info:(...args)=>logs.push(args.map(String).join(' '))};
const el=id=>{const node=document.getElementById(id);assert(node,`Missing real HTML element #${id}`);return node;};
const emit=(id,type)=>el(id).dispatchEvent(new Event(type,{cancelable:true}));
const click=id=>{assert(!el(id).disabled,`#${id} unexpectedly disabled`);emit(id,'click');};
const select=(id,value)=>{el(id).value=String(value);emit(id,'change');};
const range=(id,value)=>{el(id).value=String(value);emit(id,'input');};
const diagnostic=()=>getMCDDiagnostics();
async function until(predicate,message='Timed out',timeout=3000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error(message+'; status='+el('status').textContent);await delay(5);}}
async function frames(count){
  for(let n=0;n<count;n++){
    clock+=1000/30;frameNumber++;
    for(const video of videos){if(video.paused)continue;video.frame=frameNumber;if(!video.srcObject){video.currentTime+=1/30;if(video.currentTime>=video.duration){if(video.loop)video.currentTime%=video.duration;else{video.currentTime=video.duration;video.ended=true;video.paused=true;video.dispatchEvent(new Event('ended'));}}}
      const callbacks=[...video.callbacks.values()];video.callbacks.clear();for(const cb of callbacks)cb(clock,{mediaTime:video.currentTime,presentedFrames:frameNumber});}
    const callbacks=[...rafCallbacks.values()];rafCallbacks.clear();for(const cb of callbacks)cb(clock);
    // YouTube production sampling uses a real 33 ms timer for its invisible
    // sink. Keep the test clock close to wall time there; virtual rVFC-only
    // sources can still advance quickly without starving the real timer.
    await delay(typeof getMCDDiagnostics==='function'&&diagnostic().mode==='youtube'?35:3);
  }
  await delay(12);
}
function assertSilentCaptureGraph(){
  function walk(node,seen=new Set()){
    if(seen.has(node)||node.context.state!=='running')return false;seen.add(node);
    if(node.kind==='gain'&&node.gain.value===0)return false;
    if(node.kind==='destination')return true;
    return node.connections.some(next=>walk(next,new Set(seen)));
  }
  for(const node of nodes.filter(n=>n.kind==='stream-source'&&n.stream.getAudioTracks().some(t=>t.captured)))assert(!walk(node),'Captured soundtrack has a nonzero speaker path');
}
async function startYouTube(){
  select('inputMode','youtube');el('youtubeURL').value='https://youtu.be/dQw4w9WgXcQ?t=2';emit('youtubeURL','input');click('loadYouTube');
  await until(()=>diagnostic().running,'YouTube did not start');await frames(24);assert(diagnostic().processed>3,JSON.stringify(diagnostic()));
}
async function stop(){if(diagnostic().running||diagnostic().starting)click('toggleRun');await delay(10);assert(!diagnostic().running&&!diagnostic().starting);}
try{
  await import(new URL('mcd-live.js',root));
  await until(()=>diagnostic().modelReady,'Initial native worker/WASM startup failed',5000);
  assert.deepEqual(diagnostic().tuning,{v:45,a:36.7,late:180,scale:1});assert.equal(document.getElementById('moviePosition'),null);
  report.checks.real_html_initialisation_and_native_wasm_worker='PASS';

  await startYouTube();let d=diagnostic();
  assert.equal(d.sourceKind,'youtube-tab');assert(d.youtube.cropped&&d.youtube.audio&&d.youtube.currentTabVerified);
  assert(d.rms>0&&d.audioCoverage>.7,JSON.stringify(d));assert.equal(mediaTest.micCalls,0);
  assert.equal(mediaTest.crops[0].region.id,'youtubePlayerRegion');
  const sink=videos.find(v=>v.srcObject?.getVideoTracks()[0]?.captured);
  assert(sink&&sink.srcObject.getAudioTracks().length===0&&sink.muted&&sink.volume===0);
  assertSilentCaptureGraph();report.checks.youtube_tab_audio_and_cropped_video_process_without_microphone_or_feedback='PASS';

  const calls=yt.calls.length;
  for(const value of [400,-400,0]){
    range('avDelay',value);await delay(170);await frames(28);d=diagnostic();
    assert(d.running&&d.processed>3);assert.equal(d.delay,value);assert.equal(d.playback.delayScope,'model-inputs-only');
    assert(!d.playback.automatic&&!d.playback.audio.active&&!d.playback.video.visible);
    if(value>0)assert(Math.abs(d.actualVideoLag-value)<35,JSON.stringify(d));
    assertSilentCaptureGraph();
  }
  assert.equal(yt.calls.length,calls);assert(/playback timing is unchanged/.test(el('delayExplanation').textContent));
  report.checks.youtube_positive_negative_and_zero_model_delay_preserve_player_timing='PASS';

  range('gainCorr',-30);range('gainLag',-8);let resets=diagnostic().resetCount;await frames(4);assert.equal(diagnostic().resetCount,resets);
  range('avDelay',180);await delay(170);click('ratTuning');await delay(170);d=diagnostic();assert.deepEqual(d.tuning,{v:10,a:10,late:138,scale:1});assert.equal(d.delay,180);assert.equal(d.display.corr.gainDb,-30);
  click('resetTuning');await delay(170);assert.deepEqual(diagnostic().tuning,{v:45,a:36.7,late:180,scale:1});
  report.checks.presets_and_display_controls_preserve_existing_state_contract='PASS';

  yt.pauseVideo();await delay(15);const processed=diagnostic().processed;await frames(8);assert.equal(diagnostic().processed,processed);
  yt.playVideo();await delay(15);await frames(20);assert(diagnostic().processed>processed);
  resets=diagnostic().resetCount;yt.seekTo(25);await frames(14);assert(diagnostic().resetCount>resets);
  report.checks.player_pause_resume_and_seek_reset_analysis_segments='PASS';

  const activeCapture=mediaTest.streams.at(-1);
  for(const track of activeCapture.getTracks()){
    track.muted=true;await frames(3);const pausedCount=diagnostic().processed;
    assert(/interrupted/.test(el('status').textContent));
    await frames(4);assert.equal(diagnostic().processed,pausedCount);
    const beforeRecovery=diagnostic().resetCount;
    track.muted=false;await frames(24);
    assert(diagnostic().resetCount>beforeRecovery&&diagnostic().processed>pausedCount);
  }
  const capturedContext=nodes.find(node=>node.kind==='stream-source'&&node.context.state==='running'&&node.stream.getAudioTracks().some(track=>track.captured)).context;
  await capturedContext.suspend();await frames(3);const suspendedCount=diagnostic().processed;
  await frames(3);assert.equal(diagnostic().processed,suspendedCount);assert(/suspended/.test(el('audioStatus').textContent));
  await capturedContext.resume();await frames(24);assert(diagnostic().processed>suspendedCount);
  assert.equal(mediaTest.micCalls,0);assertSilentCaptureGraph();
  report.checks.muted_video_audio_and_suspended_audio_context_pause_then_reprime_analysis='PASS';

  const audio=mediaTest.streams.at(-1).getAudioTracks()[0];audio.dispatchEvent(new Event('ended'));await delay(15);
  assert(!diagnostic().running);assert(mediaTest.streams.at(-1).getTracks().every(t=>t.readyState==='ended'));
  assert(/soundtrack ended/.test(el('status').textContent));
  report.checks.shared_soundtrack_end_stops_and_releases_capture='PASS';

  // Real file-load workflow; media decoding is explicitly a generated double,
  // while the original audio-envelope worker and MCD worker remain real.
  select('inputMode','movie');el('movieFile').files=[new File(['test'],'test.mp4',{type:'video/mp4'})];emit('movieFile','change');
  await until(()=>el('status').textContent==='Movie ready','Movie load failed',5000);click('toggleRun');await until(()=>diagnostic().running);await frames(25);
  assert(diagnostic().processed>5&&diagnostic().movieChannels===2);
  for(const value of [400,-400,0]){
    range('avDelay',value);await delay(170);await frames(24);d=diagnostic();
    assert.equal(d.playback.audio.audioDelayMs,Math.max(0,-value));assert.equal(d.playback.video.visible,value>0);assert(d.playback.automatic);
  }
  click('pauseMovie');assert(diagnostic().moviePaused);range('movieSeek',1.2);emit('movieSeek','change');await until(()=>!diagnostic().seekActive);
  assert(diagnostic().moviePaused&&Math.abs(diagnostic().position-1.2)<.01);click('pauseMovie');await delay(15);await frames(6);assert(!diagnostic().moviePaused);
  await stop();report.checks.local_movie_worker_delay_pause_and_seek_paths_preserved='PASS';

  await startYouTube();assertSilentCaptureGraph();assert(!diagnostic().playback.audio.active);await stop();
  select('inputMode','live');click('toggleRun');await until(()=>diagnostic().running);await frames(18);assert(diagnostic().processed>3&&diagnostic().rms>0);
  await stop();assert.equal(mediaTest.micCalls,1);assert(mediaTest.streams.at(-1).getTracks().every(t=>t.readyState==='ended'));
  select('inputMode','youtube');assert.equal(diagnostic().display.corr.gainDb,-30);
  report.checks.movie_youtube_live_transitions_preserve_routing_and_per_mode_gains='PASS';

  for(const kind of ['no-audio','wrong-tab','window','crop-reject','denied']){
    mediaTest.kind=kind;const prior=mediaTest.micCalls;click('loadYouTube');await until(()=>!diagnostic().starting);
    assert(!diagnostic().running);assert.equal(el('status').dataset.kind,'error');assert.equal(mediaTest.micCalls,prior);
    assert(mediaTest.streams.every(stream=>stream.getTracks().every(t=>t.readyState==='ended')));
  }
  report.checks.failed_capture_paths_never_fall_back_to_microphone_or_whole_page='PASS';

  mediaTest.kind='pending';mediaTest.finishPermission=null;click('loadYouTube');await until(()=>!!mediaTest.finishPermission);
  click('toggleRun');mediaTest.finishPermission();await delay(30);assert(!diagnostic().running&&!diagnostic().starting);
  assert(mediaTest.streams.every(stream=>stream.getTracks().every(t=>t.readyState==='ended')));
  report.checks.cancelled_pending_permission_releases_late_stream='PASS';

  mediaTest.kind='good';const crop=globalThis.CropTarget;globalThis.CropTarget=undefined;select('inputMode','live');select('inputMode','youtube');
  assert(el('loadYouTube').disabled&&/browser/i.test(el('youtubeStatus').textContent));globalThis.CropTarget=crop;
  report.checks.unsupported_browser_message_and_disabled_capture='PASS';
  assert.deepEqual(unhandled,[]);report.unhandled_rejections=unhandled;report.status='PASS';
}catch(error){report.failure=error.stack;report.status='FAIL';process.exitCode=1;}
finally{
  windowEvents.dispatchEvent(new Event('pagehide'));
  await Promise.all(workers.map(worker=>worker.terminate()));
  globalThis.console=realConsole;
}
fs.writeFileSync(path.join(out,'youtube-app-integration-report.json'),JSON.stringify(report,null,2));
realConsole.log(JSON.stringify(report,null,2));
