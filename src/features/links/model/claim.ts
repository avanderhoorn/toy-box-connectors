import type { SlackMessage } from "@slackapi/model/messages";

// Claim messages.
//
// The owner is pinned by a code the terminal shows and a person posts to the
// bot in Slack. A code only proves that someone saw it, so any message that
// reads as a claim is consumed before storage, whatever follows the word claim,
// and only a live, new post in the exact shape is tried against the code.

/** A message that reads as a claim. `code` is set only when the text is exactly the mention, claim and a code. */
export type ClaimText = { code: string | null };

const claimPattern = /^\s*<@([A-Z0-9]+)(?:\|[^>]*)?>\s*claim\b/i;
const exactClaimPattern = /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*claim\s+(\S+)\s*$/i;

/** Reads `text` as a claim when it starts with the bot's mention and the word claim, or returns null. */
export function readClaim(text: string, botUserId: string): ClaimText | null {
  if (claimPattern.exec(text)?.[1] !== botUserId) return null;
  return { code: exactClaimPattern.exec(text)?.[1] ?? null };
}

/**
 * Whether a claim message is an attempt on the live code: the exact shape,
 * posted live and new, so not an edit, a thread broadcast or a file share, by a
 * person in the installation's team rather than a bot, an app or our bot user.
 * Gap repair never finds an attempt, so its callers don't ask.
 */
export function isClaimAttempt(
  claim: ClaimText,
  message: SlackMessage,
  edit: boolean,
  installationTeamId: string,
): claim is { code: string } {
  return (
    claim.code !== null &&
    !edit &&
    message.subtype === null &&
    message.author === "person" &&
    message.teamId === installationTeamId
  );
}
