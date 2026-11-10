"""Playback, controls and layout checks using deterministic local test movies.

Normal: python tests/test_browser.py
Restricted test environment: MCD_TEST_SHIM=1 python tests/test_browser.py

In shim mode, HTML is injected into about:blank and exact Worker source runs
through an in-page Worker API shim. Native decoding, playback, AudioContext,
Canvas, WebAssembly and UI remain real. This is NOT a native-browser-worker
or physical camera/microphone test. test_worker.mjs separately uses a native
Node worker thread. No testing shim is included in the production application.
"""
from pathlib import Path
import os, json, math, mimetypes, threading, subprocess, shutil
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from urllib.parse import urlsplit, unquote
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
HERE=Path(__file__).resolve().parent
SHIM=os.environ.get('MCD_TEST_SHIM')=='1'
FIXTURES=Path(os.environ.get('MCD_TEST_FIXTURES',str(HERE/'fixtures')))
OUT=Path(os.environ.get('MCD_TEST_PREVIEWS',str(HERE/'previews')));OUT.mkdir(parents=True,exist_ok=True)
if not (FIXTURES/'test-stereo.mp4').exists():
    subprocess.run(['bash',str(HERE/'make_fixtures.sh')],check=True)
class Handler(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
threading.Thread(target=server.serve_forever,daemon=True).start()
def json_clean(obj):
  if isinstance(obj,float) and not math.isfinite(obj): return None
  if isinstance(obj,dict): return {k:json_clean(v) for k,v in obj.items()}
  if isinstance(obj,list): return [json_clean(v) for v in obj]
  return obj
report={'status':'FAIL','worker_mode':'in-page shim' if SHIM else 'native browser worker','checks':{},'hardware_capture_tested':False}
try:
  with sync_playwright() as p:
    opt={'headless':True,'args':['--no-sandbox','--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}
    if os.environ.get('MCD_CHROMIUM') or shutil.which('chromium'): opt['executable_path']=os.environ.get('MCD_CHROMIUM') or shutil.which('chromium')
    b=p.chromium.launch(**opt);ctx=b.new_context(viewport={'width':1360,'height':1100},device_scale_factor=1)
    page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    if SHIM:
      def serve(route):
        relative=unquote(urlsplit(route.request.url).path).lstrip('/') or 'index.html'
        target=(ROOT/relative).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file():route.fulfill(status=404,headers={'Access-Control-Allow-Origin':'*'},body='');return
        mime='application/javascript' if target.suffix=='.js' else 'application/wasm' if target.suffix=='.wasm' else mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        route.fulfill(status=200,headers={'Access-Control-Allow-Origin':'*'},content_type=mime,body=target.read_bytes())
      ctx.route('https://mcd-demo.test/**',serve)
      page.evaluate("async()=>{window.testUtils=await import('https://mcd-demo.test/signal-utils.js')}")
      sources={name:(ROOT/name).read_text() for name in ['mcd-worker.js','movie-audio-worker.js']}
      page.evaluate(r'''sources=>{
        window.Worker=class{
          constructor(url){const name=new URL(url,'https://mcd-demo.test/').pathname.split('/').pop();this.dead=false;const owner=this;
            this.scope={postMessage(m,transfer=[]){const data=structuredClone(m,{transfer});queueMicrotask(()=>{if(!owner.dead)owner.onmessage?.({data})});}};
            new Function('self','fetch','buildMonoEnvelope',sources[name].replace(/^import .*?;\n/,''))(this.scope,(u,o)=>fetch(new URL(u,'https://mcd-demo.test/'),o),testUtils.buildMonoEnvelope);}
          postMessage(m,transfer=[]){const data=structuredClone(m,{transfer});queueMicrotask(()=>{if(!this.dead)this.scope.onmessage({data})});}
          terminate(){this.dead=true;}
        };
      }''',sources)
      page.set_content((ROOT/'index.html').read_text().replace('<head>','<head><base href="https://mcd-demo.test/">'),wait_until='networkidle')
    else: page.goto(f'http://127.0.0.1:{server.server_port}/',wait_until='networkidle')
    page.wait_for_function('window.getMCDDiagnostics?.().modelReady')
    state=lambda:page.evaluate('getMCDDiagnostics()')
    def set_range(id,value):
      page.locator('#'+id).fill(str(value));page.locator('#'+id).dispatch_event('input')
    def started():page.wait_for_function("getMCDDiagnostics().phase==='running'&&getMCDDiagnostics().processed>10",timeout=25000)
    assert state()['tuning']=={'v':45,'a':36.7,'late':180,'scale':1}
    assert not page.locator('#displaySettings').evaluate('(e)=>e.open')
    assert page.locator('#gainCorr').input_value()=='0' and page.locator('#gainLag').input_value()=='-40'
    assert page.locator('#gainCorr').get_attribute('min')=='-60' and page.locator('#gainLag').get_attribute('max')=='20'
    assert page.locator('#suppressCuts').is_checked()
    assert page.locator('#displaySettings').evaluate('(e)=>{const g=document.querySelector(".demo-grid");return !!(e.compareDocumentPosition(g)&Node.DOCUMENT_POSITION_FOLLOWING)}')
    assert page.locator('#tauV').get_attribute('min')=='1' and page.locator('#tauLate').get_attribute('max')=='800'
    assert page.locator('#avDelay').get_attribute('min')=='-600'
    report['checks']['controls_and_defaults']='PASS'
    page.select_option('#inputMode','movie');page.set_input_files('#movieFile',str(FIXTURES/'test-stereo.mp4'))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=40000)
    page.click('#toggleRun');started();before=state()
    page.wait_for_function('getMCDDiagnostics().loopCount>=2',timeout=20000)
    after=state();assert after['resetCount']==before['resetCount'];assert after['steps']>before['steps']
    assert after['movieChannels']==2 and after['rms']>0
    assert after['geometry']['vw']==640 and after['geometry']['vh']==360
    assert after['visualTraceSamples']>0 and after['visualTraceGaps']>0
    assert after['detectedCuts']>=2 and after['suppressedCuts']>=1
    report['checks']['stereo_movie_full_frame_and_continuous_loops']='PASS'
    report['loop_sample']=after
    page.screenshot(path=str(OUT/'desktop.png'),full_page=True);page.locator('.demo-grid').screenshot(path=str(OUT/'grid.png'))
    set_range('avDelay',600);page.wait_for_timeout(1400);assert abs(state()['actualVideoLag']-600)<37
    set_range('avDelay',-600);page.wait_for_timeout(1400);assert abs(state()['actualVideoLag'])<1
    report['checks']['positive_and_negative_delay']='PASS'
    page.locator('#displaySettings').evaluate('(e)=>e.open=true')
    page.select_option('#downsample','16');page.wait_for_timeout(700);g=state()['geometry'];assert g['vw']==640 and g['vh']==360 and g['w']==40
    page.select_option('#downsample','8');page.wait_for_timeout(700);g=state()['geometry'];assert g['w']==80 and g['h']==45 and abs(g['aspect']-16/9)<1e-9
    assert g['vw']==640 and g['vh']==360
    report['checks']['full_frame_downsampling_no_stretch']='PASS'
    page.select_option('#downsample','1');page.wait_for_timeout(1000)
    assert state()['geometry']['w']==640 and state()['geometry']['h']==360 and not state()['geometry']['capped']
    page.select_option('#downsample','8');page.wait_for_timeout(700)
    report['checks']['true_full_resolution_option']='PASS'
    count=state()['resetCount'];page.select_option('#scaleCorr','linear');set_range('gainCorr',-60);page.wait_for_timeout(300)
    assert 'dB' not in page.locator('#gainCorrValue').inner_text();assert state()['resetCount']==count
    page.select_option('#scaleCorr','db');assert 'dB' in page.locator('#gainCorrValue').inner_text()
    report['checks']['display_only_settings']='PASS'
    set_range('tauV',23);set_range('tauA',76.3);set_range('tauLate',500);set_range('timeScale',1);page.wait_for_timeout(400)
    assert state()['tuning']=={'v':23,'a':76.3,'late':500,'scale':2}
    page.click('#resetTuning');page.wait_for_timeout(400);assert state()['tuning']=={'v':45,'a':36.7,'late':180,'scale':1}
    report['checks']['independent_temporal_controls_and_reset']='PASS'
    # Stop immediately after a parameter event; the controls must not deadlock.
    set_range('tauV',60);page.click('#toggleRun');page.wait_for_timeout(450);assert state()['modelReady'] and not state()['running']
    page.click('#toggleRun');started();page.click('#toggleRun');assert not state()['running']
    report['checks']['stop_restart_during_parameter_change']='PASS'
    page.set_input_files('#movieFile',str(FIXTURES/'test-portrait.webm'))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=40000)
    page.select_option('#downsample','8');page.wait_for_timeout(500);page.click('#zeroDelay');page.click('#resetTuning');page.wait_for_timeout(500)
    set_range('gainCorr',-40);set_range('gainLag',-40);page.locator('#displaySettings').evaluate('(e)=>e.open=false')
    page.click('#toggleRun');started();assert state()['geometry']['aspect']==360/640
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(300)
    assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
    page.screenshot(path=str(OUT/'mobile.png'),full_page=True)
    report['checks']['portrait_webm_and_mobile_layout']='PASS'
    page.click('#toggleRun');page.set_viewport_size({'width':1200,'height':1000})
    # In shim mode the OS forbids real capture. Simulate MediaStreams with an
    # actual canvas capture stream and AudioContext oscillator instead.
    if SHIM:
      page.evaluate('''()=>{
        Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});
        window.fakeMediaDelay=0;window.fakeMediaCalls=0;window.fakeCreatedTracks=[];
        Object.defineProperty(navigator,'mediaDevices',{value:{
          enumerateDevices:async()=>[{kind:'videoinput',deviceId:'test-camera',label:'Synthetic camera'},{kind:'audioinput',deviceId:'test-mic',label:'Synthetic microphone'}],
          addEventListener(){},
          getUserMedia:async()=>{window.fakeMediaCalls++;await new Promise(r=>setTimeout(r,window.fakeMediaDelay));
            const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const c=canvas.getContext('2d');let step=0;
            const clock=setInterval(()=>{c.fillStyle=step%20<10?'#888':'#ddd';c.fillRect(0,0,640,480);c.fillStyle='#124';c.fillRect((step++*7)%600,120,40,100)},33);
            const s=canvas.captureStream(30),a=new AudioContext();a.resume();const oscillator=a.createOscillator(),gain=a.createGain(),dest=a.createMediaStreamDestination();
            oscillator.frequency.value=440;gain.gain.value=.1;oscillator.connect(gain);gain.connect(dest);oscillator.start();s.addTrack(dest.stream.getAudioTracks()[0]);
            for(const track of s.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();clearInterval(clock);a.close().catch(()=>{})};window.fakeCreatedTracks.push(track);}
            return s;
          }
        },configurable:true});
      }''')
    page.select_option('#inputMode','live');page.click('#toggleRun');started();page.wait_for_timeout(900)
    live=state();assert live['rms']>0 and live['geometry']['aspect']==live['geometry']['vw']/live['geometry']['vh']
    report['checks']['synthetic_live_audio_and_video']='PASS';report['live_sample']=live
    page.click('#toggleRun');assert not state()['running']
    if SHIM:
      page.evaluate('window.fakeMediaDelay=700');page.click('#toggleRun');page.wait_for_timeout(80);page.click('#toggleRun');page.wait_for_timeout(1000)
      assert not state()['running'] and not state()['starting']
      assert page.evaluate('window.fakeCreatedTracks.every(t=>t.readyState==="ended")')
      report['checks']['cancel_start_releases_late_media_tracks']='PASS'
    # Test an actual encoded 30-fps video containing a strong two-sided hard edit.
    page.select_option('#inputMode','movie')
    page.set_input_files('#movieFile',str(FIXTURES/'test-edits.mp4'))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=40000)
    assert page.locator('#suppressCuts').is_checked()
    page.click('#toggleRun');started()
    page.wait_for_function('getMCDDiagnostics().suppressedCuts>=1',timeout=14000)
    cut_state=state();assert cut_state['detectedCuts']>=1 and cut_state['suppressedCuts']>=1
    assert cut_state['visualTraceGaps']>=1, 'Suppressed editing cut must create a missing video-change sample'
    report['checks']['encoded_scene_edit_suppression_and_trace_gap']='PASS'
    # Disabling cut suppression retains the full raw visual-change trace.
    page.locator('#displaySettings').evaluate('(e)=>e.open=true')
    page.uncheck('#suppressCuts')
    page.wait_for_function('getMCDDiagnostics().processed>15',timeout=14000)
    page.wait_for_timeout(1200)
    assert state()['visualTraceGaps']==0, 'Raw mode must not insert missing samples'
    report['checks']['raw_video_changes_when_cut_suppression_disabled']='PASS'
    page.click('#toggleRun')
    assert not errors,errors
    report['javascript_errors']=errors;report['status']='PASS';b.close()
finally:
    server.shutdown();(HERE/'browser_validation_report.json').write_text(json.dumps(json_clean(report),indent=2,allow_nan=False))
print(json.dumps(report,indent=2))
