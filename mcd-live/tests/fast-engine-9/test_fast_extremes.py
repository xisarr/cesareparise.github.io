"""Additional independent trajectory checks at requested video rates and tau extremes."""
from test_numeric import load_core, view, rhs, read_reference
import numpy as np
from scipy.integrate import solve_ivp
from pathlib import Path
import json
rng=np.random.default_rng(92391)
tmp,c=load_core()
cases=[(.045,.0367,.18,1,1/16.6),(.045,.0367,.18,1,1/30),(.045,.0367,.18,.25,1/16.6),(.045,.0367,.18,4,1/16.6),(.001,.001,.001,.25,1/16.6),(.001,.2,.8,.25,1/16.6),(.2,.001,.001,4,1/16.6),(.2,.2,.8,4,.24),(.045,.0367,.18,1,.24)]
reports=[]
for bases in cases:
 c.mcd_init(1,1);assert c.mcd_set_tuning(*bases[:4]);I=view(c,'input',1);x=np.zeros(28);params=np.array(bases[:3])[np.array([0,1,2,2])]*bases[3]
 result=[];refs=[]
 for j in range(32):
  dt=bases[4]*(.8+.4*rng.random());v,a=map(float,np.float32(rng.random(2)*[.9,.2]));I[0]=v
  assert c.mcd_step(a,dt)
  sol=solve_ivp(rhs,(0,dt),x,args=(v,a,params),method='DOP853',rtol=1e-11,atol=1e-15)
  assert sol.success;x=sol.y[:,-1]
  refs.append(read_reference(x,params));result.append(np.r_[view(c,'debug',10,np.float64).copy(),view(c,'corr',1),view(c,'lag',1)])
 ref=np.array(refs);res=np.array(result);peak=np.max(np.abs(ref),axis=0)
 # Absolute floor suppresses meaningless relative errors of essentially zero
 # responses at sub-frame taus. It is specified explicitly in the report.
 err=np.max(np.abs(ref-res),axis=0)/np.maximum(peak,1e-18)
 # Late response integration is quadrature; demand <0.1% of peak for ALL tests.
 active=peak>1e-12
 rel=float(err[active].max()) if np.any(active) else 0.
 corr=float(err[10]) if peak[10]>1e-22 else None
 lag=float(err[11]) if peak[11]>1e-15 else None
 print(bases,'worst active',rel,'corr',corr,'lag',lag,flush=True)
 assert rel<.001,(bases,err)
 reports.append({'tuning_seconds':bases[:3],'scale':bases[3],'nominal_interval_s':bases[4],'steps':32,'max_peak_normalised_active_error':rel,'corr_peak_normalised_error':corr,'lag_peak_normalised_error':lag,'peaks':peak.tolist(),'errors':err.tolist()})
Path(__file__).with_name('fast_extremes_report.json').write_text(json.dumps({'status':'PASS','reference':'SciPy DOP853 rtol 1e-11 atol 1e-15; actual float32 inputs; independent full ODE','metric':'Maximum absolute error / maximum absolute reference, per signal. Active means peak>1e-12. Very small outputs use explicit floors.','cases':reports},indent=2))
