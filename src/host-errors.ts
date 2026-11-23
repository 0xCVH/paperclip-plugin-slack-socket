import { errString } from "./redact.js";

/** Keep host denials actionable without exposing tokens in the Slack response. */
export function describeHostError(err: unknown): string {
  const message = errString(err);

  if (message.includes("company context is required")) {
    return (
      "the secret could not be resolved yet. Paperclip grants a plugin access to " +
      "secrets per configured company, and this configuration has not been saved " +
      "yet — click Save first, then run Test Connection again."
    );
  }

  if (message.includes("invocation scope")) {
    return "Paperclip rejected the scope of a Slack plugin request. Check the issue before resending and the plugin logs for the failed operation.";
  }

  return message;
}
