/**
 * The disposable fixture of the Prime Runner Bridge smoke.
 *
 * The fixture proves the mechanics of the bridge - the manifest, the approval, the launch, the isolation, the
 * verification and the delivery - and produces nothing useful.
 */

/** The version of the disposable fixture. */
export const SMOKE_VERSION = 1

/** The string the fixture is named after. */
const SMOKE = 'smoke'

/** Returns the string the fixture is named after. */
export function smoke(): string {
  return SMOKE
}
