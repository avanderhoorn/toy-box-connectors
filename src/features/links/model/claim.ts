import type { SlackMessage } from "@slackapi/model/messages";
import type { SlackTs } from "@slackapi/model/ts";
import type { AdmissionProblem } from "./admission";

// Claims.
//
// The owner is pinned by a code the terminal shows and a person posts to the
// bot in Slack. A code only proves that someone saw it, so any message that
// reads as a claim is consumed before storage, whatever follows the word claim,
// and only a live, new post in the exact shape is tried against the code. The
// bridge then admits whoever posted it, and only then does the person at the
// terminal confirm who that was, which admits them once more before anything is
// pinned. One claim is open at a time. Its code works once, and the claim
// closes after five wrong tries, after ten minutes, when admission refuses the
// poster, or when the terminal answers no.

/** A message that reads as a claim. `code` is set only when the text is exactly the mention, claim and a code. */
export type ClaimText = { code: string | null };

const claimPattern = /^\s*<@([A-Z0-9]+)(?:\|[^>]*)?>\s*claim\b/i;
const exactClaimPattern = /^\s*<@[A-Z0-9]+(?:\|[^>]*)?>\s*claim\s+(\S+)\s*$/i;

/** Reads `text` as a claim when it starts with the bot's mention and the word claim, or returns null. */
export function readClaim(text: string, botUserId: string): ClaimText | null {
  if (claimPattern.exec(text)?.[1] !== botUserId) return null;
  return { code: exactClaimPattern.exec(text)?.[1] ?? null };
}

/** A message that reads as a claim, as the receiver hands it over before the ack. */
export type ClaimMessage = {
  claim: ClaimText;
  message: SlackMessage;
  /** It arrived as an edit. */
  edit: boolean;
  /** Gap repair found it after Socket Mode missed it. */
  late: boolean;
};

/** A post in the exact shape of a claim, by a person. */
export type ClaimAttempt = { code: string; userId: string; channelId: string; ts: SlackTs };

/**
 * The attempt a claim message makes on the live code, or null when it makes none. Only the exact
 * shape counts, posted live and new, so not an edit, a thread broadcast, a file share or anything
 * gap repair found, by a person rather than a bot, an app or our bot user. The workspace a message
 * names for its author isn't checked, because an Enterprise coworker can post from a sibling
 * workspace, so the bridge admits the poster before the terminal asks.
 */
export function claimAttempt(posted: ClaimMessage): ClaimAttempt | null {
  const { claim, message, edit, late } = posted;
  if (claim.code === null || edit || late || message.subtype !== null) return null;
  if (message.author !== "person" || message.userId === null) return null;
  return { code: claim.code, userId: message.userId, channelId: message.channelId, ts: message.ts };
}

/**
 * Live until someone posts the right code, posted until the bridge has admitted them, and
 * admitted until the terminal answers.
 */
export type ClaimState = "live" | "posted" | "admitted" | "confirmed" | "declined" | "void";

/** Why a claim went void. */
export type ClaimVoidReason =
  /** Its deadline passed. */
  | "expired"
  /** The last allowed wrong code was posted. */
  | "exhausted"
  /** The terminal started another claim. */
  | "replaced"
  /** The admission check refused whoever posted the code. */
  | AdmissionProblem;

/** Who posted the right code, where and when. */
export type ClaimPost = { userId: string; channelId: string; ts: SlackTs; at: number };

export type Claim = {
  /** The code is stored only as this hash. */
  codeHash: string;
  state: ClaimState;
  failedAttempts: number;
  createdAt: number;
  /** One deadline covers posting the code and answering the terminal. */
  expiresAt: number;
  /** Kept when a posted claim is declined or voided, so the audit can say who posted it. */
  post: ClaimPost | null;
  decidedAt: number | null;
  /** Set exactly when the claim is void. */
  voidReason: ClaimVoidReason | null;
};

/** How long a code has to be posted and confirmed. */
export const CLAIM_LIFETIME_MS = 10 * 60_000;

/** The wrong tries that void a claim. */
export const MAX_CLAIM_ATTEMPTS = 5;

/** How many codes there are: eight digits. */
export const CLAIM_CODE_SPACE = 100_000_000;

/** The code for `value`, a uniformly random integer below 10⁸, as the terminal shows it: 4829-1734. */
export function formatClaimCode(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= CLAIM_CODE_SPACE) {
    throw new RangeError(`${value} isn't an eight-digit claim code`);
  }
  const digits = String(value).padStart(8, "0");
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** The hash a claim keeps of `code`. Hyphens don't matter, so 48291734 matches 4829-1734. */
export function hashClaimCode(code: string): string {
  return Bun.SHA256.hash(code.replaceAll("-", ""), "hex");
}

/** A new live claim for the code whose hash is `codeHash`. */
export function newClaim(codeHash: string, now: number): Claim {
  return {
    codeHash,
    state: "live",
    failedAttempts: 0,
    createdAt: now,
    expiresAt: now + CLAIM_LIFETIME_MS,
    post: null,
    decidedAt: null,
    voidReason: null,
  };
}

