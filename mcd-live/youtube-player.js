/* Official YouTube iframe API: the player is the only audible output.
 * No media is downloaded or decoded by this module. Player times are used
 * for seek detection only, never as calibrated capture timestamps.
 */
let apiPromise=null;
function loadAPI(){
  if(globalThis.YT?.Player)return Promise.resolve(globalThis.YT);
  if(apiPromise)return apiPromise;
  apiPromise=new Promise((resolve,reject)=>{
    const previous=globalThis.onYouTubeIframeAPIReady;
    const script=document.createElement('script');
    script.src='https://www.youtube.com/iframe_api';
    script.referrerPolicy='strict-origin-when-cross-origin';
    let finished=false;
    const finish=error=>{
      if(finished)return;finished=true;clearTimeout(timer);
      if(globalThis.onYouTubeIframeAPIReady===ready)globalThis.onYouTubeIframeAPIReady=previous;
      if(error){script.remove();apiPromise=null;reject(error);}
      else resolve(globalThis.YT);
    };
    const ready=()=>{
      try{previous?.();}catch(error){console.warn('An earlier YouTube API callback failed.',error);}
      finish(globalThis.YT?.Player?null:new Error('The YouTube player API did not initialise. Reload and try again.'));
    };
    globalThis.onYouTubeIframeAPIReady=ready;
    const timer=setTimeout(()=>finish(new Error('YouTube did not load. Check your connection or whether this site blocks YouTube embeds.')),20000);
    script.onerror=()=>finish(new Error('The YouTube player could not load. Check your connection or browser content settings.'));
    document.head.append(script);
  });
  return apiPromise;
}

const ERROR_MESSAGES={
  2:'YouTube could not recognise this video. Check the URL.',
  5:'This browser could not play the YouTube video. Try another video or browser.',
  100:'This YouTube video is unavailable, private or removed. Try another video.',
  101:'The owner does not allow this YouTube video to be embedded. Try another video.',
  150:'The owner does not allow this YouTube video to be embedded. Try another video.',
  153:'YouTube could not identify this website. Open the demo over HTTPS or localhost and allow its normal referrer header.'
};
export class YouTubePlayer{
  constructor(iframe,{onState=()=>{},onError=()=>{},onAutoplayBlocked=()=>{}}={}){
    this.iframe=iframe;this.parent=iframe.parentElement;this.template=iframe.cloneNode(false);
    this.onState=onState;this.onError=onError;this.onAutoplayBlocked=onAutoplayBlocked;
    this.player=null;this.ready=false;this.state=-1;this.key=null;this.serial=0;this.cancelLoad=null;
  }
  load({id,startSeconds=0}){
    const key=`${id}:${startSeconds}`;
    if(this.ready&&this.key===key)return Promise.resolve(this);
    this.unload();this.key=key;const serial=this.serial;
    const src=new URL(`https://www.youtube.com/embed/${id}`);
    for(const [name,value] of Object.entries({enablejsapi:1,origin:location.origin,playsinline:1,fs:0,autoplay:0,rel:0,start:startSeconds}))src.searchParams.set(name,String(value));
    this.iframe.src=src.href;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=error=>{
        if(settled)return;settled=true;clearTimeout(timer);this.cancelLoad=null;
        if(error)reject(error);else resolve(this);
      };
      this.cancelLoad=()=>finish(new DOMException('YouTube load cancelled.','AbortError'));
      const timer=setTimeout(()=>finish(new Error('The YouTube embed did not become ready. The video or site may block embedding; try another video.')),25000);
      loadAPI().then(YT=>{
        if(serial!==this.serial||settled)return;
        this.player=new YT.Player(this.iframe,{
          events:{
            onReady:()=>{
              if(serial!==this.serial||settled)return;
              this.ready=true;finish();
            },
            onStateChange:event=>{
              if(serial!==this.serial)return;
              const previous=this.state;this.state=event.data;
              this.onState(this.state,previous);
            },
            onAutoplayBlocked:()=>{if(serial===this.serial)this.onAutoplayBlocked();},
            onError:event=>{
              if(serial!==this.serial)return;
              const error=new Error(ERROR_MESSAGES[event.data]||`YouTube playback failed (error ${event.data}). Try another video.`);
              this.ready=false;finish(error);this.onError(error);
            }
          }
        });
      }).catch(error=>{if(serial===this.serial)finish(error);});
    });
  }
  play(){if(this.ready)this.player.playVideo();}
  pause(){
    if(this.ready){try{this.player.pauseVideo();}catch{this.unload();}}
    else this.unload();
  }
  unload(){
    this.serial++;this.cancelLoad?.();this.cancelLoad=null;
    try{this.player?.destroy();}catch{}
    this.player=null;this.ready=false;this.state=-1;this.key=null;
    this.iframe.remove();
    this.iframe=this.template.cloneNode(false);this.iframe.removeAttribute('src');
    this.parent.append(this.iframe);
  }
  time(){
    if(!this.ready)return null;
    try{const t=this.player.getCurrentTime();return Number.isFinite(t)?t:null;}catch{return null;}
  }
  rate(){try{return this.player?.getPlaybackRate?.()||1;}catch{return 1;}}
}
