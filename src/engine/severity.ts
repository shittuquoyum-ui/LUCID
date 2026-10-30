/**
 * Severity comes from fixed rules, not from a model's mood:
 *
 *   high   data exposure (RLS off, rules that let every row through, owner
 *          checks taken out of a rule, public buckets), secrets or the
 *          service key in browser code
 *   medium a missing owner check on an update or delete, an admin route
 *          without a role check, a webhook without a signature check
 *   low    CORS *, everything else
 *
 * The picker may move a risk ONE level up or down, and only with a reason.
 * The fact checker then accepts or rejects the reason; a rejected (or
 * missing) reason leaves the rule's level. Plain code decides the result.
 */
import type { Severity } from './schemas';
import type { RiskCategory } from './signals';

export const LEVELS: readonly Severity[] = ['low', 'medium', 'high'];

export const RULE_SEVERITY: Record<RiskCategory, Severity> = {
  'data-exposure': 'high',
  secrets: 'high',
  ownership: 'medium',
  auth: 'medium',
  payments: 'medium',
  other: 'low',
};

export interface SeverityCall {
  /** What the rules say for this category. */
  rule: Severity;
  /** What the picker asks for: the rule's level, or one level away with a reason. */
  proposed: Severity;
  /** The picker's reason for moving; null when it did not move. */
  reason: string | null;
}

/** The picker's ask, held to the rules: one level at most, and never without a reason. */
export const proposeSeverity = (category: RiskCategory, wanted: Severity | null, reason: string | null | undefined): SeverityCall => {
  const rule = RULE_SEVERITY[category];
  const because = reason?.trim() ?? '';
  const from = LEVELS.indexOf(rule);
  const step = Math.sign(LEVELS.indexOf(wanted ?? rule) - from);
  if (step === 0 || !because) return { rule, proposed: rule, reason: null };
  return { rule, proposed: LEVELS[from + step]!, reason: because };
};

/** The card's severity: the move only stands when the fact checker accepted its reason. */
export const finalSeverity = (call: SeverityCall, reasonAccepted: boolean): Severity =>
  call.reason !== null && reasonAccepted ? call.proposed : call.rule;
