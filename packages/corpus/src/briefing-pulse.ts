import type { MetricObservation } from './briefing/schema.js';

export type SocialPulseSummary = {
  itemId: string;
  platform: string;
  name: string;
  latestValue: number | null;
  latestObservedAt: string | null;
  observationCount: number;
  firstObservedAt: string | null;
  delta: number | null;
  elapsedHours: number | null;
  perHour: number | null;
  status:
    'available' | 'insufficient-observations' | 'counter-decreased' | 'ambiguous-observations';
};

/** Summarize observations without combining items, platforms, or metric names. */
export function summarizeBriefingPulse(
  metrics: readonly MetricObservation[],
): SocialPulseSummary[] {
  const groups = new Map<string, MetricObservation[]>();
  for (const metric of metrics) {
    const key = JSON.stringify([metric.itemId, metric.platform, metric.name]);
    groups.set(key, [...(groups.get(key) ?? []), metric]);
  }

  return [...groups.values()]
    .map((rows): SocialPulseSummary => {
      const sorted = [...rows].sort(
        (a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id),
      );
      const first = sorted[0]!;
      const last = sorted.at(-1)!;
      const times = new Map<string, Set<number>>();
      for (const row of sorted) {
        const values = times.get(row.observedAt) ?? new Set<number>();
        values.add(row.value);
        times.set(row.observedAt, values);
      }
      const ambiguous = [...times.values()].some((values) => values.size > 1);
      const distinctTimes = [...times.keys()];
      const elapsedHours =
        distinctTimes.length > 1
          ? (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3_600_000
          : null;
      const decreased = sorted.some(
        (row, index) => index > 0 && row.value < sorted[index - 1]!.value,
      );
      const status: SocialPulseSummary['status'] = ambiguous
        ? 'ambiguous-observations'
        : decreased
          ? 'counter-decreased'
          : distinctTimes.length < 2 || !(elapsedHours! > 0)
            ? 'insufficient-observations'
            : 'available';
      const calculated = status === 'available';
      const delta = calculated ? last.value - first.value : null;
      const latestValues = times.get(last.observedAt)!;
      return {
        itemId: first.itemId,
        platform: first.platform,
        name: first.name,
        latestValue: latestValues.size === 1 ? last.value : null,
        latestObservedAt: last.observedAt,
        observationCount: rows.length,
        firstObservedAt: first.observedAt,
        delta,
        elapsedHours: calculated ? elapsedHours : null,
        perHour: calculated ? delta! / elapsedHours! : null,
        status,
      };
    })
    .sort(
      (a, b) =>
        a.itemId.localeCompare(b.itemId) ||
        a.platform.localeCompare(b.platform) ||
        a.name.localeCompare(b.name),
    );
}
