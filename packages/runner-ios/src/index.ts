/**
 * @retake/runner-ios — films an iOS environment's app in the iOS Simulator: the capture driver (runner-web's driver
 * seam, `@retake/runner-web/types`) that the composition hands to a run on an iOS environment (RunOptions.driver).
 * The XCUITest driver it builds and talks to lives in `driver/` (shipped with the package).
 */
export { createIosDriver, iosDriver, statusBarTime } from './ios-driver.js';
export type { IosDriverDeps } from './ios-driver.js';
export { DRIVER_SOURCES, driverKey, parseXcodeVersion, sourcesHash } from './driver-build.js';
