import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const messages=[];let Klass;
const scope={sampleRate:48000,currentTime:0,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)}}},registerProcessor:(name,C)=>{Klass=C}};
vm.createContext(scope);vm.runInContext(fs.readFileSync(new URL('../audio-worklet.js',import.meta.url),'utf8'),scope);
let w=new Klass();
for(let i=0;i<30;i++){scope.currentTime=i*128/48000;const out=[new Float32Array(128).fill(1)];w.process([[new Float32Array(128).fill(.2),new Float32Array(128).fill(-.2)]],[out]);assert.ok(out[0].every(x=>x===0));}
assert.ok(messages.length>10);assert.ok(messages.every(m=>m.rms===0));messages.length=0;
w=new Klass();for(let i=0;i<30;i++){scope.currentTime=i*128/48000;w.process([[new Float32Array(128).fill(.2)]],[[new Float32Array(128)]]);}
assert.ok(messages.every(m=>Math.abs(m.rms-.2)<1e-7));assert.ok(messages.every(m=>Math.abs(m.end-m.start-.005)<1e-9));
for(let i=1;i<messages.length;i++)assert.ok(Math.abs(messages[i].start-messages[i-1].end)<1e-9);
const result={status:'PASS',timestamped_5ms_packets:true,mono_mean_before_RMS:true,silent_speaker_output:true};
fs.writeFileSync(new URL('audio_worklet_validation_report.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
