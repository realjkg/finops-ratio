export interface AgentJob {
  id: string;
  workloadId: string;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
  basis: string;
  status: "queued" | "running" | "failed" | "review" | "accepted" | "dismissed";
  attempts: number;
  lease?: { owner: string; token: string; expiresAt: string };
  error?: string;
  result?: {
    engine: "deterministic-simulation-v1";
    recommendation: "review" | "continue" | "expand" | "change" | "stop";
    tasks: {
      role: "technical" | "procurement" | "executive";
      instruction: string;
    }[];
    measuredRatio: number | null;
    governanceReady: boolean;
  };
  review?: { by: string; at: string; rationale: string };
}