/** Whether a claim may still pin an owner. */
export function isOpen(claim: Claim): boolean {
  return claim.state === "live" || claim.state === "posted" || claim.state === "admitted";
}

/** What a claim's state means now, when an open claim's deadline may have passed unrecorded. */
export function claimStatus(claim: Claim, now: number): ClaimState | "expired" {
  return isOpen(claim) && now >= claim.expiresAt ? "expired" : claim.state;
}

export type ClaimAttemptOutcome =
  /** The code matched, so the claim waits for the bridge to admit who posted it. */
  | "posted"
  /** The code didn't match. */
  | "missed"
  /** The last allowed wrong code voided the claim. */
  | "exhausted"
  /** The claim's deadline had passed, so it's void and the code wasn't tried. */
  | "expired";

/**
 * Tries `attempt` against the claim, or returns null when the claim isn't live. Once someone has
 * posted the right code, nobody else can take the claim over, even with the same code.
 */
export function attemptClaim<T extends Claim>(
  claim: T,
  attempt: ClaimAttempt,
  now: number,
): { claim: T; outcome: ClaimAttemptOutcome } | null {
  if (claim.state !== "live") return null;
  if (now >= claim.expiresAt)
    return { claim: voidClaim(claim, "expired", now), outcome: "expired" };
  if (hashClaimCode(attempt.code) === claim.codeHash) {
    const { userId, channelId, ts } = attempt;
    const post = { userId, channelId, ts, at: now };
    return { claim: { ...claim, state: "posted", post }, outcome: "posted" };
  }
  const failedAttempts = claim.failedAttempts + 1;
  if (failedAttempts >= MAX_CLAIM_ATTEMPTS) {
    return {
      claim: voidClaim({ ...claim, failedAttempts }, "exhausted", now),
      outcome: "exhausted",
    };
  }
  return { claim: { ...claim, failedAttempts }, outcome: "missed" };
}

/**
 * Admits whoever posted the code, given the admission check on what users.info said about them,
 * or returns null when the claim isn't waiting for that. Someone the check refuses voids the
 * code, so nobody can post it again, and so does the deadline.
 */
export function admitPoster<T extends Claim>(
  claim: T,
  problem: AdmissionProblem | null,
  now: number,
): T | null {
  if (claim.state !== "posted") return null;
  if (now >= claim.expiresAt) return voidClaim(claim, "expired", now);
  if (problem) return voidClaim(claim, problem, now);
  return { ...claim, state: "admitted" };
}

/** The terminal's answer about the person it showed as having posted the code. */
export type ClaimAnswer = { confirm: boolean; postedBy: string };

export type ClaimAnswerOutcome<T extends Claim = Claim> =
  /** The claim pins the person who posted it. */
  | { kind: "confirmed"; claim: T }
  | { kind: "declined"; claim: T }
  /** The deadline passed, or a fresh admission check refused them after all. */
  | { kind: "void"; claim: T }
  | { kind: "refused"; reason: ClaimAnswerRefusal };

export type ClaimAnswerRefusal =
  /** Nobody has posted the code yet. */
  | "not_posted"
  /** Someone posted it, and the bridge hasn't admitted them yet. */
  | "not_admitted"
  /** The claim was confirmed, declined or voided already. */
  | "closed"
  /** Someone other than the person the terminal showed posted the code. */
  | "different_poster";

/**
 * Settles an admitted claim with the terminal's answer. A yes pins the poster only if `problem`,
 * the admission check on users.info read for that answer, is null. A no needs no check.
 */
export function answerClaim<T extends Claim>(
  claim: T,
  answer: ClaimAnswer,
  problem: AdmissionProblem | null,
  now: number,
): ClaimAnswerOutcome<T> {
  if (claim.state === "live") return { kind: "refused", reason: "not_posted" };
  if (claim.state === "posted") return { kind: "refused", reason: "not_admitted" };
  if (claim.state !== "admitted") return { kind: "refused", reason: "closed" };
  if (claim.post!.userId !== answer.postedBy) {
    return { kind: "refused", reason: "different_poster" };
  }
  if (now >= claim.expiresAt) return { kind: "void", claim: voidClaim(claim, "expired", now) };
  if (!answer.confirm) {
    return { kind: "declined", claim: { ...claim, state: "declined", decidedAt: now } };
  }
  if (problem) return { kind: "void", claim: voidClaim(claim, problem, now) };
  return { kind: "confirmed", claim: { ...claim, state: "confirmed", decidedAt: now } };
}

/** Voids an open claim for `reason`. */
export function voidClaim<T extends Claim>(claim: T, reason: ClaimVoidReason, now: number): T {
  if (!isOpen(claim)) throw new RangeError(`A claim that's ${claim.state} isn't open.`);
  return { ...claim, state: "void", decidedAt: now, voidReason: reason };
}
