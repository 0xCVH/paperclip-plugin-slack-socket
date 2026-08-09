// Slack conversation-id shape helpers.
//
// Slack channel ids are prefixed by kind — "C" public channel, "G" private
// channel or group DM (mpim), "D" direct message (im) — and that prefix is a
// reliable, network-free signal. It matters because not every Slack event
// carries an explicit type field the way `message` does (`channel_type`):
// `app_mention` does not, so anything deriving an InboundMessage from it has
// to infer the conversation kind from the id itself. Shared here (rather
// than duplicated at each call site) so bolt-gateway.ts and any other code
// that needs the same "is this a DM" answer can't drift on the rule.
export function isDmChannelId(channelId: string): boolean {
  return channelId.startsWith("D");
}
