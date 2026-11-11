/** Pure helper checks. Uses explicit capture API substitutes, not native capture.
 * Run: node tests/test_youtube_input.mjs [output-directory]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {webcrypto} from 'node:crypto';
import {parseYouTubeURL,youtubeSupport,acquireYouTubeTab} from '../youtube-input.js';

const out=path.resolve(process.argv[2]||new URL('./youtube-test-output/',import.meta.url).pathname);
fs.mkdirSync(out,{recursive:true});
const report={status:'FAIL',runtime:'Node; capture APIs replaced with test doubles',native_capture_tested:false,checks:{}};
const check=(name,body)=>{body();report.checks[name]='PASS';};
const asyncCheck=async(name,body)=>{await body();report.checks[name]='PASS';};
const videoId='dQw4w9WgXcQ';
let environment;
function install({kind='good',capturePromise=null,cropPromise=null}={}){
  const e={kind,config:null,requests:[],micCalls:0,crops:[],targetRegions:[],tracks:[],capturePromise,cropPromise};
  environment=e;
  Object.defineProperty(globalThis,'isSecureContext',{configurable:true,value:true});
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('https://example.test/mcd-live/')});
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{
    setCaptureHandleConfig(config){e.config=config;},
    getDisplayMedia(options){e.requests.push(options);if(e.kind==='denied')return Promise.reject(new DOMException('Denied','NotAllowedError'));return e.capturePromise||Promise.resolve(e.stream);},
    getUserMedia(){e.micCalls++;throw Error('Microphone must never be requested');}
  }}});
  Object.defineProperty(globalThis,'CropTarget',{configurable:true,value:{async fromElement(region){e.targetRegions.push(region);if(e.kind==='target-reject')throw Error('No crop target');return {region};}}});
  class Track extends EventTarget {
    constructor(kind){super();this.kind=kind;this.readyState='live';this.enabled=true;this.stops=0;e.tracks.push(this);}
    stop(){this.stops++;this.readyState='ended';}
    getSettings(){return {displaySurface:e.kind==='window'?'window':e.kind==='screen'?'monitor':'browser'};}
    getCaptureHandle(){return {origin:e.kind==='wrong-origin'?'https://another.test':location.origin,handle:e.kind==='wrong-tab'?'wrong-tab':e.config?.handle};}
    async cropTo(target){e.crops.push(target);if(e.kind==='crop-reject')throw new DOMException('Cannot crop','NotSupportedError');if(e.cropPromise)await e.cropPromise;}
  }
  const video=new Track('video'),audio=new Track('audio');
  if(kind==='crop-missing')video.cropTo=undefined;
  if(kind==='handle-missing')video.getCaptureHandle=undefined;
  if(kind==='video-ended')video.readyState='ended';
  if(kind==='audio-disabled')audio.enabled=false;
  e.stream={getTracks:()=>[video,...(e.kind==='no-audio'?[]:[audio])],getVideoTracks:()=>e.kind==='no-video'?[]:[video],getAudioTracks:()=>e.kind==='no-audio'?[]:[audio],get active(){return this.getTracks().some(t=>t.readyState==='live');}};
  e.video=video;e.audio=audio;
  e.region={isConnected:true,getBoundingClientRect:()=>({x:0,y:0,width:640,height:360})};
  return e;
}
function assertReleased(e){assert(e.stream.getTracks().every(t=>t.readyState==='ended'));assert.equal(e.micCalls,0);}
async function rejectsKind(kind,code){const e=install({kind});await assert.rejects(acquireYouTubeTab(e.region),err=>err.name==='YouTubeInputError'&&err.code===code);assertReleased(e);return e;}

try {
  check('watch_short_share_embed_live_and_bare_host_links',()=>{
    for(const url of [
      `https://www.youtube.com/watch?v=${videoId}`,`https://m.youtube.com/watch?v=${videoId}&feature=share`,
      `https://youtu.be/${videoId}?si=tracking`, `youtu.be/${videoId}`, `youtube.com/watch?v=${videoId}`,
      `https://www.youtube.com/shorts/${videoId}`,`https://www.youtube.com/live/${videoId}`,
      `https://www.youtube.com/embed/${videoId}`,`https://www.youtube-nocookie.com/embed/${videoId}`
    ])assert.deepEqual(parseYouTubeURL(url),{id:videoId,startSeconds:0},url);
  });
  check('timestamps_and_tracking_parameter_isolation',()=>{
    assert.deepEqual(parseYouTubeURL(`https://youtu.be/${videoId}?t=1h2m3s&si=discarded`),{id:videoId,startSeconds:3723});
    assert.equal(parseYouTubeURL(`https://www.youtube.com/watch?v=${videoId}&start=67`).startSeconds,67);
    assert.equal(parseYouTubeURL(`https://youtu.be/${videoId}#t=20s`).startSeconds,20);
    for(const t of ['-2','NaN','1e50','2147483648','bad'])assert.equal(parseYouTubeURL(`https://youtu.be/${videoId}?t=${encodeURIComponent(t)}`).startSeconds,0);
  });
  check('invalid_hosts_protocols_credentials_and_video_ids_rejected',()=>{
    for(const url of ['', 'javascript:alert(1)', 'file:///tmp/video', `https://youtube.com.evil.test/watch?v=${videoId}`,
      `https://evil.test/?v=${videoId}`,`https://youtube.com@evil.test/watch?v=${videoId}`,`https://user:password@youtube.com/watch?v=${videoId}`,
      `https://youtube.com:8443/watch?v=${videoId}`,`https://youtube.com/watch?v=too-short`,`https://youtu.be/${videoId}/extra`,
      `https://www.youtube.com/playlist?list=PL123`, '<iframe src="https://youtube.com/"></iframe>'
    ])assert.throws(()=>parseYouTubeURL(url),e=>e.code==='invalid-url',url);
  });
  check('support_requires_secure_network_context_capture_handle_and_region_capture',()=>{
    install();assert(youtubeSupport().supported);
    Object.defineProperty(globalThis,'isSecureContext',{value:false,configurable:true});assert(!youtubeSupport().supported);
    install();navigator.mediaDevices.getDisplayMedia=undefined;assert(!youtubeSupport().supported);
    install();navigator.mediaDevices.setCaptureHandleConfig=undefined;assert(!youtubeSupport().supported);
    install();CropTarget.fromElement=undefined;assert(!youtubeSupport().supported);
    install();Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('file:///tmp/index.html')});assert(!youtubeSupport().supported);
  });
  await asyncCheck('unsupported_context_fails_before_requesting_any_media',async()=>{
    const e=install();CropTarget.fromElement=undefined;
    await assert.rejects(acquireYouTubeTab(e.region),err=>err.code==='unsupported');
    assert.equal(e.requests.length,0);assert.equal(e.micCalls,0);
  });
  await asyncCheck('current_tab_audio_and_crop_are_verified_before_success',async()=>{
    const e=install();const pending=acquireYouTubeTab(e.region);
    assert.equal(e.requests.length,1,'Capture must be requested synchronously before an await loses user activation');
    const capture=await pending;
    assert.equal(e.requests[0].preferCurrentTab,true);assert.equal(e.requests[0].selfBrowserSurface,'include');
    assert.equal(e.requests[0].systemAudio,'exclude');assert.equal(e.requests[0].surfaceSwitching,'exclude');
    assert.equal(e.requests[0].audio.suppressLocalAudioPlayback,false);
    assert.equal(e.requests[0].audio.echoCancellation,false);assert.equal(e.requests[0].audio.noiseSuppression,false);
    assert.equal(e.crops.length,1);assert.equal(e.targetRegions[0],e.region);
    assert(capture.cropped&&capture.currentTabVerified&&capture.isValid());
    capture.release();capture.release();assertReleased(e);assert.equal(e.video.stops,1);assert(!capture.isValid());
  });
  await asyncCheck('window_screen_other_tab_and_origin_rejected',async()=>{
    for(const kind of ['window','screen','wrong-tab','wrong-origin'])await rejectsKind(kind,'wrong-tab');
  });
  await asyncCheck('missing_audio_video_or_required_track_apis_release_all_tracks',async()=>{
    for(const [kind,code] of [['no-audio','missing-audio'],['no-video','missing-video'],['video-ended','missing-video'],['audio-disabled','missing-audio'],['crop-missing','unsupported'],['handle-missing','unsupported']])await rejectsKind(kind,code);
  });
  await asyncCheck('crop_target_and_crop_failure_stop_capture_instead_of_using_whole_tab',async()=>{
    await rejectsKind('crop-reject','crop-failed');await rejectsKind('target-reject','crop-failed');
  });
  await asyncCheck('permission_denial_is_clear_and_never_requests_microphone',async()=>{
    const e=install({kind:'denied'});
    await assert.rejects(acquireYouTubeTab(e.region),err=>err.code==='capture-failed'&&/cancelled or denied/.test(err.message));
    assert.equal(e.micCalls,0);
  });
  await asyncCheck('cancel_during_permission_wait_releases_late_capture',async()=>{
    let resolve;const deferred=new Promise(r=>resolve=r),e=install({capturePromise:deferred});let current=true;
    const pending=acquireYouTubeTab(e.region,{isCurrent:()=>current});current=false;resolve(e.stream);
    await assert.rejects(pending,err=>err.code==='cancelled');assertReleased(e);
  });
  await asyncCheck('cancel_during_crop_wait_releases_late_capture',async()=>{
    let resolve;const deferred=new Promise(r=>resolve=r),e=install({cropPromise:deferred});let current=true;
    const pending=acquireYouTubeTab(e.region,{isCurrent:()=>current});
    for(let n=0;n<6&&!e.crops.length;n++)await Promise.resolve();
    assert.equal(e.crops.length,1);current=false;resolve();
    await assert.rejects(pending,err=>err.code==='cancelled');assertReleased(e);
  });
  await asyncCheck('share_end_audio_end_and_changed_tab_stop_the_entire_stream_once',async()=>{
    for(const event of ['video-ended','audio-ended','capturehandlechange']){
      const e=install(),messages=[];const capture=await acquireYouTubeTab(e.region,{onEnded:m=>messages.push(m)});
      if(event==='capturehandlechange'){e.kind='wrong-tab';e.video.dispatchEvent(new Event('capturehandlechange'));}
      else (event==='video-ended'?e.video:e.audio).dispatchEvent(new Event('ended'));
      assertReleased(e);assert.equal(messages.length,1);assert(!capture.isValid());
      e.video.dispatchEvent(new Event('ended'));assert.equal(messages.length,1);
    }
  });
  await asyncCheck('capture_validity_detects_mutated_identity_or_disabled_audio_between_events',async()=>{
    const e=install(),capture=await acquireYouTubeTab(e.region);
    e.audio.enabled=false;assert(!capture.isValid());e.audio.enabled=true;assert(capture.isValid());
    e.kind='wrong-tab';assert(!capture.isValid());capture.release();assertReleased(e);
  });
  report.status='PASS';
} catch(error){report.failure=error.stack;process.exitCode=1;}
fs.writeFileSync(path.join(out,'youtube-input-unit-report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
