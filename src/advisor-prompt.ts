import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ADVISOR_INJECTION_MARKER = "<!-- pi-chain-dev:advisor-hint -->";

const ADVISOR_RULE = `
${ADVISOR_INJECTION_MARKER}
RULE — when stuck or facing a difficult decision, use /cdev advisor:
- If you are looping, uncertain about the right approach, or need a concrete recommendation, use cdev({ advisor:true, task:"<describe the dilemma>" }).
- The advisor gathers evidence and gives a recommendation; it does not edit code.
- For a faster opinion without exploration, use cdev({ askAdvisor:true, task:"<question>" }).
${ADVISOR_INJECTION_MARKER}
`.trim();

interface BeforeAgentStartEventLike {
  systemPrompt: string;
}

export function getAdvisorRule(): string {
  return ADVISOR_RULE;
}

export function registerAdvisorPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const beforeEvent = event as BeforeAgentStartEventLike;
    if (!beforeEvent.systemPrompt.includes(ADVISOR_INJECTION_MARKER)) {
      beforeEvent.systemPrompt += `\n\n${ADVISOR_RULE}`;
    }
    return { systemPrompt: beforeEvent.systemPrompt };
  });
}
