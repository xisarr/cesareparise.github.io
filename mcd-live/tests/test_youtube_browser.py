"""Focused YouTube-interface and preservation checks.

Run with Python Playwright, Chromium and FFmpeg installed:
  python3 tests/test_youtube_browser.py --output /tmp/mcd-youtube-qa

Uses native browser Workers, WebAssembly, video/audio decoding and Web Audio.
Synthetic capture tests deliberately replace the permission/capture APIs; they
DO NOT validate a real browser share picker, native tab audio or Region Capture.
No test substitute is included in the application source.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument('--output', type=Path, default=Path(__file__).resolve().parent / 'youtube-test-output')
PARSER.add_argument('--section', choices=['regressions', 'youtube', 'all'], default='all')
ARGS = PARSER.parse_args()
OUT = ARGS.output.resolve()
OUT.mkdir(parents=True, exist_ok=True)
FIXTURES = OUT / 'fixtures'
FIXTURES.mkdir(exist_ok=True)


def fixtures():
    common = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
    stereo = FIXTURES / 'test-stereo.mp4'
    if not stereo.exists():
        subprocess.run(common + ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
            '-f', 'lavfi', '-i', 'aevalsrc=0.18*sin(2*PI*440*t)*(0.5+0.5*sin(2*PI*2*t))|0.12*sin(2*PI*660*t)*(0.5+0.5*sin(2*PI*2*t)):s=48000:d=4',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-shortest', '-movflags', '+faststart', str(stereo)], check=True)
    edits = FIXTURES / 'test-edits.mp4'
    if not edits.exists():
        subprocess.run(common + ['-f', 'lavfi', '-i', 'color=c=black:size=640x360:rate=30:duration=3',
            '-f', 'lavfi', '-i', 'sine=frequency=540:sample_rate=48000:duration=3',
            '-filter_complex', "[0:v]drawbox=x=0:y=0:w=320:h=360:color=white:t=fill:enable='lt(t,1.2)',drawbox=x=320:y=0:w=320:h=360:color=white:t=fill:enable='gte(t,1.2)'[v]",
            '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', str(edits)], check=True)


class Handler(SimpleHTTPRequestHandler):
    """Supply only the two absent catalogue files as deterministic test fixtures."""
    def log_message(self, *_args):
        pass

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ['/examples/av_synchrony_chart.mp4', '/examples/Ventriloquist_Movie.mp4']:
            data = (FIXTURES / 'test-stereo.mp4').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()


def save_report(name, report):
    (OUT / name).write_text(json.dumps(report, indent=2, allow_nan=False))


def new_page(browser, base, init=None):
    context = browser.new_context(viewport={'width': 1360, 'height': 1000}, device_scale_factor=1)
    # YouTube network playback is outside this reproducible test. The iframe
    # remains real DOM, but no claim is made about external playback.
    context.route('**://*.youtube.com/**', lambda r: r.fulfill(status=200, content_type='text/html', body='<html><body>YouTube test placeholder</body></html>'))
    context.route('**://*.youtube-nocookie.com/**', lambda r: r.fulfill(status=200, content_type='text/html', body='<html><body>YouTube test placeholder</body></html>'))
    if init:
        context.add_init_script(init)
    page = context.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(base, wait_until='domcontentloaded')
    page.wait_for_function('window.getMCDDiagnostics?.().modelReady', timeout=20000)
    return context, page, errors


def setrange(page, name, value):
    page.locator('#' + name).fill(str(value))
    page.locator('#' + name).dispatch_event('input')


def state(page):
    return page.evaluate('getMCDDiagnostics()')


def start(page, min_frames=8):
    page.click('#toggleRun')
    page.wait_for_function(f'getMCDDiagnostics().running && getMCDDiagnostics().processed > {min_frames}', timeout=25000)


def movie(page, filename='test-stereo.mp4'):
    if state(page)['mode'] != 'movie':
        page.select_option('#inputMode', 'movie')
    page.set_input_files('#movieFile', str(FIXTURES / filename))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'", timeout=30000)


def seek(page, target):
    setrange(page, 'movieSeek', target)
    page.locator('#movieSeek').dispatch_event('change')
    page.wait_for_function('!getMCDDiagnostics().seekActive', timeout=8000)


def stop_if_running(page):
    if state(page)['running'] or state(page)['starting']:
        page.click('#toggleRun')
    page.wait_for_function('!getMCDDiagnostics().running && !getMCDDiagnostics().starting')


SYNTHETIC_MEDIA = r"""
window.testCapture = {calls:0, micCalls:0, tracks:[], crops:[], options:[], cleanup:[], kind:'good', handle:null};
window.makeTestMedia = async function({audio=true, capture=false}={}) {
  const c=document.createElement('canvas'); c.width=640; c.height=360;
  const x=c.getContext('2d'); let k=0;
  function draw(){x.fillStyle='#777';x.fillRect(0,0,640,360);x.fillStyle='#eee';x.fillRect((k++*9)%590,100,50,100);}
  draw();const timer=setInterval(draw,33);
  const stream=c.captureStream(30), track=stream.getVideoTracks()[0];
  let ac;
  if(audio){
    ac=new AudioContext();await ac.resume();
    const o=ac.createOscillator(),gain=ac.createGain(),dest=ac.createMediaStreamDestination();
    o.frequency.value=440;gain.gain.value=.12;o.connect(gain);gain.connect(dest);o.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
  }
  const cleanup=()=>{clearInterval(timer);if(ac&&ac.state!=='closed')ac.close().catch(()=>{});};
  testCapture.cleanup.push(cleanup);
  for(const t of stream.getTracks()){
    const original=t.stop.bind(t);t.stop=()=>{original();if(stream.getTracks().every(q=>q.readyState==='ended'))cleanup();};
    testCapture.tracks.push(t);
  }
  if(capture){
    track.getSettings=()=>({displaySurface:testCapture.kind==='window'?'window':'browser',width:640,height:360});
    track.getCaptureHandle=()=>testCapture.kind==='wrong-tab'?{handle:'another-tab',origin:location.origin}:({handle:testCapture.handle,origin:location.origin});
    track.cropTo=async target=>{testCapture.crops.push(target);if(testCapture.kind==='crop-reject')throw new DOMException('Synthetic crop rejection','NotSupportedError');};
    if(testCapture.kind==='crop-missing')delete track.cropTo;
  }
  return stream;
};
"""


def regressions(browser, base):
    report = {'status': 'FAIL', 'runtime': 'Native Chromium workers/WASM/media decoding/Web Audio',
              'physical_devices_tested': False, 'native_tab_capture_tested': False,
              'example_files': 'Catalogue downloads use deterministic test fixtures; original ZIP lacks both listed MP4 files.', 'checks': {}}
    context = None
    try:
        context, page, errors = new_page(browser, base, SYNTHETIC_MEDIA)
        d = state(page)
        assert d['tuning'] == {'v': 45, 'a': 36.7, 'late': 180, 'scale': 1}, d
        assert d['display']['corr']['palette'] == 'violet' and d['display']['lag']['palette'] == 'blue-orange'
        assert page.locator('#moviePosition').count() == 0
        assert page.locator('label').filter(has=page.locator('#loopMovie')).inner_text().strip() == 'Loop'
        assert page.locator('label').filter(has=page.locator('#hearMovie')).inner_text().strip() == 'Play audio'
        report['checks']['initial_defaults_and_short_toolbar_labels'] = 'PASS'

        movie(page)
        label_boxes = [page.locator('label[for="'+i+'"]').bounding_box() for i in ['exampleMovie','movieFile']]
        assert abs(label_boxes[0]['y']-label_boxes[1]['y']) <= 2, label_boxes
        assert page.locator('#movieInfo').bounding_box()['x'] > page.locator('#inputMode').bounding_box()['x']
        assert page.locator('#movieSeek').is_enabled()
        assert 3.9 < float(page.locator('#movieSeek').get_attribute('max')) < 4.1
        page.screenshot(path=str(OUT/'movie-toolbar-desktop.png'), full_page=True)
        report['checks']['toolbar_alignment_and_loaded_transport'] = 'PASS'

        seek(page, .4)
        assert not state(page)['running'] and abs(state(page)['position']-.4)<.07
        start(page)
        d=state(page);assert d['rms']>0 and d['movieChannels']==2 and d['processed']>8
        assert d['playback']['automatic']
        report['checks']['native_local_movie_decode_processing_and_stopped_seek'] = 'PASS'

        count=d['resetCount']
        setrange(page, 'gainCorr', -28);setrange(page,'gainLag',-12)
        page.select_option('#scaleCorr','linear');page.locator('#scaleCorr').dispatch_event('input')
        page.wait_for_timeout(220)
        d=state(page);assert d['resetCount']==count
        assert d['display']['corr']['gainDb']==-28 and d['display']['lag']['gainDb']==-12
        report['checks']['display_gains_and_scale_do_not_reset_model'] = 'PASS'

        for delay in [400,-400,0]:
            setrange(page,'avDelay',delay);page.wait_for_timeout(1000)
            d=state(page);assert d['running'] and d['delay']==delay
            assert abs(d['playback']['audio']['audioDelayMs']-max(0,-delay))<.001,d
            if delay>0:
                assert d['playback']['video']['visible'],d
                assert abs(d['playback']['video']['actualVideoDelayMs']-delay)<85,d
                assert abs(d['actualVideoLag']-delay)<85,d
            else: assert not d['playback']['video']['visible'],d
        report['checks']['both_movie_playback_delay_polarities_and_zero'] = 'PASS'

        page.click('#pauseMovie');page.wait_for_function('getMCDDiagnostics().moviePaused')
        seek(page,1.6)
        d=state(page);assert d['moviePaused'] and abs(d['position']-1.6)<.07
        page.wait_for_timeout(180);assert abs(state(page)['position']-1.6)<.07
        page.click('#pauseMovie');page.wait_for_function("getMCDDiagnostics().phase==='running'")
        page.wait_for_timeout(200);assert state(page)['position']>1.6
        report['checks']['pause_seek_resume_keeps_transport_state'] = 'PASS'

        setrange(page,'avDelay',230);page.wait_for_timeout(200)
        page.click('#ratTuning');page.wait_for_timeout(220)
        d=state(page);assert d['tuning']=={'v':10,'a':10,'late':138,'scale':1} and d['delay']==230,d
        assert d['display']['corr']['gainDb']==-28 and d['display']['lag']['gainDb']==-12
        page.click('#resetTuning');page.wait_for_timeout(220)
        d=state(page);assert d['tuning']=={'v':45,'a':36.7,'late':180,'scale':1} and d['delay']==230,d
        report['checks']['temporal_presets_preserve_delay_and_gains'] = 'PASS'

        setrange(page,'avDelay',0);page.wait_for_timeout(220)
        seek(page,3.55);before=state(page)['resetCount']
        page.wait_for_function('getMCDDiagnostics().loopCount>=1',timeout=6000)
        assert state(page)['resetCount']==before
        report['checks']['loop_preserves_model_state'] = 'PASS'

        stop_if_running(page);movie(page,'test-edits.mp4');start(page)
        page.wait_for_function('getMCDDiagnostics().suppressedCuts>=1',timeout=7000)
        d=state(page);assert d['visualTraceGaps']>0
        page.locator('#downsamplingDetails').evaluate('(e)=>e.open=true')
        page.click('#suppressCuts');page.wait_for_timeout(250);seek(page,.3)
        page.wait_for_function('getMCDDiagnostics().position>1.6',timeout=5000)
        d=state(page);assert not d['cutSuppression'] and d['visualTraceGaps']==0,d
        page.click('#suppressCuts');page.wait_for_timeout(220)
        page.locator('#downsamplingDetails').evaluate('(e)=>e.open=false')
        report['checks']['cut_suppression_and_raw_cut_mode'] = 'PASS'

        stop_if_running(page)
        page.select_option('#exampleMovie','Ventriloquist_Movie.mp4')
        page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=30000)
        assert state(page)['sourceKind']=='example-movie' and state(page)['cutSuppression']
        start(page);assert state(page)['rms']>0
        stop_if_running(page);page.click('#loadSynchronyChart')
        page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=30000)
        assert state(page)['sourceKind']=='synchrony-chart' and not state(page)['cutSuppression']
        report['checks']['catalogue_and_synchrony_chart_loading_with_fixture_responses'] = 'PASS'

        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(120)
        assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
        page.screenshot(path=str(OUT/'movie-toolbar-mobile.png'),full_page=True)
        page.set_viewport_size({'width':1360,'height':1000})
        report['checks']['mobile_layout_without_horizontal_overflow'] = 'PASS'

        # After movie Web Audio has been used, test camera/microphone semantics
        # with real synthetic media tracks, not fake media-data objects.
        page.evaluate("navigator.mediaDevices.getUserMedia=async()=>{testCapture.micCalls++;return makeTestMedia();}")
        page.select_option('#inputMode','live');start(page);page.wait_for_timeout(650)
        d=state(page);assert d['mode']=='live' and d['rms']>0 and d['audioCoverage']>.7,d
        assert not d['playback']['audio']['active']
        stop_if_running(page)
        assert page.evaluate("testCapture.micCalls===1 && testCapture.tracks.every(t=>t.readyState==='ended')")
        page.select_option('#inputMode','movie')
        assert state(page)['display']['corr']['gainDb']==-28
        report['checks']['movie_to_synthetic_live_and_back_releases_tracks_preserves_settings'] = 'PASS'

        assert not errors,errors
        report['javascript_errors']=errors
        report['version']=state(page)['version']
        report['status']='PASS'
    except Exception:
        report['failure']=traceback.format_exc()
        raise
    finally:
        if context:context.close()
        save_report('regression-report.json',report)
    return report


YOUTUBE_MOCKS = SYNTHETIC_MEDIA + r"""
// Every capture/player replacement is explicit. Native browser media streams,
// audio worklets, workers, WASM and canvas remain the shipped implementation.
navigator.mediaDevices.setCaptureHandleConfig=config=>{testCapture.handle=config.handle;};
navigator.mediaDevices.getUserMedia=()=>{testCapture.micCalls++;throw Error('Unexpected microphone request in YouTube mode');};
navigator.mediaDevices.getDisplayMedia=async options=>{
  testCapture.calls++;testCapture.options.push(options);
  if(testCapture.kind==='denied')throw new DOMException('Synthetic permission denial','NotAllowedError');
  const stream=await makeTestMedia({audio:testCapture.kind!=='no-audio',capture:true});
  testCapture.lastStream=stream;
  if(testCapture.kind==='pending')await new Promise(resolve=>{testCapture.finishPermission=resolve;});
  return stream;
};
window.CropTarget={fromElement:async region=>({regionId:region.id})};
window.testYT=null;
window.YT={Player:class {
  constructor(iframe,options){
    this.iframe=iframe;this.options=options;this.state=-1;this.base=0;this.since=performance.now();
    this.calls=[];this.playbackRate=1;window.testYT=this;
    queueMicrotask(()=>options.events.onReady({target:this}));
  }
  getCurrentTime(){return this.base+(this.state===1?(performance.now()-this.since)/1000*this.playbackRate:0);}
  getPlaybackRate(){return this.playbackRate;}
  emit(state){this.base=this.getCurrentTime();this.since=performance.now();this.state=state;this.options.events.onStateChange({data:state,target:this});}
  playVideo(){this.calls.push('play');this.emit(1);}
  pauseVideo(){this.calls.push('pause');this.emit(2);}
  seekTo(time){this.calls.push('seek');this.base=time;this.since=performance.now();}
  destroy(){this.calls.push('destroy');this.state=-1;}
}};
window.testAudioEdges=[];window.testCapturedAudioSources=[];
const testConnect=AudioNode.prototype.connect,testDisconnect=AudioNode.prototype.disconnect;
AudioNode.prototype.connect=function(destination,...rest){testAudioEdges.push([this,destination]);return testConnect.call(this,destination,...rest);};
AudioNode.prototype.disconnect=function(...args){
  testAudioEdges=testAudioEdges.filter(([a,b])=>a!==this||(args.length&&b!==args[0]));
  return testDisconnect.apply(this,args);
};
const testMakeSource=AudioContext.prototype.createMediaStreamSource;
AudioContext.prototype.createMediaStreamSource=function(stream){
  const node=testMakeSource.call(this,stream);
  if(stream.getAudioTracks().some(track=>testCapture.tracks.includes(track)))testCapturedAudioSources.push(node);
  return node;
};
window.hasAudibleCapturePath=()=>{
  function visit(node,seen){
    if(seen.has(node))return false;seen.add(node);
    if(node instanceof GainNode&&node.gain.value===0)return false;
    if(node instanceof AudioDestinationNode)return true;
    return testAudioEdges.some(([a,b])=>a===node&&visit(b,new Set(seen)));
  }
  return testCapturedAudioSources.some(node=>visit(node,new Set()));
};
"""


def youtube_tests(browser, base):
    report={'status':'FAIL','runtime':'Native Chromium workers/WASM/Web Audio with synthetic tab streams and mocked capture/player APIs',
            'native_share_picker_tested':False,'native_region_capture_tested':False,
            'native_tab_audio_tested':False,'real_youtube_playback_tested':False,'checks':{}}
    context=None
    try:
        context,page,errors=new_page(browser,base,YOUTUBE_MOCKS)
        page.select_option('#inputMode','youtube')
        page.fill('#youtubeURL','https://example.test/not-youtube')
        page.click('#loadYouTube')
        page.wait_for_function("document.querySelector('#status').dataset.kind==='error'")
        assert page.evaluate('testCapture.calls===0 && testCapture.micCalls===0')
        report['checks']['invalid_url_never_requests_capture_or_microphone']='PASS'

        page.fill('#youtubeURL','https://youtu.be/dQw4w9WgXcQ?t=2')
        page.click('#loadYouTube')
        page.wait_for_function("getMCDDiagnostics().mode==='youtube' && getMCDDiagnostics().processed>10",timeout=20000)
        d=state(page)
        assert d['sourceKind']=='youtube-tab' and not d['playback']['automatic'],d
        assert d['playback']['delayScope']=='model-inputs-only',d
        assert d['youtube']['cropped'] and d['youtube']['currentTabVerified'] and d['youtube']['audio'],d
        assert d['rms']>0 and d['audioCoverage']>.7,d
        assert page.evaluate("testCapture.calls===1 && testCapture.micCalls===0 && testCapture.crops.length===1 && testCapture.crops[0].regionId==='youtubePlayerRegion'")
        assert page.locator('#youtubePlayer').get_attribute('src').startswith('https://www.youtube.com/embed/dQw4w9WgXcQ?')
        assert page.locator('#movieTransport').is_hidden()
        assert page.locator('#sourceVideo').is_hidden()
        assert page.evaluate('!hasAudibleCapturePath()')
        assert page.evaluate("[...document.querySelectorAll('video')].filter(v=>v.srcObject).every(v=>v.muted && v.srcObject.getAudioTracks().length===0)")
        report['checks']['synthetic_player_region_and_soundtrack_reach_real_model_without_audio_feedback']='PASS'

        before=page.evaluate('testYT.getCurrentTime()')
        for delay in [400,-400,0]:
            setrange(page,'avDelay',delay);page.wait_for_timeout(850)
            d=state(page);assert d['running'] and d['delay']==delay,d
            assert not d['playback']['audio']['active'] and not d['playback']['video']['visible'],d
            assert not d['playback']['automatic'] and d['playback']['delayScope']=='model-inputs-only',d
            assert page.evaluate("!testYT.calls.includes('seek') && !hasAudibleCapturePath()")
            assert 'playback timing is unchanged' in page.locator('#delayExplanation').inner_text()
        assert page.evaluate('testYT.getCurrentTime()')>before+1.5
        report['checks']['youtube_delays_affect_model_only_without_seeking_or_replaying_player']='PASS'

        page.evaluate('testYT.pauseVideo()');page.wait_for_timeout(180)
        before=state(page)['processed'];page.wait_for_timeout(180);assert state(page)['processed']==before
        page.evaluate('testYT.playVideo()');page.wait_for_function(f'getMCDDiagnostics().processed>{before+5}')
        before=state(page)['resetCount'];page.evaluate('testYT.seekTo(30)')
        page.wait_for_function(f'getMCDDiagnostics().resetCount>{before}',timeout=3000)
        report['checks']['player_pause_resume_and_seek_start_fresh_analysis_segments']='PASS'

        page.screenshot(path=str(OUT/'youtube-synthetic-desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150)
        assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
        page.screenshot(path=str(OUT/'youtube-synthetic-mobile.png'),full_page=True)
        page.set_viewport_size({'width':1360,'height':1000})
        report['checks']['youtube_mobile_layout_without_horizontal_overflow']='PASS'

        page.evaluate("testCapture.lastStream.getAudioTracks()[0].dispatchEvent(new Event('ended'))")
        page.wait_for_function('!getMCDDiagnostics().running')
        assert page.evaluate("testCapture.tracks.every(t=>t.readyState==='ended') && testCapture.micCalls===0")
        assert 'soundtrack ended' in page.locator('#status').inner_text().lower()
        report['checks']['shared_audio_end_releases_capture_and_explains_restart']='PASS'

        # Re-enter after local-movie playback created its persistent audio graph.
        movie(page);start(page);stop_if_running(page)
        page.select_option('#inputMode','youtube');page.click('#loadYouTube')
        page.wait_for_function("getMCDDiagnostics().mode==='youtube' && getMCDDiagnostics().processed>8",timeout=20000)
        assert page.evaluate('!hasAudibleCapturePath() && testCapture.micCalls===0')
        page.select_option('#inputMode','movie')
        assert page.evaluate("testCapture.tracks.every(t=>t.readyState==='ended')")
        assert not state(page)['running']
        report['checks']['movie_youtube_movie_switch_keeps_audio_routing_separate_and_releases_capture']='PASS'
        assert not errors,errors
        context.close();context=None

        for kind,phrase in [('no-audio','no tab audio'),('wrong-tab','share this mcd tab'),('window','share this mcd tab'),('crop-reject','could not isolate'),('crop-missing','cannot verify and crop'),('denied','cancelled or denied')]:
            context,page,errors=new_page(browser,base,YOUTUBE_MOCKS)
            page.evaluate('(kind)=>testCapture.kind=kind',kind)
            page.select_option('#inputMode','youtube');page.fill('#youtubeURL','https://youtu.be/dQw4w9WgXcQ')
            page.click('#loadYouTube')
            page.wait_for_function("document.querySelector('#status').dataset.kind==='error' && !getMCDDiagnostics().starting")
            assert phrase in page.locator('#status').inner_text().lower(),page.locator('#status').inner_text()
            assert page.evaluate("testCapture.micCalls===0 && testCapture.tracks.every(t=>t.readyState==='ended')")
            assert not state(page)['running'] and not errors,errors
            report['checks']['fail_closed_'+kind.replace('-','_')]='PASS'
            context.close();context=None

        context,page,errors=new_page(browser,base,YOUTUBE_MOCKS)
        page.evaluate("testCapture.kind='pending'")
        page.select_option('#inputMode','youtube');page.fill('#youtubeURL','https://youtu.be/dQw4w9WgXcQ')
        page.click('#loadYouTube');page.wait_for_function('!!testCapture.finishPermission')
        page.click('#toggleRun');page.evaluate('testCapture.finishPermission()')
        page.wait_for_function("testCapture.tracks.every(t=>t.readyState==='ended')")
        assert not state(page)['running'] and not state(page)['starting'] and page.evaluate('testCapture.micCalls===0')
        assert not errors,errors
        report['checks']['cancel_pending_share_stops_late_stream']='PASS'
        context.close();context=None

        context,page,errors=new_page(browser,base,YOUTUBE_MOCKS+"\nwindow.CropTarget=undefined;")
        page.select_option('#inputMode','youtube');page.fill('#youtubeURL','https://youtu.be/dQw4w9WgXcQ')
        assert page.locator('#loadYouTube').is_disabled()
        assert 'browser' in page.locator('#youtubeStatus').inner_text().lower()
        assert page.evaluate('testCapture.calls===0 && testCapture.micCalls===0')
        assert not errors,errors
        report['checks']['unsupported_browser_has_visible_message_and_disabled_capture']='PASS'
        report['javascript_errors']=[]
        report['status']='PASS'
    except Exception:
        report['failure']=traceback.format_exc()
        raise
    finally:
        if context:context.close()
        save_report('youtube-browser-report.json',report)
    return report


if __name__=='__main__':
    fixtures()
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_port}/'
    reports={}
    try:
        with sync_playwright() as p:
            try:
                browser=p.chromium.launch(executable_path=os.environ.get('MCD_CHROMIUM') or shutil.which('chromium'),headless=True,
                    args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
            except Exception as error:
                save_report('browser-launch-report.json', {'status':'BLOCKED','reason':str(error).split('Call log:')[0],
                    'browser_tests_run':False,'physical_devices_tested':False,'native_tab_capture_tested':False})
                raise
            save_report('browser-launch-report.json', {'status':'PASS','native_tab_capture_tested':False})
            try:
                if ARGS.section in ('regressions','all'):reports['regressions']=regressions(browser,base)
                if ARGS.section in ('youtube','all'):reports['youtube']=youtube_tests(browser,base)
            finally:browser.close()
    finally:server.shutdown()
    print(json.dumps(reports,indent=2))
