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
            this.scope={postMessage(m,transfer=[]){const data=structuredClone(m,{transfer});setTimeout(()=>{if(!owner.dead)owner.onmessage?.({data})},data.type==='frame'?85:0);}};
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
    page.select_option('#inputMode','movie');page.set_input_files('#movieFile',str(FIXTURES/'test-moderate-cuts.mp4'))
    page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=40000)
    set_range('avDelay',400);page.wait_for_timeout(300);page.click('#toggleRun');started()
    page.wait_for_function('getMCDDiagnostics().suppressedCuts>=1&&getMCDDiagnostics().visualTraceGaps>=1',timeout=10000)
    page.wait_for_timeout(400);d=state()
    assert d['skipped']>0,d
    assert max((p['value'] or 0) for p in d['recentVisualTrace'])<.015,d
    for point in d['recentVisualTrace']:
      if any(e['start']-1e-6<=point['sourceT']<=e['end']+1e-6 for e in d['cutWindows']):assert point['value'] is None,point
    assert d['visualTraceSamples']>0 and d['suppressedCuts']>0
    report['checks']['delayed_worker_skips_frames_but_cut_flags_survive']='PASS'
    report['checks']['captured_frame_trace_avoids_skipped_update_spikes']='PASS'
    report['sample']=d;report['status']='PASS';report['javascript_errors']=errors
    assert not errors,errors
    page.click('#toggleRun');b.close()
finally:
    server.shutdown();(HERE/'browser_slow_validation_report.json').write_text(json.dumps(json_clean(report),indent=2,allow_nan=False))
print(json.dumps(report,indent=2))
