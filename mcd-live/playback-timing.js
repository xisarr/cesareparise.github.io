/* Movie playback follows the same causal delay convention as the model.
 * There is one movie decoder. No second HTML audio element, periodic seeking,
 * or extra user control is used. The native soundtrack is routed through a
 * Web Audio delay; positive offsets select older coloured video frames.
 */
export function playbackDelays(ms) {
  const seconds = Math.max(-600, Math.min(600, Number(ms) || 0)) / 1000;
  return {audio: Math.max(0, -seconds), video: Math.max(0, seconds)};
}

export class MovieAudioOutput {
  constructor(video, createContext = () => new AudioContext({latencyHint:'interactive'})) {
    this.video=video; this.createContext=createContext;
    this.context=null; this.source=null; this.delay=null; this.gain=null;
    this.delaySeconds=0; this.audible=true; this.active=false; this.serial=0;
  }
  ensure() {
    if (this.context) return;
    this.context=this.createContext();
    this.source=this.context.createMediaElementSource(this.video);
    this.gain=this.context.createGain();
    this.gain.gain.value=0;
    this.gain.connect(this.context.destination);
    this.flush();
  }
  flush() {
    if (!this.context) return;
    // A fresh delay line prevents pre-seek/pre-stop audio leaking through.
    this.source.disconnect();
    if (this.delay) this.delay.disconnect();
    this.delay=this.context.createDelay(1);
    this.delay.delayTime.setValueAtTime(this.delaySeconds,this.context.currentTime);
    this.source.connect(this.delay); this.delay.connect(this.gain);
  }
  setDelay(ms) {
    const next=playbackDelays(ms).audio;
    if (next!==this.delaySeconds) {
      this.delaySeconds=next;
      // Keep the causal input history when the slider moves. Only a seek or
      // a fresh run discards it; ramping this value would change audio pitch.
      if(this.delay)this.delay.delayTime.setValueAtTime(next,this.context.currentTime);
    }
  }
  setAudible(value) {
    this.audible=!!value;
    if(this.gain) this.gain.gain.setValueAtTime(this.active&&this.audible?1:0,this.context.currentTime);
  }
  async resume(ms,audible) {
    const ticket=++this.serial;
    this.ensure(); this.setDelay(ms); this.audible=!!audible;
    // createMediaElementSource redirects the element: this does not create
    // a second native soundtrack. Use the downstream gain for Hear movie audio.
    this.video.muted=false;
    this.active=true;
    await this.context.resume();
    if(ticket!==this.serial) return false;
    if(this.context.state!=='running') throw new Error('Movie audio could not start. Press Stop, then Start movie.');
    this.setAudible(this.audible);
    return true;
  }
  pause({flush=false}={}) {
    ++this.serial; this.active=false;
    if (!this.context) return;
    this.setAudible(this.audible);
    if(flush) this.flush();
    this.context.suspend().catch(()=>{});
  }
  status() {
    return {routed:!!this.source,active:this.active,audible:this.active&&this.audible,
      contextState:this.context?.state||'not-created',audioDelayMs:1000*this.delaySeconds};
  }
}

export class DelayedVideoPreview {
  constructor(canvas,{maxEdge=960,historySeconds=.75}={}) {
    this.canvas=canvas;this.items=[];this.maxEdge=maxEdge;this.historySeconds=historySeconds;
    this.lastSourceTime=null;this.lastTargetTime=null;this.lastAnchorTime=null;
  }
  clear({hide=true}={}) {
    // Explicitly release graphics buffers, rather than waiting for GC.
    for(const item of this.items){item.image.width=1;item.image.height=1;}
    this.items=[];this.lastSourceTime=null;this.lastTargetTime=null;this.lastAnchorTime=null;
    if(hide)this.canvas.hidden=true;
  }
  capture(video,t,delayMs) {
    const seconds=playbackDelays(delayMs).video;
    if(!seconds) { if(this.items.length||!this.canvas.hidden)this.clear(); return; }
    const scale=Math.min(1,this.maxEdge/Math.max(video.videoWidth,video.videoHeight));
    const image=document.createElement('canvas');
    image.width=Math.max(1,Math.round(video.videoWidth*scale));
    image.height=Math.max(1,Math.round(video.videoHeight*scale));
    image.getContext('2d',{alpha:false}).drawImage(video,0,0,image.width,image.height);
    this.items.push({t,image});
    // Retain one frame preceding the buffer boundary for sample-and-hold.
    while(this.items.length>2&&this.items[1].t<t-this.historySeconds) {
      const old=this.items.shift();old.image.width=1;old.image.height=1;
    }
    this.present(t,delayMs);
  }
  present(anchorTime,delayMs) {
    const seconds=playbackDelays(delayMs).video;
    if(!seconds){this.canvas.hidden=true;return;}
    const target=anchorTime-seconds;
    let chosen=null;
    for(let i=this.items.length-1;i>=0;i--) if(this.items[i].t<=target+1e-7){chosen=this.items[i];break;}
    // On initial buffering hold the initial image instead of showing a jump.
    chosen=chosen||this.items[0]; if(!chosen)return;
    if(this.canvas.width!==chosen.image.width||this.canvas.height!==chosen.image.height){
      this.canvas.width=chosen.image.width;this.canvas.height=chosen.image.height;
    }
    this.canvas.getContext('2d',{alpha:false}).drawImage(chosen.image,0,0);
    this.canvas.hidden=false;
    this.lastSourceTime=chosen.t;this.lastTargetTime=target;this.lastAnchorTime=anchorTime;
  }
  status() {
    return {visible:!this.canvas.hidden,bufferedFrames:this.items.length,
      anchorTime:this.lastAnchorTime,sourceTime:this.lastSourceTime,targetTime:this.lastTargetTime,
      actualVideoDelayMs:this.lastSourceTime===null?0:1000*(this.lastAnchorTime-this.lastSourceTime)};
  }
}
