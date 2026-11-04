#!/bin/sh
# Retake's command inside Retake.app (Contents/Resources/bin/retake): the app's own Node.js and engine. A link to this
# file on the PATH runs it too — the real path decides where the app is; a copy outside an app refuses to run.
# What makes Node.js or the dynamic linker load other code is dropped first — the same names the shell drops for its
# Studio server (desktop_core::child_env_dropped; a test compares the two lists; DYLD_* is ignored under the hardened
# runtime anyway) — and Node.js loads the app's module lookup guard before the engine (node/guard.cjs: the app's code
# never resolves a module from a node_modules folder above the app).
unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT
for name in $(/usr/bin/env | /usr/bin/sed -n 's/^\(DYLD_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$name"; done
export WS_NO_BUFFER_UTIL=1 WS_NO_UTF_8_VALIDATE=1
self=$(/bin/realpath -- "$0") || exit 1
res=$(/usr/bin/dirname "$(/usr/bin/dirname "$self")")
case "$res" in
  *.app/Contents/Resources) ;;
  *) echo "retake: $self is not inside an app (Retake.app/Contents/Resources/bin/retake): link to it, do not copy it" >&2; exit 1 ;;
esac
if [ ! -x "$res/node/bin/node" ] || [ ! -f "$res/engine/dist/bin.js" ] || [ ! -f "$res/node/guard.cjs" ]; then
  echo "retake: $res is not a complete Retake app: install it again from its disk image" >&2
  exit 1
fi
exec "$res/node/bin/node" --require "$res/node/guard.cjs" "$res/engine/dist/bin.js" "$@"
