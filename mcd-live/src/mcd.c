/*
 * MCD continuous-time state-transition engine, ABI 9.
 * Reference: the supplied MCDq.m (45 / 36.7 / 180 ms, shared late tau).
 *
 * Twelve equal-tau linear states form each unimodal gamma cascade:
 *   tau*x0' = u-x0; tau*xj' = x(j-1)-xj.
 * Their exact zero-order-hold solution for h>0 is
 *   xj(h) = u + sum(k=0..j) exp(-h/tau)*(h/tau)^k/k! * (x(j-k)(0)-u).
 * fast=tau*(x6-x8), slow=tau*(x9-x11), transient=hypot(fast,slow).
 * The final two states are the exponential cascade driven by this NONLINEAR
 * transient. Its convolution is integrated with composite 8-point Gauss-Legendre
 * quadrature, evaluating the early trajectory analytically at each node.
 * Thus no generic smoother replaces the transient or late filters. Exact linear
 * evolution is distinguished from numerical quadrature of the nonlinear drive.
 *
 * Coefficients are prepared once per frame/path, not once per pixel. The SIMD
 * binary processes two pixels in parallel with DOUBLE-precision state vectors.
 * The scalar binary uses the same equations/quadrature. No fast-math is used.
 * No input-history buffer, fixed RK step, or silently shortened dt is used here.
 *
 * u1=Vtr*(late_tau*Alate2), u2=Atr*(late_tau*Vlate2);
 * corr=u1*u2; lag=u1-u2. Gains match the non-unit-area kernels in MCDq.m.
 */
#include <stdint.h>
#include <stddef.h>
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#define LANES 2
#else
#define LANES 1
#endif
#define EARLY_STATES 12
#define PATH_STATES 14
#define MAX_PIXELS 2073600
#define PARAM_MIN 0.00025
#define PARAM_MAX 5.0
#define MAX_DT 5.0
#define VERSION 9
#define MAX_NODES 192

static int g_width,g_height,g_pixels,g_stride;
static unsigned int g_steps;
static double g_tuning[4]={.045,.0367,.18,1.};
static double g_parameters[4]={.045,.0367,.18,.18};
static double *g_visual_states,*g_audio_states;
static float *g_input,*g_previous,*g_corr,*g_lag,*g_trace;
static double g_debug[10];
static unsigned char *g_arena;
static size_t g_arena_bytes;
static int g_previous_valid,g_probe;
static unsigned int g_last_nodes;
#ifdef __wasm32__
extern unsigned char __heap_base;
static unsigned char *allocate_arena(size_t n){
 uintptr_t base=((uintptr_t)&__heap_base+15u)&~(uintptr_t)15u;
 uintptr_t need=base+n,current=(uintptr_t)__builtin_wasm_memory_size(0)*65536u;
 if(need>current&&__builtin_wasm_memory_grow(0,(need-current+65535u)/65536u)==(size_t)-1)return 0;
 return (unsigned char*)base;
}
#else
#include <stdlib.h>
static unsigned char *allocate_arena(size_t n){unsigned char *p=malloc(n);if(p&&g_arena)free(g_arena);return p;}
#endif
void *memset(void *dest,int value,size_t n){unsigned char *p=dest;for(size_t i=0;i<n;++i)p[i]=(unsigned char)value;return dest;}
static void zero_bytes(void *p,size_t n){memset(p,0,n);}
static int finite_float(float x){return x<=3.402823466e+38F&&x>=-3.402823466e+38F;}
static int valid_parameter(double x){return x>=PARAM_MIN&&x<=PARAM_MAX;}
static double absd(double x){return x<0?-x:x;}
static double maxd(double a,double b){return a>b?a:b;}
static double mind(double a,double b){return a<b?a:b;}

/* Accurate scalar exp(-x), x>=0. Called for coefficient preparation ONLY.
 * Range reduction plus 16-term Taylor on |r|<=ln(2)/2. Avoids a libc import. */
