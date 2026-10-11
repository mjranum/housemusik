#!/bin/sh
# Generate a few short tone tracks so the app has something to play.
# Usage: sh test/make-demo-music.sh <dir>   (needs ffmpeg)
set -e
DIR="${1:-music}"
mkdir -p "$DIR/Test Tones/Chords" "$DIR/Test Tones/Sweeps"
n=1
for f in 220 277 330 440; do
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=$f:duration=20" -ac 2 -b:a 96k \
    -metadata title="Tone $f Hz" -metadata artist="Test Tones" -metadata album="Chords" \
    "$DIR/Test Tones/Chords/0$n Tone $f.mp3"
  n=$((n+1))
done
ffmpeg -loglevel error -y -f lavfi -i "aevalsrc=sin(2*PI*(200+40*t)*t):d=15" -ac 2 -b:a 96k \
  "$DIR/Test Tones/Sweeps/01 Rising sweep.mp3"
echo "demo tracks written to $DIR"
