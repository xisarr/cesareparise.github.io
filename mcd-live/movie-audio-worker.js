import {buildMonoEnvelope} from './signal-utils.js?v=seek-cuts-4';
self.onmessage=({data:m})=>{
  try{
    const channels=m.channels.map(b=>new Float32Array(b));
    const result=buildMonoEnvelope(channels,m.sampleRate);
    self.postMessage({id:m.id,...result,prefix:result.prefix.buffer},[result.prefix.buffer]);
  }catch(e){self.postMessage({id:m.id,error:String(e.message||e)});}
};
