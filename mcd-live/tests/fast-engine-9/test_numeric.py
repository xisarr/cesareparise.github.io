"""Independent tests of the continuous-time MCD implementation.

Compiles native C, then compares against analytic gamma step responses and
SciPy DOP853 integration (not against an alternative copy of the C RK4 loop).
No MATLAB runtime is required. This does not claim a bitwise MATLAB test.
"""
from __future__ import annotations
import ctypes as ct
import json
import subprocess
import tempfile
from pathlib import Path
import numpy as np
from scipy.integrate import solve_ivp
from scipy.special import gammainc

BASE=Path(__file__).resolve().parents[2]
DEFAULT=np.array([.045,.0367,.18,.18],dtype=float)


def load_core():
    tmp=tempfile.TemporaryDirectory()
    libpath=Path(tmp.name)/'libmcd.so'
    subprocess.run(['gcc','-O3','-fno-builtin','-ffp-contract=off','-shared','-fPIC',
                    str(BASE/'src/mcd.c'),'-lm','-o',str(libpath)],check=True)
    core=ct.CDLL(str(libpath))
    core.mcd_init.argtypes=[ct.c_int,ct.c_int]
    core.mcd_step.argtypes=[ct.c_float,ct.c_double]
    core.mcd_step_cut.argtypes=[ct.c_float,ct.c_double]
    core.mcd_prime.argtypes=[ct.c_float]
    core.mcd_set_tuning.argtypes=[ct.c_double]*4
    core.mcd_state_bytes.restype=ct.c_size_t
    core.mcd_memory_bytes.restype=ct.c_size_t
    for key in ('input','corr','lag','trace','parameters','tuning','debug'):
        getattr(core,f'mcd_{key}_ptr').restype=ct.c_size_t
    return tmp,core


def view(c,key,n,dtype=np.float32):
    typ=ct.c_float if dtype==np.float32 else ct.c_double
    return np.ctypeslib.as_array((typ*n).from_address(getattr(c,f'mcd_{key}_ptr')()))


def rhs(_,state,visual,audio,params):
    """Full continuous-time system: two independent 14-state pathways."""
    x=state.reshape(2,14)
    d=np.empty_like(x)
    for m,(inp,tau,late) in enumerate(((visual,params[0],params[2]),(audio,params[1],params[3]))):
        d[m,:12]=(np.r_[inp,x[m,:11]]-x[m,:12])/tau
        fast=tau*(x[m,6]-x[m,8])
        slow=tau*(x[m,9]-x[m,11])
        tr=np.hypot(fast,slow)
        d[m,12]=(tr-x[m,12])/late
        d[m,13]=(x[m,12]-x[m,13])/late
    return d.ravel()


def read_reference(x,p):
    v,a=x.reshape(2,14)
    vs=p[0]*(v[9]-v[11]); vf=p[0]*(v[6]-v[8])
    ass=p[1]*(a[9]-a[11]); af=p[1]*(a[6]-a[8])
    vt=np.hypot(vs,vf); at=np.hypot(ass,af)
    vd=p[2]*v[13]; ad=p[3]*a[13]
    u1=vt*ad;u2=vd*at
    return np.array([vs,vf,ass,af,vt,at,vd,ad,u1,u2,u1*u2,u1-u2])


