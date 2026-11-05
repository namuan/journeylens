import { z } from "zod";
export const Journey = z.object({
  id: z.string(),
  goal: z.string(),
  mode: z.enum(["standard", "keyboard-only"]),
  width: z.number().int().min(320).max(1920),
});
export const Candidate = z.object({
  id: z.string(),
  title: z.string(),
  expected: z.string(),
  observed: z.string(),
  steps: z.array(z.string()),
  evidenceIds: z.array(z.string()).min(1),
});
export const Decision = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("probe"),
    purpose: z.string(),
    code: z.string().max(20000),
  }),
  z.object({
    kind: z.literal("done"),
    outcome: z.enum(["completed", "blocked", "inconclusive"]),
    summary: z.string(),
    candidates: z.array(Candidate),
  }),
]);
export const Review = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      verdict: z.enum(["supported", "rejected", "uncertain"]),
      reason: z.string(),
    }),
  ),
  gaps: z.array(Journey).max(3),
});
export const Verification = z.object({
  reproduced: z.boolean(),
  validDefect: z.boolean(),
  reason: z.string(),
  evidenceIds: z.array(z.string()),
});
export type Journey = z.infer<typeof Journey>;
export type Candidate = z.infer<typeof Candidate>;
export type Model = {
  ask<T>(
    pass: string,
    input: unknown,
    schema: z.ZodType<T>,
    instructions: string,
  ): Promise<T>;
};
export type Config = {
  url: string;
  goal: string;
  out: string;
  maxCalls: number;
  maxActions: number;
  maxProbes: number;
  maxJourneys: number;
  minutes: number;
  headless: boolean;
};
export type State = {
  config: Config;
  started: string;
  deadline: number;
  calls: number;
  actions: number;
  evidence: Record<string, unknown>;
  coverage: Array<{
    journey: Journey;
    pass: string;
    outcome: string;
    summary: string;
  }>;
  candidates: Array<Candidate & { journey: Journey }>;
  reviews: unknown[];
  findings: Array<{
    candidateId: string;
    status: "confirmed" | "suspected" | "rejected";
    reason: string;
    evidenceIds: string[];
  }>;
  passes: Array<{
    name: string;
    calls: number;
    actions: number;
    coverageAdded: number;
    candidatesAdded: number;
  }>;
  error?: string;
};
