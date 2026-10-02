import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const PEER_GUIDANCE =
  '<test_peer_guidance>peer system guidance survives</test_peer_guidance>';

export default function shellPolicyPeerGuidance(pi: ExtensionAPI): void {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${PEER_GUIDANCE}`,
  }));
}
