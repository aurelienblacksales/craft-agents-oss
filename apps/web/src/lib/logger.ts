/**
 * Web logger — replaces electron-log with console-based logging.
 */

function createScope(name: string) {
  return {
    info: (...args: unknown[]) => console.info(`[${name}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${name}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${name}]`, ...args),
    debug: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
    verbose: (...args: unknown[]) => console.debug(`[${name}]`, ...args),
  }
}

const log = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
  verbose: (...args: unknown[]) => console.debug(...args),
  scope: createScope,
}

// Export scoped loggers for renderer process
export const rendererLog = log.scope('renderer')
export const searchLog = log.scope('search')

export default log
