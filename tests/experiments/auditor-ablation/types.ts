/** Frozen experimental vocabulary. No production audit gate is modified. */
export type Scenario = 'code' | 'research' | 'proof';
export type Variant = 'clean' | 'coverage-gap' | 'stale-evidence' | 'unsupported-conclusion';
export interface Source {
  id: string; url: string; retrieved_at: string; hash: string; text: string;
  excerpts: { id: string; text: string }[];
}
export interface ResearchCorpus {
  sources: Source[];
  expected_claims: { id: string; required_facts: Record<string, unknown>; source_ids: string[]; excerpt_ids: string[] }[];
}
export interface Criterion { id: string; description: string }
export interface Packet {
  task: string;
  result_ref: string;
  criteria: Criterion[];
  artifact: unknown;
  receipts: { id: string; result_ref: string; method: string; observation: unknown }[];
  sources?: Source[];
}
export interface Fixture {
  id: string; scenario: Scenario; variant: Variant; packet: Packet;
  oracle: { releasable: boolean; failures: string[]; evidence: unknown };
}
export interface Finding {
  criterion_id?: string; rule?: string; passed: boolean; method: string;
  observation: string; evidence_ids: string[];
}
export interface Decision {
  accepted: boolean; checks: Finding[]; issues: string[]; notes: string;
}
export interface TrialTurn {
  session_id: string; role: 'orchestrator' | 'auditor'; decision: Decision | null;
  error: string | null; duration_ms: number; model_requests: number;
  input_tokens: number; output_tokens: number; tool_calls: number;
  uncached_input_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  native_completed: boolean; native_stop: unknown;
  native_file: string | null; read_packet_call_ids: string[];
}
export interface Trial {
  fixture_id: string; scenario: Scenario; variant: Variant; repetition: number;
  packet_sha256: string; oracle: Fixture['oracle'];
  baseline: TrialTurn; self_review: TrialTurn; auditor: TrialTurn;
  order: readonly string[];
}
