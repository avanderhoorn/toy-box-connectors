// What the wake scheduler reads and records.
//
// A pass reads everything it decides from in one read, so links, requests, debts and the budget
// agree. A run's outcome is recorded with every change it makes to its link in one transaction.
// Failures are counted from the wakes log, so a restart keeps a link's retry backoff.

import type { RoutineRunOutcome, RoutineState } from "@toybox/model";
import {
  catchUpPeriod,
  defaultWakeTimings,
  retryDelay,
  wakeBlock,
  type LinkWakeState,
  type WakeBlock,
  type WakeRequest,
} from "@wakes/model";
import { WAKE_BUDGET_WINDOW, type RanWake } from "@wakes/model/budget";
import type { OwedCatchUp, ProposalDebt, ScheduledLink, Wake, WakePass } from "@wakes/model/plan";

type LinkRow = Omit<ScheduledLink, "requests" | "setup" | "catchUps">;

type BlockRow = Pick<LinkWakeState, "status" | "routineState" | "blockedReason"> & {
  provider: string | null;
};

type DebtRow = {
  approvalId: string;
  channelId: string;
  decidedAt: number;
  linkId: string | null;
  routineId: string | null;
  failures: number;
  lastFailedAt: number | null;
  ended: 0 | 1;
};

type SeriesRow = {
  linkId: string;
  series: string;
  routineId: string;
  routineState: RoutineState;
  period: "day" | "week";
  schedule: string;
  registeredAt: number;
};

/** Everything a pass at `now` decides from. */
export async function readWakePass(sql: Bun.SQL, now: number): Promise<WakePass> {
  const links = await sql<LinkRow[]>`
    SELECT l.id, l.toybox_channel_id AS channelId, l.requests_routine_id AS routineId, l.status,
      l.routine_state AS routineState, w.blocked_reason AS blockedReason,
      w.last_wake_at AS lastWakeAt, w.last_inbox_at AS lastInboxAt,
      COALESCE(w.wakes_since_inbox, 0) AS wakesSinceInbox, w.retry_at AS retryAt
    FROM links l LEFT JOIN wake_state w ON w.link_id = l.id
    ORDER BY l.id
  `;
  const requests = groupByLink(
    await sql<(WakeRequest & { linkId: string })[]>`
      SELECT link_id AS linkId, id, state, attention, held_at AS heldAt, changed_at AS changedAt,
        seen_at AS seenAt, touched_at AS touchedAt, reminded_at AS remindedAt
      FROM requests WHERE state IN ('open', 'seen', 'in_progress')
      ORDER BY id
    `,
  );
  const debts = await readSetupDebts(sql);
  const setup = groupByLink(
    debts.flatMap(({ linkId, approvalId, decidedAt }) =>
      linkId === null ? [] : [{ linkId, approvalId, decidedAt }],
    ),
  );
  const catchUps = groupByLink(await readOwedCatchUps(sql, now));
  const ran = await sql<RanWake[]>`
    SELECT link_id AS linkId, at FROM wakes
    WHERE outcome = 'ran' AND at > ${now - WAKE_BUDGET_WINDOW}
    ORDER BY id
  `;
  return {
    links: links.map((link) => ({
      ...link,
      requests: requests.get(link.id) ?? [],
      setup: setup.get(link.id) ?? [],
      catchUps: catchUps.get(link.id) ?? [],
    })),
    proposals: debts.flatMap(proposalDebt),
    ran,
  };
}

/**
 * Records that Toy Box answered `wake`'s run with `outcome` at `at`, and what that means for its
 * link. A catch-up shares its link's retries, but never counts toward the link's backoff or blocks
 * the link.
 */
