// Monitoring for the shard server.
//   renderMetrics() -> Prometheus text format for GET /metrics (served by serveMetrics)
//   count(name, labels?, by?) -> a counter any module can bump; it shows up in /metrics
//   log(level, msg, fields?) -> one line per event: JSON when LOG_FORMAT=json, readable text otherwise
// METRICS_TOKEN, when set, makes /metrics require "Authorization: Bearer <token>".
import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { timingSafeEqual } from 'node:crypto';
import { matchMaker } from '@colyseus/core';
import { ROOM_NAME } from '../shared/net';

const startedAt = Date.now();
// Event-loop delay, sampled every LOOP_RES_MS. Node records the whole timer interval (ns), so the
// resolution is subtracted to get the lag. Reset after each scrape: it covers the time since the last one.
const LOOP_RES_MS = 20;
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
loopDelay.enable();

/** metric name -> label text (`{a="b"}` or '') -> value */
const counters = new Map<string, Map<string, number>>();

const metricName = (name: string) => name.replace(/[^a-zA-Z0-9_:]/g, '_');
const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function labelText(labels?: Record<string, string | number>): string {
  if (!labels) return '';
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k.replace(/[^a-zA-Z0-9_]/g, '_')}="${escapeLabel(String(labels[k]))}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/**
 * Adds `by` (default 1) to a counter. Name counters fw_<thing>_total and keep label values
 * to a small fixed set (element, kind, reason), never player or room ids.
 *   count('fw_casts_total', { el: 'fire' })
 */
export function count(name: string, labels?: Record<string, string | number>, by = 1): void {
  const key = metricName(name);
  let series = counters.get(key);
  if (!series) counters.set(key, (series = new Map()));
  const l = labelText(labels);
  series.set(l, (series.get(l) ?? 0) + by);
}

/** Every metric in Prometheus text exposition format (version 0.0.4). */
export async function renderMetrics(): Promise<string> {
  const out: string[] = [];
  const metric = (name: string, type: 'gauge' | 'counter', help: string, samples: Array<[string, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) out.push(`${name}${labels} ${Number.isFinite(v) ? v : 0}`);
  };

  const rooms = await matchMaker.query({ name: ROOM_NAME });
  metric('fw_rooms', 'gauge', 'World shard rooms open in this process.', [['', rooms.length]]);
  metric('fw_clients', 'gauge', 'Players connected to shard rooms in this process.', [['', rooms.reduce((n, r) => n + r.clients, 0)]]);

  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  metric('fw_uptime_seconds', 'gauge', 'Seconds since the server process started.', [['', (Date.now() - startedAt) / 1000]]);
  metric('fw_process_cpu_seconds_total', 'counter', 'User plus system CPU time used by the process.', [['', (cpu.user + cpu.system) / 1e6]]);
  metric('fw_memory_rss_bytes', 'gauge', 'Resident set size.', [['', mem.rss]]);
  metric('fw_memory_heap_used_bytes', 'gauge', 'V8 heap in use.', [['', mem.heapUsed]]);
  metric('fw_memory_heap_total_bytes', 'gauge', 'V8 heap allocated.', [['', mem.heapTotal]]);

  const s = (ns: number) => Math.max(0, ns - LOOP_RES_MS * 1e6) / 1e9;
  metric('fw_event_loop_lag_seconds', 'gauge', 'Event-loop delay since the previous scrape (mean, p50, p99, max).', [
    ['{stat="mean"}', s(loopDelay.mean)],
    ['{stat="p50"}', s(loopDelay.percentile(50))],
    ['{stat="p99"}', s(loopDelay.percentile(99))],
    ['{stat="max"}', s(loopDelay.max)],
  ]);
  loopDelay.reset();

  for (const [name, series] of counters) metric(name, 'counter', 'Counted by the server (count()).', [...series]);
  return out.join('\n') + '\n';
}

function authorized(req: IncomingMessage): boolean {
  const want = process.env.METRICS_TOKEN;
  if (!want) return true;
  const got = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET /metrics handler. */
export async function serveMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req)) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(await renderMetrics());
}

// ---- Logging ------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const JSON_LOGS = process.env.LOG_FORMAT === 'json';

const plain = (v: unknown): unknown => (v instanceof Error ? { error: v.message, stack: v.stack } : v);

/**
 * One log line. With LOG_FORMAT=json: {"time","level","msg",...fields} for log shippers
 * (Fly, Loki, Datadog); otherwise `2026-01-01T00:00:00.000Z INFO msg key=value`.
 */
export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const time = new Date().toISOString();
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (JSON_LOGS) {
    const line: Record<string, unknown> = { time, level, msg };
    for (const k in fields) if (!(k in line)) line[k] = plain(fields[k]);
    write(JSON.stringify(line));
    return;
  }
  let line = `${time} ${level.toUpperCase()} ${msg}`;
  for (const k in fields) {
    const v = fields[k];
    line += ` ${k}=${v instanceof Error ? JSON.stringify(v.message) : typeof v === 'string' ? v : JSON.stringify(v)}`;
  }
  write(line);
}
