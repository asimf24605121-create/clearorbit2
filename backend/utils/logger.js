const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, critical: 4 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

function formatLog(level, category, data) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    category,
    ...data,
  });
}

export const logger = {
  info(category, data) {
    if (currentLevel <= LOG_LEVELS.info) console.log(formatLog('info', category, data));
  },
  warn(category, data) {
    if (currentLevel <= LOG_LEVELS.warn) console.warn(formatLog('warn', category, data));
  },
  error(category, data) {
    if (currentLevel <= LOG_LEVELS.error) console.error(formatLog('error', category, data));
  },
  critical(category, data) {
    console.error(formatLog('critical', category, data));
  },
  admin(action, adminId, data = {}) {
    console.log(formatLog('info', 'admin_action', { action, adminId, ...data }));
  },
  auth(action, data = {}) {
    console.log(formatLog('info', 'auth', { action, ...data }));
  },
  payment(action, data = {}) {
    console.log(formatLog('info', 'payment', { action, ...data }));
  },
  subscription(action, data = {}) {
    console.log(formatLog('info', 'subscription', { action, ...data }));
  },
};
