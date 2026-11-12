/**
 * The one reader of ffprobe's answers (core ffprobe.ts, L7.31, finding X3): besides the summary (ffprobe-summary.test)
 * and a user's video (media.test), a raw export's clip, an open render video, a picture's size and a take's packets —
 * each as its site read it before the readers were one module.
 */
import { describe, expect, it } from 'vitest';
import { clipProbeArgs, clipProbeFromJson, ffprobePackets, openVideoArgs, openVideoFromJson, packetsArgs, pictureSizeArgs, pictureSizeFromJson, readFfprobeJson, videoFileArgs } from '@retake/core';

describe('ffprobe answers (L7.31)', () => {
  it('every probe answers JSON, read by readFfprobeJson (a text that is no JSON throws its SyntaxError)', () => {
    for (const args of [videoFileArgs('/v.mp4'), clipProbeArgs('/c.mov'), clipProbeArgs('/c.webm', true), openVideoArgs(), pictureSizeArgs('/p.png'), packetsArgs(30)]) expect(args.slice(args.indexOf('-of'), args.indexOf('-of') + 2)).toEqual(['-of', 'json']);
    expect(readFfprobeJson('{"streams":[]}')).toEqual({ streams: [] });
    expect(() => readFfprobeJson('{')).toThrow(SyntaxError);
    expect(videoFileArgs('/v.mp4')).toEqual(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', '/v.mp4']);
    expect(openVideoArgs()).toContain('fd:');
    expect(openVideoArgs()).not.toContain('-i');
    expect(packetsArgs(30)).toEqual(expect.arrayContaining(['-read_intervals', '%+30', '-i', 'fd:']));
    expect(pictureSizeArgs('/p.png')).toEqual(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', '/p.png']);
  });

  it('a clip: its picture stream as the raw export reads it (frames counted or the container\'s, timecode, alpha, size)', () => {
    expect(clipProbeArgs('/c.mov')).not.toContain('-count_frames');
    expect(clipProbeArgs('/c.webm', true)).toContain('-count_frames');
    const answer = {
      streams: [{ codec_name: 'prores', profile: '4444', pix_fmt: 'yuva444p12le', width: 1920, height: 1080, r_frame_rate: '30000/1001', nb_frames: '90', nb_read_frames: '89', tags: { timecode: '01:00:00:00' } }],
      format: { duration: '3.003', size: '12345' },
    };
    expect(clipProbeFromJson(answer)).toEqual({ codec: 'prores', profile: '4444', pix_fmt: 'yuva444p12le', width: 1920, height: 1080, fps: 30000 / 1001, frames: 90, duration_s: 3.003, timecode: '01:00:00:00', alpha: true, size_bytes: 12345 });
    expect(clipProbeFromJson(answer, true)?.frames).toBe(89);
    // VP9's side-channel alpha, a lone rate, the format's timecode, frames it cannot count.
    expect(clipProbeFromJson({ streams: [{ codec_name: 'vp9', pix_fmt: 'yuv420p', width: 8, height: 6, r_frame_rate: '25', duration: '2', tags: { alpha_mode: '1' } }], format: { tags: { timecode: '00:00:01:00' } } })).toEqual({
      codec: 'vp9', pix_fmt: 'yuv420p', width: 8, height: 6, fps: 25, frames: 0, duration_s: 2, timecode: '00:00:01:00', alpha: true, size_bytes: 0,
    });
    expect(clipProbeFromJson({ streams: [] })).toBeNull();
    expect(() => clipProbeFromJson(null)).toThrow(TypeError);
  });

  it('an open render video: rounded rates, first frame time, frames; null without a rate and a size', () => {
    expect(openVideoFromJson({ streams: [{ r_frame_rate: '30/1', avg_frame_rate: '30/1', start_time: '0.000000', nb_frames: '150', width: 1920, height: 1080 }] })).toEqual({ fps: 30, width: 1920, height: 1080, avg_fps: 30, start_s: 0, frames: 150 });
    expect(openVideoFromJson({ streams: [{ r_frame_rate: '30000/1001', avg_frame_rate: '0/0', width: 8, height: 6, nb_frames: 'N/A' }] })).toEqual({ fps: 29.97, width: 8, height: 6 });
    expect(openVideoFromJson({ streams: [{ r_frame_rate: '0/0', width: 8, height: 6 }] })).toBeNull();
    expect(openVideoFromJson({ streams: [{ r_frame_rate: '30/1', width: 0, height: 6 }] })).toBeNull();
    expect(openVideoFromJson({})).toBeNull();
  });

  it('a picture\'s size, and a take\'s stream and packets', () => {
    expect(pictureSizeFromJson({ streams: [{ width: 640, height: 360 }] })).toEqual({ width: 640, height: 360 });
    expect(pictureSizeFromJson({ streams: [] })).toEqual({ width: NaN, height: NaN });
    expect(ffprobePackets({ streams: [{ codec_name: 'h264', has_b_frames: 2 }], packets: [{ pts_time: '0.0', flags: 'K__' }] })).toEqual({ stream: { codec_name: 'h264', has_b_frames: 2 }, packets: [{ pts_time: '0.0', flags: 'K__' }] });
    expect(ffprobePackets({})).toEqual({ packets: [] });
  });
});
