import type { Trial, TrialTurn } from './types.ts';
export const complete = (turn: TrialTurn): boolean => turn.decision !== null && turn.error === null && turn.native_completed;
export function release(trial: Trial, arm: 'baseline' | 'self_review' | 'auditor'): boolean {
  return arm === 'auditor' ? trial.baseline.decision?.accepted === true && trial.auditor.decision?.accepted === true
    : trial[arm].decision?.accepted === true;
}
export function summarize(trials: readonly Trial[]) {
  const paired = trials.filter(trial => complete(trial.baseline) && complete(trial.self_review) && complete(trial.auditor));
  const arms = ['baseline', 'self_review', 'auditor'] as const;
  return {
    planned_pairs: trials.length, complete_pairs: paired.length,
    arms: Object.fromEntries(arms.map(arm => {
      const bad = paired.filter(trial => !trial.oracle.releasable);
      const good = paired.filter(trial => trial.oracle.releasable);
      return [arm, { flawed: bad.length, false_accepts: bad.filter(trial => release(trial, arm)).length,
        clean: good.length, false_blocks: good.filter(trial => !release(trial, arm)).length,
        stage_errors: trials.filter(trial => !complete(trial[arm])).length,
        model_requests: trials.reduce((sum, trial) => sum + trial[arm].model_requests, 0),
        input_tokens: trials.reduce((sum, trial) => sum + trial[arm].input_tokens, 0),
        output_tokens: trials.reduce((sum, trial) => sum + trial[arm].output_tokens, 0),
        duration_ms: trials.reduce((sum, trial) => sum + trial[arm].duration_ms, 0),
      }];
    })),
    discordances: {
      auditor_blocks_self_accept: paired.filter(trial => !trial.oracle.releasable && release(trial, 'self_review') && !release(trial, 'auditor')).length,
      self_blocks_auditor_accept: paired.filter(trial => !trial.oracle.releasable && !release(trial, 'self_review') && release(trial, 'auditor')).length,
      auditor_repairs_baseline_false_accept: paired.filter(trial => !trial.oracle.releasable && release(trial, 'baseline') && !release(trial, 'auditor')).length,
      auditor_adds_clean_false_block: paired.filter(trial => trial.oracle.releasable && release(trial, 'baseline') && !release(trial, 'auditor')).length,
    },
    baseline_accepted_subset: {
      pairs: paired.filter(trial => release(trial, 'baseline')).length,
      flawed: paired.filter(trial => release(trial, 'baseline') && !trial.oracle.releasable).length,
      clean: paired.filter(trial => release(trial, 'baseline') && trial.oracle.releasable).length,
      auditor_false_accepts: paired.filter(trial => release(trial, 'baseline') && !trial.oracle.releasable && trial.auditor.decision!.accepted).length,
      self_false_accepts: paired.filter(trial => release(trial, 'baseline') && !trial.oracle.releasable && trial.self_review.decision!.accepted).length,
      auditor_false_blocks: paired.filter(trial => release(trial, 'baseline') && trial.oracle.releasable && !trial.auditor.decision!.accepted).length,
      self_false_blocks: paired.filter(trial => release(trial, 'baseline') && trial.oracle.releasable && !trial.self_review.decision!.accepted).length,
    },
  };
}
