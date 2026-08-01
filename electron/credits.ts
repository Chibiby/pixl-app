import { randomUUID } from 'crypto'
import type { AccountPublic, BuyTimeOutcome } from '@shared/types'
import { centavosToSeconds, secondsToCentavos } from '@shared/money'
import { getSettings } from './settings'
import {
  convertCreditsToTime,
  convertTimeToCredits,
  enqueue,
  getAccountById,
  insertLedger,
  nextSeq,
  toPublic
} from './sync/sqlite'

// Buying time converts money (centavos) into purchased seconds at the current
// peso rate. It is the only path that moves both balances at once, so it lives
// here and is shared by the login path and the mid-session IPC handler.

export interface PurchaseResult {
  outcome: BuyTimeOutcome
  message: string
  account: AccountPublic | null
  addedSeconds: number
  spentCentavos: number
}

export function purchaseTime(accountId: string, centavos: number): PurchaseResult {
  const amount = Math.round(centavos)
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('invalid_amount', 'Enter an amount greater than ₱0.')
  }

  const account = getAccountById(accountId)
  if (!account) return fail('no_account', 'Account not found.')

  const rate = getSettings().pesoToSecondsRate
  const seconds = centavosToSeconds(amount, rate)
  if (seconds <= 0) {
    return fail('invalid_amount', 'That amount does not buy any time.')
  }

  const balances = convertCreditsToTime(account.id, amount, seconds)
  if (!balances) {
    return fail('insufficient_credits', 'Not enough credits — please top up at the counter.')
  }

  const createdAt = new Date().toISOString()
  const seq = nextSeq()
  insertLedger({
    id: randomUUID(),
    account_id: account.id,
    admin_id: null,
    kind: 'buy_time',
    delta_centavos: -amount,
    delta_seconds: seconds,
    note: 'buy time',
    created_at: createdAt,
    synced_from: 'offline_queue',
    seq
  })
  enqueue('buy_time', {
    account_id: account.id,
    delta_centavos: -amount,
    delta_seconds: seconds,
    created_at: createdAt
  })

  const updated = getAccountById(account.id)
  return {
    outcome: 'ok',
    message: '',
    account: updated ? toPublic(updated) : null,
    addedSeconds: seconds,
    spentCentavos: amount
  }
}

/**
 * Refunds ALL remaining purchased time into money at the current peso rate.
 * No-op (still returns the account) when time_balance_seconds is already 0.
 */
export function refundTimeToCredits(accountId: string): {
  account: AccountPublic | null
  refundedCentavos: number
  refundedSeconds: number
} {
  const account = getAccountById(accountId)
  if (!account) {
    return { account: null, refundedCentavos: 0, refundedSeconds: 0 }
  }

  const seconds = Math.max(0, Math.floor(account.time_balance_seconds))
  if (seconds <= 0) {
    return { account: toPublic(account), refundedCentavos: 0, refundedSeconds: 0 }
  }

  const rate = getSettings().pesoToSecondsRate
  const centavos = secondsToCentavos(seconds, rate)

  const balances = convertTimeToCredits(account.id, centavos, seconds)
  if (!balances) {
    return { account: toPublic(account), refundedCentavos: 0, refundedSeconds: 0 }
  }

  const createdAt = new Date().toISOString()
  const seq = nextSeq()
  insertLedger({
    id: randomUUID(),
    account_id: account.id,
    admin_id: null,
    kind: 'sell_time',
    delta_centavos: centavos,
    delta_seconds: -seconds,
    note: 'sell time',
    created_at: createdAt,
    synced_from: 'offline_queue',
    seq
  })
  enqueue('sell_time', {
    account_id: account.id,
    delta_centavos: centavos,
    delta_seconds: -seconds,
    created_at: createdAt
  })

  const updated = getAccountById(account.id)
  return {
    account: updated ? toPublic(updated) : null,
    refundedCentavos: centavos,
    refundedSeconds: seconds
  }
}

function fail(outcome: BuyTimeOutcome, message: string): PurchaseResult {
  return { outcome, message, account: null, addedSeconds: 0, spentCentavos: 0 }
}
