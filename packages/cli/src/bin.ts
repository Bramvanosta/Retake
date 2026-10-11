#!/usr/bin/env node
import { main } from './main.js';

const code = await main(process.argv);
// Let stdout drain (pipes are asynchronous on macOS) before exiting; nothing may keep the process alive.
process.stdout.write('', () => process.exit(code));
