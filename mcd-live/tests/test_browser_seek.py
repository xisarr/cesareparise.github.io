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
if not (FIXTURES/'test-moderate-cuts.mp4').exists():
    subprocess.run(['python',str(HERE/'make_moderate_fixture.py')],check=True)
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
    assert state()['version']=='simple-display-5'
    page.select_option('#inputMode','movie')
    page.set_input_files('#movieFile',str(FIXTURES/'test-moderate-cuts.mp4'))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=40000)
    assert page.locator('#movieSeek').is_enabled()
    assert 4.9<float(page.locator('#movieSeek').get_attribute('max'))<5.1
    report['checks']['scrubber_loaded_with_duration']='PASS'
    def seek(value):
      set_range('movieSeek',value)
      page.locator('#movieSeek').dispatch_event('change')
      page.wait_for_function('!getMCDDiagnostics().seekActive',timeout=8000)
    # Set a starting position while stopped; never auto-play.
    seek(.4)
    assert not state()['running'] and abs(state()['position']-.4)<.07
    page.wait_for_timeout(180);assert abs(state()['position']-.4)<.07
    page.click('#toggleRun');started()
    assert state()['position']>.4,state()
    report['checks']['seeking_stopped_then_start_at_selected_position']='PASS'
    # Moderate, letterboxed cut: old detector rejects it; this one masks it.
    page.wait_for_function("getMCDDiagnostics().lastCut?.kind==='edit'&&getMCDDiagnostics().visualTraceGaps>=1",timeout=9000)
    page.wait_for_timeout(250)
    d=state();assert abs(d['lastCut']['mediaTime']-1.4)<.1,d
    assert d['lastCut']['meanChange']<.17
    for point in d['recentVisualTrace']:
      if any(e['start']-1e-6<=point['sourceT']<=e['end']+1e-6 for e in d['cutWindows']):
        assert point['value'] is None,point
    assert d['visualTraceSamples']>0
    assert max((p['value'] or 0) for p in d['recentVisualTrace'])<.015,d['recentVisualTrace']
    report['checks']['moderate_edit_gap_and_no_residual_spike']='PASS'
    report['cut_example']=d
    # Real pause, then seek while paused. Readout and video must stay there.
    page.click('#pauseMovie');page.wait_for_function("getMCDDiagnostics().phase==='paused'")
    old=state()['position'];page.wait_for_timeout(250);assert abs(state()['position']-old)<.03
    seek(2.2);assert state()['moviePaused'] and state()['phase']=='paused'
    page.wait_for_timeout(250);assert abs(state()['position']-2.2)<.07
    assert page.locator('#pauseMovie').inner_text()=='Resume'
    page.click('#pauseMovie');page.wait_for_function("getMCDDiagnostics().phase==='running'")
    page.wait_for_timeout(200);assert state()['position']>2.2
    report['checks']['paused_scrub_stays_paused_and_resumes']='PASS'
    # Drag the actual native range with a mouse, while playing.
    slider=page.locator('#movieSeek');slider.scroll_into_view_if_needed();box=slider.bounding_box()
    page.mouse.move(box['x']+box['width']*.55,box['y']+box['height']/2)
    page.mouse.down();page.mouse.move(box['x']+box['width']*.10,box['y']+box['height']/2,steps=8)
    assert state()['seekActive'] and page.locator('#sourceVideo').evaluate('(v)=>v.paused')
    page.mouse.up();page.wait_for_function("!getMCDDiagnostics().seekActive&&getMCDDiagnostics().phase==='running'",timeout=8000)
    assert state()['position']<1.1
    assert state()['loopCount']==0
    report['checks']['mouse_drag_backwards_resumes_without_false_loop']='PASS'
    # Keyboard arrow navigation works too.
    page.click('#pauseMovie');slider.focus();before=state()['position'];page.keyboard.press('ArrowRight')
    page.wait_for_function('!getMCDDiagnostics().seekActive',timeout=8000)
    assert state()['moviePaused'] and abs(state()['position']-(before+.01))<.08
    report['checks']['keyboard_scrub_accessibility']='PASS'
    # Both delay polarities: gap mask follows the visual frame, not audio time.
    for delay in [400,-400]:
      set_range('avDelay',delay);page.wait_for_timeout(250);seek(.3)
      if state()['moviePaused']:page.click('#pauseMovie')
      page.wait_for_function("getMCDDiagnostics().suppressedCuts>=1&&getMCDDiagnostics().visualTraceGaps>=1",timeout=9000)
      d=state()
      for point in d['recentVisualTrace']:
        if any(e['start']-1e-6<=point['sourceT']<=e['end']+1e-6 for e in d['cutWindows']):assert point['value'] is None
      assert abs(d['actualVideoLag']-max(0,delay))<45
      page.click('#pauseMovie')
    report['checks']['gaps_aligned_at_positive_and_negative_av_delay']='PASS'
    # Looping keeps ordinary model state; selective cut reset continues.
    set_range('avDelay',0);page.wait_for_timeout(250);seek(4.5)
    page.click('#pauseMovie');before=state()['resetCount']
    page.wait_for_function('getMCDDiagnostics().loopCount>=1&&getMCDDiagnostics().suppressedCuts>=1',timeout=6000)
    d=state();assert d['resetCount']==before and d['visualTraceGaps']>=1
    report['checks']['known_loop_boundary_gap_without_full_reset']='PASS'
    # Raw mode retains the low-contrast edit rather than masking all big changes.
    page.locator('#displaySettings').evaluate('(e)=>e.open=true')
    page.uncheck('#suppressCuts');page.wait_for_timeout(300);seek(.3)
    page.wait_for_function('getMCDDiagnostics().position>1.7',timeout=6000)
    d=state();assert d['visualTraceGaps']==0
    assert max((p['value'] or 0) for p in d['recentVisualTrace'])>.03/2  # two-sample display average
    report['checks']['suppression_off_keeps_actual_cut_spike']='PASS'
    page.check('#suppressCuts');page.wait_for_timeout(250);seek(.5)
    page.wait_for_function('getMCDDiagnostics().suppressedCuts>=1',timeout=6000)
    page.click('#pauseMovie');page.locator('#displaySettings').evaluate('(e)=>e.open=false')
    # Capture gap and transport: original scientific layout stays intact.
    page.set_viewport_size({'width':1280,'height':1100});page.wait_for_timeout(150)
    assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
    page.screenshot(path=str(OUT/'seek-cuts-desktop.png'),full_page=True)
    page.locator('.input-panel').screenshot(path=str(OUT/'movie-scrubber.png'))
    page.locator('.trace-list').screenshot(path=str(OUT/'visual-gap.png'))
    page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150)
    assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
    page.screenshot(path=str(OUT/'seek-cuts-mobile.png'),full_page=True)
    report['checks']['desktop_mobile_layout']='PASS'
    # Stopping while a seek finalises cannot leave background playback running.
    set_range('movieSeek',2.8);page.locator('#movieSeek').dispatch_event('change');page.click('#toggleRun')
    page.wait_for_timeout(500)
    assert not state()['running'] and not state()['seekActive']
    assert page.locator('#sourceVideo').evaluate('(v)=>v.paused')
    report['checks']['stop_cancels_pending_seek']='PASS'
    assert not errors,errors
    report['javascript_errors']=errors;report['status']='PASS';b.close()
finally:
    server.shutdown();(HERE/'browser_seek_validation_report.json').write_text(json.dumps(json_clean(report),indent=2,allow_nan=False))
print(json.dumps(report,indent=2))
