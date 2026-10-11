// The app's version, read from package.json so the About screen and the sidebar footer can never drift
// from the release (T341). A named import keeps the rest of package.json out of the bundle.
import { version } from '../package.json'

export const APP_VERSION = version
