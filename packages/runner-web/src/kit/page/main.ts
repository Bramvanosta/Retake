/**
 * The in-page kit, installed as `window.__retake` in every page and frame: the entry of the page script.
 *
 * The kit's modules (this folder) are built into one script by esbuild (source.ts `kitBundle`) and evaluated in the
 * page, so they import only each other, and types (`import type`, erased): never a package or a Node module (a test
 * walks the graph). Every other module only declares — functions, constants, state; what touches the page happens
 * here, in this order (the order the kit has always installed itself in).
 */
import { api } from './api.js';
import { stopWatchingOnDispose } from './changes.js';
import { installCursor } from './cursor.js';
import { stopEffectsOnDispose } from './effects.js';
import { relayFramePointer } from './frame-pointer.js';
import { createHost } from './host.js';
import { listenForPing, replacePrevious } from './lifecycle.js';
import { relayNotifications } from './notifications.js';
import { keepPopoverMethods } from './overlay.js';

function install(): void {
  relayNotifications();
  if (!replacePrevious()) return;
  listenForPing();
  stopWatchingOnDispose();
  createHost();
  keepPopoverMethods();
  installCursor();
  relayFramePointer();
  stopEffectsOnDispose();
  Object.defineProperty(window, '__retake', { value: api, configurable: true, enumerable: false, writable: true });
}

install();
