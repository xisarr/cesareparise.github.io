from pathlib import Path
import numpy as np, subprocess
out=Path(__file__).resolve().parent/'fixtures'/'test-moderate-cuts.mp4';out.parent.mkdir(exist_ok=True)
w,h=384,216; fps=30;duration=5
p=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{w}x{h}','-r',str(fps),'-i','-','-f','lavfi','-i',f'sine=frequency=440:sample_rate=48000:duration={duration}','-c:v','libx264','-preset','ultrafast','-crf','12','-pix_fmt','yuv420p','-c:a','aac','-shortest','-movflags','+faststart',str(out)],stdin=subprocess.PIPE)
y,x=np.mgrid[:h,:w]
for i in range(fps*duration):
 t=i/fps; phase=int(1.4<=t<3.0)
 sign=np.where((x//24+y//24+phase)%2,1.,-1.)
 img=np.clip(.45+.045*sign+.0015*np.sin(t*2*np.pi),0,1)
 # black side bars deliberately retain only the central 50% of the frame
 img[:, :w//4]=0;img[:,3*w//4:]=0
 # A small moving patch gives nonzero ordinary visual-change samples.
 xx=w//2-15+int(8*np.sin(2*np.pi*t));img[85:98,xx:xx+10]=.52
 frame=np.repeat(np.round(img[:,:,None]*255).astype(np.uint8),3,axis=2)
 p.stdin.write(frame.tobytes())
p.stdin.close();assert p.wait()==0
print(out)
