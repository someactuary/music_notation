/**
 * Sends the Help panel's feedback box to Frank by email, through Web3Forms (a free form
 * service: the website has no server of its own to send mail). Web3Forms delivers every
 * message to the inbox the access key was made for (frankc@mail.instinct.com). The key is
 * meant to be public: it can only send to that inbox, never read from it.
 */
import { IS_WEBSITE } from "./site";

export const WEB3FORMS_ENDPOINT = "https://api.web3forms.com/submit";
export const WEB3FORMS_ACCESS_KEY = "49ba8ce0-3cf3-4743-9325-8cd59dacdf2a";

export interface FeedbackInput {
  message: string;
  name?: string;
  /** So Frank can reply; optional. */
  email?: string;
  /** The hidden spam-trap checkbox; people never tick it, bots do. */
  botcheck?: boolean;
}

/** What gets sent: the visitor's words plus where they were, never the score itself. */
export function feedbackPayload(input: FeedbackInput, context: { userAgent: string; url: string }): Record<string, unknown> {
  const name = input.name?.trim();
  const email = input.email?.trim();
  return {
    access_key: WEB3FORMS_ACCESS_KEY,
    subject: "Sheet Music Assistant feedback",
    from_name: name || "Sheet Music Assistant user",
    ...(name ? { name } : {}),
    ...(email ? { email, replyto: email } : {}),
    message: input.message.trim(),
    sent_from: IS_WEBSITE ? "website" : "local app",
    page: context.url,
    browser: context.userAgent,
    botcheck: input.botcheck ?? false,
  };
}

/** Throws with a plain-language message when the feedback couldn't be sent. */
export async function sendFeedback(input: FeedbackInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!input.message.trim()) throw new Error("Please write a message first.");
  const payload = feedbackPayload(input, { userAgent: navigator.userAgent, url: location.href });
  let res: Response;
  try {
    res = await fetchImpl(WEB3FORMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Couldn't send: check your internet connection and try again.");
  }
  let body: { success?: boolean; message?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Not JSON (e.g. a proxy error page); fall through to the status check.
  }
  if (!res.ok || body.success === false) {
    throw new Error(`Couldn't send${body.message ? `: ${body.message}` : ` (error ${res.status})`}. Please try again later.`);
  }
}
