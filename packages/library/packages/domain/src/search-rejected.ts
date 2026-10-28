/** Rejected proposals remain inspectable, but never become validated entities or save inputs. */
export function rejectedNativeLeads(usage: unknown) {
  if (!usage || typeof usage !== 'object' || !('rejectedProposal' in usage)) return [];
  const proposal = usage.rejectedProposal;
  if (
    !proposal ||
    typeof proposal !== 'object' ||
    !('candidates' in proposal) ||
    !Array.isArray(proposal.candidates)
  )
    return [];
  return proposal.candidates.slice(0, 60).flatMap((candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const c = candidate as Record<string, unknown>;
    if (
      typeof c.name !== 'string' ||
      typeof c.description !== 'string' ||
      typeof c.uri !== 'string' ||
      !Array.isArray(c.limits) ||
      !c.limits.every((limit) => typeof limit === 'string')
    )
      return [];
    return [
      {
        name: c.name.slice(0, 200),
        description: c.description.slice(0, 1600),
        uri: c.uri.slice(0, 2048),
        limits: c.limits.slice(0, 30).map((limit) => limit.slice(0, 1600)),
      },
    ];
  });
}