export async function recordWake(
  transaction: Bun.SQL,
  wake: Wake,
  outcome: RoutineRunOutcome,
  at: number,
  timings = defaultWakeTimings,
): Promise<void> {
  const row = {
    link_id: wake.linkId,
    approval_id: wake.approvalId,
    at,
    kind: wake.kind,
    publication_key: wake.catchUp?.key ?? null,
    outcome,
  };
  await transaction`INSERT INTO wakes ${transaction(row)}`;
  const linkId = wake.linkId;
  // A link removed while its run was in flight keeps only the log.
  if (linkId === null || !(await linkExists(transaction, linkId))) return;

  if (outcome === "failed") {
    const retryAt = at + retryDelay(await failuresInARow(transaction, linkId), timings);
    await transaction`
      INSERT INTO wake_state (link_id, retry_at) VALUES (${linkId}, ${retryAt})
      ON CONFLICT(link_id) DO UPDATE SET retry_at = excluded.retry_at
    `;
  } else if (wake.catchUp) {
    if (outcome === "missing") {
      await transaction`
        UPDATE link_routines SET routine_state = 'missing'
        WHERE link_id = ${linkId} AND series = ${wake.catchUp.series}
          AND routine_id = ${wake.routineId}
      `;
    }
  } else if (outcome === "ran") {
    await transaction`
      INSERT INTO wake_state (link_id, last_wake_at, wakes_since_inbox) VALUES (${linkId}, ${at}, 1)
      ON CONFLICT(link_id) DO UPDATE SET
        last_wake_at = excluded.last_wake_at,
        wakes_since_inbox = wakes_since_inbox + 1,
        retry_at = NULL
    `;
    if (wake.reminded.length) {
      await transaction`
        UPDATE requests SET reminded_at = ${at}
        WHERE id IN ${transaction([...wake.reminded])} AND state IN ('seen', 'in_progress')
      `;
    }
  } else if (outcome === "missing") {
    // Only the routine that was run is gone. A routine recorded since is the lead's fix.
    await transaction`
      UPDATE links SET routine_state = 'missing', updated_at = ${at}
      WHERE id = ${linkId} AND requests_routine_id = ${wake.routineId}
    `;
  } else {
    await transaction`
      INSERT INTO wake_state (link_id, blocked_reason) VALUES (${linkId}, 'refused')
      ON CONFLICT(link_id) DO UPDATE SET blocked_reason = excluded.blocked_reason
    `;
  }
}

/** Records that the link's lead read its inbox at `at`, which ends its backoff and any stall. */
export async function recordInbox(transaction: Bun.SQL, linkId: string, at: number): Promise<void> {
  await transaction`
    INSERT INTO wake_state (link_id, last_inbox_at) VALUES (${linkId}, ${at})
    ON CONFLICT(link_id) DO UPDATE SET last_inbox_at = excluded.last_inbox_at, wakes_since_inbox = 0
  `;
}

/**
 * Why the link's lead can't be woken until a person acts, or null. A request on a blocked link
 * gets no 👀, because nobody should be told the lead is coming. A link that's gone is inactive.
 */
export async function readWakeBlock(sql: Bun.SQL, linkId: string): Promise<WakeBlock | null> {
  const [link] = await sql<BlockRow[]>`
    SELECT l.status, l.routine_state AS routineState, s.provider, w.blocked_reason AS blockedReason
    FROM links l
      LEFT JOIN toybox_streams s ON s.toybox_channel_id = l.toybox_channel_id
      LEFT JOIN wake_state w ON w.link_id = l.id
    WHERE l.id = ${linkId}
  `;
  return link ? wakeBlock(link, link.routineState, link.provider) : "link_inactive";
}

/**
 * The decided proposals whose lead hasn't heard the outcome, oldest first. A landed run settles
 * each, so does inbox reporting it, and for a proposal without a link a missing routine or a
 * refusal ends it too.
 */
