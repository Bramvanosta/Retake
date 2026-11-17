/**
 * The conversion's arguments (src/convert.ts), pure: the recording's decode times ignored, a black base at the
 * capture's rate held to the end of the take, the recording from time 0 read as BT.709 TV range, the touch overlay
 * converted with the BT.709 matrix, round(endT · fps) frames, BT.709 TV tags; ffprobe's packet times sorted and from 0;
 * the touch box kept inside the picture.
 */
import { describe, expect, it } from 'vitest';
import { convertArgs, fromCaptureStart, onCaptureClock, parseProbe, takeFrames, touchBox } from '../src/convert.js';
import { idleTimes, recordingProblem } from '../src/take.js';

const ARGS = {
  mov: '/r/.ios/capture.mov',
  list: '/r/.ios/touches/touches.ffconcat',
  out: '/r/capture.mp4',
  endT: 35.417,
  fps: 30,
  width: 1206,
  height: 2622,
  codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16'],
};

describe('the conversion', () => {
  it('round(endT · fps) frames', () => {
    expect(takeFrames(35.417, 30)).toBe(1063);
    expect(takeFrames(35.399, 30)).toBe(1062);
    expect(takeFrames(35.41, 30)).toBe(1062);
    expect(takeFrames(0.01, 30)).toBe(1);
    const a = convertArgs(ARGS);
    expect(a[a.indexOf('-frames:v') + 1]).toBe('1063');
  });

  it('inputs: the recording with its decode times ignored, the overlay list; the graph and the tags', () => {
    const a = convertArgs(ARGS);
    expect(a.slice(a.indexOf('-fflags'), a.indexOf('-fflags') + 4)).toEqual(['-fflags', '+igndts', '-i', '/r/.ios/capture.mov']);
    expect(a.slice(a.indexOf('concat') - 1, a.indexOf('concat') + 5)).toEqual(['-f', 'concat', '-safe', '0', '-i', '/r/.ios/touches/touches.ffconcat']);
    const graph = a[a.indexOf('-filter_complex') + 1].split(';');
    expect(graph).toEqual([
      'color=c=black:s=1206x2622:r=30:d=35.417,format=yuv420p[base]',
      '[0:v]setpts=PTS-STARTPTS,scale=1206:2622:in_range=tv:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,format=yuv420p[screen]',
      '[base][screen]overlay=eof_action=repeat:format=yuv420[filmed]',
      '[1:v]format=rgba,scale=1206:2622:out_range=tv:out_color_matrix=bt709,format=yuva420p[touches]',
      '[filmed][touches]overlay=eof_action=repeat:format=yuv420,format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709[out]',
    ]);
    expect(a).toEqual(expect.arrayContaining(['-map', '[out]', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', '30', '-an']));
    expect(a.slice(a.indexOf('-c:v'), a.indexOf('-c:v') + 6)).toEqual(ARGS.codec);
    expect(a.at(-1)).toBe('/r/capture.mp4');
  });

  it("ffprobe's packet times: sorted (decode order is not presentation order), from the first; the stream's size", () => {
    const p = parseProbe('0.000000\n2.511667\n2.501667\n2.500000,\n\n', '1206,2622\n');
    expect(p).toEqual({ width: 1206, height: 2622, frameTimes: [0, 2.5, 2.501667, 2.511667], first: 0, shift: 0 });
    expect(parseProbe('1.5\n1.6\n', '').frameTimes).toEqual([0, 0.1]);
  });

  it("on the capture clock: the frames moved by the start stamp's lateness (one place), the film shifted to match", () => {
    const p = onCaptureClock(parseProbe('0.5\n0.52\n1.5\n', '1206,2622\n'), 0.04);
    expect(p).toMatchObject({ first: 0.5, shift: 0.04 });
    expect(p.frameTimes).toEqual([-0.04, -0.02, 0.96]);
    // The frames before capture time 0 are one frame at 0.
    expect(fromCaptureStart(p.frameTimes)).toEqual([0, 0.96]);
    expect(fromCaptureStart([0, 1])).toEqual([0, 1]);
    const graph = convertArgs({ ...ARGS, shift: p.shift })[convertArgs(ARGS).indexOf('-filter_complex') + 1];
    expect(graph).toContain('[0:v]setpts=PTS-STARTPTS-0.0400/TB,scale=');
  });

  it('the box around a touch: 44 pt in device pixels, inside the picture', () => {
    expect(touchBox(201, 437, 3, { width: 1206, height: 2622 })).toEqual({ x: 537, y: 1245, w: 132, h: 132 });
    expect(touchBox(2, 3, 3, { width: 1206, height: 2622 })).toEqual({ x: 0, y: 0, w: 132, h: 132 });
    expect(touchBox(400, 873, 3, { width: 1206, height: 2622 })).toEqual({ x: 1074, y: 2490, w: 132, h: 132 });
  });

  it("the recording must have the device's size and a frame", () => {
    const screen = { width: 402, height: 874, scale: 3 };
    expect(recordingProblem({ width: 1206, height: 2622, frameTimes: [0] }, screen)).toBeNull();
    expect(recordingProblem({ width: 2622, height: 1206, frameTimes: [0] }, screen)).toMatch(/the recording is 2622×1206 px, not the device's 1206×2622/);
    expect(recordingProblem({ width: 1206, height: 2622, frameTimes: [] }, screen)).toBe('the recording holds no frame');
  });

  it("the edit's idle spans end at a frame of the recording or a change of the touch overlay", () => {
    expect(idleTimes([0, 2.5, 2.6], [1.0, 1.233, 2.5])).toEqual([0, 1.0, 1.233, 2.5, 2.6]);
  });
});
