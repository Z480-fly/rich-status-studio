import { describe, expect, it } from "bun:test";
import { chatSend, chatSearch, isParticipant } from "./chat-rules";

describe("private Zora messaging", () => {
  it("allows only sender and recipient to receive a message", () => {
    const message = { sender_id: "123", recipient_id: "456" };
    expect(isParticipant("123", message)).toBe(true);
    expect(isParticipant("456", message)).toBe(true);
    expect(isParticipant("789", message)).toBe(false);
  });
  it("rejects blank messages and messages over 2000 characters", () => {
    expect(chatSend.safeParse({ peerId: "123", body: "   " }).success).toBe(false);
    expect(chatSend.safeParse({ peerId: "123", body: "x".repeat(2000) }).success).toBe(true);
    expect(chatSend.safeParse({ peerId: "123", body: "x".repeat(2001) }).success).toBe(false);
  });
  it("rejects non-Discord recipient IDs", () => {
    expect(chatSend.safeParse({ peerId: "123),sender_id.neq.0", body: "hello" }).success).toBe(false);
  });
  it("requires at least two characters to search people", () => {
    expect(chatSearch.safeParse({ query: "a" }).success).toBe(false);
    expect(chatSearch.safeParse({ query: "ab" }).success).toBe(true);
  });
});