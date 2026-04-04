const JOB_SENTINEL = Symbol("startJob");

export interface StartJobMarker {
  [key: symbol]: true;
  id: string;
}

export function startJob(opts: { id: string }): StartJobMarker {
  return { [JOB_SENTINEL]: true, id: opts.id };
}

export function isStartJob(value: unknown): value is StartJobMarker {
  return typeof value === "object" && value !== null && JOB_SENTINEL in value;
}

type Entry = { type: "event"; data: unknown } | { type: "return"; data: unknown } | { type: "error"; data: Error };

interface Job {
  id: string;
  buffer: Entry[];
  done: boolean;
  subscribers: Set<(entry: Entry) => void>;
}

const jobs = new Map<string, Job>();

export function registerJob(id: string): Job {
  const job: Job = { id, buffer: [], done: false, subscribers: new Set() };
  jobs.set(id, job);
  return job;
}

function notify(job: Job, entry: Entry) {
  job.buffer.push(entry);
  for (const sub of job.subscribers) sub(entry);
}

export function pushEvent(id: string, data: unknown) {
  const job = jobs.get(id);
  if (!job) return;
  notify(job, { type: "event", data });
}

export function completeJob(id: string, returnValue: unknown) {
  const job = jobs.get(id);
  if (!job) return;
  job.done = true;
  notify(job, { type: "return", data: returnValue });
  jobs.delete(id);
}

export function failJob(id: string, error: Error) {
  const job = jobs.get(id);
  if (!job) return;
  job.done = true;
  notify(job, { type: "error", data: error });
  jobs.delete(id);
}

export async function* findJob(id: string): AsyncGenerator<unknown, unknown, undefined> {
  const job = jobs.get(id);
  if (!job) return null;

  // Replay buffered events
  let index = 0;
  while (index < job.buffer.length) {
    const entry = job.buffer[index++]!;
    if (entry.type === "event") yield entry.data;
    else if (entry.type === "return") return entry.data;
    else throw entry.data;
  }

  // If job already completed during replay
  if (job.done) return undefined;

  // Subscribe for live events
  const queue: Entry[] = [];
  let waiter: (() => void) | null = null;

  const callback = (entry: Entry) => {
    queue.push(entry);
    if (waiter) {
      waiter();
      waiter = null;
    }
  };

  job.subscribers.add(callback);
  try {
    while (true) {
      if (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.type === "event") yield entry.data;
        else if (entry.type === "return") return entry.data;
        else throw entry.data;
      } else {
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    }
  } finally {
    job.subscribers.delete(callback);
  }
}
