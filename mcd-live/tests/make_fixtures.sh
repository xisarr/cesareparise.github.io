#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures
ffmpeg -hide_banner -loglevel error -y \
 -f lavfi -i 'testsrc2=size=640x360:rate=30:duration=3' \
 -f lavfi -i 'aevalsrc=0.18*sin(2*PI*440*t)*(0.5+0.5*sin(2*PI*2*t))|0.12*sin(2*PI*660*t)*(0.5+0.5*sin(2*PI*2*t)):s=48000:d=3' \
 -c:v libx264 -preset ultrafast -crf 20 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart fixtures/test-stereo.mp4
ffmpeg -hide_banner -loglevel error -y \
 -f lavfi -i 'testsrc2=size=360x640:rate=24:duration=2' \
 -f lavfi -i 'sine=frequency=480:sample_rate=48000:duration=2' \
 -c:v libvpx -b:v 800k -c:a libopus -shortest fixtures/test-portrait.webm

# Abrupt edit: reversed black/white halves at t=1 s, with continuous audio.
ffmpeg -hide_banner -loglevel error -y \
 -f lavfi -i 'color=c=black:size=640x360:rate=30:duration=2.0' \
 -f lavfi -i 'sine=frequency=540:sample_rate=48000:duration=2.0' \
 -filter_complex "[0:v]drawbox=x=0:y=0:w=320:h=360:color=white:t=fill:enable='lt(t,1)',drawbox=x=320:y=0:w=320:h=360:color=white:t=fill:enable='gte(t,1)'[v]" \
 -map '[v]' -map '1:a' -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart fixtures/test-edits.mp4
