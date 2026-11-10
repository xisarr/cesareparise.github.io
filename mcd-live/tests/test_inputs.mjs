import assert from 'node:assert/strict';
import fs from 'node:fs';
import {geometry,averageVisualChanges,defaultDisplaySettings,delaySeconds,greyPixels,meanAbsoluteDifference,greyPixels16,detectSceneCut,FrameHistory,AudioHistory,buildMonoEnvelope,movieRms,colourAt,COLOURS} from '../signal-utils.js';
const checks={};
assert.deepEqual(delaySeconds(-600),{video:0,audio:.6});assert.deepEqual(delaySeconds(600),{video:.6,audio:0});assert.deepEqual(delaySeconds(0),{video:0,audio:0});checks.delay_polarity='PASS';
let g=geometry(1280,720,8);assert.equal(g.w,160);assert.equal(g.h,90);assert.equal(g.aspect,1280/720);
g=geometry(360,640,8);assert.equal(g.w,45);assert.equal(g.h,80);assert.equal(g.aspect,360/640);
g=geometry(1280,720,1);assert.equal(g.w,1280);assert.equal(g.h,720);assert.equal(g.tooLarge,false);
g=geometry(1920,1080,1);assert.equal(g.w*g.h,2073600);assert.equal(g.tooLarge,false);
g=geometry(3840,2160,1);assert.equal(g.w,3840);assert.equal(g.h,2160);assert.equal(g.tooLarge,true);checks.actual_1x_without_silent_capping='PASS';
assert.equal(averageVisualChanges(.08,0),.04);assert.equal(averageVisualChanges(0,.08),.04);
assert.equal(averageVisualChanges(0,0),0);assert.equal(averageVisualChanges(.1,undefined),.1);
assert.ok(Number.isNaN(averageVisualChanges(.1,NaN)));checks.two_difference_display_summary='PASS';
assert.equal(defaultDisplaySettings('live').corrGain,0);assert.equal(defaultDisplaySettings('movie').corrGain,-20);
assert.equal(defaultDisplaySettings('live').lagGain,-40);checks.mode_specific_display_defaults='PASS';
assert.equal(meanAbsoluteDifference(new Float32Array([.2,.7]),new Float32Array([.2,.7])),0);
assert.equal(meanAbsoluteDifference(new Float32Array([0,0]),new Float32Array([1,1])),1);
assert.ok(Math.abs(greyPixels(new Uint8Array([255,255,255,255]))[0]-1)<1e-7);checks.grayscale_difference='PASS';

const lum=greyPixels16(new Uint8ClampedArray([255,255,255,255,0,0,0,255]));
assert.deepEqual([...lum],[65535,0]);
let prev=new Uint16Array(100).fill(10000),next=new Uint16Array(100).fill(10000);
assert.equal(detectSceneCut(prev,next).cut,false);
for(let i=0;i<100;i++){prev[i]=i<50?0:65535;next[i]=i<50?65535:0;}
assert.equal(detectSceneCut(prev,next).cut,true);
next.fill(65535);assert.equal(detectSceneCut(prev,next).cut,false,'Uniform flash is not an edit');
next=prev.slice();for(let i=0;i<10;i++)next[i]=65535;
assert.equal(detectSceneCut(prev,next).cut,false,'Local object motion is not an edit');
checks.cut_detection_conservative='PASS';
let f=new FrameHistory();for(let i=0;i<90;i++)f.push({id:i,t:i/30});assert.equal(f.at(2.5).id,75);assert.equal(f.at(2.51).id,75);assert.ok(f.items.length<34);checks.frame_delay_quantisation='PASS';
const hist=new AudioHistory();hist.push(0,.01,.3);hist.push(.01,.02,.4);assert.ok(Math.abs(hist.measure(0,.02).rms-Math.sqrt((.09+.16)/2))<1e-12);assert.equal(hist.measure(0,.04).coverage,.5);checks.audio_packet_integral='PASS';
const channels=[new Float32Array(4800).fill(.5),new Float32Array(4800).fill(-.5)];let e=buildMonoEnvelope(channels,48000);assert.equal(e.peak,0);assert.equal(movieRms(e,0,.1,.1),0);
e=buildMonoEnvelope([new Float32Array(4800).fill(.5),new Float32Array(4800).fill(.5)],48000);assert.ok(Math.abs(movieRms(e,.08,.13,.1,true)-.5)<1e-7);assert.ok(Math.abs(movieRms(e,.08,.13,.1,false)-Math.sqrt(.25*.02/.05))<1e-7);checks.mono_before_rms_and_loop_boundary='PASS';
for(const c of Object.values(COLOURS)){assert.deepEqual(colourAt(0,c),[255,255,255]);assert.deepEqual(colourAt(1,c),c);}checks.white_baseline='PASS';
const bytes=fs.readFileSync(new URL('../mcd.wasm',import.meta.url));const ex=(await WebAssembly.instantiate(bytes,{})).instance.exports;assert.equal(ex.mcd_version(),7);assert.ok(ex.mcd_init(2,1));let v=new Float32Array(ex.memory.buffer,ex.mcd_input_ptr(),2);let t=new Float32Array(ex.memory.buffer,ex.mcd_trace_ptr(),6);v.set([.2,.4]);ex.mcd_prime(.02);assert.equal(t[0],0);ex.mcd_step(.02,1/30);assert.equal(t[0],0);v.set([.6,.4]);ex.mcd_step(.02,1/30);assert.ok(Math.abs(t[0]-.2)<1e-7);checks.compiled_frame_difference='PASS';

// Selective visual baseline after a cut: auditory response continues while
// visual transients, correlation and lag are cleared.
assert.equal(ex.mcd_set_tuning(.045,.0367,.18,1),1);
ex.mcd_reset();v.set([.1,.4]);ex.mcd_prime(.01);
for(let i=0;i<16;i++){v.set([.1,.4]);ex.mcd_step(i%2?.07:.03,1/30);}
const audioBefore=new Float64Array(ex.memory.buffer,ex.mcd_debug_ptr(),10)[5];
v.set([.9,.05]);assert.equal(ex.mcd_step_cut(.2,1/30),1);
assert.equal(t[2],0);assert.equal(t[4],0);assert.equal(t[5],0);
assert.ok(Math.abs(t[0])>.01,'Visual-change timeline records actual cut');
assert.ok(new Float32Array(ex.memory.buffer,ex.mcd_corr_ptr(),2).every(v=>v===0));
assert.ok(new Float32Array(ex.memory.buffer,ex.mcd_lag_ptr(),2).every(v=>v===0));
assert.ok(t[3]>0 && audioBefore>0,'Auditory transient persists across cut');
checks.visual_only_cut_rebaseline='PASS';
for(const [a,b,l] of [[.001,.001,.001],[.2,.2,.8]])for(const scale of [.25,1,4]){assert.equal(ex.mcd_set_tuning(a,b,l,scale),1);ex.mcd_reset();v.set([.3,.7]);ex.mcd_prime(.02);v.set([.5,.1]);assert.equal(ex.mcd_step(.03,1/30),1);assert.ok([...t].every(Number.isFinite));}checks.full_control_range='PASS';
const result={status:'PASS',checks};console.log(JSON.stringify(result,null,2));fs.writeFileSync(new URL('input_validation_report.json',import.meta.url),JSON.stringify(result,null,2));
