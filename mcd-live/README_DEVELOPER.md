# MCD live — state-transition engine (fast-engine-9, ABI 9)

This upgrade starts from the existing automatic-playback-delay release. It changes
numerical implementation, frame scheduling, rendering and the final colour selection;
it does not change the scientific differential equations or source/response gains.

## Reference and defaults

The authoritative MATLAB reference is the user's `MCDq.m` in `reference/`.
Base constants: visual 0.045 s, auditory 0.0367 s, shared second-stage 0.180 s.
The global multiplier scales all three together (default 1, range 0.25–4).
The shared late constant is enforced in compiled C; auditory and visual late states
remain independent. Beta = 1, fast order = 6, slow order = 9.

For each modality there are twelve linear states with the same early tau:

    dx0/dt = (u - x0)/tau
    dxj/dt = (x(j-1) - xj)/tau, j=1,...,11
    fast = tau*(x6-x8)
    slow = tau*(x9-x11)
    transient = sqrt(fast^2 + slow^2)
    dy1/dt = (transient-y1)/late_tau
    dy2/dt = (y1-y2)/late_tau
    delayed_transient = late_tau*y2

These tau factors preserve the unnormalised kernels in MCDq.m.

    u1 = Vtransient * Adelayed
    u2 = Vdelayed * Atransient
    corr = u1*u2
    lag = u1-u2

There is one visual pathway per retained pixel and one shared mono auditory pathway.
The model receives grayscale pixel intensity, not the visual-change summary trace.

## New numerical solver

Input values are held constant during each supplied sample interval, as in the previous
streaming implementation. Under that assumption the early cascade has an analytic update:

    xj(h) = u + sum[k=0..j] c[k]*(x(j-k)(0)-u)
    c[k] = exp(-h/tau)*(h/tau)^k/k!

The two late states use their exact linear homogeneous solution plus quadrature of
the nonlinear transient drive:

    y1(h) = exp(-h/l)*y1(0) + integral[0,h] exp(-(h-s)/l)*f(s)/l ds
    y2(h) = exp(-h/l)*(y2(0)+h/l*y1(0))
            + integral[0,h] exp(-(h-s)/l)*(h-s)*f(s)/l^2 ds

At each quadrature node, f(s) is evaluated from the analytic early-state trajectory.
This is not endpoint smoothing, a different MCD, or an unqualified claim of an exact
solution for the nonlinear system. Composite eight-point Gauss-Legendre integration
introduces a small, measured numerical error. Panels adapt to early and late taus;
coefficients are prepared once per pathway/interval, not per pixel. Exponentially
negligible tail contributions beyond 96 early taus or 48 late taus are omitted from
the *quadrature interval*, never from persistent filter states. Homogeneous evolution
always spans the complete supplied interval.

State and internal accumulation precision remains double. SIMD batches two visual
pixels; the scalar binary follows the same arithmetic and quadrature. Both compiled
binaries import no JS numerical functions. exp(-x) for scalar coefficient preparation
uses range reduction and a 16-term local series; sqrt uses native WASM instructions.

The continuous-time formulation is not bitwise identical to the MATLAB function's
finite dt*conv and linspace sampling. Tests compare to independently integrated
continuous equations and analytic gamma responses, not to an unrun MATLAB runtime.

## Scheduling and overload

`frame-scheduler.js` chooses the oldest eligible captured frame after the last processed
frame. Only one model request is in flight. Ordinarily every captured frame is processed.
The capture/display timestamps and AV delay rules are unchanged.

The backlog bound is max(0.2 s, four recent source-frame intervals). If exceeded, or
if a comparable source interruption occurs, the current sample is sent with an explicit
resync flag. The worker primes BOTH pathways at that sample, without trying to integrate
the unknown missing interval under a false held image. The actual interval is not
silently shortened or stretched. Skipped samples and resyncs are counted, and missing
segments break all six trace polylines. This deliberately sacrifices continuity after
a real overload rather than creating a runaway workload or pretending to recover data.

This is NOT ordinary editing-cut handling. Editing cuts continue to prime the VISUAL
pathway only and advance the auditory pathway normally. Ordinary movie loops preserve
states except for optional visual cut handling; manual seeks reset both.

## Rendering and palettes

Model output and rendering are decoupled. Maps redraw at most 30 times per second;
intermediate model updates are not skipped merely because a paint is not due. Gain
multipliers are computed outside the pixel loop and palette RGBA words are cached.
The display still uses the same soft-log transform `log10(1+q)/3` or linear `q/70`,
clipped to [0,1]; these are display conventions, not calibrated acoustic dB.

The exact existing Violet Oklab ramp and Blue/orange lag ramps are retained, with exact
black at zero. Alternative palette selectors have been removed. Negative lag is blue
(Vision lead), positive lag orange (Audio lead). A near-zero lag is not proof of a strong
common-source correlation: use the separate correlation output.

No crop; original aspect ratio. Full-frame downsampling, movie progress slider,
automatic playback delay, cut-toggle location, independent scale/gain controls,
black traces and the two-difference visual display summary are preserved.

## Compilation

Already-built `mcd.wasm` and `mcd-scalar.wasm` are included. To reproduce them:

    bash build.sh

Requires Clang with WebAssembly target + wasm-ld. No Emscripten runtime or libc needed.
The script produces SIMD and scalar builds from the same `src/mcd.c`. The model worker
tries SIMD first, then scalar. ABI 9 guards against mixing older binaries and workers.
Main-thread code and the worker use the `fast-engine-9` cache key.

Clang's `-msimd128` enables 128-bit WebAssembly vector instructions. See the primary
compiler guidance: https://emscripten.org/docs/porting/simd.html
Frame metadata reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback

## Validation

See `tests/fast-engine-9/` for test code and reports. The archive includes direct ODE
fixtures, SIMD/scalar comparisons, native-worker tests, a scheduling/fallback test and
browser tests. Test scripts resolve the demo root automatically when placed in that
folder. The numerical Python tests require NumPy and SciPy; browser tests additionally
require Playwright, Chromium and FFmpeg. Adjust executable paths for your computer.
The benchmark additionally requires the prior WASM binary for a same-run comparison.

Browser runs here use real media decoding, Web Audio, Canvas and the actual WASM with
an explicit in-page Worker substitute, because normal browser localhost/worker loading
is restricted in this environment. The actual worker was separately exercised in a
native Node thread. These checks do not certify physical webcam/microphone timing or
predict a particular frame rate on another computer.

## Analytics / local installation

Merge this update into your existing `mcd-live` folder; do not delete it. This patch does
not include/overwrite `usage-config.js` or `usage-analytics.js`. It does not edit the root
academic website, publish anything, or send tests to the user's Cloudflare account.
