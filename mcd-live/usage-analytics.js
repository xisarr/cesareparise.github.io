/* Minimal, non-blocking usage accounting. No cookies, storage, media or filenames.
 * The random page token exists only in memory and expires on page reload.
 */
export function deploymentPolicy(config, location, navigator = {}) {
  let url;
  try { url=new URL(location.href); } catch {return {publicSite:false,reason:'No valid website location'};}
  if(url.searchParams.get('stats')==='off')return {publicSite:false,reason:'Owner/test exclusion (?stats=off)'};
  if(config.respectPrivacySignals&&(navigator.globalPrivacyControl===true||navigator.doNotTrack==='1'))
    return {publicSite:false,reason:'Browser privacy preference'};
  const path=url.pathname.replace(/index\.html$/,'').replace(/\/?$/,'/');
  if(url.protocol!=='https:'||!(config.allowedOrigins||[]).includes(url.origin)||!(config.allowedPaths||[]).includes(path))
    return {publicSite:false,reason:'Local/preview/unlisted site: no analytics requests'};
  return {publicSite:true,reason:'Approved public demo URL'};
}
function pageToken() {
  if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
  // getRandomValues is also available in restricted test/older browser contexts.
  const b=new Uint8Array(16);globalThis.crypto.getRandomValues(b);
  b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
  const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export function createUsageTracker(config, env={}) {
  const root=globalThis,loc=env.location||root.location,nav=env.navigator||root.navigator||{},doc=env.document||root.document;
  const now=env.now||(()=>performance.now()),fetcher=env.fetch||root.fetch?.bind(root),uuid=env.uuid||pageToken;
  const later=env.setTimeout||root.setTimeout.bind(root),cancel=env.clearTimeout||root.clearTimeout.bind(root);
  const policy=deploymentPolicy(config,loc,nav);
  let endpoint='';try{const u=new URL(config.endpoint);if(u.protocol==='https:'&&!u.username&&!u.password)endpoint=u.href;}catch{}
  const enabled=Boolean(config.enabled&&endpoint&&policy.publicSite&&fetcher);
  const threshold=Math.max(1,Number(config.engagedSeconds)||30),created=now(),MAX_AGE=24*60*60*1000;
  let id=null,live=false,movie=false,engaged=false,activeSeconds=0,previous=null;
  let revision=0,acknowledged=0,attempts=0,retries=0,inFlight=false,timer=null,lastError='',disposed=false;
  const snapshot=()=>({v:1,session:id,live,movie,engaged});
  function breakActivity(){previous=null;}
  function status(){return {enabled,reason:policy.publicSite?(enabled?'Enabled':'Counter not configured/enabled'):policy.reason,
    successful:live||movie,live,movie,both:live&&movie,engaged,activeSeconds:Number(activeSeconds.toFixed(3)),
    pending:revision>acknowledged,updates:revision,acknowledged,requests:attempts,lastError};}
  function queue(){if(!enabled||disposed||!id||inFlight||timer||revision<=acknowledged)return;
    timer=later(()=>{timer=null;void flush();},0);}
  async function flush(){
    if(!enabled||disposed||inFlight||!id||revision<=acknowledged||retries>=3)return;
    const rev=revision,body=JSON.stringify(snapshot());inFlight=true;attempts++;retries++;
    const controller=new AbortController(),timeout=later(()=>controller.abort(),5000);
    try{
      const response=await fetcher(endpoint,{method:'POST',body,headers:{'Content-Type':'text/plain;charset=UTF-8'},
        mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store',keepalive:true,signal:controller.signal});
      if(!response.ok)throw new Error(`Counter HTTP ${response.status}`);
      acknowledged=Math.max(acknowledged,rev);lastError='';
    }catch(e){lastError=e?.message||'Counter unavailable';}
    finally{cancel(timeout);inFlight=false;}
    if(disposed||revision<=acknowledged)return;
    if(revision!==rev){retries=0;queue();}
    else if(retries<3)timer=later(()=>{timer=null;void flush();},retries===1?1500:5000);
  }
  function successfulFrame({mode,valid,foreground=doc?.visibilityState!=='hidden',timestamp=now()}={}){
    try{
      if(disposed||!valid||!foreground||!['live','movie'].includes(mode)||!Number.isFinite(timestamp)||timestamp-created>MAX_AGE){breakActivity();return;}
      let change=false;if(!id)id=uuid();
      if(mode==='live'&&!live){live=true;change=true;}if(mode==='movie'&&!movie){movie=true;change=true;}
      if(previous!==null){const dt=(timestamp-previous)/1000;if(dt>0&&dt<=1)activeSeconds+=dt;}
      previous=timestamp;
      if(!engaged&&activeSeconds+1e-8>=threshold){engaged=true;change=true;}
      if(change){revision++;retries=0;queue();}
    }catch(e){lastError=e?.message||'Usage counting unavailable';breakActivity();}
  }
  const onHide=()=>{breakActivity();if(doc?.visibilityState==='hidden')void flush();};
  const onPageHide=()=>{breakActivity();void flush();};
  doc?.addEventListener?.('visibilitychange',onHide);root.addEventListener?.('pagehide',onPageHide);
  return Object.freeze({successfulFrame,breakActivity,status,flush,
    dispose(){disposed=true;cancel(timer);doc?.removeEventListener?.('visibilitychange',onHide);root.removeEventListener?.('pagehide',onPageHide);}});
}
export function installPageViewBeacon(config,env={}){
  const doc=env.document||globalThis.document,loc=env.location||globalThis.location,nav=env.navigator||globalThis.navigator;
  if(!doc||!config.pageViewsEnabled||!deploymentPolicy(config,loc,nav).publicSite||!/^[a-f0-9]{32}$/i.test(config.webAnalyticsToken||''))return false;
  if(doc.querySelector('script[src*="static.cloudflareinsights.com/beacon.min.js"]'))return false;
  const script=doc.createElement('script');script.defer=true;script.src='https://static.cloudflareinsights.com/beacon.min.js';
  script.dataset.cfBeacon=JSON.stringify({token:config.webAnalyticsToken});doc.body.appendChild(script);return true;
}