static double exp_neg(double x){
 if(x>745.)return 0.;
 const double LN2=0.693147180559945309417232121458;
 int k=(int)(x/LN2+.5);double r=k*LN2-x;
 double p=1.,term=1.;
 for(int i=1;i<=16;++i){term*=r/i;p+=term;}
 union {uint64_t u;double d;} v;
 if(k>1074)return 0.;
 if(k<=1022){v.u=(uint64_t)(1023-k)<<52;return p*v.d;}
 v.u=(uint64_t)1<<(1074-k);return p*v.d;
}
static void kernel(double r,double *c){c[0]=exp_neg(r);for(int k=1;k<12;++k)c[k]=c[k-1]*r/k;}

typedef struct {double fast[12],slow[12],w1,w2;} Node;
typedef struct {double end[12],decay,r,tau;int count;Node nodes[MAX_NODES];} Plan;
static Plan vplan,aplan;
static double cached_dt=-1,cached_tv=-1,cached_ta=-1,cached_late=-1;
static const double GLX[8]={-.96028985649753623168,-.79666647741362673959,-.52553240991632898582,-.18343464249564980494,.18343464249564980494,.52553240991632898582,.79666647741362673959,.96028985649753623168};
static const double GLW[8]={.10122853629037625915,.22238103445337447054,.31370664587788728734,.36268378337836198297,.36268378337836198297,.31370664587788728734,.22238103445337447054,.10122853629037625915};
static void add_point(double *points,int *n,double x,double lo,double hi){if(x>lo+1e-14&&x<hi-1e-14)points[(*n)++]=x;}
static void make_plan(Plan *p,double h,double early,double late){
 kernel(h/early,p->end);p->r=h/late;p->decay=exp_neg(p->r);p->tau=early;p->count=0;
 /* Beyond these exponential tails the omitted nonlinear contribution is
  * below ~1e-18 of a bounded pathway-state scale, not a 2-s signal cutoff.
  * The entire homogeneous state evolution still spans the full h. */
 double lo=maxd(0.,h-48.*late),hi=mind(h,96.*early);
 if(!(hi>lo))return;
 double points[24];int n=0;points[n++]=lo;points[n++]=hi;
 for(double f=2.;f<=64.;f*=2.){add_point(points,&n,f*early,lo,hi);add_point(points,&n,h-f*late,lo,hi);}
 for(int i=1;i<n;++i){double x=points[i];int j=i-1;while(j>=0&&points[j]>x){points[j+1]=points[j];--j;}points[j+1]=x;}
 for(int b=0;b<n-1;++b){
  double half=(points[b+1]-points[b])*.5,mid=(points[b]+points[b+1])*.5;
  if(half<1e-14)continue;
  for(int q=0;q<8;++q){
   Node *z=&p->nodes[p->count++];double s=mid+half*GLX[q],c[12];kernel(s/early,c);
   for(int j=0;j<12;++j){z->fast[j]=early*((j<=6?c[6-j]:0.)-(j<=8?c[8-j]:0.));z->slow[j]=early*((j<=9?c[9-j]:0.)-c[11-j]);}
   double r=(h-s)/late;z->w1=half*GLW[q]*exp_neg(r)/late;z->w2=z->w1*r;
  }
 }
}
static void prepare(double dt){
 if(dt!=cached_dt||g_parameters[0]!=cached_tv||g_parameters[1]!=cached_ta||g_parameters[2]!=cached_late){
  make_plan(&vplan,dt,g_parameters[0],g_parameters[2]);make_plan(&aplan,dt,g_parameters[1],g_parameters[3]);
  cached_dt=dt;cached_tv=g_parameters[0];cached_ta=g_parameters[1];cached_late=g_parameters[2];
 }
 g_last_nodes=vplan.count;
}
int mcd_set_tuning(double v,double a,double l,double scale){
 if(!valid_parameter(v)||!valid_parameter(a)||!valid_parameter(l)||!(scale>=.25&&scale<=4.))return 0;
 if(!valid_parameter(v*scale)||!valid_parameter(a*scale)||!valid_parameter(l*scale))return 0;
 g_tuning[0]=v;g_tuning[1]=a;g_tuning[2]=l;g_tuning[3]=scale;
 g_parameters[0]=v*scale;g_parameters[1]=a*scale;g_parameters[2]=g_parameters[3]=l*scale;return 1;
}
void mcd_default_parameters(void){(void)mcd_set_tuning(.045,.0367,.18,1.);}
int mcd_init(int w,int h){
 if(w<1||h<1||(int64_t)w*h>MAX_PIXELS)return 0;
 size_t n=(size_t)w*h,padded=(n+LANES-1)/LANES*LANES;
 size_t bytes=(padded+1)*14*sizeof(double)+(4*padded+6)*sizeof(float);
 unsigned char *p=allocate_arena(bytes);if(!p)return 0;
 g_arena=p;g_arena_bytes=bytes;zero_bytes(p,bytes);
 g_visual_states=(double*)p;g_audio_states=g_visual_states+padded*14;
 g_input=(float*)(g_audio_states+14);g_previous=g_input+padded;g_corr=g_previous+padded;g_lag=g_corr+padded;g_trace=g_lag+padded;
 g_width=w;g_height=h;g_pixels=(int)n;g_stride=(int)padded;g_probe=0;g_steps=0;g_previous_valid=0;g_last_nodes=0;
 zero_bytes(g_debug,sizeof(g_debug));mcd_default_parameters();return 1;
}
int mcd_version(void){return VERSION;}
int mcd_simd(void){return LANES==2;}
unsigned int mcd_quadrature_nodes(void){return g_last_nodes;}
int mcd_pixels(void){return g_pixels;}
unsigned int mcd_steps(void){return g_steps;}
size_t mcd_state_bytes(void){return g_pixels?((size_t)g_stride+1)*14*sizeof(double):0;}
size_t mcd_memory_bytes(void){return g_arena_bytes;}
uintptr_t mcd_input_ptr(void){return(uintptr_t)g_input;}
uintptr_t mcd_corr_ptr(void){return(uintptr_t)g_corr;}
uintptr_t mcd_lag_ptr(void){return(uintptr_t)g_lag;}
uintptr_t mcd_trace_ptr(void){return(uintptr_t)g_trace;}
uintptr_t mcd_parameters_ptr(void){return(uintptr_t)g_parameters;}
uintptr_t mcd_tuning_ptr(void){return(uintptr_t)g_tuning;}
uintptr_t mcd_debug_ptr(void){return(uintptr_t)g_debug;}
int mcd_set_probe(int x,int y){if(x<0||y<0||x>=g_width||y>=g_height||!g_pixels)return 0;g_probe=y*g_width+x;return 1;}
void mcd_reset(void){if(!g_arena)return;zero_bytes(g_arena,g_arena_bytes);zero_bytes(g_debug,sizeof(g_debug));g_steps=0;g_previous_valid=0;}
static double transient(const double *s,double tau){double f=tau*(s[6]-s[8]),l=tau*(s[9]-s[11]);return __builtin_sqrt(f*f+l*l);}
static void update_scalar(double *s,double input,const Plan *p){
 double d[12];for(int j=0;j<12;++j)d[j]=s[j]-input;
 double y1=p->decay*s[12],y2=p->decay*(s[13]+p->r*s[12]);
 for(int q=0;q<p->count;++q){const Node *z=p->nodes+q;double f=0.,l=0.;
  for(int j=0;j<12;++j){f+=z->fast[j]*d[j];l+=z->slow[j]*d[j];}
  double ftr=__builtin_sqrt(f*f+l*l);y1+=z->w1*ftr;y2+=z->w2*ftr;
 }
 for(int j=0;j<12;++j){double v=input;for(int k=0;k<=j;++k)v+=p->end[k]*d[j-k];s[j]=v;}
 s[12]=y1;s[13]=y2;
}
#ifdef __wasm_simd128__
typedef v128_t V;
#define VS(x) wasm_f64x2_splat(x)
#define ADD(a,b) wasm_f64x2_add(a,b)
#define MUL(a,b) wasm_f64x2_mul(a,b)
#define SUB(a,b) wasm_f64x2_sub(a,b)
static void update_pair(double *s,V input,const Plan *p,V *vtr,V *late){
 V d[12];for(int j=0;j<12;++j)d[j]=SUB(wasm_v128_load(s+2*j),input);
 V old1=wasm_v128_load(s+24),old2=wasm_v128_load(s+26);
 V y1=MUL(VS(p->decay),old1),y2=MUL(VS(p->decay),ADD(old2,MUL(VS(p->r),old1)));
 for(int q=0;q<p->count;++q){const Node *z=p->nodes+q;V f=VS(0),l=VS(0);
  for(int j=0;j<12;++j){f=ADD(f,MUL(VS(z->fast[j]),d[j]));l=ADD(l,MUL(VS(z->slow[j]),d[j]));}
  V tr=wasm_f64x2_sqrt(ADD(MUL(f,f),MUL(l,l)));y1=ADD(y1,MUL(VS(z->w1),tr));y2=ADD(y2,MUL(VS(z->w2),tr));
 }
 V x[12];for(int j=0;j<12;++j){V v=input;for(int k=0;k<=j;++k)v=ADD(v,MUL(VS(p->end[k]),d[j-k]));x[j]=v;wasm_v128_store(s+2*j,v);}
 wasm_v128_store(s+24,y1);wasm_v128_store(s+26,y2);
 V f=MUL(VS(p->tau),SUB(x[6],x[8])),l=MUL(VS(p->tau),SUB(x[9],x[11]));
 *vtr=wasm_f64x2_sqrt(ADD(MUL(f,f),MUL(l,l)));*late=MUL(VS(g_parameters[2]),y2);
}
#endif
static void prime_visual(void){
 for(int i=0;i<g_stride;++i){double value=i<g_pixels?g_input[i]:0.;int b=i/LANES*LANES,lane=i%LANES;
  double *s=g_visual_states+(size_t)b*14;
  for(int j=0;j<12;++j)s[j*LANES+lane]=value;
  s[12*LANES+lane]=s[13*LANES+lane]=0;g_previous[i]=(float)value;g_corr[i]=g_lag[i]=0;
 }
}
int mcd_prime(float audio){
 if(!g_pixels||!finite_float(audio)||audio<0)return 0;
 for(int i=0;i<g_pixels;++i)if(!finite_float(g_input[i]))return 0;
 prime_visual();for(int j=0;j<12;++j)g_audio_states[j]=audio;g_audio_states[12]=g_audio_states[13]=0;
 zero_bytes(g_trace,6*sizeof(float));g_trace[1]=audio;zero_bytes(g_debug,sizeof(g_debug));g_steps=0;g_previous_valid=1;return 1;
}
static void debug_first(double atr,double ad){
 double *s=g_visual_states,tv=g_parameters[0],ta=g_parameters[1];
 g_debug[0]=tv*(s[9*LANES]-s[11*LANES]);g_debug[1]=tv*(s[6*LANES]-s[8*LANES]);
 g_debug[2]=ta*(g_audio_states[9]-g_audio_states[11]);g_debug[3]=ta*(g_audio_states[6]-g_audio_states[8]);
 g_debug[4]=__builtin_sqrt(g_debug[0]*g_debug[0]+g_debug[1]*g_debug[1]);g_debug[5]=atr;
 g_debug[6]=g_parameters[2]*s[13*LANES];g_debug[7]=ad;g_debug[8]=g_debug[4]*ad;g_debug[9]=g_debug[6]*atr;
}
int mcd_step(float audio,double dt){
 if(!g_pixels||!(dt>0&&dt<=MAX_DT)||!finite_float(audio)||audio<0)return 0;
 for(int i=0;i<g_pixels;++i)if(!finite_float(g_input[i]))return 0;
 prepare(dt);update_scalar(g_audio_states,audio,&aplan);
 double atr=transient(g_audio_states,g_parameters[1]),ad=g_parameters[3]*g_audio_states[13];
 double sum_diff=0.,sum_v=0.,sum_c=0.,sum_l=0.;
#ifdef __wasm_simd128__
 for(int i=0;i<g_stride;i+=2){
  double a=g_input[i],b=i+1<g_pixels?g_input[i+1]:a;
  V vt,vd;update_pair(g_visual_states+(size_t)i*14,wasm_f64x2_make(a,b),&vplan,&vt,&vd);
  V u1=MUL(vt,VS(ad)),u2=MUL(vd,VS(atr)),cv=MUL(u1,u2),lv=SUB(u1,u2);
  double cs[2]={wasm_f64x2_extract_lane(cv,0),wasm_f64x2_extract_lane(cv,1)};
  double ls[2]={wasm_f64x2_extract_lane(lv,0),wasm_f64x2_extract_lane(lv,1)};
  double ts[2]={wasm_f64x2_extract_lane(vt,0),wasm_f64x2_extract_lane(vt,1)};
  for(int lane=0;lane<2&&i+lane<g_pixels;++lane){int idx=i+lane;double in=g_input[idx];
   if(g_previous_valid)sum_diff+=absd(in-g_previous[idx]);g_previous[idx]=(float)in;g_corr[idx]=(float)cs[lane];g_lag[idx]=(float)ls[lane];
   sum_v+=ts[lane];sum_c+=cs[lane];sum_l+=ls[lane];}
 }
#else
 for(int i=0;i<g_pixels;++i){double *s=g_visual_states+(size_t)i*14,in=g_input[i];
  if(g_previous_valid)sum_diff+=absd(in-g_previous[i]);g_previous[i]=(float)in;
  update_scalar(s,in,&vplan);double vtr=transient(s,g_parameters[0]),vd=g_parameters[2]*s[13];
  double u1=vtr*ad,u2=vd*atr,c=u1*u2,l=u1-u2;g_corr[i]=(float)c;g_lag[i]=(float)l;
  sum_v+=vtr;sum_c+=c;sum_l+=l;
 }
#endif
 debug_first(atr,ad);g_trace[0]=(float)(sum_diff/g_pixels);g_trace[1]=audio;g_trace[2]=(float)(sum_v/g_pixels);g_trace[3]=(float)atr;
 g_trace[4]=(float)(sum_c/g_pixels);g_trace[5]=(float)(sum_l/g_pixels);++g_steps;g_previous_valid=1;return 1;
}
int mcd_step_cut(float audio,double dt){
 if(!g_pixels||!(dt>0&&dt<=MAX_DT)||!finite_float(audio)||audio<0)return 0;
 double diff=0.;for(int i=0;i<g_pixels;++i){if(!finite_float(g_input[i]))return 0;if(g_previous_valid)diff+=absd(g_input[i]-g_previous[i]);}
 prepare(dt);update_scalar(g_audio_states,audio,&aplan);prime_visual();
 double atr=transient(g_audio_states,g_parameters[1]);g_trace[0]=(float)(diff/g_pixels);g_trace[1]=audio;g_trace[2]=0;g_trace[3]=(float)atr;g_trace[4]=g_trace[5]=0;
 debug_first(atr,g_parameters[3]*g_audio_states[13]);g_previous_valid=1;++g_steps;return 1;
}
