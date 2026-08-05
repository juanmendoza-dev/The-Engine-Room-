import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` otherwise appends its own block to AGENTS.md on every run, which
  // in this repo means every agent's branch carries the same phantom diff.
  // Our AGENTS.md is hand-written and hook-enforced, so keep it ours only.
  agentRules: false,
};

export default nextConfig;
