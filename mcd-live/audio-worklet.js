/* Live mono RMS packets with audio-clock timestamps. Output is SILENCE:
 * microphone playback is never connected to the speakers. */
class MCDMicLevel extends AudioWorkletProcessor {
  constructor(){super();this.energy=0;this.count=0;this.peak=0;this.start=0;this.block=Math.max(1,Math.round(sampleRate*.005));}
  process(inputs,outputs){
    const input=inputs[0]||[],n=input[0]?.length||0;
    for(let i=0;i<n;i++){
      if(!this.count)this.start=currentTime+i/sampleRate;
      let x=0;for(let c=0;c<input.length;c++)x+=input[c][i]||0;
      x/=input.length;this.energy+=x*x;this.peak=Math.max(this.peak,Math.abs(x));this.count++;
      if(this.count>=this.block){
        const end=currentTime+(i+1)/sampleRate;
        this.port.postMessage({start:this.start,end,rms:Math.sqrt(this.energy/this.count),peak:this.peak});
        this.energy=0;this.count=0;this.peak=0;
      }
    }
    for(const channel of outputs[0]||[])channel.fill(0);
    return true;
  }
}
registerProcessor('mcd-mic-level',MCDMicLevel);
