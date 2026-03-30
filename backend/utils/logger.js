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

function logAtLevel(level, category, data) {
  const lvl = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (currentLevel > lvl) return;
  const output = formatLog(level, category, data);
  if (lvl >= LOG_LEVELS.error) console.error(output);
  else if (lvl >= LOG_LEVELS.warn) console.warn(output);
  else console.log(output);
}

export const logger = {
  info(category, data) {
    logAtLevel('info', category, data);
  },
  warn(category, data) {
    logAtLevel('warn', category, data);
  },
  error(category, data) {
    logAtLevel('error', category, data);
  },
  critical(category, data) {
    console.error(formatLog('critical', category, data));
  },
  admin(action, adminId, data = {}) {
    const level = data.level || 'info';
    delete data.level;
    logAtLevel(level, 'admin_action', { action, adminId, ...data });
  },
  auth(actionOrData, data = {}) {
    if (typeof actionOrData === 'object') { data = actionOrData; actionOrData = data.action; }
    const level = data.level || 'info';
    delete data.level;
    logAtLevel(level, 'auth', { action: actionOrData, ...data });
  },
  payment(actionOrData, data = {}) {
    if (typeof actionOrData === 'object') { data = actionOrData; actionOrData = data.action; }
    const level = data.level || 'info';
    delete data.level;
    logAtLevel(level, 'payment', { action: actionOrData, ...data });
  },
  subscription(actionOrData, data = {}) {
    if (typeof actionOrData === 'object') { data = actionOrData; actionOrData = data.action; }
    const level = data.level || 'info';
    delete data.level;
    logAtLevel(level, 'subscription', { action: actionOrData, ...data });
  },
};