function readSetupDebts(sql: Bun.SQL): Promise<DebtRow[]> {
  return sql<DebtRow[]>`
    SELECT a.id AS approvalId, a.toybox_channel_id AS channelId,
      COALESCE(a.applied_at, a.decided_at) AS decidedAt, l.id AS linkId,
      (SELECT json_extract(field.value, '$.after') FROM json_each(a.patch) AS field
        WHERE json_extract(field.value, '$.field') = 'requests_routine_id') AS routineId,
      (SELECT COUNT(*) FROM wakes w WHERE w.approval_id = a.id AND w.outcome = 'failed')
        AS failures,
      (SELECT MAX(w.at) FROM wakes w WHERE w.approval_id = a.id AND w.outcome = 'failed')
        AS lastFailedAt,
      EXISTS (
        SELECT 1 FROM wakes w WHERE w.approval_id = a.id AND w.outcome IN ('missing', 'refused')
      ) AS ended
    FROM approvals a LEFT JOIN links l ON l.toybox_channel_id = a.toybox_channel_id
    WHERE a.decided_by IS NOT NULL AND a.reported_at IS NULL
      AND a.state IN ('applied', 'rejected', 'expired', 'stale')
      AND NOT EXISTS (SELECT 1 FROM wakes w WHERE w.approval_id = a.id AND w.outcome = 'ran')
    ORDER BY decidedAt, a.number
  `;
}

function proposalDebt(debt: DebtRow): ProposalDebt[] {
  // A proposal that never became a link and names no routine has nothing to run.
  if (debt.linkId !== null || debt.ended || debt.routineId === null) return [];
  return [
    {
      approvalId: debt.approvalId,
      channelId: debt.channelId,
      routineId: debt.routineId,
      failures: { count: debt.failures, lastAt: debt.lastFailedAt },
    },
  ];
}

/**
 * The periods each series owes a catch-up for at `now`. A period is settled once an outbox item
 * holds its key, in the states outbox_one_publication covers, or a catch-up for it didn't fail.
 */
async function readOwedCatchUps(
  sql: Bun.SQL,
  now: number,
): Promise<(OwedCatchUp & { linkId: string })[]> {
  const series = await sql<SeriesRow[]>`
    SELECT link_id AS linkId, series, routine_id AS routineId, routine_state AS routineState,
      period, schedule, registered_at AS registeredAt
    FROM link_routines ORDER BY link_id, series
  `;
  const owed: (OwedCatchUp & { linkId: string })[] = [];
  for (const row of series) {
    const period = catchUpPeriod(row, now);
    if (!period) continue;
    const [{ settled }] = await sql<{ settled: 0 | 1 }[]>`
      SELECT EXISTS (
        SELECT 1 FROM outbox
        WHERE link_id = ${row.linkId} AND publication_key = ${period.key}
          AND state IN ('queued', 'sending', 'sent', 'delivery_unknown', 'stray', 'retracted',
            'skipped')
      ) OR EXISTS (
        SELECT 1 FROM wakes
        WHERE link_id = ${row.linkId} AND publication_key = ${period.key} AND outcome <> 'failed'
      ) AS settled
    `;
    if (settled) continue;
    const { linkId, series: name, routineId, routineState } = row;
    owed.push({ linkId, series: name, routineId, routineState, ...period });
  }
  return owed;
}

function groupByLink<Row extends { linkId: string }>(
  rows: readonly Row[],
): Map<string, Omit<Row, "linkId">[]> {
  const groups = new Map<string, Omit<Row, "linkId">[]>();
  for (const { linkId, ...row } of rows) groups.set(linkId, [...(groups.get(linkId) ?? []), row]);
  return groups;
}

async function linkExists(transaction: Bun.SQL, linkId: string): Promise<boolean> {
  const rows = await transaction`SELECT 1 FROM links WHERE id = ${linkId}`;
  return rows.length > 0;
}

/** The link's failed runs since its last run that didn't fail, the one just recorded included. */
async function failuresInARow(transaction: Bun.SQL, linkId: string): Promise<number> {
  const [{ failures }] = await transaction<{ failures: number }[]>`
    SELECT COUNT(*) AS failures FROM wakes
    WHERE link_id = ${linkId} AND outcome = 'failed' AND id > COALESCE(
      (SELECT MAX(id) FROM wakes WHERE link_id = ${linkId} AND outcome <> 'failed'), 0)
  `;
  return failures;
}
