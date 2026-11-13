#!/bin/zsh
# Put the Genlock voice model online for the phone app, once per pinned model: the same Kokoro
# files the Mac speaks with (lib/voices.mjs ENGINE), from ~/.genlock/voice after lib/voices.mjs
# verify() has checked them, uploaded to the R2 bucket "genlock-builds" under voice/<model>/.
#
# The phone downloads them once and keeps them across app updates (TJ, 2026-11-12: "download
# the voice model once from our own link ... do not build it into the app"). Every piece is
# pinned by sha256 in app/src/main/assets/voice-model.json, which this script writes: the phone
# refuses a piece that does not match, so a changed file can never become a changed voice.
#
# model.onnx is 310 MiB, over Wrangler's 300 MiB upload limit, so it travels in 96 MiB parts
# that the phone joins and checks against the whole file's hash. espeak-ng-data is a folder of
# 120 files, so it travels as one zip.
#
#   mobile/voice_upload.sh            make the pieces, upload, check each online, write the manifest
#   mobile/voice_upload.sh --dry      make the pieces and the manifest, upload nothing
set -euo pipefail
here=${0:A:h}
root=${here:h}
model=kokoro-multi-lang-v1_0
src=${GENLOCK_VOICE_HOME:-$HOME/.genlock/voice}/$model
bucket=genlock-builds
manifest=$here/android/app/src/main/assets/voice-model.json
wr() { (cd $HOME && npx --no-install wrangler "$@") }

node --input-type=module -e "import { verify } from '$root/lib/voices.mjs'; verify();" \
  || { echo "the voice files here do not match their pins: genlock voice install"; exit 1; }
[[ -f $src/model.onnx ]] || { echo "no model at $src"; exit 1; }

work=$(mktemp -d -t genlock_voice)
trap 'rm -rf $work' EXIT
cd $src
split -b 96m -a 1 model.onnx $work/model.onnx.part-     # part-a, part-b, ...
cp voices.bin tokens.txt lexicon-us-en.txt lexicon-gb-en.txt $work/
# Sorted names, no extra attributes: the same folder makes the same zip.
find espeak-ng-data -type f | LC_ALL=C sort | zip -qX -0 $work/espeak-ng-data.zip -@

public=https://pub-9940b8a7001844d88ff982b0fc52632e.r2.dev
sha() { shasum -a 256 $1 | cut -d' ' -f1 }
size() { stat -f %z $1 }

python3 - $work $model $public "$(sha model.onnx)" > $work/manifest.json <<'PY'
import json, os, sys, hashlib
work, model, public, whole = sys.argv[1:5]
h = lambda p: hashlib.sha256(open(p, 'rb').read()).hexdigest()
piece = lambda n: {'path': n, 'size': os.path.getsize(os.path.join(work, n)), 'sha256': h(os.path.join(work, n))}
parts = sorted(n for n in os.listdir(work) if n.startswith('model.onnx.part-'))
files = [{'name': 'model.onnx', 'sha256': whole, 'parts': [piece(p) for p in parts]}]
for n in ['voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'lexicon-gb-en.txt']:
    files.append({'name': n, 'sha256': h(os.path.join(work, n)), 'parts': [piece(n)]})
files.append({'name': 'espeak-ng-data', 'unzip': True, 'sha256': h(os.path.join(work, 'espeak-ng-data.zip')), 'parts': [piece('espeak-ng-data.zip')]})
print(json.dumps({'model': model, 'base': f'{public}/voice/{model}/', 'files': files}, indent=2))
PY

mkdir -p ${manifest:h}
cp $work/manifest.json $manifest
echo "manifest: $manifest"
[[ "${1:-}" == "--dry" ]] && { ls -la $work; exit 0; }

for f in $(python3 -c 'import json,sys;[print(p["path"]) for f in json.load(open(sys.argv[1]))["files"] for p in f["parts"]]' $manifest); do
  online=$(curl -sI "$public/voice/$model/$f" | awk 'tolower($1)=="content-length:"{print $2+0}')
  if [[ $online == $(size $work/$f) ]]; then echo "already online: $f"; continue; fi
  wr r2 object put "$bucket/voice/$model/$f" --file $work/$f --remote --content-type application/octet-stream
  online=$(curl -sI "$public/voice/$model/$f" | awk 'tolower($1)=="content-length:"{print $2+0}')
  [[ $online == $(size $work/$f) ]] || { echo "upload check FAILED for $f: online $online bytes"; exit 1; }
  echo "online: $f ($online bytes)"
done
echo "Voice model online at $public/voice/$model/ and pinned in $manifest"
