/**
 * The errors the CLI prints as one line (no stack): every class that states an error kind (the errors raised on purpose,
 * whose message is written for the person), the CLI's own and EngineError. Derived from the classes, not a list of
 * names: the classes a hand-kept list missed print one line too.
 */
import { describe, expect, it } from 'vitest';
import { AccessError, ClockError, ConfigError, EnvironmentError, HostRefusedError, SandboxConfigError, ScenarioChangedError, ScenarioError, StepError as ScenarioStepError, TemplateError, WriteRefusedError } from '@retake/core';
import { BundleError, H264EncoderError } from '@retake/core/io';
import { ComponentError } from '@retake/components';
import { ExportError, PlanError, PlanTrustError, RenderCancelledError, RenderDiskFullError, RenderError } from '@retake/editor';
import { EngineError, HooksSourceError, RunOptionError, SandboxTakeError } from '@retake/engine';
import { HookError, HookSecurityError, JournalError } from '@retake/hooks';
import { ReviewCancelledError, ReviewError } from '@retake/review';
import { CancelledError, EncodeError, LoginPageError, PreflightError, RunnerError, StepError } from '@retake/runner-web';
import { SandboxError } from '@retake/sandbox';
import { CliError, UsageError, isKnownError } from '../src/errors.js';

const PROJECT = { config: { name: 'shop', allow_hosts: [] } } as never;

/** One line already before the list was derived. */
const KNOWN: [string, Error][] = [
  ['CliError', new CliError('x')],
  ['UsageError', new UsageError('x')],
  ['ConfigError', new ConfigError('x')],
  ['SandboxConfigError (named ConfigError)', new SandboxConfigError('x', [], '/s.yaml', 'local')],
  ['ScenarioError', new ScenarioError('x')],
  ['EnvironmentError', new EnvironmentError('x')],
  ['TemplateError', new TemplateError('x')],
  ['core StepError', new ScenarioStepError('x')],
  ['runner StepError', new StepError('x')],
  ['RunnerError', new RunnerError('x')],
  ['PreflightError', new PreflightError('x')],
  ['LoginPageError', new LoginPageError('x')],
  ['EncodeError', new EncodeError('x')],
  ['CancelledError', new CancelledError()],
  ['RenderCancelledError (named CancelledError)', new RenderCancelledError()],
  ['HookError', new HookError('x')],
  ['HookSecurityError', new HookSecurityError('x', 'host')],
  ['AccessError', new AccessError('x')],
  ['ClockError', new ClockError('x')],
  ['JournalError', new JournalError('x', '/j')],
  ['ComponentError', new ComponentError('x')],
  ['RenderError', new RenderError('x')],
  ['PlanError', new PlanError('x')],
  ['ReviewError', new ReviewError('x')],
  ['SandboxError', new SandboxError('x')],
  ['EngineError', new EngineError('invalid', 'x')],
  ['RunOptionError', new RunOptionError('x')],
  ['SandboxTakeError', new SandboxTakeError('x', false)],
  ['BundleError', new BundleError('x')],
  ['H264EncoderError', new H264EncoderError('x')],
];

/** A stack before (missing from the hand-kept list), one line now (CHANGELOG). */
const NOW_KNOWN: [string, Error][] = [
  ['ScenarioChangedError', new ScenarioChangedError('/s.yaml', 'a', 'b')],
  ['WriteRefusedError', new WriteRefusedError(['POST /x'], 'staging')],
  ['HostRefusedError', new HostRefusedError(['evil.example'], PROJECT)],
  ['PlanTrustError', new PlanTrustError(['x'])],
  ['ExportError', new ExportError('x')],
  ['HooksSourceError', new HooksSourceError('x', true)],
  ['ReviewCancelledError', new ReviewCancelledError()],
  ['RenderDiskFullError (named DiskFullError)', new RenderDiskFullError('ENOSPC')],
];

describe('isKnownError: the errors printed as one line', () => {
  it.each(KNOWN)('%s: one line', (_n, e) => expect(isKnownError(e)).toBe(true));
  it.each(NOW_KNOWN)('%s: one line (derived from the class)', (_n, e) => expect(isKnownError(e)).toBe(true));
  it('a bug keeps its stack: a plain Error, a TypeError, an error only named like a known one, not an Error', () => {
    expect(isKnownError(new Error('x'))).toBe(false);
    expect(isKnownError(new TypeError('x'))).toBe(false);
    expect(isKnownError(Object.assign(new Error('x'), { name: 'ScenarioError' }))).toBe(false);
    expect(isKnownError(Object.assign(new Error('x'), { errorKind: 'nonsense' }))).toBe(false);
    expect(isKnownError('x')).toBe(false);
  });
});
