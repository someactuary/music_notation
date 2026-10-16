// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { feedbackPayload, sendFeedback, WEB3FORMS_ACCESS_KEY, WEB3FORMS_ENDPOINT } from "@/ui/feedback";
import { HelpPanel } from "@/ui/HelpPanel";

const ctx = { userAgent: "TestBrowser/1.0", url: "https://someactuary.github.io/music_notation/" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("feedbackPayload", () => {
  it("sends the message with the access key, subject and where it came from, never the score", () => {
    const p = feedbackPayload({ message: "  The beam button is great  " }, ctx);
    expect(p).toMatchObject({
      access_key: WEB3FORMS_ACCESS_KEY,
      subject: "Sheet Music Assistant feedback",
      from_name: "Sheet Music Assistant user",
      message: "The beam button is great",
      page: ctx.url,
      browser: "TestBrowser/1.0",
      botcheck: false,
    });
    expect(p).not.toHaveProperty("email");
    expect(JSON.stringify(p)).not.toMatch(/measures|parts/);
  });

  it("includes the name and a reply-to address when given", () => {
    const p = feedbackPayload({ message: "Hi", name: " Ann ", email: " ann@example.com " }, ctx);
    expect(p).toMatchObject({ from_name: "Ann", name: "Ann", email: "ann@example.com", replyto: "ann@example.com" });
  });
});

describe("sendFeedback", () => {
  it("posts JSON to Web3Forms and resolves on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: true, message: "Email sent successfully!" }));
    await sendFeedback({ message: "Hello" }, fetchMock as unknown as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(WEB3FORMS_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ message: "Hello", access_key: WEB3FORMS_ACCESS_KEY });
  });

  it("refuses an empty message without sending anything", async () => {
    const fetchMock = vi.fn();
    await expect(sendFeedback({ message: "   " }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/write a message/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains a network failure (e.g. offline) in plain words", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(sendFeedback({ message: "Hi" }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/internet connection/);
  });

  it("passes on Web3Forms' own reason when it refuses", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ success: false, message: "Invalid access key" }, 400));
    await expect(sendFeedback({ message: "Hi" }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/Invalid access key/);
  });

  it("handles a server error that isn't JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>oops</html>", { status: 502 }));
    await expect(sendFeedback({ message: "Hi" }, fetchMock as unknown as typeof fetch)).rejects.toThrow(/error 502/);
  });
});

describe("HelpPanel feedback box", () => {
  it("shows a message box, optional name and email, and a Send button", () => {
    const html = renderToStaticMarkup(createElement(HelpPanel, { onClose: () => {} }));
    expect(html).toContain("Send feedback");
    expect(html).toContain('aria-label="Your message"');
    expect(html).toContain("Your email, if you&#x27;d like a reply (optional)");
    expect(html).toMatch(/<button type="submit" disabled="">Send<\/button>/); // disabled until there's a message
  });
});
