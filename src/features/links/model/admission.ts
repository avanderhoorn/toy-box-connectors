import type { Installation } from "@slackapi/model/installation";
import type { SlackPerson } from "@slackapi/model/users";

// Admitting a person.
//
// Allowing someone gives them a say over what the lead does, so allow admits them only if
// users.info shows a full member: not a guest, a deactivated account, a bot, a workflow bot or
// Slackbot, and in the installation's workspace or, in an Enterprise org, the installation's org.
// The workspace a message names for its author is never the test, because an Enterprise coworker
// can post from a sibling workspace. A response that leaves out whether they're a bot or a guest,
// or their workspace or org, refuses rather than guesses. The people admitted are rechecked the
// same way.

/** Why the bridge won't admit someone. */
export type AdmissionProblem =
  /** Slack doesn't know the user. */
  | "user_not_found"
  /** users.info described someone else, or left out a flag, workspace or org admission needs. */
  | "unverified"
  /** A bot, a workflow bot or Slackbot. */
  | "bot"
  | "deactivated"
  /** A multi-channel or single-channel guest. */
  | "guest"
  /** A member of another Enterprise org. */
  | "other_org"
  /** A member of another workspace, outside the installation's org. */
  | "other_workspace";

/** Slackbot's user ID, the same in every workspace. */
const SLACKBOT_USER_ID = "USLACKBOT";

/**
 * Why `userId` can't be admitted, given what users.info returned for them, or null when they can.
 * `person` is null when Slack doesn't know them. A definite problem comes before a flag Slack left
 * out, so a recheck that only removes people for a definite answer still removes them.
 */
export function admissionProblem(
  userId: string,
  person: SlackPerson | null,
  home: Pick<Installation, "teamId" | "enterpriseId">,
): AdmissionProblem | null {
  if (!person) return "user_not_found";
  if (userId !== person.id && userId !== person.enterpriseUserId) return "unverified";
  if (person.isBot === true || person.isWorkflowBot || person.id === SLACKBOT_USER_ID) return "bot";
  if (person.deleted) return "deactivated";
  if (person.isRestricted === true || person.isUltraRestricted === true) return "guest";
  const place = placeProblem(person, home);
  if (place) return place;
  if (person.isBot === null || person.isRestricted === null || person.isUltraRestricted === null) {
    return "unverified";
  }
  return null;
}

function placeProblem(
  person: SlackPerson,
  home: Pick<Installation, "teamId" | "enterpriseId">,
): AdmissionProblem | null {
  if (person.teamId !== null && person.teamId === home.teamId) return null;
  if (home.enterpriseId === null) return person.teamId === null ? "unverified" : "other_workspace";
  if (person.enterpriseId === home.enterpriseId) return null;
  return person.enterpriseId === null ? "unverified" : "other_org";
}
