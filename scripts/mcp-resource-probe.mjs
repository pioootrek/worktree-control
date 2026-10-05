// Measurement-only preload, with one bounded histogram. Not imported by production.
import { monitorEventLoopDelay } from 'node:perf_hooks';
const histogram = monitorEventLoopDelay({ resolution: 100 });
histogram.enable();
process.on('message', msg => {
  if (msg?.kind !== 'mcp-resource-sample') return;
  const value = ns => Number.isFinite(ns) ? ns / 1e6 : null;
  process.send?.({ id: msg.id, eventLoop: { resolutionMs: 100, meanMs: value(histogram.mean), maxMs: value(histogram.max), p99Ms: value(histogram.percentile(99)) } });
  histogram.reset();
});