def main():
    tmp,c=load_core()
    report={'authoritative_defaults_seconds':DEFAULT.tolist(),'checks':{}}
    assert c.mcd_init(1,1)==1
    np.testing.assert_array_equal(view(c,'parameters',4,np.float64),DEFAULT)
    # Reject invalid changes atomically.
    assert c.mcd_set_tuning(np.nan,.03,.18,1)==0
    assert c.mcd_set_tuning(.045,.0367,.18,0)==0
    assert c.mcd_set_tuning(.045,.0367,.18,4.01)==0
    assert c.mcd_set_tuning(.045,.0367,5,4)==0
    np.testing.assert_array_equal(view(c,'parameters',4,np.float64),DEFAULT)
    np.testing.assert_array_equal(view(c,'tuning',4,np.float64),[.045,.0367,.18,1])
    assert c.mcd_version()==9
    report['checks']['defaults_and_input_validation']='PASS'

    # Analytic response to a unit step, at irregular sampling intervals.
    # Integral of tau*(h_(n+1)-h_(n+3)) is tau*(P(n+1,z)-P(n+3,z)).
    rng=np.random.default_rng(4301)
    max_early_error=0
    for tau in (.0025,.01,.0367,.045,.12,.48):
        c.mcd_init(1,1);c.mcd_set_tuning(tau,tau,.18,1)
        I=view(c,'input',1); I[0]=1
        t=0.; observed=[]; expected=[]
        for _ in range(110):
            dt=float(rng.uniform(.012,.045));t+=dt
            assert c.mcd_step(1,dt)==1
            d=view(c,'debug',10,np.float64)
            observed.append(d[:2].copy())
            expected.append([tau*(gammainc(n+1,t/tau)-gammainc(n+3,t/tau)) for n in (9,6)])
        expected=np.array(expected); observed=np.array(observed)
        err=float(np.max(np.abs(observed-expected))/np.max(np.abs(expected)))
        assert err<2e-5,(tau,err)
        max_early_error=max(max_early_error,err)
    report['checks']['analytic_biphasic_step_response']={'status':'PASS','max_peak_normalised_error':max_early_error}

    # Full nonlinear chain, changing base constants and global scale midstream.
    # Float32 input values are used in both C and SciPy, to avoid input mismatch.
    c.mcd_init(1,1)
    I=view(c,'input',1); state=np.zeros(28);params=DEFAULT.copy()
    tuning=np.array([.045,.0367,.18,1.])
    actual=[];reference=[];fixture=[]
    for k in range(160):
        if k==50:
            tuning=np.array([.075,.021,.30,.5])
            params=tuning[3]*tuning[[0,1,2,2]]
            assert c.mcd_set_tuning(*tuning)==1
        if k==105:
            tuning=np.array([.12,.01,.60,2.])
            params=tuning[3]*tuning[[0,1,2,2]]
            assert c.mcd_set_tuning(*tuning)==1
        dt=float(rng.uniform(.014,.047))
        v=float(np.float32(rng.uniform(.02,.95)))
        a=float(np.float32(rng.uniform(.001,.15)))
        I[0]=v
        assert c.mcd_step(a,dt)==1
        sol=solve_ivp(rhs,(0,dt),state,args=(v,a,params),method='DOP853',rtol=2e-12,atol=2e-15)
        assert sol.success
        state=sol.y[:,-1]
        ref=read_reference(state,params)
        result=np.r_[view(c,'debug',10,np.float64).copy(),view(c,'corr',1),view(c,'lag',1)]
        actual.append(result);reference.append(ref)
        fixture.append({'tuning':tuning.tolist(),'params':params.tolist(),'dt':dt,'video':v,'audio':a,'expected':ref.tolist()})
    actual=np.array(actual);reference=np.array(reference)
    peaks=np.maximum(np.max(np.abs(reference),axis=0),1e-30)
    errors=np.max(np.abs(actual-reference),axis=0)/peaks
    assert np.max(errors)<1e-4,errors
    labels=['V slow','V fast','A slow','A fast','V transient','A transient','V delayed','A delayed','u1','u2','corr','lag']
    report['checks']['independent_ode_reference']={
        'status':'PASS','reference':'SciPy DOP853; rtol=2e-12; atol=2e-15',
        'samples':len(fixture),'irregular_time_steps':True,'live_parameter_changes':2,
        'peak_normalised_errors':dict(zip(labels,errors.tolist()))}
    (BASE/'tests/fast-engine-9/ode_reference.json').write_text(json.dumps({'peaks':peaks.tolist(),'samples':fixture},indent=2))

    # Primed constant input must produce zero transients without a startup wait.
    c.mcd_init(3,2);I=view(c,'input',6);I[:]=[.1,.2,.3,.4,.5,.6]
    assert c.mcd_prime(.02)==1
    for _ in range(80): assert c.mcd_step(.02,1/30)==1
    assert np.max(np.abs(view(c,'corr',6)))==0
    assert np.max(np.abs(view(c,'lag',6)))==0
    assert view(c,'trace',6)[2]==0
    I[:]=.8
    for _ in range(20):c.mcd_step(.1,1/30)
    assert np.max(view(c,'corr',6))>0
    report['checks']['priming_and_live_response']='PASS'

    # Editing cut re-baselines VISUAL pathways only, not the audio filter.
    # Compare auditory filtered transient with an independent SciPy ODE step
    # from the precise pre-cut auditory state, which must be retained.
    c.mcd_init(1,1);I=view(c,'input',1);I[0]=.25
    assert c.mcd_prime(.03)==1
    audio_state=np.array([.03]*12+[0.,0.]);audio_tau=.0367;late=.18
    for k in range(40):
        I[0]=float(np.float32(.25 if k<20 else .65))
        a=float(np.float32(.03 if k%10<5 else .17));dt=1/30
        assert c.mcd_step(a,dt)==1
        state=np.zeros((2,14));state[1]=audio_state
        sol=solve_ivp(rhs,(0,dt),state.ravel(),args=(float(I[0]),a,DEFAULT),method='DOP853',rtol=1e-12,atol=1e-14)
        audio_state=sol.y[:,-1].reshape(2,14)[1]
    I[0]=.03
    cut_audio=float(np.float32(.21))
    state=np.zeros((2,14));state[1]=audio_state
    sol=solve_ivp(rhs,(0,1/30),state.ravel(),args=(float(I[0]),cut_audio,DEFAULT),method='DOP853',rtol=1e-12,atol=1e-14)
    expected_audio=read_reference(sol.y[:,-1],DEFAULT)[5]
    assert c.mcd_step_cut(cut_audio,1/30)==1
    np.testing.assert_allclose(view(c,'trace',6)[3],expected_audio,rtol=2e-4,atol=1e-8)
    assert view(c,'trace',6)[0]>.1
    assert view(c,'trace',6)[2]==view(c,'trace',6)[4]==view(c,'trace',6)[5]==0
    assert view(c,'corr',1)[0]==view(c,'lag',1)[0]==0
    report['checks']['visual_rebaseline_preserves_auditory_ode']='PASS'


    # Equal pathways + equal inputs must give zero lag, nonnegative corr.
    c.mcd_init(2,1);c.mcd_set_tuning(.045,.045,.18,1);I=view(c,'input',2)
    for k in range(120):
        z=.7 if k%20<10 else .1;I[:]=np.float32(z)
        c.mcd_step(ct.c_float(z),1/30)
        assert np.all(view(c,'corr',2)>=0)
        assert np.all(view(c,'lag',2)==0)
    report['checks']['symmetric_lag_and_nonnegative_correlation']='PASS'

    # Long tau: kernel tail must remain after 2 s (no finite FIR cutoff).
    c.mcd_init(1,1);c.mcd_set_tuning(.6,.6,.6,1);I=view(c,'input',1)
    I[0]=1;c.mcd_step(1,.02);I[0]=0
    for k in range(119): c.mcd_step(0,.02)
    assert view(c,'debug',10,np.float64)[4]>1e-6
    report['checks']['no_two_second_tail_truncation']='PASS'

    c.mcd_init(90,160)
    before=c.mcd_state_bytes()
    c.mcd_set_tuning(.12,.01,.60,4)
    after=c.mcd_state_bytes()
    assert before==after==(90*160+1)*14*8
    report['checks']['constant_state_memory']={'status':'PASS','state_bytes_at_90x160':before,'double_states_per_visual_pixel':14}
    # Shared second-stage constant and global proportional scaling are enforced in C.
    c.mcd_init(1,1)
    bases=np.array([.045,.0367,.18])
    for scale in (.25,.5,1.,2.,4.):
        assert c.mcd_set_tuning(*bases,scale)==1
        effective=view(c,'parameters',4,np.float64).copy()
        np.testing.assert_allclose(effective,scale*bases[[0,1,2,2]],rtol=1e-15)
        np.testing.assert_array_equal(view(c,'tuning',4,np.float64)[:3],bases)
        assert effective[2]==effective[3]
    c.mcd_step(.1,1/30)
    states_before=view(c,'debug',10,np.float64).copy();steps_before=c.mcd_steps()
    c.mcd_default_parameters()
    np.testing.assert_array_equal(view(c,'parameters',4,np.float64),DEFAULT)
    np.testing.assert_array_equal(view(c,'tuning',4,np.float64),[.045,.0367,.18,1.])
    assert c.mcd_steps()==steps_before
    np.testing.assert_array_equal(view(c,'debug',10,np.float64),states_before)
    report['checks']['shared_late_and_global_scale']={'status':'PASS',
        'scales':[.25,.5,1.,2.,4.],'base_values_preserved':True,
        'late_constants_equal':True,'reset_preserves_states':True}

    # Stretch both time and all taus. MCDq's unnormalised kernels retain their
    # amplitude scaling: early transient ~s, delayed transient ~s^2,
    # subunit ~s^3, correlation ~s^6, lag ~s^3 (not secretly renormalised).
    signals=np.float32(rng.uniform(.1,.9,(50,2)))
    runs=[]
    for scale in (1.,2.):
        c.mcd_init(1,1);c.mcd_set_tuning(*bases,scale);I=view(c,'input',1)
        y=[]
        for v,a in signals:
            I[0]=v;c.mcd_step(float(a),.02*scale)
            y.append(np.r_[view(c,'debug',10,np.float64).copy(),
                          view(c,'corr',1),view(c,'lag',1)])
        runs.append(np.array(y))
    powers=np.array([1,1,1,1,1,1,2,2,3,3,6,3])
    expected=runs[0]*2.**powers
    covariance_error=np.max(np.abs(runs[1]-expected),axis=0)/np.maximum(np.max(np.abs(expected),axis=0),1e-30)
    assert np.max(covariance_error)<1e-4,covariance_error
    report['checks']['time_scale_and_original_kernel_gains']={
        'status':'PASS','max_peak_normalised_error':float(np.max(covariance_error))}

    # No input history; pointer accessors for kernels/taps intentionally gone.
    assert not hasattr(c,'mcd_taps') and not hasattr(c,'mcd_kernels_ptr')
    assert c.mcd_step(.1,0)==0 and c.mcd_step(.1,np.nan)==0
    report['checks']['no_fir_interface']='PASS'
    (BASE/'tests/fast-engine-9/validation_report.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2))
    tmp.cleanup()

if __name__=='__main__':main()
