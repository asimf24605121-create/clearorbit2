class Job {
  constructor(id, name, handler, data, options = {}) {
    this.id = id;
    this.name = name;
    this.handler = handler;
    this.data = data;
    this.status = 'pending';
    this.attempts = 0;
    this.maxAttempts = options.maxAttempts || 3;
    this.retryDelay = options.retryDelay || 2000;
    this.result = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.progress = 0;
  }
}

class JobQueue {
  constructor(options = {}) {
    this.concurrency = options.concurrency || 3;
    this.running = 0;
    this.queue = [];
    this.jobs = new Map();
    this.jobCounter = 0;
    this.maxHistory = options.maxHistory || 100;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  _emit(event, data) {
    const fns = this.listeners.get(event) || [];
    for (const fn of fns) {
      try { fn(data); } catch (e) { console.error(`JobQueue event error [${event}]:`, e.message); }
    }
  }

  add(name, handler, data, options = {}) {
    const id = `job_${++this.jobCounter}_${Date.now().toString(36)}`;
    const job = new Job(id, name, handler, data, options);
    this.jobs.set(id, job);
    this.queue.push(job);
    this._emit('added', { id, name });
    this._process();
    this._trimHistory();
    return id;
  }

  async _process() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job || job.status === 'cancelled') continue;
      this.running++;
      job.status = 'running';
      job.startedAt = Date.now();
      job.attempts++;
      this._emit('started', { id: job.id, name: job.name, attempt: job.attempts });

      try {
        const updateProgress = (pct) => { job.progress = Math.min(100, Math.max(0, pct)); };
        job.result = await job.handler(job.data, updateProgress);
        job.status = 'completed';
        job.completedAt = Date.now();
        job.progress = 100;
        this._emit('completed', { id: job.id, name: job.name, result: job.result, duration: job.completedAt - job.startedAt });
      } catch (err) {
        job.error = err.message;
        if (job.attempts < job.maxAttempts) {
          job.status = 'retrying';
          this._emit('retrying', { id: job.id, name: job.name, attempt: job.attempts, error: err.message });
          await new Promise(r => setTimeout(r, job.retryDelay * job.attempts));
          this.queue.push(job);
        } else {
          job.status = 'failed';
          job.completedAt = Date.now();
          this._emit('failed', { id: job.id, name: job.name, error: err.message, attempts: job.attempts });
        }
      }
      this.running--;
      this._process();
    }
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job && (job.status === 'pending' || job.status === 'retrying')) {
      job.status = 'cancelled';
      return true;
    }
    return false;
  }

  getStatus(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return {
      id: job.id, name: job.name, status: job.status,
      attempts: job.attempts, maxAttempts: job.maxAttempts,
      progress: job.progress, error: job.error,
      createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
      duration: job.completedAt ? job.completedAt - job.startedAt : job.startedAt ? Date.now() - job.startedAt : 0,
    };
  }

  getAll() {
    const result = { pending: 0, running: 0, completed: 0, failed: 0, retrying: 0, cancelled: 0 };
    const recent = [];
    for (const job of this.jobs.values()) {
      result[job.status] = (result[job.status] || 0) + 1;
      if (Date.now() - job.createdAt < 3600000) {
        recent.push(this.getStatus(job.id));
      }
    }
    return { stats: result, concurrency: this.concurrency, running: this.running, queued: this.queue.length, recent };
  }

  _trimHistory() {
    if (this.jobs.size <= this.maxHistory * 2) return;
    const sorted = [...this.jobs.entries()]
      .filter(([, j]) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, sorted.length - this.maxHistory);
    for (const [id] of toRemove) this.jobs.delete(id);
  }
}

export const accountQueue = new JobQueue({ concurrency: 2 });
export const intelligenceQueue = new JobQueue({ concurrency: 1 });
export const importQueue = new JobQueue({ concurrency: 1 });

export function getQueues() {
  return {
    accounts: accountQueue.getAll(),
    intelligence: intelligenceQueue.getAll(),
    imports: importQueue.getAll(),
  };
}
