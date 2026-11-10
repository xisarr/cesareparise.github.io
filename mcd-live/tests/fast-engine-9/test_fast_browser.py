"""Current interface regression tests with native decoding/WASM and explicit Worker shim.
No real camera/microphone hardware; no test-only code ships in the app.
"""
from pathlib import Path
import json,mimetypes,math,subprocess
from urllib.parse import urlsplit,unquote
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2];HERE=Path(__file__).resolve().parent
OUT=HERE/'fast-previews';OUT.mkdir(exist_ok=True)
if not (HERE/'fixtures/test-stereo.mp4').exists(): subprocess.run(['bash',str(HERE/'make_fixtures.sh')],check=True)
report={'worker_mode':'in-page Worker substitute; actual shipped WASM', 'native_media_decoding':True,'physical_devices_tested':False,'checks':{}}
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 ctx=b.new_context(viewport={'width':1360,'height':1000},device_scale_factor=1)
 def serve(route):
  rel=unquote(urlsplit(route.request.url).path).lstrip('/') or 'index.html';target=(ROOT/rel).resolve()
  if not target.is_relative_to(ROOT) or not target.is_file():return route.fulfill(status=404,body='')
  mime='application/javascript' if target.suffix=='.js' else 'application/wasm' if target.suffix=='.wasm' else mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
  route.fulfill(status=200,headers={'Access-Control-Allow-Origin':'*'},content_type=mime,body=target.read_bytes())
 ctx.route('https://mcd-demo.test/**',serve)
 page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.evaluate("async()=>{window.testUtils=await import('https://mcd-demo.test/signal-utils.js')}")
 sources={n:(ROOT/n).read_text() for n in ['mcd-worker.js','movie-audio-worker.js']}
 page.evaluate(r'''sources=>{window.Worker=class {
 constructor(url){const name=new URL(url,'https://mcd-demo.test/').pathname.split('/').pop();this.dead=false;const owner=this;
 this.scope={postMessage(m,transfer=[]){const data=structuredClone(m,{transfer});const reply=()=>{if(!owner.dead)owner.onmessage?.({data})};
 if(name==='mcd-worker.js'&&m.type==='frame'&&window.testWorkerReplyDelay)setTimeout(reply,window.testWorkerReplyDelay);else queueMicrotask(reply);}};
 new Function('self','fetch','buildMonoEnvelope',sources[name].replace(/^import .*?;\n/,''))(this.scope,(u,o)=>fetch(new URL(u,'https://mcd-demo.test/'),o),testUtils.buildMonoEnvelope);}
 postMessage(m,transfer=[]){const data=structuredClone(m,{transfer});queueMicrotask(()=>{if(!this.dead)this.scope.onmessage({data})});}terminate(){this.dead=true;}
 };}''',sources)
 page.set_content((ROOT/'index.html').read_text().replace('<head>','<head><base href="https://mcd-demo.test/">'),wait_until='networkidle')
 page.wait_for_function('window.getMCDDiagnostics?.().modelReady',timeout=15000)
 state=lambda:page.evaluate('getMCDDiagnostics()')
 def setrange(name,value):page.locator('#'+name).fill(str(value));page.locator('#'+name).dispatch_event('input')
 def movie(name):
  page.select_option('#inputMode','movie');page.set_input_files('#movieFile',str(HERE/'fixtures'/name))
  page.wait_for_function("document.querySelector('#status').textContent==='Movie ready'",timeout=30000)
 def start():
  page.click('#toggleRun');page.wait_for_function('getMCDDiagnostics().running&&getMCDDiagnostics().processed>12',timeout=20000)
 assert state()['version']=='fast-engine-9' and state()['engine']=='SIMD state-transition'
 assert state()['tuning']=={'v':45,'a':36.7,'late':180,'scale':1}
 assert page.locator('#paletteCorr,#paletteLag').count()==0
 assert state()['display']['corr']['palette']=='violet'
 assert page.locator('#gainCorr').get_attribute('min')=='-60'
 assert page.locator('#downsample').locator('option[value="1"]').count()==1
 report['checks']['fixed_palettes_controls_defaults']='PASS'
 movie('test-stereo.mp4');page.select_option('#downsample','1');page.wait_for_timeout(500);start()
 page.wait_for_timeout(3500);a=state();assert a['geometry']['w']==640 and a['geometry']['h']==360
 assert a['steps']>25 and a['meanComputeMs']>0 and a['rms']>0
 report['checks']['full_640x360_movie_processing']='PASS';report['full_resolution_snapshot']={k:a[k] for k in ['captured','processed','skipped','resyncs','meanComputeMs','meanRenderMs','engine']}
 # Preserve linear/log scale settings and original response-gain defaults.
 assert a['display']['corr']['gainDb']==-20
 count=a['resetCount'];page.select_option('#scaleCorr','linear');setrange('gainCorr',-60)
 page.wait_for_timeout(200);assert 'dB' not in page.locator('#gainCorrValue').inner_text();assert state()['resetCount']==count
 page.select_option('#scaleCorr','db');setrange('gainCorr',-20)
 report['checks']['scale_and_gain_do_not_reset_model']='PASS'
 # In this restricted browser the worker is simulated in-page, so load tests
 # check behaviour, not a production browser throughput promise.
 page.select_option('#downsample','4');page.wait_for_timeout(500)
 page.wait_for_function('getMCDDiagnostics().loopCount>=1',timeout=12000);a=state();assert a['steps']>5
 report['checks']['loop_continuity']='PASS'
 for d in [400,-400,0]:
  setrange('avDelay',d);page.wait_for_timeout(1400);a=state()
  assert a['delay']==d and a['running']
  assert abs(a['playback']['audio']['audioDelayMs']-max(0,-d))<1e-4
  if d>0:
   assert a['playback']['video']['visible'] and abs(a['playback']['video']['actualVideoDelayMs']-d)<80
   assert abs(a['actualVideoLag']-d)<80
  else:assert not a['playback']['video']['visible']
 report['checks']['automatic_audiovisual_playback_delay']='PASS'
 page.click('#pauseMovie');page.wait_for_timeout(200);a=state();assert a['moviePaused']
 proc=a['processed'];page.wait_for_timeout(200);assert state()['processed']==proc
 page.locator('#movieSeek').fill('1.2');page.locator('#movieSeek').dispatch_event('input');page.locator('#movieSeek').dispatch_event('change');page.wait_for_timeout(400)
 assert state()['moviePaused'] and abs(state()['position']-1.2)<.1
 page.click('#pauseMovie');page.wait_for_timeout(700);assert not state()['moviePaused']
 report['checks']['pause_seek_resume']='PASS'
 # Exaggerated worker latency must result in counted, explicit resyncs, not a
 # giant elapsed interval integrated as if the latest frame filled the gap.
 page.evaluate('window.testWorkerReplyDelay=330');before=state()['resyncs'];page.wait_for_timeout(2200)
 a=state();assert a['resyncs']>before and a['skipped']>0 and a['visualTraceGaps']>0
 page.evaluate('window.testWorkerReplyDelay=0');page.wait_for_timeout(500);a=state();after=a['processed'];page.wait_for_timeout(700)
 assert state()['processed']>after+6
 report['checks']['overload_counted_gaps_and_recovery']='PASS'
 # Cut suppression continues to preserve normal cut-gap behaviour.
 page.click('#toggleRun');movie('test-edits.mp4');page.select_option('#downsample','4');page.wait_for_timeout(300);start()
 page.wait_for_function('getMCDDiagnostics().suppressedCuts>=1',timeout=8000)
 assert state()['visualTraceGaps']>0
 page.click('#suppressCuts');page.wait_for_timeout(1800);assert state()['visualTraceGaps']==0
 page.click('#suppressCuts');page.wait_for_timeout(600)
 report['checks']['movie_cut_toggle_and_missing_values']='PASS'
 # Fast and slow tuning, reset, Stop remain functional.
 setrange('tauV',1);setrange('tauA',200);setrange('tauLate',800);setrange('timeScale',-2);page.wait_for_timeout(500)
 assert state()['modelReady'] and state()['running'];page.click('#resetTuning');page.wait_for_timeout(400)
 assert state()['tuning']=={'v':45,'a':36.7,'late':180,'scale':1}
 report['checks']['temporal_controls_and_reset']='PASS'
 page.screenshot(path=str(OUT/'desktop.png'),full_page=True)
 page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(300)
 assert page.evaluate('document.documentElement.scrollWidth-innerWidth')<=1
 page.screenshot(path=str(OUT/'mobile.png'),full_page=True)
 page.set_viewport_size({'width':1360,'height':1000});page.click('#toggleRun')
 # Capture actual Canvas/AudioContext MediaStreams to exercise LIVE path,
 # without representing them as physical hardware tests.
 page.evaluate('''()=>{
  Object.defineProperty(window,'isSecureContext',{value:true,configurable:true});window.fakeTracks=[];
  Object.defineProperty(navigator,'mediaDevices',{value:{enumerateDevices:async()=>[],addEventListener(){},getUserMedia:async()=>{
   const c=document.createElement('canvas');c.width=640;c.height=360;const x=c.getContext('2d');let k=0;
   const timer=setInterval(()=>{x.fillStyle='#888';x.fillRect(0,0,640,360);x.fillStyle='#123';x.fillRect((k++*8)%600,120,40,70)},60);
   const s=c.captureStream(1000/60),a=new AudioContext();a.resume();const o=a.createOscillator(),g=a.createGain(),dest=a.createMediaStreamDestination();o.frequency.value=440;g.gain.value=.1;o.connect(g);g.connect(dest);o.start();s.addTrack(dest.stream.getAudioTracks()[0]);
   for(const t of s.getTracks()){const stop=t.stop.bind(t);t.stop=()=>{stop();clearInterval(timer);a.close().catch(()=>{})};window.fakeTracks.push(t);}return s;
  }},configurable:true});
 }''')
 page.select_option('#inputMode','live');page.select_option('#downsample','1');page.wait_for_timeout(400);start();page.wait_for_timeout(1500)
 a=state();assert a['geometry']['w']==640 and a['geometry']['h']==360 and a['rms']>0 and a['audioCoverage']>.5
 report['checks']['synthetic_live_640x360_16_7fps']='PASS';report['live_snapshot']={k:a[k] for k in ['captured','processed','skipped','resyncs','meanComputeMs','meanRenderMs','rms']}
 page.click('#toggleRun');assert not state()['running'] and page.evaluate('fakeTracks.every(t=>t.readyState==="ended")')
 report['checks']['stop_releases_synthetic_tracks']='PASS'
 report['javascript_errors']=errors;assert not errors,errors;report['status']='PASS'
 b.close()
(HERE/'fast_browser_report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
