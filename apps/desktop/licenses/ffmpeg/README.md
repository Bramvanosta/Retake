# ffmpeg in Retake.app — licence, notices and source offer

Retake.app carries two separate programs, `ffmpeg` and `ffprobe` (in `Contents/Resources/ffmpeg/`), built from
unmodified upstream sources by `scripts/build-ffmpeg.mjs` in Retake's source repository. Retake runs them as separate
processes; it does not link them.

## What is in them, and under which licence

| Component | Version | Licence | Notice files here |
|---|---|---|---|
| FFmpeg (libavcodec, libavformat, libavfilter, libavdevice, libswscale, libswresample, libavutil, the `ffmpeg` and `ffprobe` tools) | 9.0.2 | GPL v2 or later as built (`--enable-gpl`, with libx264); LGPL v2.1 or later for most of its files | `ffmpeg-LICENSE.md`, `COPYING.GPLv2`, `COPYING.LGPLv2.1` |
| x264 (libx264, static) | 0.165, stable branch commit b35605ace3ddf7c1a5d67a2eb553f034aef41d55 | GPL v2 or later — Copyright (C) 2003-2025 x264 project | `x264-COPYING` |
| libvpx (static) | 1.17.0 | BSD 3-clause, with an additional patent grant — Copyright (c) 2010, The WebM Project authors | `libvpx-LICENSE`, `libvpx-PATENTS` |
| Opus (libopus, static) | 1.6.1 | BSD 3-clause — Copyright 2001-2023 Xiph.Org and the other holders listed | `opus-COPYING` |

FFmpeg is Copyright (c) 2000-2026 the FFmpeg developers. Because the build enables GPL parts and links libx264, the
combined programs `ffmpeg` and `ffprobe` are distributed under the **GNU General Public License, version 2 or later**
(`COPYING.GPLv2`). No nonfree component is included (`--disable-nonfree`: no libfdk-aac); the AAC and ProRes encoders
are FFmpeg's own. These programs come with NO WARRANTY, to the extent permitted by law (see `COPYING.GPLv2`).

## How they were built

macOS arm64, Apple clang, minimum macOS 15.0; the three libraries as static libraries into a scratch prefix
(`<deps>`), then FFmpeg against them through pkg-config. Only system libraries are linked (`/usr/lib`, `/System`).

```
x264:   ./configure --prefix=<deps> --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --extra-cflags=-mmacosx-version-min=15.0 --extra-ldflags=-mmacosx-version-min=15.0
libvpx: ./configure --target=arm64-darwin24-gcc --enable-static --disable-shared --enable-pic --disable-examples --disable-tools --disable-docs --disable-unit-tests --extra-cflags=-mmacosx-version-min=15.0
        make PREFIX=<deps> DIST_DIR=<deps> && make install PREFIX=<deps> DIST_DIR=<deps>
opus:   ./configure --prefix=<deps> --enable-static --disable-shared --with-pic --disable-doc --disable-extra-programs CFLAGS='-O2 -mmacosx-version-min=15.0'
ffmpeg: PKG_CONFIG_LIBDIR=<deps>/lib/pkgconfig ./configure --cc=clang --arch=arm64 --target-os=darwin --enable-static --disable-shared --disable-autodetect --enable-gpl --disable-nonfree --enable-libx264 --enable-libvpx --enable-libopus --enable-videotoolbox --enable-audiotoolbox --enable-zlib --disable-network --disable-ffplay --disable-doc --disable-debug --pkg-config=pkg-config --pkg-config-flags=--static --extra-cflags=-mmacosx-version-min=15.0 --extra-ldflags=-mmacosx-version-min=15.0
```

`ffmpeg -buildconf` prints the FFmpeg line of the copy you have.

## Source code (written offer)

The complete corresponding source code of these programs is the four upstream archives below, unmodified, plus the
build script `scripts/build-ffmpeg.mjs` (and its pinned list `scripts/ffmpeg-sources.json`) of the same Retake
release. Each archive is identified by its SHA-256:

| Archive | SHA-256 |
|---|---|
| https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2 | `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224` |
| https://github.com/webmproject/libvpx/archive/refs/tags/v1.17.0.tar.gz | `1020f184046187baa2985dbde38e0691f49c44088bca7a1842b0236c6081dc0a` |
| https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz | `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1` |

Each Retake release publishes these archives and the build script next to the app's disk image. In addition, for at
least three years from the date you received this copy of Retake.app, whoever distributed it to you will give any third
party, on request, a complete machine-readable copy of that source code on a medium customarily used for software
interchange, for a charge no more than the cost of physically performing the distribution.
