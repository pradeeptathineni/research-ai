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
      const instants = new Map<number, MetricObservation[]>();
      for (const row of rows) {
        const instant = Date.parse(row.observedAt);
        instants.set(instant, [...(instants.get(instant) ?? []), row]);
      }
      const points = [...instants.entries()]
        .sort(([a], [b]) => a - b)
        .map(([instant, observations]) => ({
          instant,
          observations: observations.sort((a, b) => a.id.localeCompare(b.id)),
          values: new Set(observations.map((observation) => observation.value)),
        }));
      const firstPoint = points[0]!;
      const lastPoint = points.at(-1)!;
      const first = firstPoint.observations[0]!;
      const last = lastPoint.observations.at(-1)!;
      const ambiguous = points.some((point) => point.values.size > 1);
      const distinctTimes = points.length;
      const elapsedHours =
        distinctTimes > 1 ? (lastPoint.instant - firstPoint.instant) / 3_600_000 : null;
      const decreased = points.some(
        (point, index) => index > 0 && [...point.values][0]! < [...points[index - 1]!.values][0]!,
      );
      const status: SocialPulseSummary['status'] = ambiguous
        ? 'ambiguous-observations'
        : decreased
          ? 'counter-decreased'
          : distinctTimes < 2 || !(elapsedHours! > 0)
            ? 'insufficient-observations'
            : 'available';
      const calculated = status === 'available';
      const delta = calculated ? last.value - first.value : null;
      return {
        itemId: first.itemId,
        platform: first.platform,
        name: first.name,
        latestValue: lastPoint.values.size === 1 ? last.value : null,
        latestObservedAt: last.observedAt,
        observationCount: distinctTimes,
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
