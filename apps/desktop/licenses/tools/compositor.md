# The compositor — Remotion compositor 4.0.534

**What it is.** Remotion's npm package `@remotion/compositor-darwin-arm64` 4.0.534: Remotion's `remotion` program
(Rust) and its own FFmpeg build, which Remotion's renderer runs to encode Retake's renders. It is separate from
Retake's own `ffmpeg` / `ffprobe` (`../ffmpeg/README.md`), which the app carries.

| File | What it is |
|---|---|
| `ffmpeg`, `ffprobe` | FFmpeg's programs |
| `libavcodec.dylib`, `libavdevice.dylib`, `libavfilter.dylib`, `libavformat.dylib`, `libavutil.dylib`, `libswresample.dylib`, `libswscale.dylib` | FFmpeg's libraries (shared) |
| `remotion` | Remotion's compositor, linked against those libraries |

**Who publishes it.** Remotion (the Remotion project), on the npm registry.

**Where it comes from.** Retake does not carry it and does not redistribute it. On your click (Set-up › Tools, or
`retake tools install`) Retake downloads the package's tarball, unmodified, from the npm registry:

    https://registry.npmjs.org/@remotion/compositor-darwin-arm64/-/compositor-darwin-arm64-4.0.534.tgz

It checks the tarball's size and sha256 before extracting anything (its sha512 is the integrity Retake's lockfile
pins), and the extracted folder's digest after, then keeps the package's files in your Retake home
(`<RETAKE_HOME>/tools/compositor-4.0.534`).

**Its licences.**
- Remotion's own code is under Remotion's licence (the text Remotion's packages carry: `../remotion/LICENSE.md`);
  the package itself names no other licence.
- Its FFmpeg is **FFmpeg n7.1** built with `--enable-gpl`: `ffmpeg -L` prints the **GNU General Public License,
  version 2 or later** (the GPL text: `../ffmpeg/COPYING.GPLv2`; FFmpeg's licence notes: `../ffmpeg/ffmpeg-LICENSE.md`).
  Its configuration (`ffmpeg -buildconf` in that folder, with `DYLD_LIBRARY_PATH` set to it) enables, among others,
  x264, x265, libaom, dav1d, libvpx, Opus, LAME, zimg and **fdk-aac** (the Fraunhofer AAC library), and VideoToolbox.
  FFmpeg's own configure treats fdk-aac with `--enable-gpl` as non-redistributable unless `--enable-nonfree`; the
  binary does not say which. Remotion encodes AAC audio with it.
- The source: Remotion's repository for this package
  (https://github.com/remotion-dev/remotion/tree/main/packages/compositor-darwin-arm64, at its 4.0.534 release) and
  FFmpeg n7.1 upstream (https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz; Remotion may patch it).

Retake never fetches these terms itself; this notice is Retake's own summary, read from the files of version 4.0.534.
