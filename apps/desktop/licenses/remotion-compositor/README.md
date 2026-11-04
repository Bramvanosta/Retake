# Remotion's compositor in Retake.app — licence notice and source pointer

Retake renders its videos with Remotion. Remotion's npm package `@remotion/compositor-darwin-arm64 4.0.534` ships
inside the app as npm ships it (`Contents/Resources/engine/node_modules/@remotion/compositor-darwin-arm64/`), its
install names only rewritten to `@loader_path` and re-signed. It holds Remotion's `remotion` program and its own
FFmpeg build, separate from Retake's own `ffmpeg` / `ffprobe` (`../ffmpeg/README.md`):

| File | What it is |
|---|---|
| `ffmpeg`, `ffprobe` | FFmpeg's programs |
| `libavcodec.dylib`, `libavdevice.dylib`, `libavfilter.dylib`, `libavformat.dylib`, `libavutil.dylib`, `libswresample.dylib`, `libswscale.dylib` | FFmpeg's libraries (shared) |
| `remotion` | Remotion's compositor (Rust), linked against those libraries |

## What the FFmpeg build is, as the binaries report it

- **FFmpeg n7.1**, built for macOS 15.0 arm64 with Apple clang 17. `ffmpeg -L` prints the **GNU General Public
  License, version 2 or later** (`--enable-gpl`). The GPL text: `../ffmpeg/COPYING.GPLv2`; FFmpeg's own licence
  notes: `../ffmpeg/ffmpeg-LICENSE.md`.
- Its configuration (`ffmpeg -buildconf` in that folder, with `DYLD_LIBRARY_PATH` set to it, prints it in full)
  enables, among others: `--enable-gpl --enable-shared --enable-small --enable-libx264 --enable-libx265
  --enable-libaom --enable-libdav1d --enable-libvpx --enable-libopus --enable-libmp3lame --enable-libzimg
  --enable-libfdk-aac --enable-videotoolbox`, with a reduced set of filters, encoders, decoders, muxers and demuxers
  and a Remotion input device (`--enable-indev=remotionshm`).
- Libraries compiled in: x264, x265 (API 215), libaom, dav1d, libvpx, Opus (`libopus 1.3.1` in its strings), LAME
  (`3.101`), zimg, fdk-aac; the other versions are not printed by the binaries (strings `1.2.1-0-g8a6f054e` and
  `v1.12.0` are probably dav1d's and libvpx's).
- **fdk-aac** (the Fraunhofer AAC library) is in the build while `--enable-gpl` is set. FFmpeg's own configure
  treats that pair as non-redistributable unless `--enable-nonfree`; the binary does not say it. Remotion encodes
  AAC audio with it (its renderer maps the `aac` audio codec to `libfdk_aac`), so Retake's renders use it. This is
  recorded for the commercial release (BACKLOG BL-138), not settled here.

These facts were read from the files of version 4.0.534 when Retake staged them; the stage refuses a compositor of
another version until this notice is updated.

## Source code

- Remotion's compositor package: the repository its `package.json` names,
  https://github.com/remotion-dev/remotion/tree/main/packages/compositor-darwin-arm64 (Remotion's monorepo, at its
  4.0.534 release). Where Remotion publishes the exact FFmpeg source and build script of this compositor was not
  checked offline: the commercial release must confirm it (BACKLOG BL-138).
- FFmpeg n7.1 upstream: https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz (Remotion may patch it: its repository is the
  reference for the exact source).

Retake does not modify these files and does not, today, carry a written offer of its own for them: that is part of
the commercial release (BACKLOG BL-138). Remotion itself is licensed under its own terms (`../remotion/LICENSE.md`).
