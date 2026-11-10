/* Display-only palettes. No model, input or time-series processing occurs here.
 * Oklab conversion: Bjorn Ottosson, https://bottosson.github.io/posts/oklab/
 * The palette paths below are custom (not named third-party scientific maps).
 * Each ramp starts at exact black, with increasing Oklab L. Gamut mapping
 * reduces chroma while keeping lightness and hue; no dynamic frame rescaling.
 */
export const PALETTE_SIZE = 2049;
export const CORRELATION_PALETTES = Object.freeze({violet: {label:'Violet',hue:300,chroma:.165}});
export const LAG_PALETTES = Object.freeze({'blue-orange': {label:'Blue / orange',negative:{hue:250,chroma:.155},positive:{hue:55,chroma:.155}}});

function linearRGB(L,a,b) {
  const l=(L+.3963377774*a+.2158037573*b)**3;
  const m=(L-.1055613458*a-.0638541728*b)**3;
  const s=(L-.0894841775*a-1.291485548*b)**3;
  return [4.0767416621*l-3.3077115913*m+.2309699292*s,
    -1.2684380046*l+2.6097574011*m-.3413193965*s,
    -.0041960863*l-.7034186147*m+1.707614701*s];
}
function inGamut(rgb) {return rgb.every(x=>x>=-1e-8&&x<=1+1e-8);}
function encode(x) {
  x=Math.min(1,Math.max(0,x));
  return Math.round(255*(x<=.0031308?12.92*x:1.055*x**(1/2.4)-.055));
}
function oklchColour(L,C,hue) {
  const h=hue*Math.PI/180,ca=Math.cos(h),cb=Math.sin(h);
  let rgb=linearRGB(L,C*ca,C*cb);
  if(!inGamut(rgb)) {
    let lo=0,hi=C;
    for(let i=0;i<22;i++) {
      const mid=(lo+hi)/2;
      if(inGamut(linearRGB(L,mid*ca,mid*cb)))lo=mid;else hi=mid;
    }
    rgb=linearRGB(L,lo*ca,lo*cb);
  }
  return rgb.map(encode);
}
function createRamp(spec,peakL=.84) {
  const table=new Uint8ClampedArray(PALETTE_SIZE*3);
  for(let i=1;i<PALETTE_SIZE;i++) {
    const t=i/(PALETTE_SIZE-1);
    // Shared lightness profile on both lag branches. Slightly more chroma
    // through the middle keeps colours distinct against black.
    const C=spec.chroma*Math.sin(t*Math.PI/2);
    table.set(oklchColour(peakL*t,C,spec.hue),3*i);
  }
  return table;
}
const corrCache=new Map(),lagCache=new Map();
export function correlationLUT(key='violet') {
  if(!(key in CORRELATION_PALETTES))key='violet';
  if(!corrCache.has(key))corrCache.set(key,createRamp(CORRELATION_PALETTES[key],.87));
  return corrCache.get(key);
}
export function lagLUTs(key='blue-orange') {
  if(!(key in LAG_PALETTES))key='blue-orange';
  if(!lagCache.has(key)) {
    const p=LAG_PALETTES[key];
    lagCache.set(key,{negative:createRamp(p.negative),positive:createRamp(p.positive)});
  }
  return lagCache.get(key);
}
export function paletteIndex(strength) {
  if(!Number.isFinite(strength)||strength<=0)return 0;
  return 3*Math.round(Math.min(1,strength)*(PALETTE_SIZE-1));
}
export function gradientCSS(negative,positive=null) {
  const stops=[],n=24;
  const rgb=(table,q)=>{const k=paletteIndex(q);return `rgb(${table[k]},${table[k+1]},${table[k+2]})`;};
  if(positive) {
    for(let i=0;i<=n;i++)stops.push(`${rgb(negative,1-i/n)} ${50*i/n}%`);
    for(let i=1;i<=n;i++)stops.push(`${rgb(positive,i/n)} ${50+50*i/n}%`);
  }else for(let i=0;i<=n;i++)stops.push(`${rgb(negative,i/n)} ${100*i/n}%`);
  return `linear-gradient(90deg,${stops.join(',')})`;
}
