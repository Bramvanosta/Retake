/**
 * L5.15 (critique H2): editor guardEncoderPipe in a process with no handler of its own (a `retake render`). Arg
 * `epipe`: a write to the encoder's closed pipe rejects unhandled — the process lives on and prints "alive". `other`:
 * any other unhandled rejection still ends the process (Node's default is kept).
 */
import { guardEncoderPipe } from '@retake/editor';

guardEncoderPipe();
guardEncoderPipe(); // once per process, however many renders
const mode = process.argv[2];
void Promise.reject(mode === 'epipe' ? Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' }) : new Error('something else'));
setTimeout(() => {
  process.stdout.write(`alive ${process.listenerCount('unhandledRejection')}\n`);
  process.exit(0);
}, 300);
