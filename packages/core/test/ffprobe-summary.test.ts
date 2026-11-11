/**
 * The ffprobe summary of a media file (core ffprobe-summary.ts), shared by the render's record (editor probeMedia) and
 * the review (probeVideo): the first video stream's size, frame rate to 3 decimals and frame count, the audio streams,
 * the codecs and the length; nothing for an answer that is not JSON of that shape.
 */
import { describe, expect, it } from 'vitest';
import { ffprobeSummaryArgs, parseFfprobeSummary } from '@retake/core';

const answer = (o: unknown) => JSON.stringify(o);

describe('the ffprobe summary', () => {
  it('asks ffprobe for the streams and the length as JSON', () => {
    expect(ffprobeSummaryArgs('/p/renders/a-v1.mp4')).toEqual(['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration', '-of', 'json', '/p/renders/a-v1.mp4']);
  });

  it('reads the first video stream, the audio streams and the length, in the record’s key order', () => {
    const p = parseFfprobeSummary(
      answer({
        streams: [
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30000/1001', nb_frames: '450' },
          { codec_type: 'video', codec_name: 'png', width: 10, height: 10, r_frame_rate: '1/1' },
          { codec_type: 'audio', codec_name: 'opus' },
        ],
        format: { duration: '15.015000' },
      }),
    );
    expect(p).toEqual({ duration_s: 15.015, width: 1920, height: 1080, fps: 29.97, audio_streams: 2, frames: 450, video_codec: 'h264', audio_codec: 'aac' });
    expect(Object.keys(p!)).toEqual(['duration_s', 'width', 'height', 'fps', 'audio_streams', 'frames', 'video_codec', 'audio_codec']);
  });

  it('a file without a video stream, a frame count or a length reads as zeros; a rate with a zero denominator is 0 fps', () => {
    expect(parseFfprobeSummary(answer({ streams: [{ codec_type: 'audio', codec_name: 'mp3' }], format: {} }))).toEqual({ duration_s: 0, width: 0, height: 0, fps: 0, audio_streams: 1, audio_codec: 'mp3' });
    expect(parseFfprobeSummary(answer({ streams: [{ codec_type: 'video', width: 8, height: 6, r_frame_rate: '25/0' }], format: { duration: '1' } }))).toEqual({ duration_s: 1, width: 8, height: 6, fps: 0, audio_streams: 0 });
  });

  it('nothing for an answer that is not JSON of that shape', () => {
    expect(parseFfprobeSummary('')).toBeUndefined();
    expect(parseFfprobeSummary('{')).toBeUndefined();
    expect(parseFfprobeSummary(answer({ format: {} }))).toBeUndefined();
    expect(parseFfprobeSummary(answer({ streams: [] }))).toBeUndefined();
  });
});
