import type { Feedback, Item, Story } from './briefing/schema.js';

export function activeStoryFeedback(
  feedback: readonly Feedback[],
  story: Story,
  item: Item,
  now: number,
) {
  const undone = new Set(
    feedback.filter((entry) => entry.action === 'undo').map((entry) => entry.undoesFeedbackId),
  );
  return feedback.filter((entry) => {
    if (undone.has(entry.id)) return false;
    if (entry.targetKind === 'story' && entry.targetId === story.id) {
      if (entry.action === 'dismiss') return true;
      if (entry.action === 'snooze') return Boolean(entry.until) && Date.parse(entry.until!) > now;
    }
    if (entry.action === 'mute-source' && entry.targetId === item.sourceId) return true;
    if (
      entry.action === 'mute-term' &&
      story.interestMatches.some((match) => match.matchedTerms.includes(entry.targetId))
    )
      return true;
    return false;
  });
}

export function isStoryHidden(
  feedback: readonly Feedback[],
  story: Story,
  item: Item,
  now: number,
) {
  return activeStoryFeedback(feedback, story, item, now).some(
    (entry) =>
      entry.action === 'dismiss' ||
      entry.action === 'mute-source' ||
      entry.action === 'mute-term' ||
      entry.action === 'snooze',
  );
}
